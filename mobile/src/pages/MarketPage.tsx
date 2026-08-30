// 行情页 —— 桌面端 market.tsx 的移动端迁移：
// 指数卡片(横滑) + 标的搜索 + 自选股(★收藏，localStorage) + 实时排行(涨幅/跌幅/成交/换手)
// + 财经快讯。15s 自动刷新（页面隐藏时暂停），支持下拉刷新。
// A 股红涨绿跌（data-tone 可切国际配色）。
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Search, Star, X } from "lucide-react";
import {
  fmtAmount, fmtNum, fmtPct, getIndices, getNews, getNewsDetail, getQuotes, getRankings, searchSymbols, toneOf,
  type MarketQuote, type NewsDetail, type NewsItem, type SearchHit,
} from "../lib/market";
import { loadWatchlist, onWatchlistChange, removeFromWatchlist, type WatchItem } from "../lib/watchlist";
import { useApp, type StockTarget } from "../App";
import PullToRefresh from "../components/PullToRefresh";

const RANK_TABS = [
  { key: "watch", label: "自选", sort: "", order: "" },
  { key: "gain", label: "涨幅榜", sort: "change_pct", order: "desc" },
  { key: "loss", label: "跌幅榜", sort: "change_pct", order: "asc" },
  { key: "amount", label: "成交额", sort: "amount", order: "desc" },
  { key: "turnover", label: "换手率", sort: "turnover", order: "desc" },
] as const;
type RankKey = (typeof RANK_TABS)[number]["key"];

// 每个 Tab 的补充指标（第二指标行）
const extraMetric = (key: RankKey, r: MarketQuote): string => {
  if (key === "amount") return r.turnover_rate != null ? `换手 ${r.turnover_rate.toFixed(2)}%` : "";
  if (r.amount != null) return `额 ${fmtAmount(r.amount)}`;
  return "";
};

export default function MarketPage() {
  const { openStock, notify } = useApp();
  const [indices, setIndices] = useState<MarketQuote[]>([]);
  const [idxError, setIdxError] = useState("");
  const [rankTab, setRankTab] = useState<RankKey>("gain");
  const [rows, setRows] = useState<MarketQuote[]>([]);
  const [rankError, setRankError] = useState("");
  const [watch, setWatch] = useState<WatchItem[]>(() => loadWatchlist());
  const [news, setNews] = useState<NewsItem[]>([]);
  const [detail, setDetail] = useState<NewsDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadIndices = useCallback(async () => {
    try {
      const res = await getIndices();
      setIndices(res.indices || []);
      setIdxError(res.ok ? "" : (res.error || "加载失败"));
    } catch (e) { setIdxError(e instanceof Error ? e.message : "加载失败"); }
  }, []);
  const loadNews = useCallback(async () => {
    try { const res = await getNews(20); setNews(res.news || []); } catch { /* 快讯失败静默 */ }
  }, []);
  const active = RANK_TABS.find(t => t.key === rankTab)!;
  const loadRankings = useCallback(async () => {
    if (active.key === "watch") return;
    try {
      const res = await getRankings(active.sort, active.order, 30);
      setRows(res.rankings || []);
      setRankError(res.ok ? "" : (res.error || "加载失败"));
    } catch (e) { setRankError(e instanceof Error ? e.message : "加载失败"); }
  }, [active.key, active.sort, active.order]);
  // 自选股实时报价：A 股与指数分组拉取
  const loadWatchQuotes = useCallback(async () => {
    if (active.key !== "watch") return;
    const items = loadWatchlist();
    const stocks = items.filter(x => x.market === "a");
    const idx = items.filter(x => x.market === "index");
    const parts = await Promise.all([
      stocks.length ? getQuotes(stocks.map(s => s.symbol), "a").catch(() => null) : null,
      idx.length ? getQuotes(idx.map(s => s.symbol), "index").catch(() => null) : null,
    ]);
    const map = new Map<string, MarketQuote>();
    for (const part of parts) for (const q of part?.quotes || []) map.set(q.symbol, q);
    setRows(items.map(x => map.get(x.symbol)).filter((x): x is MarketQuote => !!x));
    setRankError(items.length && !rows.length ? "暂无报价（引擎未连接或已退市）" : "");
  }, [active.key, rows.length]);

  // 切 Tab 或自选列表变化时加载
  useEffect(() => { if (rankTab === "watch") void loadWatchQuotes(); else void loadRankings(); }, [rankTab, loadRankings, loadWatchQuotes]);
  // 自选列表变化（个股页 ★ 操作）→ 重新拉报价
  useEffect(() => {
    setWatch(loadWatchlist());
    return onWatchlistChange(() => setWatch(loadWatchlist()));
  }, []);
  useEffect(() => { if (rankTab === "watch") void loadWatchQuotes(); }, [watch.length, rankTab, loadWatchQuotes]);

  // 首载 + 15s 自动刷新（页面隐藏时暂停）
  useEffect(() => {
    void loadIndices(); void loadNews();
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void loadIndices();
      if (rankTab === "watch") void loadWatchQuotes(); else void loadRankings();
    };
    const timer = window.setInterval(tick, 15000);
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [loadIndices, loadNews, loadRankings, loadWatchQuotes, rankTab]);

  const pullRefresh = useCallback(async () => {
    await Promise.all([loadIndices(), rankTab === "watch" ? loadWatchQuotes() : loadRankings(), loadNews()]);
  }, [loadIndices, loadNews, loadRankings, loadWatchQuotes, rankTab]);

  const openNews = async (item: NewsItem) => {
    setDetail({ ok: true, title: item.title, content: item.content, image: item.image });
    setDetailLoading(true);
    try { const d = await getNewsDetail(item.url); setDetail(d.ok ? d : { ok: true, title: item.title, content: item.content }); }
    catch { /* 保留列表摘要 */ }
    finally { setDetailLoading(false); }
  };

  const openItem = (r: { symbol: string; name: string; market?: string }) =>
    openStock({ market: r.market === "index" ? "index" : "a", symbol: r.symbol, name: r.name });

  return <PullToRefresh onRefresh={pullRefresh}><div className="page">
    <header className="page-head">
      <h1>行情中心</h1>
      <p>自选 · 大盘指数 · 实时排行 · 快讯</p>
    </header>

    <MarketSearch onPick={openStock} notify={notify} />

    {idxError && !indices.length ? <div className="inline-error">{idxError}</div> : null}
    <div className="index-scroll">
      {indices.map(idx => (
        <button className={`index-card tone-bg-${toneOf(idx.change_pct)}`} key={idx.symbol}
          onClick={() => openStock({ market: "index", symbol: idx.symbol, name: idx.name })}>
          <span className="ic-name">{idx.name}</span>
          <strong className={`tone-${toneOf(idx.change_pct)}`}>{fmtNum(idx.price)}</strong>
          <em className={`tone-${toneOf(idx.change_pct)}`}>{fmtPct(idx.change_pct)}</em>
        </button>
      ))}
      {!indices.length && !idxError && <div className="loading-row"><RefreshCw className="spin" size={14} />正在读取行情…</div>}
    </div>

    <div className="section-head">
      <div className="segmented grow scroll-x">
        {RANK_TABS.map(t => <button key={t.key} className={rankTab === t.key ? "active" : ""} onClick={() => setRankTab(t.key)}>{t.label}</button>)}
      </div>
    </div>
    {rankError && !rows.length ? <div className="inline-error">{rankError}</div> : null}
    <div className="card list-card">
      {rankTab === "watch" ? <>
        {watch.length === 0 && <div className="list-empty">暂无自选 —— 打开个股详情点 ★ 添加</div>}
        {rows.map(r => <QuoteRow key={`w-${r.symbol}`} r={r} onOpen={openItem}
          action={<button className="row-star on" onClick={e => { e.stopPropagation(); removeFromWatchlist("a", r.symbol); notify("已移出自选"); }}>
            <Star size={14} fill="currentColor" />
          </button>} />)}
      </> : <>
        {rows.map((r, i) => <QuoteRow key={`${r.symbol}-${i}`} r={r} onOpen={openItem}
          extra={extraMetric(rankTab, r)} />)}
      </>}
      {!rows.length && rankTab !== "watch" && <div className="loading-row"><RefreshCw className="spin" size={14} />正在读取排行…</div>}
    </div>

    <div className="section-head"><h2>财经快讯</h2></div>
    <div className="card list-card">
      {news.map(item => (
        <button className="row news-row" key={item.id} onClick={() => void openNews(item)}>
          <span className="row-main"><b>{item.title}</b><small>{item.time} · {item.source}</small></span>
        </button>
      ))}
      {!news.length && <div className="loading-row"><RefreshCw className="spin" size={14} />正在读取快讯…</div>}
    </div>

    {detail && <div className="sheet-mask" onClick={() => setDetail(null)}>
      <div className="sheet news-sheet" onClick={e => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="sheet-head"><h2>快讯详情</h2><button className="icon-btn" onClick={() => setDetail(null)}><X size={16} /></button></div>
        <h2 className="news-title">{detail.title}</h2>
        {detail.image && <img src={detail.image} alt="" loading="lazy" />}
        {detailLoading ? <div className="loading-row"><RefreshCw className="spin" size={14} />正在加载正文…</div>
          : <div className="news-body">{detail.content?.split(/\n+/).filter(Boolean).map((p, i) => <p key={i}>{p}</p>)}</div>}
      </div>
    </div>}
  </div></PullToRefresh>;
}

function QuoteRow({ r, onOpen, extra, action }: {
  r: MarketQuote; extra?: string; action?: React.ReactNode;
  onOpen: (r: { symbol: string; name: string; market?: string }) => void;
}) {
  return <div className="row quote-row" onClick={() => onOpen(r)}>
    <span className="row-main"><b>{r.name}</b><code>{r.symbol}</code></span>
    <span className="row-side">
      <b>{fmtNum(r.price)}</b>
      <em className={`tone-${toneOf(r.change_pct)}`}>{fmtPct(r.change_pct)}</em>
      {extra && <small>{extra}</small>}
    </span>
    {action}
  </div>;
}

function MarketSearch({ onPick, notify }: { onPick: (t: StockTarget) => void; notify: (m: string, t?: "ok" | "error") => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults([]); setOpen(false); return; }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try { const res = await searchSymbols(term); setResults(res.results || []); setOpen(true); }
      catch { setResults([]); }
    }, 300);
    return () => window.clearTimeout(timer.current);
  }, [q]);
  return <div className="market-search">
    <div className="search-box">
      <Search size={15} />
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索代码 / 名称，如 600519、茅台" />
      {q && <button className="clear-btn" onClick={() => { setQ(""); setOpen(false); }}><X size={13} /></button>}
    </div>
    {open && results.length > 0 && <div className="search-drop">
      {results.map((hit, i) => (
        <button key={`${hit.symbol}-${i}`} onClick={() => { onPick({ market: hit.type === "index" ? "index" : "a", symbol: hit.symbol, name: hit.name }); setOpen(false); setQ(""); }}>
          <b>{hit.name}</b><code>{hit.symbol}</code><em>{hit.type === "index" ? "指数" : "股票"}</em>
        </button>
      ))}
    </div>}
    {open && !results.length && q.trim() ? <div className="search-drop"><span className="search-empty" onClick={() => notify("没有匹配的标的")}>没有匹配结果</span></div> : null}
  </div>;
}

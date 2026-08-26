// 行情中心页面: 大盘 / 排行 / 新闻 / 个股详情
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowLeftRight, ChevronDown, ChevronRight, Copy, Database, Link2, Newspaper, RefreshCw, Search, X } from "lucide-react";
import {
  fmtAmount, fmtNum, fmtPct, getDetail, getFflow, getHsgt, getIndices, getKline, getNews, getNewsDetail, getQuotes, getRankings, importDailyPrices, searchSymbols, toneOf,
  type FflowItem, type HsgtResp, type IntradayPoint, type KlineOpts, type MarketBar, type MarketDetail, type MarketQuote, type MoneyFlow, type NewsItem, type SearchHit,
} from "./lib/market";
import { CandlestickChart, IntradayChart, macd, pivots, sma } from "./lib/kline";

export type StockTarget = { market: "a" | "index"; symbol: string; name?: string };

// ---------- 刷新控制 ----------
function RefreshControl({ onRefresh, busy }: { onRefresh: () => void; busy: boolean }) {
  const [interval, setInterval] = useState(() => Number(localStorage.getItem("quant-market-refresh")) || 0);
  const set = (v: number) => { setInterval(v); localStorage.setItem("quant-market-refresh", String(v)); };
  return (
    <div className="market-refresh">
      <button className="secondary-btn" onClick={onRefresh} disabled={busy}>{busy ? <RefreshCw className="spin" size={13} /> : <RefreshCw size={13} />}刷新</button>
      <select className="market-refresh-select" value={interval} onChange={e => set(Number(e.target.value))} title="自动刷新">
        <option value={0}>手动</option>
        <option value={15}>自动15s</option>
        <option value={30}>自动30s</option>
        <option value={60}>自动60s</option>
      </select>
    </div>
  );
}

function useAutoRefresh(interval: number, fn: () => void) {
  useEffect(() => {
    if (!interval) return;
    const timer = setInterval(fn, interval * 1000);
    return () => clearInterval(timer);
  }, [interval, fn]);
}

// ---------- 内联错误 ----------
function InlineError({ text }: { text: string }) {
  return <div className="market-error"><span>!</span><p>{text}</p></div>;
}

// ---------- 搜索结果下拉 ----------
function SymbolSearch({ onPick, compact }: { onPick: (hit: SearchHit) => void; compact?: boolean }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number>(0);
  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults([]); setOpen(false); return; }
    setBusy(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try {
        const res = await searchSymbols(term);
        setResults(res.results || []);
        setOpen(true);
      } catch { setResults([]); } finally { setBusy(false); }
    }, 300);
    return () => window.clearTimeout(timer.current);
  }, [q]);
  return (
    <div className={`symbol-search ${compact ? "compact" : ""}`}>
      <div className="symbol-search-input"><Search size={13} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索代码或名称，如 600519 / 平安" /><span className="ss-close" onClick={() => { setQ(""); setOpen(false); }}><X size={12} /></span></div>
      {open && results.length > 0 && (
        <div className="symbol-search-drop">
          {results.map((hit, i) => (
            <button key={`${hit.symbol}-${i}`} onClick={() => { onPick(hit); setOpen(false); }}>
              <span className="ss-name">{hit.name}</span>
              <code>{hit.symbol}</code>
              <em className={`ss-type ss-${hit.type}`}>{hit.type === "index" ? "指数" : "股票"}</em>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- 大盘页 ----------
export function MarketPage({ onOpenStock }: { onOpenStock: (t: StockTarget) => void }) {
  const [indices, setIndices] = useState<MarketQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(() => Number(localStorage.getItem("quant-market-refresh")) || 0);
  const load = async () => {
    setLoading(true);
    try {
      const res = await getIndices();
      setIndices(res.indices || []);
      setStale(!!res.stale);
      setError(res.ok ? "" : (res.error || "加载失败"));
    } catch (e) { setError(e instanceof Error ? e.message : "加载失败"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  useAutoRefresh(refreshInterval, load);
  return (
    <div className="page-body v3-page">
      <div className="page-action-row">
        <p>主要指数实时行情。点击指数或搜索结果进入个股详情。{stale ? <em className="stale-tag">缓存数据</em> : null}</p>
        <div className="market-actions"><RefreshControl onRefresh={() => void load()} busy={loading} /><select className="market-refresh-select" value={refreshInterval} onChange={e => { const v = Number(e.target.value); setRefreshInterval(v); localStorage.setItem("quant-market-refresh", String(v)); }} title="自动刷新"><option value={0}>手动</option><option value={15}>自动15s</option><option value={30}>自动30s</option><option value={60}>自动60s</option></select></div>
      </div>
      {error && !indices.length ? <InlineError text={error} /> : null}
      {loading && !indices.length ? <div className="loading-state"><RefreshCw className="spin" />正在读取行情…</div> :
        <div className="market-index-grid">
          {indices.map(idx => (
            <button className="card market-index" key={idx.symbol} onClick={() => onOpenStock({ market: "index", symbol: idx.symbol, name: idx.name })}>
              <span className="mi-name">{idx.name}<small>{idx.symbol}</small></span>
              <strong className={`tone-${toneOf(idx.change_pct)}`}>{fmtNum(idx.price)}</strong>
              <em className={`tone-${toneOf(idx.change_pct)}`}>{fmtPct(idx.change_pct)}</em>
              <small className={`tone-${toneOf(idx.change_pct)}`}>{idx.change_amt !== null && idx.change_amt !== undefined ? (idx.change_amt > 0 ? "+" : "") + fmtNum(idx.change_amt) : "—"}</small>
            </button>
          ))}
        </div>}
      <div className="card market-search-card">
        <h3>搜索标的</h3>
        <SymbolSearch onPick={hit => onOpenStock({ market: hit.type === "index" ? "index" : "a", symbol: hit.symbol, name: hit.name })} />
      </div>
      <h3 className="market-section-title">实时排行</h3>
      <RankingsSection onOpenStock={onOpenStock} embedded />
    </div>
  );
}

// ---------- 排行(可嵌入) ----------
const RANK_TABS = [
  { key: "gain", label: "涨幅榜", sort: "change_pct", order: "desc" },
  { key: "loss", label: "跌幅榜", sort: "change_pct", order: "asc" },
  { key: "amount", label: "成交额榜", sort: "amount", order: "desc" },
  { key: "turnover", label: "换手率榜", sort: "turnover", order: "desc" },
] as const;

export function RankingsSection({ onOpenStock, embedded }: { onOpenStock: (t: StockTarget) => void; embedded?: boolean }) {
  const [tab, setTab] = useState<(typeof RANK_TABS)[number]["key"]>("gain");
  const [rows, setRows] = useState<MarketQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(20);
  const [interval, setInterval] = useState(() => Number(localStorage.getItem("quant-market-refresh")) || 0);
  const active = RANK_TABS.find(t => t.key === tab)!;
  const load = async () => {
    setLoading(true);
    try {
      const res = await getRankings(active.sort, active.order, limit);
      setRows(res.rankings || []);
      setError(res.ok ? "" : (res.error || "加载失败"));
    } catch (e) { setError(e instanceof Error ? e.message : "加载失败"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [tab, limit]);
  useAutoRefresh(interval, load);
  return (
    <div className={embedded ? "rankings-embedded" : ""}>
      <div className="rankings-head">
        <div className="segmented rank-tabs">{RANK_TABS.map(t => <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>{t.label}</button>)}</div>
        <div className="market-actions">
          <select className="market-refresh-select" value={limit} onChange={e => setLimit(Number(e.target.value))} title="数量">
            <option value={20}>前20</option><option value={50}>前50</option><option value={100}>前100</option>
          </select>
          <RefreshControl onRefresh={() => void load()} busy={loading} />
        </div>
      </div>
      {error && !rows.length ? <InlineError text={error} /> : null}
      {loading && !rows.length ? <div className="loading-state"><RefreshCw className="spin" />正在读取排行…</div> :
        <div className="card rank-table-wrap">
          <table className="rank-table">
            <thead><tr><th>#</th><th>代码</th><th>名称</th><th className="num">现价</th><th className="num">涨跌幅</th><th className="num">涨跌额</th><th className="num">成交额</th><th className="num">换手率</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.symbol}-${i}`} onClick={() => onOpenStock({ market: "a", symbol: r.symbol, name: r.name })}>
                  <td className="rank-no">{i + 1}</td>
                  <td><code>{r.symbol}</code></td>
                  <td className="rank-name">{r.name}</td>
                  <td className={`num tone-${toneOf(r.change_pct)}`}>{fmtNum(r.price)}</td>
                  <td className={`num tone-${toneOf(r.change_pct)}`}>{fmtPct(r.change_pct)}</td>
                  <td className={`num tone-${toneOf(r.change_amt)}`}>{r.change_amt !== null && r.change_amt !== undefined ? (r.change_amt > 0 ? "+" : "") + fmtNum(r.change_amt) : "—"}</td>
                  <td className="num">{fmtAmount(r.amount)}</td>
                  <td className="num">{r.turnover_rate !== null && r.turnover_rate !== undefined ? `${r.turnover_rate.toFixed(2)}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
    </div>
  );
}

export function RankingsPage({ onOpenStock }: { onOpenStock: (t: StockTarget) => void }) {
  return (
    <div className="page-body v3-page">
      <div className="page-action-row"><p>A 股实时排行，点击任意一行进入个股详情。</p></div>
      <RankingsSection onOpenStock={onOpenStock} />
    </div>
  );
}

// ---------- 新闻页 ----------
const NEWS_CATEGORIES: Array<{ kw: string[]; label: string; tone: string; icon: string }> = [
  { kw: ["回购", "增持", "减持", "并购", "重组", "股权", "定增"], label: "资本运作", tone: "cap", icon: "💰" },
  { kw: ["涨停", "跌停", "大涨", "大跌", "涨停潮", "异动"], label: "异动", tone: "surge", icon: "⚡" },
  { kw: ["央行", "降息", "降准", "利率", "存款准备金", "LPR", "MLF", "逆回购"], label: "货币", tone: "macro", icon: "🏦" },
  { kw: ["GDP", "CPI", "PPI", "PMI", "经济数据", "出口", "投资", "消费"], label: "宏观", tone: "macro", icon: "📈" },
  { kw: ["华为", "小米", "苹果", "英伟达", "AI", "人工智能", "芯片", "半导体", "算力"], label: "科技", tone: "tech", icon: "🤖" },
  { kw: ["新能源", "光伏", "锂电", "储能", "风电", "电动车", "电池"], label: "新能源", tone: "green", icon: "🔋" },
  { kw: ["医药", "创新药", "医疗器械", "集采", "生物", "医疗"], label: "医药", tone: "med", icon: "💊" },
  { kw: ["楼市", "房地产", "住房", "房贷", "地产", "土拍"], label: "地产", tone: "real", icon: "🏠" },
  { kw: ["原油", "黄金", "大宗商品", "期货", "铜", "锂矿", "涨价"], label: "大宗", tone: "com", icon: "🛢️" },
  { kw: ["中报", "年报", "业绩", "营收", "净利润", "预增", "预亏"], label: "业绩", tone: "fin", icon: "📄" },
];
function classifyNews(title: string, content: string): { label: string; tone: string; icon: string } {
  const text = `${title} ${content}`;
  for (const c of NEWS_CATEGORIES) if (c.kw.some(k => text.includes(k))) return c;
  return { label: "财经", tone: "fin", icon: "📰" };
}

export function NewsPage({ onOpenExternal }: { onOpenExternal?: (url: string) => void }) {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, { content: string; loading?: boolean; error?: string }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = async () => {
    setLoading(true);
    try {
      const res = await getNews(50);
      setNews(res.news || []);
      setError(res.ok ? "" : (res.error || "加载失败"));
    } catch (e) { setError(e instanceof Error ? e.message : "加载失败"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const toggle = (item: NewsItem) => {
    const id = item.id;
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    if (!item.url || detail[id]?.loading || detail[id]?.content) return;
    setDetail(prev => ({ ...prev, [id]: { loading: true, content: "" } }));
    void getNewsDetail(item.url).then(res => {
      setDetail(prev => ({ ...prev, [id]: { loading: false, content: res.content || "", error: res.error } }));
    }).catch(() => setDetail(prev => ({ ...prev, [id]: { loading: false, content: "", error: "加载详情失败" } })));
  };
  const curDetail = openId ? detail[openId] : undefined;
  return (
    <div className="page-body v3-page">
      <div className="page-action-row"><p>财经要闻，真实封面，点击卡片加载全文。</p><button className="secondary-btn" onClick={() => void load()}><RefreshCw size={13} />刷新</button></div>
      {error && !news.length ? <InlineError text={error} /> : null}
      {loading && !news.length ? <div className="loading-state"><RefreshCw className="spin" />正在读取要闻…</div> :
        <div className="news-list">
          {news.map(item => {
            const cat = classifyNews(item.title, item.content || "");
            const open = openId === item.id;
            return (
              <div className={`card news-item ${open ? "open" : ""}`} key={item.id}>
                <div className="news-cover" onClick={() => toggle(item)}>
                  <span className={`news-cover-bg ncat-${cat.tone}`}><i>{cat.icon}</i></span>
                  {item.image && <img className="news-cover-img" src={item.image} alt="" loading="eager" decoding="async" referrerPolicy="no-referrer" onError={e => { e.currentTarget.style.display = "none"; }} />}
                  <span className={`news-cat ncat-${cat.tone}`}>{cat.label}</span>
                </div>
                <div className="news-main" onClick={() => toggle(item)}>
                  <div className="news-head"><span className="news-time">{item.time}</span><Newspaper size={12} /><span className="news-src">{item.source || "东方财富"}</span></div>
                  <h3>{item.title}</h3>
                  {open && <div className="news-body">
                    {curDetail?.loading ? <span className="news-detail-loading"><RefreshCw className="spin" size={11} />正在加载全文…</span>
                      : curDetail?.content ? <p>{curDetail.content}</p>
                      : curDetail?.error ? <p className="news-detail-error">{curDetail.error}</p>
                      : <p>{item.content}</p>}
                  </div>}
                  <div className="news-foot">
                    <span className="news-chevron"><ChevronDown size={13} className={open ? "" : "collapsed"} />{open ? "收起" : "展开"}</span>
                    {item.url && <button className="news-open" onClick={e => { e.stopPropagation(); if (onOpenExternal) onOpenExternal(item.url); else window.open(item.url, "_blank"); }} title="在内置浏览器打开原文"><Link2 size={12} />查看原文</button>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>}
    </div>
  );
}

// ---------- 副图指标面板 ----------
type IndTab = "vol" | "macd" | "pivots" | "vr" | "compare" | "fflow" | "money" | "hsgt";
const IND_TABS: Array<{ key: IndTab; label: string }> = [
  { key: "vol", label: "分时量" }, { key: "macd", label: "MACD" }, { key: "pivots", label: "分时顶底" },
  { key: "vr", label: "量比" }, { key: "compare", label: "成交对比" }, { key: "fflow", label: "大单净量" },
  { key: "money", label: "大单金额" }, { key: "hsgt", label: "两市北向净买" },
];

function MiniWrap({ children, note }: { children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="ind-panel">
      {note != null && <div className="ind-note">{note}</div>}
      {children}
    </div>
  );
}

// 通用迷你柱状图(成交量 / 大单净量)
function MiniBars({ values, height = 150, colorOf, labels }: {
  values: Array<number | null>; height?: number; colorOf: (v: number | null, i: number) => string; labels?: (v: number | null, i: number) => string;
}) {
  const [wrapRef, width] = useContainerWidth2<HTMLDivElement>();
  const n = values.length;
  if (n === 0) return <div className="ind-empty">暂无数据</div>;
  const pad = 8;
  const plotW = Math.max(width - pad * 2, 0);
  const maxAbs = Math.max(1, ...values.map(v => Math.abs(v ?? 0)));
  const barW = plotW / n;
  const baseY = 6;
  return (
    <div ref={wrapRef} className="mini-bars" style={{ height }}>
      {width > 0 && <svg width={width} height={height}>
        <line x1={pad} y1={baseY + (height - baseY - 18) / 2} x2={pad + plotW} y2={baseY + (height - baseY - 18) / 2} className="k-grid" />
        {values.map((v, i) => {
          const val = v ?? 0;
          const h = (Math.abs(val) / maxAbs) * (height - baseY - 26);
          const centerY = baseY + (height - baseY - 18) / 2;
          const y = val >= 0 ? centerY - h : centerY;
          return <g key={i}>
            <rect x={pad + i * barW + barW * 0.18} y={y} width={barW * 0.64} height={Math.max(h, 0.5)} fill={colorOf(v, i)} />
            {labels ? <text x={pad + (i + 0.5) * barW} y={height - 4} className="k-axis" textAnchor="middle" fontSize={9}>{labels(v, i)}</text> : null}
          </g>;
        })}
      </svg>}
    </div>
  );
}

function useContainerWidth2<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(Math.floor(w));
    });
    obs.observe(el);
    setWidth(Math.floor(el.getBoundingClientRect().width || 0));
    return () => obs.disconnect();
  }, []);
  return [ref, width];
}

function VolChart({ volumes, closes }: { volumes: number[]; closes: number[] }) {
  const colorOf = (v: number | null, i: number) => {
    const prev = i > 0 ? closes[i - 1] : closes[0];
    return closes[i] >= prev ? "var(--red-soft)" : "var(--green-soft)";
  };
  const labels = (v: number | null, i: number) => (i % 2 === 0 ? closes[i].toFixed(2) : "");
  return <MiniBars values={volumes} colorOf={colorOf} labels={labels} />;
}

function MacdChart({ closes }: { closes: number[] }) {
  const [wrapRef, width] = useContainerWidth2<HTMLDivElement>();
  const pts = macd(closes);
  const n = pts.length;
  if (n === 0) return <div className="ind-empty">暂无数据</div>;
  let maxAbs = 1;
  for (const p of pts) if (p && Math.abs(p.hist) > maxAbs) maxAbs = Math.abs(p.hist);
  for (const p of pts) if (p && Math.abs(p.dif) > maxAbs) maxAbs = Math.abs(p.dif);
  const padL = 8, padR = 8;
  const plotW = Math.max(width - padL - padR, 0);
  const plotH = 110, top = 6;
  const mapY = (v: number) => top + (1 - (v + maxAbs) / (2 * maxAbs)) * plotH;
  const barW = plotW / n;
  const difLine = pts.map((p, i) => p ? `${padL + i * barW + barW / 2},${mapY(p.dif)}` : "").filter(Boolean).join(" ");
  const deaLine = pts.map((p, i) => p ? `${padL + i * barW + barW / 2},${mapY(p.dea)}` : "").filter(Boolean).join(" ");
  return (
    <div ref={wrapRef} className="mini-bars" style={{ height: 150 }}>
      {width > 0 && <svg width={width} height={150}>
        <line x1={padL} y1={mapY(0)} x2={padL + plotW} y2={mapY(0)} className="k-grid" />
        {pts.map((p, i) => p ? <rect key={i} x={padL + i * barW + barW * 0.3} y={p.hist >= 0 ? mapY(p.hist) : mapY(0)} width={barW * 0.4} height={Math.max(Math.abs(mapY(0) - mapY(p.hist)), 0.5)} fill={p.hist >= 0 ? "var(--red-soft)" : "var(--green-soft)"} /> : null)}
        <polyline fill="none" className="k-price" strokeWidth={1.2} points={difLine} />
        <polyline fill="none" className="k-avg" strokeWidth={1.2} points={deaLine} />
        <text x={padL} y={12} className="k-axis" fontSize={9}>DIF/DEA(12,26,9)</text>
      </svg>}
    </div>
  );
}

function PivotChart({ closes }: { closes: number[] }) {
  const [wrapRef, width] = useContainerWidth2<HTMLDivElement>();
  const n = closes.length;
  if (n === 0) return <div className="ind-empty">暂无数据</div>;
  const ps = pivots(closes, 8);
  const lo = Math.min(...closes), hi = Math.max(...closes);
  const padL = 8, padR = 8, padTop = 10, padBottom = 18;
  const plotW = Math.max(width - padL - padR, 0);
  const plotH = 112;
  const mapY = (v: number) => padTop + (1 - (v - lo) / (hi - lo || 1)) * plotH;
  const barW = plotW / n;
  const line = closes.map((v, i) => `${padL + i * barW + barW / 2},${mapY(v)}`).join(" ");
  return (
    <div ref={wrapRef} className="mini-bars" style={{ height: 150 }}>
      {width > 0 && <svg width={width} height={150}>
        {[0.25, 0.5, 0.75].map(t => <line key={t} x1={padL} y1={padTop + t * plotH} x2={padL + plotW} y2={padTop + t * plotH} className="k-grid" />)}
        <polyline fill="none" className="k-price" strokeWidth={1.3} points={line} />
        {ps.map((p, i) => (
          <g key={i}>
            <circle cx={padL + p.index * barW + barW / 2} cy={mapY(p.value)} r={3} fill={p.high ? "var(--red)" : "var(--green)"} />
            <text x={padL + p.index * barW + barW / 2} y={mapY(p.value) + (p.high ? -4 : 12)} textAnchor="middle" fontSize={10} className={p.high ? "tone-up" : "tone-down"}>{p.high ? "▲" : "▼"}</text>
          </g>
        ))}
      </svg>}
    </div>
  );
}

function VrChart({ volumes, amountOf }: { volumes: number[]; amountOf: (i: number) => number }) {
  const n = volumes.length;
  if (n < 6) return <div className="ind-empty">需至少 6 期数据计算量比</div>;
  const last = volumes[n - 1] ?? 0;
  const avg5 = sma(volumes.slice(0, -1), 5) ?? 1;
  const vr = last / avg5;
  const prev = amountOf(n - 1);
  const p5 = sma(Array.from({ length: n - 1 }, (_, i) => amountOf(i)), 5);
  return (
    <MiniWrap note={<>量比 <b className={`tone-${vr >= 1 ? "up" : "down"}`}>{vr.toFixed(2)}</b>　（今日量 ÷ 前5日均量）</>}>
      <MiniBars values={volumes.slice(-6)} height={110} colorOf={(_v, _i) => "var(--blue)"} />
      <div className="ind-meta">
        <span>前5日均量 {avg5.toFixed(0)}</span><span>今日量 {last.toFixed(0)}</span>
        <span>前5日均额 {p5 ? fmtAmount(p5) : "—"}</span><span>今日额 {fmtAmount(prev)}</span>
      </div>
    </MiniWrap>
  );
}

function CompareChart({ amountOf, n }: { amountOf: (i: number) => number; n: number }) {
  if (n < 6) return <div className="ind-empty">需至少 6 期数据</div>;
  const today = amountOf(n - 1);
  const avg5 = sma(Array.from({ length: n - 1 }, (_, i) => amountOf(i)), 5) ?? 0;
  const diff = today - avg5;
  const diffPct = avg5 ? (diff / avg5) * 100 : 0;
  return (
    <MiniWrap note={<>今日成交 <b className={`tone-${diff >= 0 ? "up" : "down"}`}>{fmtAmount(today)}</b>　较前5日均量 <b className={`tone-${diff >= 0 ? "up" : "down"}`}>{diffPct >= 0 ? "+" : ""}{diffPct.toFixed(1)}%</b></>}>
      <div className="compare-bars">
        {[0, 1, 2, 3, 4, 5].map(i => {
          const idx = n - 6 + i;
          const v = amountOf(idx);
          const max = Math.max(today, avg5, 1);
          return <div key={i} className="cb-col" title={`${v.toFixed(0)}`}>
            <div className="cb-bar" style={{ height: `${Math.max((v / max) * 70, 2)}%` }}><b>{i === 5 ? "今" : "前" + (5 - i)}</b></div>
            <small>{i === 5 ? "今日" : "-" + (5 - i) + "日"}</small>
          </div>;
        })}
      </div>
      <div className="ind-meta"><span>今日 {fmtAmount(today)}</span><span>前5日均 {fmtAmount(avg5)}</span></div>
    </MiniWrap>
  );
}

function FflowChart({ symbol, market }: { symbol: string; market: string }) {
  const [items, setItems] = useState<FflowItem[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    getFflow(symbol, market, 30).then(r => { if (live) { setItems(r.items || []); setErr(r.ok ? "" : (r.error || "")); } }).catch(e => live && setErr(e instanceof Error ? e.message : "加载失败"));
    return () => { live = false; };
  }, [symbol, market]);
  if (err) return <MiniWrap note={err}><div className="ind-empty">资金流数据暂不可用</div></MiniWrap>;
  if (!items.length) return <div className="loading-state"><RefreshCw className="spin" />正在读取资金流…</div>;
  const colorOf = (v: number | null) => (v ?? 0) >= 0 ? "var(--red-soft)" : "var(--green-soft)";
  const labels = (v: number | null, i: number) => (items[i]?.ts ?? "").slice(5).replace("-", "/");
  return <MiniWrap note={<>近 {items.length} 日主力净流入（红=净买，绿=净卖）</>}><MiniBars values={items.map(i => i.main_net)} colorOf={colorOf} labels={labels} /></MiniWrap>;
}

function MoneyChart({ flow }: { flow?: MoneyFlow }) {
  const rows: Array<{ label: string; v: number | null | undefined }> = [
    { label: "超大单", v: flow?.xl_net }, { label: "大单", v: flow?.big_net },
    { label: "中单", v: flow?.mid_net }, { label: "小单", v: flow?.small_net },
  ];
  const hasData = rows.some(r => r.v !== null && r.v !== undefined);
  if (!hasData) return <div className="ind-empty">该标的暂无资金流数据</div>;
  const maxAbs = Math.max(1, ...rows.map(r => Math.abs(r.v ?? 0)));
  return (
    <MiniWrap note={<>今日主力净流入 <b className={`tone-${(flow?.main_net ?? 0) >= 0 ? "up" : "down"}`}>{fmtAmount(flow?.main_net)}</b></>}>
      <div className="money-rows">
        {rows.map(r => {
          const v = r.v ?? 0;
          const w = (Math.abs(v) / maxAbs) * 50;
          return <div key={r.label} className="money-row">
            <span className="mr-label">{r.label}</span>
            <div className="mr-track">
              <div className={`mr-fill ${v >= 0 ? "up" : "down"}`} style={{ left: v >= 0 ? "50%" : `${50 - w}%`, width: `${w}%` }} />
            </div>
            <b className={`tone-${v >= 0 ? "up" : "down"}`}>{v >= 0 ? "+" : ""}{fmtAmount(v)}</b>
          </div>;
        })}
      </div>
    </MiniWrap>
  );
}

function HsgtChart() {
  const [res, setRes] = useState<HsgtResp | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    getHsgt().then(r => { if (live) { setRes(r); setErr(r.ok ? "" : (r.error || "")); } }).catch(e => live && setErr(e instanceof Error ? e.message : "加载失败"));
    return () => { live = false; };
  }, []);
  if (err) return <MiniWrap note={err}><div className="ind-empty">北向数据暂不可用</div></MiniWrap>;
  if (!res) return <div className="loading-state"><RefreshCw className="spin" />正在读取北向资金…</div>;
  const rows = res.rows || [];
  const maxAbs = Math.max(1, ...rows.map(r => Math.abs(r.net_buy ?? 0)));
  return (
    <MiniWrap note={res.net_unavailable ? <span className="muted">2024年8月起交易所停止披露实时北向成交，以下为日度汇总/额度余额。</span> : "沪深港通资金（北向/南向）"}>
      <div className="money-rows">
        {rows.map(r => {
          const v = r.net_buy ?? 0;
          const w = (Math.abs(v) / maxAbs) * 50;
          return <div key={r.name} className="money-row">
            <span className="mr-label">{r.name}</span>
            <div className="mr-track">
              <div className={`mr-fill ${v >= 0 ? "up" : "down"}`} style={{ left: v >= 0 ? "50%" : `${50 - w}%`, width: `${w}%` }} />
            </div>
            <b className={`tone-${v >= 0 ? "up" : "down"}`}>{r.net_buy === null ? "—" : `${v >= 0 ? "+" : ""}${fmtAmount(v)}`}</b>
          </div>;
        })}
      </div>
      {rows.length === 0 && <div className="ind-empty">无北向汇总数据</div>}
    </MiniWrap>
  );
}

function IndicatorPanel({ bars, indTab, detail, symbol, market }: {
  bars: Array<MarketBar | IntradayPoint>; indTab: IndTab; detail: MarketDetail | null; symbol: string; market: string;
}) {
  const closes = useMemo(() => bars.map(b => ("close" in b ? b.close : (b.price ?? 0))), [bars]);
  const volumes = useMemo(() => bars.map(b => b.volume ?? 0), [bars]);
  const amountOf = useMemo(() => (i: number) => {
    const b = bars[i];
    if (!b) return 0;
    if ("amount" in b && b.amount != null) return b.amount;
    const c = "close" in b ? b.close : (b.price ?? 0);
    return (b.volume ?? 0) * c;
  }, [bars]);
  switch (indTab) {
    case "vol": return <MiniWrap note="分时量（每分钟成交量）"><VolChart volumes={volumes} closes={closes} /></MiniWrap>;
    case "macd": return <MiniWrap note="MACD(12,26,9) · 红柱多头绿柱空头"><MacdChart closes={closes} /></MiniWrap>;
    case "pivots": return <MiniWrap note="分时顶底 · ▲顶 ▼底"><PivotChart closes={closes} /></MiniWrap>;
    case "vr": return <VrChart volumes={volumes} amountOf={amountOf} />;
    case "compare": return <CompareChart amountOf={amountOf} n={bars.length} />;
    case "fflow": return <FflowChart symbol={symbol} market={market} />;
    case "money": return <MoneyChart flow={detail?.money_flow} />;
    case "hsgt": return <HsgtChart />;
    default: return null;
  }
}

// ---------- 个股详情页 ----------
const PERIODS = [
  { key: "intraday", label: "分时" }, { key: "1", label: "1分" }, { key: "5", label: "5分" },
  { key: "15", label: "15分" }, { key: "30", label: "30分" }, { key: "60", label: "60分" },
  { key: "daily", label: "日K" }, { key: "weekly", label: "周K" }, { key: "monthly", label: "月K" },
] as const;

// ---------- 多视图下方资讯条 ----------
type StripMode = "news" | "gains" | "drops" | "off";

let _newsBriefCache: { t: number; items: NewsItem[] } | null = null;
async function _loadNewsBrief(): Promise<NewsItem[]> {
  if (_newsBriefCache && Date.now() - _newsBriefCache.t < 120000) return _newsBriefCache.items;
  try {
    const r = await getNews(60);
    _newsBriefCache = { t: Date.now(), items: r.news || [] };
  } catch { _newsBriefCache = _newsBriefCache || { t: 0, items: [] }; }
  return _newsBriefCache.items;
}

// 涨幅/跌幅榜：按方向各缓存一次（引擎侧 rankings 缓存 20s，这里 60s 够跑马灯用）
let _stripRankCache: { t: number; key: "desc" | "asc"; items: MarketQuote[] } | null = null;
async function _loadStripRankings(order: "desc" | "asc"): Promise<MarketQuote[]> {
  if (_stripRankCache && _stripRankCache.key === order && Date.now() - _stripRankCache.t < 60000) return _stripRankCache.items;
  try {
    const r = await getRankings("change_pct", order, 16);
    _stripRankCache = { t: Date.now(), key: order, items: r.rankings || [] };
  } catch { _stripRankCache = _stripRankCache || { t: 0, key: order, items: [] }; }
  return _stripRankCache.items;
}

// 多视图场景下，在视图区下方显示资讯/涨跌幅滚动条；可切换 快讯/涨幅/跌幅 模式
export function ViewNewsStrip({ view, onOpenExternal, onMore, onGainsMore, onOpenStock, actions }: {
  view: { page: string; title: string; stock?: { name?: string; symbol?: string } | null };
  onOpenExternal: (url: string) => void;
  onMore: () => void;
  onGainsMore?: () => void;
  onOpenStock?: (t: StockTarget) => void;
  actions?: React.ReactNode;
}) {
  const [mode, setMode] = useState<StripMode>(() => (localStorage.getItem("quant-strip-mode") as StripMode) || "news");
  const [newsItems, setNewsItems] = useState<NewsItem[]>([]);
  const [rankItems, setRankItems] = useState<MarketQuote[]>([]);
  const areaRef = useRef<HTMLDivElement>(null);
  const setRef = useRef<HTMLDivElement>(null);
  const [copies, setCopies] = useState(1);
  const [scrolling, setScrolling] = useState(false);
  useEffect(() => { localStorage.setItem("quant-strip-mode", mode); }, [mode]);
  // 新闻：定期拉取更新标题（_loadNewsBrief 内存缓存 120s，引擎侧 news 缓存 240s）
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const all = await _loadNewsBrief();
        if (alive) setNewsItems(all);
      } catch { /* 保留旧标题 */ }
    };
    void tick();
    const timer = setInterval(tick, 180000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  // 涨幅/跌幅：按当前模式拉排行（隐藏模式不拉）
  useEffect(() => {
    if (mode === "news" || mode === "off") return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await _loadStripRankings(mode === "gains" ? "desc" : "asc");
        if (alive) setRankItems(r);
      } catch { /* 保留旧数据 */ }
    };
    void tick();
    const timer = setInterval(tick, 120000);
    return () => { alive = false; clearInterval(timer); };
  }, [mode]);
  // 新闻模式：挑选与当前视图相关的标题；无匹配时按财经分类兜底（多显示一些，滚动不单调）
  const rel = useMemo(() => {
    if (!newsItems.length) return [];
    const q = (view.stock?.name || view.stock?.symbol || "").trim();
    const cats = view.page === "market" || view.page === "rankings" ? ["macro", "cap", "surge", "fin"] : ["macro", "fin", "cap"];
    const general = newsItems.filter(n => cats.includes(classifyNews(n.title, n.content || "").tone));
    // 股票相关匹配过少时(常见只有 1~2 条), 相关优先 + 分类兜底补足, 保证滚动条不单调
    const matched = q ? newsItems.filter(n => n.title.includes(q) || (n.content || "").includes(q)).slice(0, 6) : [];
    if (matched.length >= 6) return matched;
    const merged = [...matched, ...general.filter(n => !matched.includes(n))].slice(0, 14);
    return merged.length ? merged : newsItems.slice(0, 14);
  }, [newsItems, view]);
  const display = mode === "news" ? rel : rankItems;
  // 测量：一组标题宽度超过可视区才滚动，并复制足够组实现无缝循环；否则单组静态展示
  useEffect(() => {
    const measure = () => {
      const area = areaRef.current, set = setRef.current;
      if (!area || !set) return;
      const areaW = area.clientWidth;
      const setW = set.getBoundingClientRect().width;
      if (setW <= 0) return;
      if (setW <= areaW + 8) { setScrolling(false); setCopies(1); return; }
      setScrolling(true);
      setCopies(Math.max(2, Math.ceil(areaW / setW) + 1));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (areaRef.current) ro.observe(areaRef.current);
    return () => ro.disconnect();
  }, [display]);
  const label = mode === "news" ? view.title : mode === "gains" ? "涨幅榜" : mode === "drops" ? "跌幅榜" : "已隐藏";
  const cycleMode = () => setMode(m => (m === "news" ? "gains" : m === "gains" ? "drops" : m === "drops" ? "off" : "news"));
  // 隐藏模式: 栏保留但只显示标签(可点击恢复), 不滚动任何内容
  if (mode === "off") {
    return (
      <div className="view-news-strip vns-off">
        <button className="vns-label" onClick={cycleMode} title="当前已隐藏 · 点击恢复 快讯/涨幅榜/跌幅榜"><Newspaper size={12} />已隐藏<ArrowLeftRight size={10} className="vns-swap" /></button>
        {actions}
      </div>
    );
  }
  return (
    <div className="view-news-strip">
      <button className="vns-label" onClick={cycleMode} title={`当前 ${mode === "news" ? "快讯" : label} · 点击切换 快讯/涨幅榜/跌幅榜/隐藏`}><Newspaper size={12} />{label}<ArrowLeftRight size={10} className="vns-swap" /></button>
      <div className={`vns-items${scrolling ? " scrolling" : ""}`} ref={areaRef}>
        {display.length ? <div className={`vns-track${scrolling ? " scrolling" : ""}`} style={{ "--shift": `-${(100 / Math.max(2, copies)).toFixed(3)}%`, "--dur": `${Math.max(30, copies * 20)}s` } as React.CSSProperties}>
          {Array.from({ length: Math.max(1, copies) }).map((_, c) => (
            <div className="vns-set" key={c} ref={c === 0 ? setRef : undefined}>
              {mode === "news" ? rel.map(n => {
                const cat = classifyNews(n.title, n.content || "");
                return (
                  <button key={`${n.id}-${c}`} className="vns-item" title={`${n.source || "财经快讯"} · ${n.time}`} onClick={() => { if (n.url) onOpenExternal(n.url); else onMore(); }}>
                    <i className={`vns-cat ncat-${cat.tone}`}>{cat.icon}</i>
                    <span>{n.title}</span>
                    <small>{n.time.slice(5, 16)}</small>
                  </button>
                );
              }) : rankItems.map((r, i) => {
                const tone = toneOf(r.change_pct);
                return (
                  <button key={`${r.symbol}-${c}`} className="vns-item vns-quote" title={`${r.name} · ${fmtPct(r.change_pct)}`} onClick={() => onOpenStock?.({ market: "a", symbol: r.symbol, name: r.name })}>
                    <i className="vns-rank">{i + 1}</i>
                    <b className="vns-qname">{r.name}</b>
                    <em className={`num tone-${tone}`}>{fmtNum(r.price)}</em>
                    <strong className={`num tone-${tone}`}>{fmtPct(r.change_pct)}</strong>
                  </button>
                );
              })}
            </div>
          ))}
        </div> : <span className="vns-empty">正在获取…</span>}
      </div>
      <button className="vns-more" onClick={() => { if (mode !== "news" && onGainsMore) onGainsMore(); else onMore(); }}>更多<ChevronRight size={12} /></button>
      {actions}
    </div>
  );
}

export function StockPage({ target, onBack, onOpenStock }: { target: StockTarget; onBack: () => void; onOpenStock: (t: StockTarget) => void }) {
  const [quote, setQuote] = useState<MarketQuote | null>(null);
  const [detail, setDetail] = useState<MarketDetail | null>(null);
  const [bars, setBars] = useState<Array<MarketBar | IntradayPoint>>([]);
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["key"]>("daily");
  const [adjust, setAdjust] = useState<"qfq" | "">("qfq");
  const [indTab, setIndTab] = useState<IndTab>("vol");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [interval, setInterval] = useState(() => Number(localStorage.getItem("quant-market-refresh")) || 0);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const importToWorkspace = async () => {
    setImporting(true); setImportMsg("");
    try {
      const res = await importDailyPrices(target.symbol, target.market, isKline ? adjust : "qfq");
      setImportMsg(res.ok ? `已入分析库 ${res.rows} 行 (${res.start} ~ ${res.end})，Agent 分析工具可用了` : (res.error || "导入失败"));
    } catch (e) { setImportMsg(e instanceof Error ? e.message : "导入失败"); }
    finally { setImporting(false); }
  };
  const isKline = !["intraday", "1", "5", "15", "30", "60"].includes(period);
  // 切周期提速: K线按 (symbol,period,adjust) 客户端缓存(<25s 直接展示, 过期后台刷新);
  // quote/detail 按 symbol 只拉一次, 切换周期不再重复请求
  const klineCacheRef = useRef<Map<string, { bars: Array<MarketBar | IntradayPoint>; stale: boolean; t: number }>>(new Map());
  const qdKey = `${target.market}:${target.symbol}`;
  const qdDoneRef = useRef<string>("");
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const curKey = `${target.market}:${target.symbol}:${period}:${isKline ? adjust : "-"}`;

  const load = async () => {
    try {
      if (qdDoneRef.current !== qdKey) {
        setLoading(true);
        const [qRes, dRes] = await Promise.all([
          getQuotes([target.symbol], target.market),
          getDetail(target.symbol, target.market).catch(() => null),
        ]);
        qdDoneRef.current = qdKey;
        setQuote((qRes.quotes || [])[0] || null);
        setDetail(dRes && dRes.ok ? dRes : null);
        if (!qRes.ok) setError(qRes.error || "加载失败");
      }
      const opts: KlineOpts = { market: target.market, period };
      if (isKline) opts.adjust = adjust;
      const cached = klineCacheRef.current.get(curKey);
      if (cached && Date.now() - cached.t <= 25000) {
        setBars(cached.bars); setStale(cached.stale); setLoadedKey(curKey);
      } else {
        if (!cached) setLoading(true);
        const kRes = await getKline(target.symbol, opts);
        const v = { bars: kRes.bars || [], stale: !!kRes.stale, t: Date.now() };
        klineCacheRef.current.set(curKey, v);
        setBars(v.bars); setStale(v.stale); setLoadedKey(curKey);
        if (kRes.ok) setError(""); else setError(kRes.error || "加载失败");
      }
    } catch (e) { setError(e instanceof Error ? e.message : "加载失败"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [target.symbol, target.market, period, adjust]);
  useAutoRefresh(interval, load);

  const q = quote;
  const d = detail;
  const stats: Array<{ label: string; value: React.ReactNode }> = [
    { label: "今开", value: fmtNum(q?.open) }, { label: "昨收", value: fmtNum(q?.prev_close) },
    { label: "最高", value: fmtNum(q?.high) }, { label: "最低", value: fmtNum(q?.low) },
    { label: "成交量", value: fmtVolume(q?.volume) }, { label: "成交额", value: fmtAmount(q?.amount) },
    { label: "换手率", value: q?.turnover_rate != null ? `${q.turnover_rate.toFixed(2)}%` : "—" },
    { label: "市盈率", value: q?.pe != null ? q.pe.toFixed(2) : "—" },
    { label: "市净率", value: q?.pb != null ? q.pb.toFixed(2) : "—" },
  ];
  // K 线上方信息栏: 市值/流通/市盈/量比/换/额
  const infoBar: Array<{ label: string; value: React.ReactNode }> = [
    { label: "总市值", value: d?.market_cap != null ? fmtAmount(d.market_cap) : "—" },
    { label: "流通", value: d?.float_cap != null ? fmtAmount(d.float_cap) : "—" },
    { label: "市盈", value: d?.pe != null ? d.pe.toFixed(2) : (q?.pe != null ? q.pe.toFixed(2) : "—") },
    { label: "量比", value: d?.volume_ratio_raw != null ? d.volume_ratio_raw.toFixed(2) : "—" },
    { label: "换", value: q?.turnover_rate != null ? `${q.turnover_rate.toFixed(2)}%` : "—" },
    { label: "额", value: fmtAmount(d?.amount ?? q?.amount) },
  ];
  return (
    <div className="page-body v3-page">
      <div className="page-action-row">
        <button className="secondary-btn stock-back" onClick={onBack}><ArrowLeft size={13} />返回</button>
        <SymbolSearch compact onPick={hit => onOpenStock({ market: hit.type === "index" ? "index" : "a", symbol: hit.symbol, name: hit.name })} />
        <div className="market-actions">
          <select className="market-refresh-select" value={interval} onChange={e => { const v = Number(e.target.value); setInterval(v); localStorage.setItem("quant-market-refresh", String(v)); }} title="自动刷新"><option value={0}>手动</option><option value={15}>自动15s</option><option value={30}>自动30s</option><option value={60}>自动60s</option></select>
          <RefreshControl onRefresh={() => void load()} busy={loading} />
        </div>
      </div>
      {error && !q ? <InlineError text={error} /> : null}
      {q && (
        <>
          <div className="card quote-header">
            <div className="qh-main">
              <h2>{q.name}<small>{q.symbol} · {target.market === "index" ? "指数" : "A股"}</small></h2>
              <div className="qh-price"><strong className={`tone-${toneOf(q.change_pct)}`}>{fmtNum(q.price)}</strong><em className={`tone-${toneOf(q.change_pct)}`}>{fmtPct(q.change_pct)}</em><em className={`tone-${toneOf(q.change_amt)}`}>{q.change_amt !== null && q.change_amt !== undefined ? (q.change_amt > 0 ? "+" : "") + fmtNum(q.change_amt) : "—"}</em></div>
              <button className="to-workspace-btn" onClick={() => void importToWorkspace()} disabled={importing} title="把该标的日 K 固化进工作区分析库，Agent 的 Alpha扫描/回测/风险工具即可对它分析"><Database size={12}/>{importing ? "导入中…" : "加入分析库"}</button>
              {importMsg && <em className="qh-import-msg">{importMsg}</em>}
            </div>
            <div className="qh-stats">{stats.map(s => <div key={s.label}><small>{s.label}</small><strong>{s.value}</strong></div>)}</div>
          </div>
          <div className="qh-info-bar">{infoBar.map(s => <div key={s.label}><small>{s.label}</small><b>{s.value}</b></div>)}</div>
        </>
      )}
      <div className="kline-toolbar-wrap">
        <div className="segmented kline-toolbar">{PERIODS.map(p => <button key={p.key} className={period === p.key ? "active" : ""} onClick={() => setPeriod(p.key)}>{p.label}</button>)}</div>
        {isKline && <div className="segmented adjust-toolbar"><button className={adjust === "qfq" ? "active" : ""} onClick={() => setAdjust("qfq")}>前复权</button><button className={adjust === "" ? "active" : ""} onClick={() => setAdjust("")}>不复权</button></div>}
      </div>
      <div className="card kline-card">
        {loadedKey !== curKey || !bars.length ? <div className="loading-state"><RefreshCw className="spin" />正在读取K线…</div> :
          period === "intraday"
            ? <IntradayChart points={bars as IntradayPoint[]} height={300} />
            : <CandlestickChart bars={bars as MarketBar[]} height={340} />}
        {stale && <p className="kline-stale">数据来自本地缓存（行情源暂时不可达）</p>}
      </div>
      <div className="ind-tabs-wrap">
        <div className="segmented ind-tabs">{IND_TABS.map(t => <button key={t.key} className={indTab === t.key ? "active" : ""} onClick={() => setIndTab(t.key)}>{t.label}</button>)}</div>
        <div className="card ind-card">
          <IndicatorPanel bars={bars} indTab={indTab} detail={d} symbol={target.symbol} market={target.market === "index" ? "index" : "a"} />
        </div>
      </div>
    </div>
  );
}

function fmtVolume(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const a = Math.abs(v);
  if (a >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (a >= 1e4) return `${(v / 1e4).toFixed(2)}万`;
  return v.toFixed(0);
}

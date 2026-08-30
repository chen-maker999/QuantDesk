// 个股详情 —— 桌面端 market.tsx StockPage 的移动端迁移：
// 实时报价卡 + 周期 K 线（客户端缓存 25s）+ 指标面板（分时量/MACD/大单净量/大单金额）+
// 加入分析库（把日 K 固化进工作区，供 Agent 分析）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Database, RefreshCw, Star } from "lucide-react";
import {
  fmtAmount, fmtNum, fmtPct, fmtVolume, getDetail, getFflow, getKline, getQuotes, importDailyPrices, toneOf,
  type FflowItem, type IntradayPoint, type KlineOpts, type MarketBar, type MarketDetail, type MoneyFlow,
} from "../lib/market";
import { isWatched, toggleWatch } from "../lib/watchlist";
import { CandlestickChart, IntradayChart, macd } from "../lib/kline";
import type { StockTarget } from "../App";
import PullToRefresh from "../components/PullToRefresh";

const PERIODS = [
  { key: "intraday", label: "分时" }, { key: "1", label: "1分" }, { key: "5", label: "5分" },
  { key: "15", label: "15分" }, { key: "30", label: "30分" }, { key: "60", label: "60分" },
  { key: "daily", label: "日K" }, { key: "weekly", label: "周K" }, { key: "monthly", label: "月K" },
] as const;
const IND_TABS = [
  { key: "vol", label: "分时量" }, { key: "macd", label: "MACD" },
  { key: "fflow", label: "大单净量" }, { key: "money", label: "大单金额" },
] as const;

type Bar = MarketBar | IntradayPoint;

export default function StockPage({ target, onBack }: { target: StockTarget; onBack: () => void }) {
  const [quoteObj, setQuoteObj] = useState<Awaited<ReturnType<typeof getQuotes>>["quotes"][number] | null>(null);
  const [detail, setDetail] = useState<MarketDetail | null>(null);
  const [bars, setBars] = useState<Bar[]>([]);
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["key"]>("daily");
  const [adjust, setAdjust] = useState<"qfq" | "">("qfq");
  const [indTab, setIndTab] = useState<(typeof IND_TABS)[number]["key"]>("vol");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const [starTick, setStarTick] = useState(0); // 仅用于 ★ 切换后触发重渲染

  const isKline = !["intraday", "1", "5", "15", "30", "60"].includes(period);
  // 桌面端同款 K 线缓存：(symbol,period,adjust) 25s 内直接展示，过期后台刷新
  const klineCacheRef = useRef<Map<string, { bars: Bar[]; stale: boolean; t: number }>>(new Map());
  const qdDoneRef = useRef("");
  const curKey = `${target.market}:${target.symbol}:${period}:${isKline ? adjust : "-"}`;

  const load = useCallback(async () => {
    try {
      const qKey = `${target.market}:${target.symbol}`;
      if (qdDoneRef.current !== qKey) {
        const [qRes, dRes] = await Promise.all([
          getQuotes([target.symbol], target.market),
          getDetail(target.symbol, target.market).catch(() => null),
        ]);
        qdDoneRef.current = qKey;
        setQuoteObj((qRes.quotes || [])[0] || null);
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
        const value = { bars: kRes.bars || [], stale: !!kRes.stale, t: Date.now() };
        klineCacheRef.current.set(curKey, value);
        setBars(value.bars); setStale(value.stale); setLoadedKey(curKey);
        if (kRes.ok) setError(""); else setError(kRes.error || "加载失败");
      }
    } catch (e) { setError(e instanceof Error ? e.message : "加载失败"); }
    finally { setLoading(false); }
  }, [target.market, target.symbol, period, adjust, isKline, curKey]);
  useEffect(() => { void load(); }, [load]);

  // 报价 15s 自动刷新（K 线走缓存逻辑，不在此列）
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void getQuotes([target.symbol], target.market)
        .then(r => { const q = (r.quotes || [])[0]; if (q) { setQuoteObj(q); setError(""); } })
        .catch(() => { /* 静默，下一轮重试 */ });
    }, 15000);
    return () => window.clearInterval(timer);
  }, [target.symbol, target.market]);

  const importToWorkspace = async () => {
    setImporting(true); setImportMsg("");
    try {
      const res = await importDailyPrices(target.symbol, target.market, isKline ? adjust : "qfq");
      setImportMsg(res.ok ? `已入分析库 ${res.rows} 行 (${res.start} ~ ${res.end})，Agent 可以分析了` : (res.error || "导入失败"));
    } catch (e) { setImportMsg(e instanceof Error ? e.message : "导入失败"); }
    finally { setImporting(false); }
  };

  const q = quoteObj;
  const d = detail;
  const stats = [
    { label: "今开", value: fmtNum(q?.open) }, { label: "昨收", value: fmtNum(q?.prev_close) },
    { label: "最高", value: fmtNum(q?.high) }, { label: "最低", value: fmtNum(q?.low) },
    { label: "成交量", value: fmtVolume(q?.volume) }, { label: "成交额", value: fmtAmount(q?.amount) },
    { label: "换手率", value: q?.turnover_rate != null ? `${q.turnover_rate.toFixed(2)}%` : "—" },
    { label: "市盈率", value: q?.pe != null ? q.pe.toFixed(2) : "—" },
    { label: "市净率", value: q?.pb != null ? q.pb.toFixed(2) : "—" },
  ];

  const watched = starTick >= 0 && isWatched(target.market, target.symbol);
  const toggleStar = () => {
    toggleWatch({ market: target.market, symbol: target.symbol, name: q?.name || target.name || target.symbol });
    setStarTick(t => t + 1);
  };

  return <PullToRefresh onRefresh={load}><div className="page">
    <header className="page-head with-back">
      <button className="back-btn" onClick={onBack}><ArrowLeft size={18} /></button>
      <div className="ph-title">
        <h1>{q?.name || target.name || target.symbol}</h1>
        <p>{target.symbol} · {target.market === "index" ? "指数" : "A股"}</p>
      </div>
      {target.market === "a" && <button className={`icon-btn star-btn${watched ? " on" : ""}`}
        onClick={toggleStar} aria-label={watched ? "移出自选" : "加入自选"}>
        <Star size={19} fill={watched ? "currentColor" : "none"} />
      </button>}
    </header>

    {error && !q ? <div className="inline-error tap-error" onClick={() => void load()}>
      <RefreshCw size={13} /><span>{error} · 点击重试</span>
    </div> : null}
    {q && <>
      <div className="card quote-card">
        <div className="quote-main">
          <strong className={`tone-${toneOf(q.change_pct)}`}>{fmtNum(q.price)}</strong>
          <div className="quote-change">
            <em className={`tone-${toneOf(q.change_pct)}`}>{fmtPct(q.change_pct)}</em>
            <em className={`tone-${toneOf(q.change_amt)}`}>{q.change_amt !== null && q.change_amt !== undefined ? (q.change_amt > 0 ? "+" : "") + fmtNum(q.change_amt) : "—"}</em>
          </div>
          <button className="ghost-btn" onClick={() => void importToWorkspace()} disabled={importing}>
            <Database size={13} />{importing ? "导入中…" : "加入分析库"}
          </button>
        </div>
        {importMsg && <p className="import-msg">{importMsg}</p>}
        <div className="quote-stats">
          {stats.map(s => <div key={s.label}><small>{s.label}</small><b>{s.value}</b></div>)}
        </div>
      </div>
      <div className="info-bar">
        <span><small>总市值</small><b>{d?.market_cap != null ? fmtAmount(d.market_cap) : "—"}</b></span>
        <span><small>流通</small><b>{d?.float_cap != null ? fmtAmount(d.float_cap) : "—"}</b></span>
        <span><small>市盈</small><b>{d?.pe != null ? d.pe.toFixed(2) : (q?.pe != null ? q.pe.toFixed(2) : "—")}</b></span>
        <span><small>量比</small><b>{d?.volume_ratio_raw != null ? d.volume_ratio_raw.toFixed(2) : "—"}</b></span>
      </div>
    </>}

    <div className="segmented scroll-x">
      {PERIODS.map(p => <button key={p.key} className={period === p.key ? "active" : ""} onClick={() => setPeriod(p.key)}>{p.label}</button>)}
    </div>
    {isKline && <div className="segmented narrow">
      <button className={adjust === "qfq" ? "active" : ""} onClick={() => setAdjust("qfq")}>前复权</button>
      <button className={adjust === "" ? "active" : ""} onClick={() => setAdjust("")}>不复权</button>
    </div>}

    <div className="card kline-card">
      {loadedKey !== curKey || !bars.length
        ? <div className="loading-row tall"><RefreshCw className="spin" size={16} />正在读取K线…</div>
        : period === "intraday"
          ? <IntradayChart points={bars as IntradayPoint[]} height={280} />
          : <CandlestickChart bars={bars as MarketBar[]} height={320} />}
      {stale && <p className="kline-stale">数据来自本地缓存（行情源暂时不可达）</p>}
    </div>

    <div className="segmented grow">
      {IND_TABS.map(t => <button key={t.key} className={indTab === t.key ? "active" : ""} onClick={() => setIndTab(t.key)}>{t.label}</button>)}
    </div>
    <div className="card ind-card">
      <IndicatorPanel bars={bars} indTab={indTab} detail={d} symbol={target.symbol} market={target.market} />
    </div>
  </div></PullToRefresh>;
}

// ---------- 指标面板（桌面端 IndicatorPanel 的移动端子集） ----------

function IndicatorPanel({ bars, indTab, detail, symbol, market }: {
  bars: Bar[]; indTab: (typeof IND_TABS)[number]["key"]; detail: MarketDetail | null; symbol: string; market: string;
}) {
  const closes = useMemo(() => bars.map(b => ("close" in b ? b.close : (b.price ?? 0))), [bars]);
  const volumes = useMemo(() => bars.map(b => b.volume ?? 0), [bars]);
  if (indTab === "fflow") return <FflowChart symbol={symbol} market={market} />;
  if (indTab === "money") return <MoneyChart flow={detail?.money_flow} />;
  if (indTab === "vol") return <MiniWrap note="成交量（红涨绿跌）"><VolChart volumes={volumes} closes={closes} /></MiniWrap>;
  return <MiniWrap note="MACD(12,26,9) · 红柱多头绿柱空头"><MacdChart closes={closes} /></MiniWrap>;
}

function MiniWrap({ children, note }: { children: React.ReactNode; note?: React.ReactNode }) {
  return <div className="ind-panel">{note != null && <div className="ind-note">{note}</div>}{children}</div>;
}

function useContainerWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
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

function MiniBars({ values, height = 150, colorOf, labels }: {
  values: Array<number | null>; height?: number; colorOf: (v: number | null, i: number) => string; labels?: (v: number | null, i: number) => string;
}) {
  const [wrapRef, width] = useContainerWidth<HTMLDivElement>();
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

function VolChart({ volumes, closes }: { volumes: number[]; closes: number[] }) {
  const colorOf = (v: number | null, i: number) => {
    const prev = i > 0 ? closes[i - 1] : closes[0];
    return closes[i] >= prev ? "var(--red-soft)" : "var(--green-soft)";
  };
  const labels = (v: number | null, i: number) => (i % 2 === 0 ? closes[i].toFixed(2) : "");
  return <MiniBars values={volumes} colorOf={colorOf} labels={labels} />;
}

function MacdChart({ closes }: { closes: number[] }) {
  const [wrapRef, width] = useContainerWidth<HTMLDivElement>();
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

function FflowChart({ symbol, market }: { symbol: string; market: string }) {
  const [items, setItems] = useState<FflowItem[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    getFflow(symbol, market, 30).then(r => { if (live) { setItems(r.items || []); setErr(r.ok ? "" : (r.error || "")); } }).catch(e => live && setErr(e instanceof Error ? e.message : "加载失败"));
    return () => { live = false; };
  }, [symbol, market]);
  if (err) return <MiniWrap note={err}><div className="ind-empty">资金流数据暂不可用</div></MiniWrap>;
  if (!items.length) return <div className="loading-row"><RefreshCw className="spin" size={14} />正在读取资金流…</div>;
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

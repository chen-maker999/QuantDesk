// 自绘 SVG K 线图: 蜡烛图(含 MA5/10/20 + 成交量副图 + 十字光标)与分时图(价格线 + 均价线)。
// 不引第三方图表库, 直接用 CSS 变量适配明暗主题。A 股红涨绿跌: 阳线 var(--red), 阴线 var(--green)。
// 十字光标对齐: 每次移动用 getBoundingClientRect 的实时宽度计算 barW, 避免 ResizeObserver 宽度滞后导致错位。
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { fmtAmount, fmtNum, fmtPct, fmtVolume, toneOf, type IntradayPoint, type MarketBar } from "./market";

export function useContainerWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 拖拽分隔条/浏览器宽度期间（document.documentElement.dataset.dragging==="1"）跳过 setState 重渲，
    // 松开后（quant-drag-end）再测量一次同步最终宽度，避免每帧 RO→重渲 SVG 造成拖拽卡顿
    const obs = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0 && document.documentElement.dataset.dragging !== "1") setWidth(Math.floor(w));
    });
    const sync = () => {
      const w = ref.current?.getBoundingClientRect().width ?? 0;
      if (w > 0) setWidth(Math.floor(w));
    };
    obs.observe(el);
    sync();
    window.addEventListener("quant-drag-end", sync);
    return () => {
      obs.disconnect();
      window.removeEventListener("quant-drag-end", sync);
    };
  }, []);
  return [ref, width];
}

export function ma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// 简单移动均线值(用于量比/成交对比的 5 日参考)
export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ---------- MACD(12/26/9) ----------
export type MacdPoint = { dif: number; dea: number; hist: number } | null;
export function macd(closes: number[], fast = 12, slow = 26, signal = 9): MacdPoint[] {
  const ema = (arr: number[], span: number): number[] => {
    const k = 2 / (span + 1);
    const out: number[] = [];
    let prev: number | null = null;
    for (const v of arr) {
      prev = prev === null ? v : v * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  };
  const efast = ema(closes, fast);
  const eslow = ema(closes, slow);
  const dif = closes.map((_, i) => efast[i] - eslow[i]);
  const dea = ema(dif, signal);
  return dif.map((d, i) => ({ dif: d, dea: dea[i], hist: (d - dea[i]) * 2 }));
}

// 分时顶底: 局部极大/极小(摆动点), window 为两侧各看多少个点
export function pivots(values: number[], window = 8): Array<{ index: number; value: number; high: boolean }> {
  const out: Array<{ index: number; value: number; high: boolean }> = [];
  for (let i = window; i < values.length - window; i++) {
    const v = values[i];
    let isHigh = true, isLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (values[j] >= v) isHigh = false;
      if (values[j] <= v) isLow = false;
    }
    if (isHigh && isLow) continue; // 平顶
    if (isHigh) out.push({ index: i, value: v, high: true });
    else if (isLow) out.push({ index: i, value: v, high: false });
  }
  return out;
}

type Cross = { index: number; x: number; y: number } | null;
// 十字中心对齐光标顶部：偏移一个系统箭头指针的高度，避免手部遮挡读数
const CURSOR_OFFSET = 18;

// 十字光标定位: 用实时 svg 宽度计算 barW, 保证竖线与鼠标在同一 bar 下
function hitIndex(e: React.MouseEvent<SVGSVGElement>, n: number, padL: number, padR: number): { x: number; y: number; index: number; barW: number } {
  const rect = e.currentTarget.getBoundingClientRect();
  const liveW = e.currentTarget.clientWidth || rect.width;
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const barW = n > 0 ? (liveW - padL - padR) / n : 1;
  const index = n ? clamp(Math.floor((x - padL) / barW), 0, n - 1) : -1;
  return { x, y, index, barW };
}

// ---------- 蜡烛图 ----------
export function CandlestickChart({ bars, height = 320, maPeriods = [5, 10, 20] }: { bars: MarketBar[]; height?: number; maPeriods?: number[] }) {
  const [wrapRef, width] = useContainerWidth<HTMLDivElement>();
  const [cross, setCross] = useState<Cross>(null);
  const padL = 8, padR = 8, padTop = 14, padBottom = 18;
  const plotW = Math.max(width - padL - padR, 0);
  const priceH = Math.max((height - padTop - padBottom) * 0.72, 0);
  const volH = Math.max((height - padTop - padBottom) * 0.28, 0);
  const n = bars.length;

  const { yMin, yMax, volMax, closes } = useMemo(() => {
    let lo = Infinity, hi = -Infinity, vMax = 0;
    const closes: number[] = [];
    for (const b of bars) {
      if (b.low < lo) lo = b.low;
      if (b.high > hi) hi = b.high;
      if (b.volume && b.volume > vMax) vMax = b.volume;
      closes.push(b.close);
    }
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    const pad = (hi - lo) * 0.05 || 1;
    return { yMin: lo - pad, yMax: hi + pad, volMax: vMax || 1, closes };
  }, [bars]);

  const mapY = (v: number) => padTop + (1 - (v - yMin) / (yMax - yMin)) * priceH;
  const barW = n > 0 ? plotW / n : 1;
  const candleW = clamp(barW * 0.62, 1, 9);
  const maLines = maPeriods.map(p => ({ period: p, values: ma(closes, p) }));
  const maColors = ["var(--purple)", "var(--orange)", "var(--blue)"];

  if (n === 0) return <div className="kline-empty">暂无K线数据</div>;

  const xTicks = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor(3 * n / 4), n - 1].filter((v, i, a) => a.indexOf(v) === i);
  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => setCross(hitIndex(e, n, padL, padR));

  const bar = cross ? bars[cross.index] : null;
  const tipW = 156;
  // tooltip 翻转: 光标在右半区时放到十字左侧
  const tipLeft = cross ? (cross.x > width / 2 ? cross.x - tipW - 12 : cross.x + 14) : 0;
  // 十字竖线跟随鼠标 X(钳制在绘图区); 横线上移 CURSOR_OFFSET 使十字中心对齐光标顶部
  const vx = cross ? clamp(cross.x, padL, padL + plotW) : 0;
  const crossY = cross ? clamp(cross.y - CURSOR_OFFSET, padTop, padTop + priceH + volH) : 0;
  return (
    <div ref={wrapRef} className="kline-wrap" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} onMouseMove={handleMove} onMouseLeave={() => setCross(null)}>
          {yTicks.map(t => { const y = padTop + t * priceH; return <g key={t}><line x1={padL} y1={y} x2={padL + plotW} y2={y} className="k-grid"/><text x={padL} y={y - 3} className="k-axis">{fmtNum(yMin + (yMax - yMin) * (1 - t))}</text></g>; })}
          {xTicks.map(i => <text key={i} x={padL + (i + 0.5) * barW} y={height - 4} className="k-axis k-axis-x" textAnchor="middle">{bars[i].ts.slice(5)}</text>)}
          {bars.map((b, i) => {
            const h = b.volume ? (b.volume / volMax) * volH : 0;
            const y = padTop + priceH + (volH - h);
            const tone = toneOf(b.change_pct);
            const color = tone === "up" ? "var(--candle-up-soft)" : tone === "down" ? "var(--candle-down-soft)" : "var(--muted-soft)";
            return <rect key={i} x={padL + i * barW + (barW - candleW) / 2} y={y} width={candleW} height={Math.max(h, 0.5)} fill={color} />;
          })}
          {bars.map((b, i) => {
            const x = padL + i * barW + barW / 2;
            const up = b.close >= b.open;
            const color = up ? "var(--candle-up)" : "var(--candle-down)";
            const top = Math.max(b.open, b.close), bot = Math.min(b.open, b.close);
            return <g key={i}>
              <line x1={x} y1={mapY(b.high)} x2={x} y2={mapY(b.low)} stroke={color} strokeWidth={1} />
              <rect x={x - candleW / 2} y={mapY(top)} width={candleW} height={Math.max(mapY(bot) - mapY(top), 0.6)} fill={color} />
            </g>;
          })}
          {maLines.map(({ period, values }, mi) => (
            <polyline key={period} fill="none" stroke={maColors[mi % maColors.length]} strokeWidth={1.2} strokeDasharray={period === 20 ? "3 2" : undefined} points={values.map((v, i) => v === null ? "" : `${padL + i * barW + barW / 2},${mapY(v)}`).filter(Boolean).join(" ")} />
          ))}
          {cross && cross.index >= 0 && (
            <g>
              <line x1={vx} y1={padTop} x2={vx} y2={padTop + priceH + volH} className="k-cross" />
              <line x1={padL} y1={crossY} x2={padL + plotW} y2={crossY} className="k-cross" />
              <text x={vx + 4} y={padTop + 10} className="k-axis">{fmtNum(bar!.close)}</text>
            </g>
          )}
        </svg>
      )}
      {cross && bar && (
        <div className="chart-tooltip k-tooltip" style={{ left: clamp(tipLeft, 4, width - tipW), top: clamp(crossY - 54, 4, height - 96) }}>
          <div className="k-tip-title">{bar.ts} <em className={`tone-${toneOf(bar.change_pct)}`}>{fmtPct(bar.change_pct)}</em></div>
          <div className="k-tip-row"><span>开</span><b>{fmtNum(bar.open)}</b><span className="sp">高</span><b>{fmtNum(bar.high)}</b></div>
          <div className="k-tip-row"><span>低</span><b>{fmtNum(bar.low)}</b><span className="sp">收</span><b>{fmtNum(bar.close)}</b></div>
          <div className="k-tip-row"><span>量</span><b>{fmtAmount(bar.volume)}</b></div>
        </div>
      )}
    </div>
  );
}

// ---------- 分时图 ----------
export function IntradayChart({ points, height = 320 }: { points: IntradayPoint[]; height?: number }) {
  const [wrapRef, width] = useContainerWidth<HTMLDivElement>();
  const [cross, setCross] = useState<Cross>(null);
  const padL = 8, padR = 8, padTop = 14, padBottom = 18;
  const plotW = Math.max(width - padL - padR, 0);
  const priceH = Math.max((height - padTop - padBottom) * 0.75, 0);
  const volH = Math.max((height - padTop - padBottom) * 0.25, 0);
  const n = points.length;

  const { yMin, yMax, prevClose, volMax } = useMemo(() => {
    let lo = Infinity, hi = -Infinity, vMax = 0;
    for (const p of points) {
      if (p.price !== null && p.price < lo) lo = p.price;
      if (p.price !== null && p.price > hi) hi = p.price;
      if (p.avg_price !== null && p.avg_price < lo) lo = p.avg_price;
      if (p.avg_price !== null && p.avg_price > hi) hi = p.avg_price;
      if (p.volume && p.volume > vMax) vMax = p.volume;
    }
    const prev = points[0] ? (points[0].avg_price ?? points[0].price) : null;
    if (!isFinite(lo) || !isFinite(hi)) { lo = prev ?? 0; hi = (prev ?? 0) + 1; }
    const pad = (hi - lo) * 0.05 || 0.01;
    return { yMin: lo - pad, yMax: hi + pad, prevClose: prev, volMax: vMax || 1 };
  }, [points]);

  const mapY = (v: number) => padTop + (1 - (v - yMin) / (yMax - yMin)) * priceH;
  const xOf = (i: number) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const liveW = e.currentTarget.clientWidth || rect.width;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const index = n ? clamp(Math.round(((x - padL) / (liveW - padL - padR)) * (n - 1)), 0, n - 1) : -1;
    setCross({ index, x, y });
  };

  if (n === 0) return <div className="kline-empty">暂无分时数据</div>;
  const line = points.map((p, i) => p.price === null ? "" : `${xOf(i)},${mapY(p.price)}`).filter(Boolean).join(" ");
  const avgLine = points.map((p, i) => p.avg_price === null ? "" : `${xOf(i)},${mapY(p.avg_price)}`).filter(Boolean).join(" ");
  const area = `M${xOf(0)},${mapY(prevClose ?? (points[0].price ?? 0))} ${points.map((p, i) => `${p.price === null ? "" : `L${xOf(i)},${mapY(p.price)}`}`).filter(Boolean).join(" ")} L${xOf(n - 1)},${padTop + priceH} L${xOf(0)},${padTop + priceH} Z`;
  const timeTicks = [0, Math.floor(n / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
  const barW = n > 1 ? plotW / (n - 1) : 1;
  const vx = cross ? clamp(cross.x, padL, padL + plotW) : 0;
  const crossY = cross ? clamp(cross.y - CURSOR_OFFSET, padTop, padTop + priceH + volH) : 0;

  const p = cross ? points[cross.index] : null;
  const tipW = 150;
  const tipLeft = cross ? (cross.x > width / 2 ? cross.x - tipW - 12 : cross.x + 14) : 0;
  return (
    <div ref={wrapRef} className="kline-wrap" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} onMouseMove={handleMove} onMouseLeave={() => setCross(null)}>
          {prevClose !== null && <line x1={padL} y1={mapY(prevClose)} x2={padL + plotW} y2={mapY(prevClose)} className="k-prevline" strokeDasharray="4 3" />}
          {[0.25, 0.5, 0.75].map(t => <line key={t} x1={padL} y1={padTop + t * priceH} x2={padL + plotW} y2={padTop + t * priceH} className="k-grid" />)}
          {timeTicks.map(i => <text key={i} x={xOf(i)} y={height - 4} className="k-axis k-axis-x" textAnchor="middle">{points[i].ts.slice(11)}</text>)}
          {/* 分时量(副图) */}
          {points.map((pt, i) => {
            if (pt.volume == null) return null;
            const h = (pt.volume / volMax) * volH;
            const y = padTop + priceH + (volH - h);
            const base = points[0]?.price ?? 0;
            const color = pt.price != null && pt.price >= base ? "var(--candle-up-soft)" : "var(--candle-down-soft)";
            return <rect key={i} x={xOf(i) - barW / 4} y={y} width={Math.max(barW / 2, 1)} height={Math.max(h, 0.5)} fill={color} />;
          })}
          <path d={area} fill="url(#kgrad)" className="k-area" />
          <polyline fill="none" className="k-price" strokeWidth={1.4} points={line} />
          <polyline fill="none" className="k-avg" strokeWidth={1.2} points={avgLine} />
          <defs><linearGradient id="kgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" className="k-grad-top" /><stop offset="100%" className="k-grad-bot" /></linearGradient></defs>
          {cross && cross.index >= 0 && (
            <g>
              <line x1={vx} y1={padTop} x2={vx} y2={padTop + priceH + volH} className="k-cross" />
              <line x1={padL} y1={crossY} x2={padL + plotW} y2={crossY} className="k-cross" />
              {p?.price !== null && p?.price !== undefined && <circle cx={vx} cy={mapY(p.price)} r={2.5} className="k-price" fill="currentColor" />}
            </g>
          )}
        </svg>
      )}
      {cross && p && (
        <div className="chart-tooltip k-tooltip" style={{ left: clamp(tipLeft, 4, width - tipW), top: clamp(crossY - 46, 4, height - 80) }}>
          <div className="k-tip-title">{p.ts.slice(11)}</div>
          <div className="k-tip-row"><span>价</span><b>{fmtNum(p.price)}</b><span className="sp">均</span><b>{fmtNum(p.avg_price)}</b></div>
          <div className="k-tip-row"><span>量</span><b>{fmtVolume(p.volume)}</b></div>
        </div>
      )}
    </div>
  );
}

// 研究页 —— 桌面端 BacktestPage + research.tsx 的移动端迁移：
// 点时信号回测 / 因子研究 / 组合再平衡回测 / 价格与风险预警 四个分段。
// 引擎侧核算逻辑与桌面端完全一致（滞后一周期、扣除成本、真实数据约束）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, FlaskConical, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  deleteAlert, evaluateFactor, listAlerts, runBacktest, runPortfolioBacktest, saveAlert,
  type FactorResult, type PortfolioBacktestResult, type PriceAlert,
} from "../lib/backend";
import { useApp } from "../App";
import PullToRefresh from "../components/PullToRefresh";

const pct = (v: number | undefined) => v === undefined ? "—" : `${(v * 100).toFixed(2)}%`;
const signedPct = (v: number | undefined) => v === undefined ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

type Seg = "signal" | "factor" | "portfolio" | "alerts";
const SEGS: Array<{ key: Seg; label: string }> = [
  { key: "signal", label: "点时回测" }, { key: "factor", label: "因子研究" },
  { key: "portfolio", label: "组合回测" }, { key: "alerts", label: "预警" },
];

export default function ResearchPage() {
  const [seg, setSeg] = useState<Seg>("portfolio");
  const { status } = useApp();
  return <PullToRefresh onRefresh={() => new Promise(r => window.setTimeout(r, 300))}><div className="page">
    <header className="page-head">
      <h1>研究 · 回测</h1>
      <p>只用真实数据 · 不补数不插值</p>
    </header>
    <div className="segmented grow scroll-x sticky-tabs">
      {SEGS.map(s => <button key={s.key} className={seg === s.key ? "active" : ""} onClick={() => setSeg(s.key)}>{s.label}</button>)}
    </div>
    {status.market_rows === 0 && seg !== "alerts" && <div className="inline-error"><AlertTriangle size={13} /><span>工作区还没有市场数据 —— 可在个股页「加入分析库」或桌面端导入后使用</span></div>}
    {seg === "signal" && <SignalBacktest />}
    {seg === "factor" && <FactorCard />}
    {seg === "portfolio" && <PortfolioCard />}
    {seg === "alerts" && <AlertsCard />}
  </div></PullToRefresh>;
}

// ---------- 点时信号回测（CSV：return,signal） ----------

function SignalBacktest() {
  const { notify } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Array<{ ret: number; signal: number }>>([]);
  const [cost, setCost] = useState(12);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  const importFile = async (file: File) => {
    try {
      const text = await file.text();
      const lines = text.trim().split(/\r?\n/);
      const headers = lines.shift()?.split(",").map(x => x.trim().toLowerCase()) || [];
      const ri = headers.indexOf("return"), si = headers.indexOf("signal");
      if (ri < 0 || si < 0) throw new Error("CSV 必须包含 return、signal 列");
      const parsed = lines.map(line => { const c = line.split(","); return { ret: Number(c[ri]), signal: Number(c[si]) }; })
        .filter(x => Number.isFinite(x.ret) && Number.isFinite(x.signal));
      if (parsed.length < 20) throw new Error("至少需要 20 行有效记录");
      setRows(parsed); setResult(null);
      notify(`已读取 ${parsed.length} 行回测输入`);
    } catch (e) { notify(e instanceof Error ? e.message : "读取失败", "error"); }
  };
  const run = async () => {
    setBusy(true);
    try {
      setResult(await runBacktest(rows.map(x => x.ret), rows.map(x => x.signal), cost));
      notify("回测已完成");
    } catch (e) { notify(e instanceof Error ? e.message : "回测失败", "error"); }
    finally { setBusy(false); }
  };

  const items: Array<[string, string]> = [["年化收益", "annual_return"], ["年化波动", "annual_volatility"], ["夏普比率", "sharpe"], ["最大回撤", "max_drawdown"], ["胜率", "win_rate"], ["年化换手", "turnover"]];
  return <div className="card form-card">
    <input ref={input} hidden type="file" accept=".csv,text/csv" onChange={e => { const f = e.target.files?.[0]; if (f) void importFile(f); }} />
    <p className="form-hint">导入你自己的真实收益与信号序列 CSV（列：return, signal）。引擎自动滞后一周期并扣除换手成本。</p>
    <button className="secondary-btn" onClick={() => input.current?.click()}><FlaskConical size={13} />{rows.length ? `更换 CSV（已加载 ${rows.length} 行）` : "导入 CSV"}</button>
    <label className="field">成本（bps）
      <input className="num-input" type="number" min={0} max={100} value={cost} onChange={e => setCost(Number(e.target.value))} inputMode="numeric" />
    </label>
    <button className="primary-btn" disabled={rows.length < 20 || busy} onClick={() => void run()}>
      {busy ? <RefreshCw className="spin" size={14} /> : <FlaskConical size={14} />}运行回测
    </button>
    {result && <div className="metric-grid">
      {items.map(([label, key]) => {
        const v = typeof result[key] === "number" ? Number(result[key]) : undefined;
        const tone = key === "annual_return" ? ((v ?? 0) > 0 ? "tone-up" : (v ?? 0) < 0 ? "tone-down" : "") : key === "max_drawdown" ? "tone-down" : "";
        return <div key={key} className="metric"><small>{label}</small><strong className={tone}>{v !== undefined ? (v * (key === "sharpe" ? 1 : 100)).toFixed(2) + (key === "sharpe" ? "" : "%") : "—"}</strong></div>;
      })}
    </div>}
  </div>;
}

// ---------- 因子研究 ----------

const DEFAULT_FACTOR = `def factor(df):
    close = df["close"]
    mom = close.pct_change(20)
    vol = close.pct_change().rolling(20).std()
    return mom / vol`;

function FactorCard() {
  const { status } = useApp();
  const [code, setCode] = useState(DEFAULT_FACTOR);
  const [horizon, setHorizon] = useState(1);
  const [quantiles, setQuantiles] = useState(5);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FactorResult | null>(null);
  const [error, setError] = useState("");

  const run = async () => {
    setBusy(true); setError(""); setResult(null);
    try { setResult(await evaluateFactor({ code, horizon, quantiles })); }
    catch (e) { setError(e instanceof Error ? e.message : "评估失败"); }
    finally { setBusy(false); }
  };

  return <div className="card form-card">
    <p className="form-hint">受限因子表达式在真实日线上计算 RankIC、ICIR、分层回测与衰减。OHLCV/成交额只在完整导入时可用。</p>
    <textarea className="code-area" value={code} onChange={e => setCode(e.target.value)} spellCheck={false} rows={7} autoCapitalize="off" autoCorrect="off" />
    <div className="field-duo">
      <label className="field">预测期(日)
        <input className="num-input" type="number" min={1} max={10} value={horizon} onChange={e => setHorizon(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} inputMode="numeric" />
      </label>
      <label className="field">分层数
        <input className="num-input" type="number" min={2} max={10} value={quantiles} onChange={e => setQuantiles(Math.max(2, Math.min(10, Number(e.target.value) || 5)))} inputMode="numeric" />
      </label>
    </div>
    <button className="primary-btn" disabled={busy || !code.trim()} onClick={() => void run()}>
      {busy ? <RefreshCw className="spin" size={14} /> : <Activity size={14} />}运行因子检验
    </button>
    {error && <div className="inline-error"><AlertTriangle size={13} /><span>{error}</span></div>}
    {result && (result.available ? <div className="factor-result">
      <div className="metric-grid">
        <Metric label="RankIC 均值" value={signedPct(result.ic_mean)} tone={(result.ic_mean ?? 0) > 0 ? "tone-up" : "tone-down"} />
        <Metric label="ICIR" value={result.ic_ir?.toFixed(3)} />
        <Metric label="IC 胜率" value={pct(result.ic_positive_ratio)} />
        <Metric label="t 统计量" value={result.t_stat?.toFixed(2)} />
        <Metric label="多空年化" value={signedPct(result.long_short_annual)} tone={(result.long_short_annual ?? 0) > 0 ? "tone-up" : "tone-down"} />
        <Metric label="样本期数" value={String(result.periods ?? "—")} />
      </div>
      {result.layers && <div className="layer-chips">
        {result.layers.map(l => <span key={l.layer}><em>第 {l.layer} 层</em><b className={l.annual_return > 0 ? "tone-up" : "tone-down"}>{signedPct(l.annual_return)}</b><small>夏普 {l.sharpe.toFixed(2)}</small></span>)}
      </div>}
      {result.data_coverage && <p className="note-line">数据覆盖：{result.data_coverage.symbols_with_complete_data} 个标的字段完整{Object.keys(result.data_coverage.excluded_symbols).length ? ` · 排除 ${Object.keys(result.data_coverage.excluded_symbols).length} 个` : ""}</p>}
      {result.decay && result.decay.length > 0 && <p className="note-line">衰减：{result.decay.map(d => `${d.horizon}日 IC ${d.ic.toFixed(3)}`).join(" · ")}</p>}
    </div> : <p className="empty-line">{result.reason || "无法评估"}</p>)}
  </div>;
}

// ---------- 组合再平衡回测 ----------

function PortfolioCard() {
  const { status, notify } = useApp();
  const [weightsText, setWeightsText] = useState("");
  const [rebal, setRebal] = useState(20);
  const [cost, setCost] = useState(12);
  const [slip, setSlip] = useState(5);
  const [benchmark, setBenchmark] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PortfolioBacktestResult | null>(null);
  const [error, setError] = useState("");

  const parsedWeights = useMemo(() => {
    const out: Record<string, number> = {};
    for (const part of weightsText.split(/[,，\n]/)) {
      const seg = part.split(/[:=：]/).map(s => s.trim());
      if (seg.length === 2 && seg[0] && Number.isFinite(Number(seg[1]))) out[seg[0].toUpperCase()] = Number(seg[1]);
    }
    return out;
  }, [weightsText]);

  const suggestHoldings = useCallback(async () => {
    try {
      const { getPositions } = await import("../lib/trade");
      const pos = await getPositions();
      const text = (pos.positions || []).map(p => `${p.symbol}: ${Math.abs(p.quantity)}`).join(", ");
      if (text) { setWeightsText(text); notify("已填入模拟持仓数量（请改为目标权重）"); }
      else notify("暂无模拟持仓", "error");
    } catch { notify("模拟持仓不可用", "error"); }
  }, [notify]);

  const run = async () => {
    setBusy(true); setError(""); setResult(null);
    try { setResult(await runPortfolioBacktest({ weights: parsedWeights, rebalanceDays: rebal, costBps: cost, slippageBps: slip, benchmark })); }
    catch (e) { setError(e instanceof Error ? e.message : "回测失败"); }
    finally { setBusy(false); }
  };

  const m = result?.metrics;
  const c = result?.comparison;
  const benchName = result?.benchmark || "等权基准";
  return <div className="card form-card">
    <p className="form-hint">多标的按目标权重定期再平衡，计入佣金与滑点；输出净值曲线、基准对比、月度收益与逐标的归因。</p>
    <label className="field">目标权重（代码:权重，逗号分隔）
      <textarea value={weightsText} onChange={e => setWeightsText(e.target.value)} placeholder="600519: 0.3, 000001: 0.4, 600036: 0.3" rows={2} autoCapitalize="off" />
    </label>
    <div className="field-trio">
      <label className="field">再平衡(日)<input className="num-input" type="number" min={0} max={250} value={rebal} onChange={e => setRebal(Math.max(0, Math.min(250, Number(e.target.value) || 20)))} inputMode="numeric" /></label>
      <label className="field">成本(bps)<input className="num-input" type="number" min={0} max={200} value={cost} onChange={e => setCost(Math.max(0, Number(e.target.value) || 0))} inputMode="numeric" /></label>
      <label className="field">滑点(bps)<input className="num-input" type="number" min={0} max={200} value={slip} onChange={e => setSlip(Math.max(0, Number(e.target.value) || 0))} inputMode="numeric" /></label>
    </div>
    <label className="field">基准代码（可选，需已导入指数日线）
      <input value={benchmark} onChange={e => setBenchmark(e.target.value)} placeholder="000300" autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
    </label>
    <div className="btn-row">
      <button className="secondary-btn" onClick={() => void suggestHoldings()}>填入模拟持仓</button>
      <button className="primary-btn" disabled={busy || Object.keys(parsedWeights).length === 0} onClick={() => void run()}>
        {busy ? <RefreshCw className="spin" size={14} /> : <FlaskConical size={14} />}运行回测
      </button>
    </div>
    {Object.keys(parsedWeights).length === 0 && weightsText.trim() !== "" && <p className="empty-line">未能解析出有效权重，格式示例：600519: 0.3</p>}
    {error && <div className="inline-error"><AlertTriangle size={13} /><span>{error}</span></div>}
    {m && result && <div className="factor-result">
      <NavChart navs={[{ values: result.nav || [], color: "var(--red)" }, { values: result.benchmark_nav || [], color: "var(--muted)" }]} />
      <p className="note-line">红=组合，灰=基准（{benchName}）· {result.start} ~ {result.end} · 再平衡 {m.rebalances} 次</p>
      <div className="metric-grid">
        <Metric label="累计收益" value={signedPct(m.total_return)} tone={m.total_return > 0 ? "tone-up" : "tone-down"} />
        <Metric label="年化收益" value={signedPct(m.annual_return)} tone={m.annual_return > 0 ? "tone-up" : "tone-down"} />
        <Metric label="夏普" value={m.sharpe?.toFixed(2)} />
        <Metric label="最大回撤" value={pct(m.max_drawdown)} tone="tone-down" />
        <Metric label="胜率" value={pct(m.win_rate)} />
        <Metric label="成本拖累" value={pct(m.total_cost_drag)} />
        <Metric label={`基准年化（${benchName}）`} value={signedPct(result.benchmark_annual_return)} />
        <Metric label="平均换手" value={pct(m.avg_turnover_per_rebal)} />
        {!!m.deferred_trades && <Metric label="涨跌停顺延" value={`${m.deferred_trades} 次`} tone="tone-down" />}
      </div>
      {c && <>
        <p className="note-line">基准对比（{benchName}）</p>
        <div className="metric-grid">
          <Metric label="超额年化" value={signedPct(c.excess_annual_return)} tone={c.excess_annual_return > 0 ? "tone-up" : "tone-down"} />
          <Metric label="Alpha 年化" value={signedPct(c.alpha_annual)} tone={c.alpha_annual > 0 ? "tone-up" : "tone-down"} />
          <Metric label="Beta" value={c.beta.toFixed(3)} />
          <Metric label="信息比率" value={c.information_ratio.toFixed(2)} tone={c.information_ratio > 0 ? "tone-up" : "tone-down"} />
          <Metric label="跟踪误差" value={pct(c.tracking_error)} />
        </div>
        {result.relative_nav && result.relative_nav.length > 1 && <>
          <p className="note-line">相对净值（组合 / 基准）</p>
          <NavChart navs={[{ values: result.relative_nav, color: "var(--blue)" }]} />
        </>}
      </>}
      {result.monthly_returns && result.monthly_returns.length > 0 && <>
        <p className="note-line">月度收益（最近 12 个月）</p>
        <div className="layer-chips">
          {result.monthly_returns.slice(-12).map(row =>
            <span key={row.month}><em>{row.month}</em><b className={row.return > 0 ? "tone-up" : "tone-down"}>{signedPct(row.return)}</b></span>)}
        </div>
      </>}
      {result.attribution && Object.keys(result.attribution).length > 0 && <div className="layer-chips">
        {Object.entries(result.attribution).sort((a, b) => b[1] - a[1]).map(([symbol, v]) =>
          <span key={symbol}><em>{symbol}</em><b className={v > 0 ? "tone-up" : "tone-down"}>{signedPct(v)}</b></span>)}
      </div>}
    </div>}
  </div>;
}

function Metric({ label, value, tone }: { label: string; value?: string; tone?: string }) {
  return <div className="metric"><small>{label}</small><strong className={tone}>{value ?? "—"}</strong></div>;
}

function NavChart({ navs }: { navs: Array<{ values: number[]; color: string }> }) {
  const width = 560, height = 130;
  const all = navs.flatMap(n => n.values).filter(v => Number.isFinite(v));
  if (all.length < 2) return null;
  const min = Math.min(...all), max = Math.max(...all), span = max - min || 1;
  const path = (values: number[]) => values.map((v, i) => `${(i / (values.length - 1)) * width},${height - ((v - min) / span) * height}`).join(" ");
  return <svg viewBox={`0 0 ${width} ${height}`} className="nav-chart" preserveAspectRatio="none">
    {navs.map((n, idx) => <polyline key={idx} points={path(n.values)} fill="none" stroke={n.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
    <text x={4} y={11} fontSize="10" fill="var(--muted)">{max.toFixed(3)}</text>
    <text x={4} y={height - 4} fontSize="10" fill="var(--muted)">{min.toFixed(3)}</text>
  </svg>;
}

// ---------- 价格与风险预警 ----------

const ALERT_KIND_LABELS: Record<string, string> = {
  price_above: "价格高于", price_below: "价格低于",
  pct_change_above: "涨幅≥(%)", pct_change_below: "跌幅≥(%)",
  concentration_above: "单票占比>(%)", drawdown_below: "组合回撤>(%)",
};

function AlertsCard() {
  const { notify } = useApp();
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [symbol, setSymbol] = useState("");
  const [kind, setKind] = useState("price_above");
  const [threshold, setThreshold] = useState("");
  const needsSymbol = kind !== "drawdown_below";

  const load = useCallback(async () => {
    try { setAlerts(await listAlerts()); } catch { /* 引擎未就绪 */ }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 30000); return () => window.clearInterval(timer); }, [load]);

  const create = async () => {
    const value = Number(threshold);
    if (!Number.isFinite(value)) return;
    try {
      await saveAlert({ symbol: symbol.trim() || "PORTFOLIO", kind, threshold: value });
      setThreshold(""); await load(); notify("预警已添加");
    } catch (e) { notify(e instanceof Error ? e.message : "添加失败", "error"); }
  };
  const toggle = async (a: PriceAlert) => {
    try { await saveAlert({ ...a, enabled: !a.enabled }); await load(); } catch { /* 静默 */ }
  };

  return <div className="card form-card">
    <p className="form-hint">引擎每 30 秒检查一次，触发即产生通知；开启推送后（我的 → 推送通知）会直接推送到手机。</p>
    <div className="alert-form">
      {needsSymbol && <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} placeholder="代码，如 600519" autoCapitalize="characters" />}
      <select value={kind} onChange={e => setKind(e.target.value)}>
        {Object.entries(ALERT_KIND_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </select>
      <input className="num-input" type="number" value={threshold} onChange={e => setThreshold(e.target.value)} placeholder="阈值" inputMode="decimal" />
      <button className="primary-btn" disabled={!Number.isFinite(Number(threshold)) || threshold === "" || (needsSymbol && !symbol.trim())} onClick={() => void create()}>
        <Plus size={13} />添加
      </button>
    </div>
    {alerts.length === 0 ? <p className="empty-line">还没有预警规则</p> : <div className="alert-list">
      {alerts.map(a => <div className="alert-item" key={a.id}>
        <button className={`toggle ${a.enabled ? "on" : ""}`} onClick={() => void toggle(a)}><i /></button>
        <span className="alert-desc"><b>{a.symbol === "PORTFOLIO" || !a.symbol ? "组合" : a.symbol}</b><small>{ALERT_KIND_LABELS[a.kind] || a.kind} {a.threshold}{a.lastTriggeredAt ? ` · 最近触发 ${new Date(a.lastTriggeredAt).toLocaleString()}` : ""}</small></span>
        <button className="row-del" onClick={() => void deleteAlert(a.id).then(load)}><Trash2 size={13} /></button>
      </div>)}
    </div>}
    <p className="form-hint">通知记录见「资产」页右上角铃铛；开启推送后（我的 → 推送通知）触发会直接推送到手机系统通知。</p>
  </div>;
}

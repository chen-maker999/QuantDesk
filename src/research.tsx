// 研究与风控扩展组件: 因子研究、组合回测、价格/风险预警、通知中心。
import { useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, Bell, CheckCircle2, FlaskConical, Plus, RefreshCw, Trash2,
} from "lucide-react";
import {
  deleteAlert, evaluateFactor, listAlerts, listNotifications, markNotificationsRead,
  runPortfolioBacktest, saveAlert, type EngineNotification, type FactorResult, type PortfolioBacktestResult, type PriceAlert,
} from "./lib/backend";
import type { WorkspaceStatus } from "./lib/backend";

// ---------- 迷你净值曲线(组合 vs 基准) ----------
function NavChart({ navs, labels }: { navs: Array<{ values: number[]; color: string }>; labels: string[] }) {
  const width = 520;
  const height = 120;
  const all = navs.flatMap(n => n.values).filter(v => Number.isFinite(v));
  if (all.length < 2) return null;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const path = (values: number[]) => values.map((v, i) => `${(i / (values.length - 1)) * width},${height - ((v - min) / span) * height}`).join(" ");
  return <svg viewBox={`0 0 ${width} ${height}`} className="nav-chart">
    {navs.map((n, idx) => <polyline key={idx} points={path(n.values)} fill="none" stroke={n.color} strokeWidth="1.6" />)}
    <text x={4} y={10} fontSize="9" fill="var(--muted)">{max.toFixed(3)}</text>
    <text x={4} y={height - 4} fontSize="9" fill="var(--muted)">{min.toFixed(3)}</text>
  </svg>;
}

const pct = (v: number | undefined) => v === undefined ? "—" : `${(v * 100).toFixed(2)}%`;
const signedPct = (v: number | undefined) => v === undefined ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

// ---------- 因子研究卡 ----------
export function FactorResearchCard({ status }: { status: WorkspaceStatus }) {
  const [code, setCode] = useState(`def factor(df):\n    # df: 真实日线 DataFrame；至少含 close，完整导入时含 OHLCV/amount\n    close = df["close"]\n    mom = close.pct_change(20)\n    vol = close.pct_change().rolling(20).std()\n    return mom / vol`);
  const [horizon, setHorizon] = useState(1);
  const [quantiles, setQuantiles] = useState(5);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FactorResult | null>(null);
  const [error, setError] = useState("");

  const run = async () => {
    setBusy(true); setError(""); setResult(null);
    try { setResult(await evaluateFactor({ code, horizon, quantiles })) }
    catch (e) { setError(e instanceof Error ? e.message : "评估失败") }
    finally { setBusy(false) }
  };

  return <div className="card factor-card">
    <div className="provider-heading"><span><FlaskConical /></span><div><h2>因子研究</h2><p>用受限因子表达式在真实日线上计算 RankIC、ICIR、分层回测与衰减。OHLCV/成交额只会在完整导入时可用，缺字段的标的不参与对应因子。</p></div></div>
    <textarea className="factor-code" value={code} onChange={e => setCode(e.target.value)} spellCheck={false} rows={6}/>
    <div className="factor-params">
      <label>预测期(日)<input type="number" min={1} max={10} value={horizon} onChange={e => setHorizon(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}/></label>
      <label>分层数<input type="number" min={2} max={10} value={quantiles} onChange={e => setQuantiles(Math.max(2, Math.min(10, Number(e.target.value) || 5)))}/></label>
      <button className="primary-btn" disabled={busy || !code.trim()} onClick={() => void run()}>{busy ? <RefreshCw className="spin"/> : <Activity/>}运行因子检验</button>
    </div>
    {!status.market_rows && <p className="ens-empty">尚未导入市场数据：请先在数据中心导入至少 3 个标的的日线。</p>}
    {error && <div className="inline-error"><AlertTriangle size={14}/><span>{error}</span></div>}
    {result && (result.available ?
      <div className="factor-result">
        <div className="result-real-grid">
          <div className="card"><small>RankIC 均值</small><strong className={(result.ic_mean ?? 0) > 0 ? "tone-up" : "tone-down"}>{signedPct(result.ic_mean)}</strong></div>
          <div className="card"><small>ICIR</small><strong>{result.ic_ir?.toFixed(3)}</strong></div>
          <div className="card"><small>IC 胜率</small><strong>{pct(result.ic_positive_ratio)}</strong></div>
          <div className="card"><small>t 统计量</small><strong>{result.t_stat?.toFixed(2)}</strong></div>
          <div className="card"><small>多空年化</small><strong className={(result.long_short_annual ?? 0) > 0 ? "tone-up" : "tone-down"}>{signedPct(result.long_short_annual)}</strong></div>
          <div className="card"><small>样本期数</small><strong>{result.periods}</strong></div>
        </div>
        {result.layers && <div className="layer-table">{result.layers.map(l => <span key={l.layer}><em>第 {l.layer} 层</em><b className={l.annual_return > 0 ? "tone-up" : "tone-down"}>{signedPct(l.annual_return)}</b><small>夏普 {l.sharpe}</small></span>)}</div>}
        {result.data_coverage && <p className="decay-line">数据覆盖：{result.data_coverage.required_columns.join("、")} · {result.data_coverage.symbols_with_complete_data} 个标的具备完整字段{Object.keys(result.data_coverage.excluded_symbols).length ? ` · 已排除 ${Object.keys(result.data_coverage.excluded_symbols).length} 个缺字段标的` : ""}</p>}
        {result.decay && result.decay.length > 0 && <p className="decay-line">衰减：{result.decay.map(d => `${d.horizon}日 IC ${d.ic}`).join(" · ")}</p>}
      </div> :
      <p className="ens-empty">{result.reason || "无法评估"}</p>)}
  </div>;
}

// ---------- 组合回测卡 ----------
export function PortfolioBacktestCard({ status }: { status: WorkspaceStatus }) {
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

  const suggestHoldings = async () => {
    try {
      const { getPositions } = await import("./lib/trade");
      const pos = await getPositions();
      const text = (pos.positions || []).map(p => `${p.symbol}: ${Math.abs(p.quantity)}`).join(", ");
      if (text) setWeightsText(text);
    } catch { /* 模拟持仓不可用时静默 */ }
  };

  const run = async () => {
    setBusy(true); setError(""); setResult(null);
    try { setResult(await runPortfolioBacktest({ weights: parsedWeights, rebalanceDays: rebal, costBps: cost, slippageBps: slip, benchmark })) }
    catch (e) { setError(e instanceof Error ? e.message : "回测失败") }
    finally { setBusy(false) }
  };

  const m = result?.metrics;
  const c = result?.comparison;
  const benchName = result?.benchmark || "等权基准";
  return <div className="card factor-card">
    <div className="provider-heading"><span><RefreshCw/></span><div><h2>组合再平衡回测</h2><p>多标的按目标权重定期再平衡，计入佣金与滑点；输出净值曲线、基准对比、月度收益与逐标的归因。</p></div></div>
    <label className="weights-label">目标权重（代码:权重，逗号分隔）<textarea value={weightsText} onChange={e => setWeightsText(e.target.value)} placeholder={"600519: 0.3, 000001: 0.4, 600036: 0.3"} rows={2}/></label>
    <div className="factor-params">
      <label>再平衡周期(日)<input type="number" min={0} max={250} value={rebal} onChange={e => setRebal(Math.max(0, Math.min(250, Number(e.target.value) || 20)))}/></label>
      <label>成本(bps)<input type="number" min={0} max={200} value={cost} onChange={e => setCost(Math.max(0, Number(e.target.value) || 0))}/></label>
      <label>滑点(bps)<input type="number" min={0} max={200} value={slip} onChange={e => setSlip(Math.max(0, Number(e.target.value) || 0))}/></label>
      <label>基准代码<input type="text" value={benchmark} onChange={e => setBenchmark(e.target.value)} placeholder="000300（需已导入）" spellCheck={false}/></label>
      <button className="secondary-btn" onClick={() => void suggestHoldings()}>填入模拟持仓</button>
      <button className="primary-btn" disabled={busy || Object.keys(parsedWeights).length === 0} onClick={() => void run()}>{busy ? <RefreshCw className="spin"/> : <FlaskConical/>}运行回测</button>
    </div>
    {Object.keys(parsedWeights).length === 0 && weightsText.trim() !== "" && <p className="ens-empty">未能解析出有效权重，格式示例：600519: 0.3</p>}
    {!status.market_rows && <p className="ens-empty">尚未导入市场数据，回测需要标的的本地价格历史。</p>}
    {error && <div className="inline-error"><AlertTriangle size={14}/><span>{error}</span></div>}
    {m && result && <div className="factor-result">
      <NavChart navs={[{ values: result.nav || [], color: "#c0392b" }, { values: result.benchmark_nav || [], color: "#7f8c8d" }]} labels={["组合", `基准（${benchName}）`]}/>
      <p className="decay-line">红线=组合，灰线=基准（{benchName}）· {result.start} ~ {result.end} · 再平衡 {m.rebalances} 次</p>
      <div className="result-real-grid">
        <div className="card"><small>累计收益</small><strong className={m.total_return > 0 ? "tone-up" : "tone-down"}>{signedPct(m.total_return)}</strong></div>
        <div className="card"><small>年化收益</small><strong className={m.annual_return > 0 ? "tone-up" : "tone-down"}>{signedPct(m.annual_return)}</strong></div>
        <div className="card"><small>夏普</small><strong>{m.sharpe}</strong></div>
        <div className="card"><small>最大回撤</small><strong className="tone-down">{pct(m.max_drawdown)}</strong></div>
        <div className="card"><small>胜率</small><strong>{pct(m.win_rate)}</strong></div>
        <div className="card"><small>成本拖累</small><strong>{pct(m.total_cost_drag)}</strong></div>
        <div className="card"><small>基准年化（{benchName}）</small><strong>{signedPct(result.benchmark_annual_return)}</strong></div>
        <div className="card"><small>平均换手</small><strong>{pct(m.avg_turnover_per_rebal)}</strong></div>
        {!!m.deferred_trades && <div className="card"><small>涨跌停顺延</small><strong className="tone-down">{m.deferred_trades} 次</strong></div>}
      </div>
      {c && <>
        <h3>基准对比（{benchName}）</h3>
        <div className="result-real-grid">
          <div className="card"><small>超额年化</small><strong className={c.excess_annual_return > 0 ? "tone-up" : "tone-down"}>{signedPct(c.excess_annual_return)}</strong></div>
          <div className="card"><small>Alpha 年化</small><strong className={c.alpha_annual > 0 ? "tone-up" : "tone-down"}>{signedPct(c.alpha_annual)}</strong></div>
          <div className="card"><small>Beta</small><strong>{c.beta.toFixed(3)}</strong></div>
          <div className="card"><small>信息比率</small><strong className={c.information_ratio > 0 ? "tone-up" : "tone-down"}>{c.information_ratio.toFixed(3)}</strong></div>
          <div className="card"><small>跟踪误差</small><strong>{pct(c.tracking_error)}</strong></div>
        </div>
        {result.relative_nav && result.relative_nav.length > 1 && <>
          <h3>相对净值（组合 / 基准）</h3>
          <NavChart navs={[{ values: result.relative_nav, color: "#2563eb" }]} labels={["相对净值"]}/>
        </>}
      </>}
      {result.monthly_returns && result.monthly_returns.length > 0 && <>
        <h3>月度收益</h3>
        <div className="layer-table">{result.monthly_returns.slice(-12).map(row =>
          <span key={row.month}><em>{row.month}</em><b className={row.return > 0 ? "tone-up" : "tone-down"}>{signedPct(row.return)}</b></span>)}</div>
      </>}
      {result.attribution && Object.keys(result.attribution).length > 0 &&
        <div className="layer-table">{Object.entries(result.attribution).sort((a, b) => b[1] - a[1]).map(([symbol, v]) =>
          <span key={symbol}><em>{symbol}</em><b className={v > 0 ? "tone-up" : "tone-down"}>{signedPct(v)}</b></span>)}</div>}
    </div>}
  </div>;
}

// ---------- 预警管理 ----------
const ALERT_KIND_LABELS: Record<string, string> = {
  price_above: "价格高于", price_below: "价格低于",
  pct_change_above: "涨幅≥(%)", pct_change_below: "跌幅≥(%)",
  concentration_above: "单票占比>(%)", drawdown_below: "组合回撤>(%)",
};

export function AlertsCard() {
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [symbol, setSymbol] = useState("");
  const [kind, setKind] = useState("price_above");
  const [threshold, setThreshold] = useState("");
  const needsSymbol = kind !== "drawdown_below";

  const load = async () => { setLoading(true); try { setAlerts(await listAlerts()) } catch { /* 引擎未就绪 */ } finally { setLoading(false) } };
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 30000); return () => clearInterval(timer) }, []);

  const create = async () => {
    const value = Number(threshold);
    if (!Number.isFinite(value)) return;
    await saveAlert({ symbol: symbol.trim(), kind, threshold: value }).catch(() => undefined);
    setThreshold(""); await load();
  };
  const toggle = async (a: PriceAlert) => { await saveAlert({ ...a, enabled: !a.enabled }).catch(() => undefined); await load() };

  return <section className="alerts-section">
    <h3>价格与风险预警<small>引擎每 30 秒检查一次，触发即推送通知</small></h3>
    <div className="alert-create">
      {!needsSymbol ? <span className="alert-scope-hint">整个投资组合</span> :
        <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} placeholder="代码，如 600519"/>}
      <select value={kind} onChange={e => setKind(e.target.value)}>
        {Object.entries(ALERT_KIND_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </select>
      <input type="number" value={threshold} onChange={e => setThreshold(e.target.value)} placeholder="阈值"/>
      <button className="primary-btn" disabled={!Number.isFinite(Number(threshold)) || threshold === "" || (needsSymbol && !symbol.trim())} onClick={() => void create()}><Plus size={13}/>添加</button>
    </div>
    {loading ? <div className="loading-state"><RefreshCw className="spin"/>正在读取…</div> :
      alerts.length === 0 ? <p className="chat-empty">还没有预警规则</p> :
      <div className="alert-list">{alerts.map(a => <div className="alert-item" key={a.id}>
        <button className={`toggle ${a.enabled ? "on" : ""}`} title={a.enabled ? "点击停用" : "点击启用"} onClick={() => void toggle(a)}><i/></button>
        <span className="alert-desc"><b>{needsSymbol ? a.symbol : "组合"}</b><small>{ALERT_KIND_LABELS[a.kind]} {a.threshold}{a.lastTriggeredAt ? ` · 最近触发 ${new Date(a.lastTriggeredAt).toLocaleString()}` : ""}</small></span>
        <i className="chat-del" title="删除" onClick={() => void deleteAlert(a.id).then(load)}><Trash2 size={13}/></i>
      </div>)}</div>}
  </section>;
}

// ---------- 通知中心 ----------
export function NotificationsCard() {
  const [items, setItems] = useState<EngineNotification[]>([]);
  const [unread, setUnread] = useState(0);

  const load = async () => { try { const r = await listNotifications(30); setItems(r.notifications); setUnread(r.unread) } catch { /* 引擎未就绪 */ } };
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 15000); return () => clearInterval(timer) }, []);

  return <section className="alerts-section">
    <h3>通知中心{unread > 0 && <MiniBadge tone="blue">{unread} 条未读</MiniBadge>}<button className="secondary-btn mark-read" onClick={() => void markNotificationsRead().then(load)}>全部已读</button></h3>
    {items.length === 0 ? <p className="chat-empty">暂无通知</p> :
      <div className="notif-list">{items.map(n => <div className={`notif-item ${n.read ? "" : "unread"}`} key={n.id}>
        <span className={`notif-icon ${n.source}`}>{n.source === "alert" ? <AlertTriangle size={13}/> : n.source === "task" ? <CheckCircle2 size={13}/> : <Bell size={13}/>}</span>
        <span><b>{n.title}</b><small>{n.body || ""} · {new Date(n.createdAt).toLocaleString()}</small></span>
      </div>)}</div>}
  </section>;
}

function MiniBadge({ children, tone = "gray" }: { children: React.ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }

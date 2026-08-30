import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, KeyRound, RefreshCw, ShieldCheck, Unlock } from "lucide-react";
import {
  armBrokerLive, cancelBrokerOrder, configureBrokerEngine, connectBroker, disarmBrokerLive, getBrokerAccount,
  getBrokerOrders, getBrokerPositions, hasBrokerCredentials, listBrokers, listOmsDrafts, lookupIbkrContracts, placeBrokerOrder,
  resetBrokerBreaker, saveBrokerCredentials, type BrokerCredentials, type BrokerId, type BrokerOrder, type BrokerPosition, type BrokerStatus,
} from "./lib/brokers";
import "./brokeroms.css";

type Notify = (message: string, tone?: "ok" | "error") => void;
type Draft = BrokerCredentials & { api_key: string; api_secret: string; gateway_url: string; account_id: string };

const defaults: Record<BrokerId, Draft> = {
  alpaca: { api_key: "", api_secret: "", gateway_url: "", account_id: "", trading_mode: "paper", max_order_notional: 1000, max_open_orders: 10, max_daily_loss_pct: 3, max_orders_per_hour: 30, max_position_notional: 10000 },
  ibkr: { api_key: "", api_secret: "", gateway_url: "https://localhost:5000/v1/api", account_id: "", trading_mode: "paper", max_order_notional: 1000, max_open_orders: 10, max_daily_loss_pct: 3, max_orders_per_hour: 30, max_position_notional: 10000 },
};
const nameOf: Record<BrokerId, string> = { alpaca: "Alpaca", ibkr: "IBKR / 盈透" };
const fmt = (value: number | undefined | null) => value == null || !Number.isFinite(value) ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function BrokerOmsPage({ notify }: { notify: Notify }) {
  const [active, setActive] = useState<BrokerId>("alpaca");
  const [status, setStatus] = useState<Record<BrokerId, BrokerStatus>>({ alpaca: { broker: "alpaca", configured: false, connected: false }, ibkr: { broker: "ibkr", configured: false, connected: false } });
  const [drafts, setDrafts] = useState<Record<BrokerId, Draft>>(defaults);
  const [account, setAccount] = useState<Record<string, unknown> | null>(null);
  const [positions, setPositions] = useState<BrokerPosition[]>([]);
  const [orders, setOrders] = useState<BrokerOrder[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [symbol, setSymbol] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [estimatedPrice, setEstimatedPrice] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [contracts, setContracts] = useState<Array<{ contract_id: string; symbol: string; description?: string }>>([]);
  const [contractId, setContractId] = useState("");
  const [omsDrafts, setOmsDrafts] = useState<Array<{ id: string; payload?: { note?: string; orders?: Array<Record<string, unknown>> } }>>([]);

  const current = status[active];
  const currentDraft = drafts[active];
  const isLive = currentDraft.trading_mode === "live";
  const isArmed = !!current.live_armed_until && current.live_armed_until > Date.now();

  const loadStatus = useCallback(async () => {
    try {
      const data = await listBrokers();
      setStatus({ alpaca: data.brokers.find(x => x.broker === "alpaca") || { broker: "alpaca", configured: false, connected: false }, ibkr: data.brokers.find(x => x.broker === "ibkr") || { broker: "ibkr", configured: false, connected: false } });
      const pending = await listOmsDrafts().catch(() => ({ drafts: [] }));
      setOmsDrafts(pending.drafts || []);
    } catch { /* 引擎尚未启动时由后续查询重试 */ }
  }, []);
  const refreshTrading = useCallback(async (broker = active) => {
    if (!status[broker]?.configured) return;
    setBusy(true);
    try {
      const [a, p, o] = await Promise.all([getBrokerAccount(broker), getBrokerPositions(broker), getBrokerOrders(broker)]);
      setAccount((a.account || a.summary || null) as Record<string, unknown> | null);
      setPositions(p.positions || []); setOrders(o.orders || []);
      await loadStatus();
    } catch (error) { notify(error instanceof Error ? error.message : "券商账户读取失败", "error"); }
    finally { setBusy(false); }
  }, [active, loadStatus, notify, status]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);
  useEffect(() => {
    setAccount(null); setPositions([]); setOrders([]); setContracts([]); setContractId("");
    void (async () => {
      if (await hasBrokerCredentials(active).catch(() => false)) await configureBrokerEngine(active).catch(() => undefined);
      await loadStatus();
    })();
  }, [active, loadStatus]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDrafts(all => ({ ...all, [active]: { ...all[active], [key]: value } }));
  const save = async () => {
    if (active === "alpaca" && (!currentDraft.api_key.trim() || !currentDraft.api_secret.trim())) { notify("请填写 Alpaca API Key 与 API Secret", "error"); return; }
    if (!(currentDraft.max_order_notional > 0)) { notify("请设置正数的单笔金额上限", "error"); return; }
    setBusy(true);
    try {
      const payload: BrokerCredentials = active === "alpaca"
        ? { api_key: currentDraft.api_key.trim(), api_secret: currentDraft.api_secret.trim(), trading_mode: currentDraft.trading_mode, max_order_notional: currentDraft.max_order_notional, max_open_orders: currentDraft.max_open_orders, max_daily_loss_pct: currentDraft.max_daily_loss_pct, max_orders_per_hour: currentDraft.max_orders_per_hour, max_position_notional: currentDraft.max_position_notional }
        : { gateway_url: currentDraft.gateway_url.trim(), account_id: currentDraft.account_id.trim(), trading_mode: currentDraft.trading_mode, max_order_notional: currentDraft.max_order_notional, max_open_orders: currentDraft.max_open_orders, max_daily_loss_pct: currentDraft.max_daily_loss_pct, max_orders_per_hour: currentDraft.max_orders_per_hour, max_position_notional: currentDraft.max_position_notional };
      await saveBrokerCredentials(active, payload);
      await configureBrokerEngine(active);
      await loadStatus();
      notify(`${nameOf[active]} 已安全保存，下一步请测试连接`);
    } catch (error) { notify(error instanceof Error ? error.message : "保存券商配置失败", "error"); }
    finally { setBusy(false); }
  };
  const connect = async () => {
    setBusy(true);
    try { await connectBroker(active); await loadStatus(); await refreshTrading(active); notify(`${nameOf[active]} 已连接`); }
    catch (error) { notify(error instanceof Error ? error.message : "连接失败", "error"); }
    finally { setBusy(false); }
  };
  const arm = async () => {
    setBusy(true);
    try { await armBrokerLive(active, confirm); setConfirm(""); await loadStatus(); notify("真实资金已解锁 5 分钟；请逐笔核对订单", "ok"); }
    catch (error) { notify(error instanceof Error ? error.message : "解锁失败", "error"); }
    finally { setBusy(false); }
  };
  const lookup = async () => {
    if (!symbol.trim()) return;
    setBusy(true);
    try { const result = await lookupIbkrContracts(symbol.trim()); setContracts(result.contracts || []); setContractId(""); }
    catch (error) { notify(error instanceof Error ? error.message : "IBKR 合约查询失败", "error"); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    const qty = Number(quantity), estimate = Number(estimatedPrice), limit = Number(limitPrice);
    if (!symbol.trim() || !(qty > 0) || !(estimate > 0)) { notify("请填写标的、数量和预估价格", "error"); return; }
    if (orderType === "limit" && !(limit > 0)) { notify("限价单必须填写限价", "error"); return; }
    if (active === "ibkr" && !contractId) { notify("IBKR 必须从合约查询结果中选择精确 conid", "error"); return; }
    const text = `${nameOf[active]} ${current.trading_mode === "live" ? "真实" : "模拟"} ${side === "buy" ? "买入" : "卖出"} ${symbol.toUpperCase()} × ${qty}`;
    if (!window.confirm(`确认提交：${text}\n预估金额 ${fmt(qty * estimate)}。`)) return;
    setBusy(true);
    try {
      await placeBrokerOrder(active, { symbol: symbol.trim(), side, quantity: qty, order_type: orderType, estimated_price: estimate, ...(orderType === "limit" ? { limit_price: limit } : {}), ...(active === "ibkr" ? { contract_id: contractId } : {}) });
      notify("订单已提交给券商；请以订单状态与成交回报为准");
      await refreshTrading(active);
    } catch (error) { notify(error instanceof Error ? error.message : "下单失败", "error"); }
    finally { setBusy(false); }
  };
  const cancel = async (id: string) => {
    if (!window.confirm(`确认撤销订单 ${id}？`)) return;
    setBusy(true);
    try { await cancelBrokerOrder(active, id); notify("撤单请求已提交"); await refreshTrading(active); }
    catch (error) { notify(error instanceof Error ? error.message : "撤单失败", "error"); }
    finally { setBusy(false); }
  };
  const accountItems = useMemo(() => account ? Object.entries(account).filter(([, value]) => typeof value === "string" || typeof value === "number").slice(0, 8) : [], [account]);

  return <div className="page-body broker-oms">
    <div className="broker-oms-head"><div><h3>实盘 OMS</h3><p>券商下单与 Agent、模拟盘完全隔离。凭据仅保存在 Windows Credential Manager；真实模式必须每次会话重新解锁。Agent 只能生成草稿，不能直接下单。</p></div><button className="secondary-btn" disabled={busy} onClick={() => void refreshTrading()}><RefreshCw size={13} />同步账户</button></div>
    {omsDrafts.length > 0 && <section className="card"><h3>Agent 待确认草稿</h3><p className="broker-note">以下由模拟盘升进生成，请核对后在下方手工下单；系统不会自动提交给券商。</p>{omsDrafts.map(draft => <div key={draft.id} className="broker-note"><b>{draft.id}</b> · {draft.payload?.note || "无备注"} · {(draft.payload?.orders || []).length} 笔</div>)}</section>}
    <div className="broker-tabs">{(["alpaca", "ibkr"] as BrokerId[]).map(broker => <button key={broker} className={active === broker ? "active" : ""} onClick={() => setActive(broker)}><b>{nameOf[broker]}</b><small>{status[broker].configured ? `${status[broker].trading_mode === "live" ? "真实" : "模拟"}已配置` : "未配置"}</small></button>)}</div>
    <div className="broker-grid">
      <section className="card broker-config"><h3><KeyRound size={15} />连接配置</h3>
        {active === "alpaca" ? <><label>API Key<input type="password" value={currentDraft.api_key} onChange={e => update("api_key", e.target.value)} placeholder="Alpaca API Key" /></label><label>API Secret<input type="password" value={currentDraft.api_secret} onChange={e => update("api_secret", e.target.value)} placeholder="Alpaca API Secret" /></label></> : <><label>Gateway 地址<input value={currentDraft.gateway_url} onChange={e => update("gateway_url", e.target.value)} placeholder="https://localhost:5000/v1/api" /></label><label>账户 ID（多账户时必填）<input value={currentDraft.account_id} onChange={e => update("account_id", e.target.value)} placeholder="例如 U1234567" /></label><p className="broker-note">请先在本机启动并登录 IBKR Client Portal Gateway；不输入 IBKR 登录密码。</p></>}
        <div className="broker-inline"><label>模式<select value={currentDraft.trading_mode} onChange={e => update("trading_mode", e.target.value as "paper" | "live")}><option value="paper">模拟 / Paper</option><option value="live">真实资金 / Live</option></select></label><label>单笔金额上限<input type="number" min="1" value={currentDraft.max_order_notional} onChange={e => update("max_order_notional", Number(e.target.value))} /></label></div>
        <div className="broker-inline"><label>最大挂单数<input type="number" min="1" max="200" value={currentDraft.max_open_orders} onChange={e => update("max_open_orders", Number(e.target.value))} /></label><label>单标的持仓上限<input type="number" min="1" value={currentDraft.max_position_notional} onChange={e => update("max_position_notional", Number(e.target.value))} /></label></div>
        <div className="broker-inline"><label>单日亏损熔断 %<input type="number" min="0.1" max="100" step="0.1" value={currentDraft.max_daily_loss_pct} onChange={e => update("max_daily_loss_pct", Number(e.target.value))} /></label><label>每小时下单上限<input type="number" min="1" max="600" value={currentDraft.max_orders_per_hour} onChange={e => update("max_orders_per_hour", Number(e.target.value))} /></label></div>
        <div className="broker-actions"><button className="secondary-btn" disabled={busy} onClick={() => void save()}>安全保存</button><button className="primary-btn" disabled={busy || !status[active].configured} onClick={() => void connect()}>{busy ? <RefreshCw className="spin" size={13} /> : <CheckCircle2 size={13} />}测试连接</button></div>
      </section>
      <section className={`card broker-safety ${isLive ? "live" : "paper"}`}><h3><ShieldCheck size={15} />交易安全状态</h3><p>{current.configured ? `${current.trading_mode === "live" ? "真实资金模式" : "模拟盘模式"} · 单笔≤${fmt(current.max_order_notional)} · 挂单≤${current.max_open_orders} · 单日亏损熔断 ${fmt(current.max_daily_loss_pct)}% · 时频率≤${current.max_orders_per_hour}/时 · 单标的≤${fmt(current.max_position_notional)}` : "尚未配置券商"}</p>{current.risk?.breaker_tripped && <div className="broker-warning breaker"><AlertTriangle size={15} />熔断已触发：{current.risk.breaker_tripped}<button className="secondary-btn" disabled={busy} onClick={() => void resetBrokerBreaker(active).then(loadStatus).then(() => notify("熔断已手动解除", "ok"))}>解除熔断</button></div>}{current.configured && <p className="broker-risk-line">最近 1 小时下单 {current.risk?.orders_last_hour ?? 0} 次 · 今日起点权益 {fmt(current.risk?.day_start_equity ?? null)}</p>}{isLive && <><div className="broker-warning"><AlertTriangle size={15} />真实模式默认锁定，解锁仅对本次引擎会话有效 5 分钟。</div>{isArmed ? <button className="secondary-btn danger" disabled={busy} onClick={() => void disarmBrokerLive(active).then(loadStatus)}>立即锁定真实资金</button> : <div className="broker-arm"><input value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="输入 ENABLE LIVE TRADING" /><button className="primary-btn" disabled={busy} onClick={() => void arm()}><Unlock size={13} />解锁 5 分钟</button></div>}</>}{!isLive && <p className="broker-safe">当前不会触达真实资金。切换真实模式后仍需再次手动解锁。</p>}</section>
    </div>
    {current.configured && <><section className="card broker-order"><div className="broker-section-title"><h3>手工订单</h3><small>预估价格用于本地单笔风控；实际成交和交易权限以券商返回为准。</small></div><div className="broker-order-row"><label>标的<input value={symbol} onChange={e => { setSymbol(e.target.value); setContracts([]); setContractId(""); }} placeholder={active === "alpaca" ? "AAPL" : "AAPL"} /></label>{active === "ibkr" && <button className="secondary-btn broker-lookup" disabled={busy} onClick={() => void lookup()}>查询 IBKR 合约</button>}<label>方向<select value={side} onChange={e => setSide(e.target.value as "buy" | "sell")}><option value="buy">买入</option><option value="sell">卖出</option></select></label><label>类型<select value={orderType} onChange={e => setOrderType(e.target.value as "market" | "limit")}><option value="market">市价</option><option value="limit">限价</option></select></label><label>数量<input type="number" min="0" value={quantity} onChange={e => setQuantity(e.target.value)} /></label><label>预估价<input type="number" min="0" value={estimatedPrice} onChange={e => setEstimatedPrice(e.target.value)} /></label>{orderType === "limit" && <label>限价<input type="number" min="0" value={limitPrice} onChange={e => setLimitPrice(e.target.value)} /></label>}<button className="primary-btn broker-submit" disabled={busy || (isLive && !isArmed)} onClick={() => void submit()}>{current.trading_mode === "live" ? "提交真实订单" : "提交模拟订单"}</button></div>{active === "ibkr" && contracts.length > 0 && <label className="broker-contract">精确合约（必选）<select value={contractId} onChange={e => setContractId(e.target.value)}><option value="">选择 conid…</option>{contracts.map(c => <option key={c.contract_id} value={c.contract_id}>{c.symbol} · {c.description || "—"} · conid {c.contract_id}</option>)}</select></label>}</section>
      <div className="broker-data-grid"><section className="card"><h3>账户摘要</h3>{accountItems.length ? <dl className="broker-summary">{accountItems.map(([key, value]) => <><dt key={`${key}-k`}>{key}</dt><dd key={`${key}-v`}>{String(value)}</dd></>)}</dl> : <p className="broker-empty">点击“测试连接”或“同步账户”加载。</p>}</section><section className="card"><h3>持仓</h3>{positions.length ? <table className="rank-table broker-table"><thead><tr><th>标的</th><th className="num">数量</th><th className="num">市值</th><th className="num">浮盈</th></tr></thead><tbody>{positions.slice(0, 12).map(p => <tr key={`${p.contract_id}-${p.symbol}`}><td><b>{p.symbol}</b><small>{p.contract_id}</small></td><td className="num">{fmt(p.quantity)}</td><td className="num">{fmt(p.market_value)}</td><td className={`num ${p.unrealized_pnl >= 0 ? "tone-up" : "tone-down"}`}>{fmt(p.unrealized_pnl)}</td></tr>)}</tbody></table> : <p className="broker-empty">暂无持仓或尚未同步。</p>}</section></div>
      <section className="card broker-orders"><h3>订单</h3>{orders.length ? <table className="rank-table broker-table"><thead><tr><th>标的</th><th>方向</th><th className="num">数量</th><th>状态</th><th></th></tr></thead><tbody>{orders.slice(0, 30).map(order => <tr key={order.id}><td>{order.symbol}</td><td>{order.side}</td><td className="num">{fmt(order.quantity)}</td><td>{order.status}</td><td>{["new", "accepted", "pending_new", "partially_filled", "submitted", "presubmitted"].includes(String(order.status).toLowerCase()) ? <button className="secondary-btn" onClick={() => void cancel(order.id)}>撤单</button> : "—"}</td></tr>)}</tbody></table> : <p className="broker-empty">暂无订单或尚未同步。</p>}</section></>}
  </div>;
}

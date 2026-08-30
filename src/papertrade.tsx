// 模拟交易页面: 股票 + 期货。资产头(模拟资产/可用/持仓市值/浮动盈亏/当日参考盈亏)、
// 买卖开平表单、持仓 / 今日委托 / 今日成交。引擎侧核算在 engine/papertrade.py。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, RefreshCw, RotateCcw, Search, X } from "lucide-react";
import { fmtAmount, fmtNum, searchSymbols, toneOf, type SearchHit } from "./lib/market";
import {
  CONDITIONAL_KIND_LABELS, SIDE_LABELS, cancelConditionalOrder, cancelOrder, createConditionalOrder,
  getAccount, getConditionalOrders, getOrders, getPositions, getRiskGuard, getTrades, placeOrder,
  resetAccount, resumeRiskGuard,
  type ConditionalKind, type ConditionalOrder, type PaperAccount, type PaperOrder,
  type PaperPosition, type PaperTrade, type RiskGuardStatus,
} from "./lib/trade";

const STOCK_SIDES = ["buy", "sell"] as const;
const FUTURES_SIDES = ["open_long", "open_short", "close_long", "close_short"] as const;
type Side = string;
// 方向语义色(A股红涨绿跌): 买入/开多/平空=红(主动做多), 卖出/开空/平多=绿(做空/了结)
const SIDE_TONE: Record<string, "up" | "down"> = {
  buy: "up", open_long: "up", close_short: "up",
  sell: "down", open_short: "down", close_long: "down",
};
const POS_SIDE_TONE = (l: string): "up" | "down" | "flat" => {
  if (l.includes("多") || l === "buy" || l === "买入") return "up";
  if (l.includes("空") || l === "sell" || l === "卖出") return "down";
  return "flat";
};
const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  pending: { label: "待成交", cls: "orange" },
  filled: { label: "已成交", cls: "green" },
  cancelled: { label: "已撤销", cls: "muted" },
};
const COND_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  pending: { label: "监控中", cls: "orange" },
  triggered: { label: "已触发", cls: "green" },
  cancelled: { label: "已撤销", cls: "muted" },
};
const COND_KINDS: ConditionalKind[] = ["stop_loss", "take_profit", "trailing_stop"];

function Stat({ label, value, tone, sub }: { label: string; value: string; tone?: "up" | "down" | "flat"; sub?: string }) {
  return (
    <div className="card paper-stat">
      <small>{label}</small>
      <strong className={tone && tone !== "flat" ? `tone-${tone}` : ""}>{value}</strong>
      {sub && <em>{sub}</em>}
    </div>
  );
}

export function PaperTradePage({ notify }: { notify?: (m: string, t?: "ok" | "error") => void }) {
  const [market, setMarket] = useState<"a" | "futures">("a");
  const sides: Side[] = market === "a" ? [...STOCK_SIDES] : [...FUTURES_SIDES];
  const [side, setSide] = useState<Side>("buy");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  const [query, setQuery] = useState("");
  const [futName, setFutName] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [sel, setSel] = useState<SearchHit | null>(null);
  const [busy, setBusy] = useState(false);
  const [acc, setAcc] = useState<PaperAccount | null>(null);
  const [positions, setPositions] = useState<PaperPosition[]>([]);
  const [orders, setOrders] = useState<PaperOrder[]>([]);
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [tab, setTab] = useState<"positions" | "orders" | "trades" | "conditional">("positions");
  const [armed, setArmed] = useState(0);
  const armedTimer = useRef<number | null>(null);
  const [guard, setGuard] = useState<RiskGuardStatus | null>(null);
  const [condOrders, setCondOrders] = useState<ConditionalOrder[]>([]);
  const [mode, setMode] = useState<"order" | "conditional">("order");
  const [condKind, setCondKind] = useState<ConditionalKind>("stop_loss");
  const [condTrigger, setCondTrigger] = useState("");
  const [condPct, setCondPct] = useState("");

  const load = useCallback(async () => {
    try {
      const [a, p, o, t, g, c] = await Promise.all([
        getAccount(), getPositions(), getOrders(), getTrades(100),
        getRiskGuard().catch(() => null), getConditionalOrders(),
      ]);
      setAcc(a); setPositions(p.positions || []); setOrders(o.orders || []); setTrades(t.trades || []);
      setGuard(g && g.ok !== false ? g : null);
      setCondOrders(c.orders || []);
    } catch (e) { notify?.(e instanceof Error ? e.message : "加载模拟账户失败", "error"); }
  }, [notify]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (market === "a") return;
    setSide(FUTURES_SIDES[0]); setQuery(""); setSel(null);
  }, [market]);

  useEffect(() => {
    if (!query.trim() || market !== "a") { setResults([]); return; }
    const timer = setTimeout(async () => {
      try { const r = await searchSymbols(query.trim()); setResults(r.results || []); }
      catch { setResults([]); }
    }, 260);
    return () => clearTimeout(timer);
  }, [query, market]);

  const pickSymbol = (hit: SearchHit) => {
    setSel(hit); setQuery(`${hit.name} ${hit.symbol}`); setResults([]);
  };

  const submit = async () => {
    const symbol = sel?.symbol || query.trim();
    if (!symbol) { notify?.("请先输入标的代码", "error"); return; }
    const quantity = Number(qty);
    if (!(quantity > 0)) { notify?.("请输入大于 0 的数量", "error"); return; }
    if (orderType === "limit" && !(Number(price) > 0)) { notify?.("限价单需要填写委托价格", "error"); return; }
    setBusy(true);
    try {
      const r = await placeOrder({
        market, symbol, name: market === "a" ? sel?.name : futName || undefined,
        side, order_type: orderType, price: orderType === "limit" ? Number(price) : null, quantity,
      });
      if (!r.ok) notify?.(r.error || "下单失败", "error");
      else notify?.(r.status === "filled"
        ? `已成交 ${SIDE_LABELS[side] || side} ${symbol} ×${quantity} @ ${r.price ?? "—"}`
        : `${SIDE_LABELS[side] || side} 委托已挂出（等待成交）`, "ok");
      setQty(""); setPrice("");
      void load();
    } catch (e) { notify?.(e instanceof Error ? e.message : "下单失败", "error"); }
    finally { setBusy(false); }
  };

  const cancel = async (id: number) => {
    try { const r = await cancelOrder(id); notify?.(r.ok ? "已撤单" : r.error || "撤单失败", r.ok ? "ok" : "error"); void load(); }
    catch (e) { notify?.(e instanceof Error ? e.message : "撤单失败", "error"); }
  };

  const submitConditional = async () => {
    const symbol = sel?.symbol || query.trim();
    if (!symbol) { notify?.("请先输入标的代码", "error"); return; }
    const quantity = Number(qty);
    if (!(quantity > 0)) { notify?.("请输入大于 0 的数量", "error"); return; }
    const trigger = Number(condTrigger);
    const pct = Number(condPct);
    if (condKind === "trailing_stop") {
      if (!(pct > 0 && pct < 100)) { notify?.("回撤比例需在 0-100 之间", "error"); return; }
    } else if (!(trigger > 0)) { notify?.("请填写触发价格", "error"); return; }
    setBusy(true);
    try {
      const r = await createConditionalOrder({
        market, symbol, kind: condKind, quantity,
        trigger_price: condKind === "trailing_stop" ? null : trigger,
        trailing_pct: condKind === "trailing_stop" ? pct / 100 : null,
      });
      if (!r.ok) notify?.(r.error || "条件单创建失败", "error");
      else notify?.(`条件单已创建：${CONDITIONAL_KIND_LABELS[condKind]} ${symbol} ×${quantity}`, "ok");
      setQty(""); setCondTrigger(""); setCondPct("");
      void load();
    } catch (e) { notify?.(e instanceof Error ? e.message : "条件单创建失败", "error"); }
    finally { setBusy(false); }
  };

  const cancelCond = async (id: number) => {
    try { const r = await cancelConditionalOrder(id); notify?.(r.ok ? "条件单已撤销" : r.error || "撤销失败", r.ok ? "ok" : "error"); void load(); }
    catch (e) { notify?.(e instanceof Error ? e.message : "撤销失败", "error"); }
  };

  const doResume = async () => {
    try { const r = await resumeRiskGuard(); notify?.(r.ok ? "风控熔断已恢复，可继续开仓" : r.error || "恢复失败", r.ok ? "ok" : "error"); void load(); }
    catch (e) { notify?.(e instanceof Error ? e.message : "恢复失败", "error"); }
  };

  const doReset = () => {
    const now = Date.now();
    if (!armed || now - armed > 3000) { setArmed(now); if (armedTimer.current) window.clearTimeout(armedTimer.current); armedTimer.current = window.setTimeout(() => setArmed(0), 3000); return; }
    if (armedTimer.current) window.clearTimeout(armedTimer.current);
    setArmed(0);
    void (async () => {
      try { const r = await resetAccount(); notify?.(r.ok ? "模拟账户已重置（100 万初始资金）" : r.error || "重置失败", r.ok ? "ok" : "error"); void load(); }
      catch (e) { notify?.(e instanceof Error ? e.message : "重置失败", "error"); }
    })();
  };

  const prefill = (p: PaperPosition) => {
    setMarket(p.market === "a" ? "a" : "futures");
    const closing = p.market === "a" ? "sell"
      : p.side_label === "多" || p.side_label === "多单" ? "close_long" : "close_short";
    setSide(closing);
    setSel({ market: p.market as SearchHit["market"], symbol: p.symbol, name: p.name || "", type: p.market === "a" ? "stock" : "futures" });
    setQuery(`${p.name || ""} ${p.symbol}`.trim());
    if (p.market === "futures") setFutName(p.name || "");
    setQty(String(Math.abs(p.quantity)));
  };

  // 从持仓一键进入条件单模式（保护性平仓预填）
  const prefillProtect = (p: PaperPosition) => {
    prefill(p);
    setMode("conditional");
    setCondKind("stop_loss");
    setCondTrigger("");
    setCondPct("");
  };

  const assetDelta = (acc?.total_asset ?? 0) - (acc?.initial_cash ?? 0);
  const assetTone = toneOf(assetDelta);
  const pnl = (v: number | null | undefined) => toneOf(v);

  return (
    <div className="page-body v3-page paper-page">
      <div className="page-action-row">
        <p>股票与期货模拟交易：下单按实时价撮合，限价单等待触发；只模拟，不接真实券商。</p>
        <div className="paper-actions">
          <button className="secondary-btn" onClick={() => void load()}><RefreshCw size={13} />查询</button>
          <button className={`secondary-btn ${armed ? "danger" : ""}`} onClick={doReset}><RotateCcw size={13} />{armed ? "再点一次确认重置" : "重置账户"}</button>
        </div>
      </div>

      {/* 资产头 */}
      <div className="paper-asset-grid">
        <Stat label="模拟资产" value={fmtAmount(acc?.total_asset)} tone={assetTone} sub={`初始 ${fmtAmount(acc?.initial_cash)}`} />
        <Stat label="可用资金" value={fmtAmount(acc?.cash)} sub={acc ? `${acc.positions_count} 个持仓` : undefined} />
        <Stat label="持仓市值" value={fmtAmount(acc?.market_value)} />
        <Stat label="浮动盈亏" value={`${(acc?.unrealized_pnl ?? 0) >= 0 ? "+" : ""}${fmtAmount(acc?.unrealized_pnl)}`} tone={pnl(acc?.unrealized_pnl)} />
        <Stat label="当日参考盈亏" value={`${(acc?.day_pnl ?? 0) >= 0 ? "+" : ""}${fmtAmount(acc?.day_pnl)}`} tone={pnl(acc?.day_pnl)} />
        <Stat label="已实现盈亏" value={`${(acc?.realized_pnl ?? 0) >= 0 ? "+" : ""}${fmtAmount(acc?.realized_pnl)}`} tone={pnl(acc?.realized_pnl)} />
      </div>
      {acc?.risk_limits && <div className="card paper-risk-policy"><b>预交易风控（模拟盘）</b><span>单笔 ≤ {(acc.risk_limits.max_order_notional_pct * 100).toFixed(0)}% · 单标的 ≤ {(acc.risk_limits.max_single_position_pct * 100).toFixed(0)}% · 总敞口 ≤ {(acc.risk_limits.max_gross_exposure_pct * 100).toFixed(0)}% · 期货保证金 ≤ {(acc.risk_limits.max_futures_margin_pct * 100).toFixed(0)}% · 挂单 ≤ {acc.risk_limits.max_pending_orders}</span></div>}
      {guard && (guard.halted ? (
        <div className="card paper-guard-banner halted">
          <div className="pgb-text">
            <b>账户风控熔断中 — 新开仓已禁止</b>
            <span>{guard.halt_reason}（{guard.halted_at}）。平仓不受影响；确认风险后可手动恢复。</span>
          </div>
          <button className="secondary-btn" onClick={() => void doResume()}>恢复交易</button>
        </div>
      ) : (
        <div className="card paper-guard-banner ok">
          <b>账户风控正常</b>
          <span>日亏损熔断 {(guard.config.daily_max_loss_pct * 100).toFixed(0)}% · 连亏 {guard.config.consecutive_loss_limit} 笔熔断 · 当日连亏 {guard.consec_losses} 笔</span>
        </div>
      ))}

      {/* 交易表单 + 列表 */}
      <div className="paper-layout">
        <div className="card paper-trade-form">
          <div className="paper-form-head">
            <h3>下单</h3>
            <div className="segmented paper-market-switch">
              <button className={market === "a" ? "active" : ""} onClick={() => setMarket("a")}>股票</button>
              <button className={market === "futures" ? "active" : ""} onClick={() => setMarket("futures")}>期货</button>
            </div>
          </div>

          {/* 模式: 普通单 / 条件单 */}
          <label className="paper-field">模式
            <div className="segmented">
              <button className={mode === "order" ? "active" : ""} onClick={() => setMode("order")}>普通单</button>
              <button className={mode === "conditional" ? "active" : ""} onClick={() => setMode("conditional")}>条件单（保护性平仓）</button>
            </div>
          </label>

          {mode === "conditional" && (
            <label className="paper-field">条件类型
              <div className="segmented">
                {COND_KINDS.map(k => (
                  <button key={k} className={condKind === k ? "active" : ""} onClick={() => setCondKind(k)}>{CONDITIONAL_KIND_LABELS[k]}</button>
                ))}
              </div>
            </label>
          )}

          {/* 标的 */}
          <label className="paper-field">标的
            {market === "a" ? (
              <div className="symbol-search paper-symbol">
                <div className="symbol-search-input"><Search size={13} /><input value={query} onChange={e => { setQuery(e.target.value); setSel(null); }} placeholder="代码 / 名称，如 600519 或 茅台…" />{query && <span className="ss-close" onClick={() => { setQuery(""); setSel(null); setResults([]); }}><X size={12} /></span>}</div>
                {query && results.length > 0 && (
                  <div className="symbol-search-drop">
                    {results.map(hit => (
                      <button key={`${hit.type}-${hit.symbol}`} onClick={() => pickSymbol(hit)}>
                        <span className="ss-name">{hit.name}</span><code>{hit.symbol}</code>
                        <em className={`ss-type ${hit.type === "index" ? "ss-index" : "ss-stock"}`}>{hit.type === "index" ? "指数" : "股票"}</em>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="paper-fut-inputs">
                <input value={query} onChange={e => { setQuery(e.target.value); setSel(null); }} placeholder="期货代码，如 AU2608 / RB2610" />
                <input value={futName} onChange={e => setFutName(e.target.value)} placeholder="名称（可选）" />
              </div>
            )}
          </label>

          {/* 方向 */}
          {mode === "order" && (
            <label className="paper-field">方向
              <div className="segmented paper-sides">
                {sides.map(s => (
                  <button key={s} className={`${side === s ? "active" : ""} side-${SIDE_TONE[s]}`} onClick={() => setSide(s)}>{SIDE_LABELS[s]}</button>
                ))}
              </div>
            </label>
          )}

          {/* 价格类型 */}
          {mode === "order" && (
            <label className="paper-field">类型
              <div className="segmented">
                <button className={orderType === "market" ? "active" : ""} onClick={() => setOrderType("market")}>市价</button>
                <button className={orderType === "limit" ? "active" : ""} onClick={() => setOrderType("limit")}>限价</button>
              </div>
            </label>
          )}

          <div className="paper-num-row">
            {mode === "order" ? (
              <label className="paper-field">{orderType === "limit" ? "委托价" : "现价"}<input className="paper-num" value={orderType === "limit" ? price : ""} disabled={orderType === "market"} onChange={e => setPrice(e.target.value)} placeholder={orderType === "market" ? "市价成交" : "价格"} /></label>
            ) : condKind === "trailing_stop" ? (
              <label className="paper-field">回撤比例 (%)<input className="paper-num" value={condPct} onChange={e => setCondPct(e.target.value)} placeholder="如 3 表示 3%" inputMode="decimal" /></label>
            ) : (
              <label className="paper-field">触发价<input className="paper-num" value={condTrigger} onChange={e => setCondTrigger(e.target.value)} placeholder={condKind === "stop_loss" ? "低于此价触发" : "高于此价触发"} inputMode="decimal" /></label>
            )}
            <label className="paper-field">数量<input className="paper-num" value={qty} onChange={e => setQty(e.target.value)} placeholder="手 / 股" inputMode="numeric" /></label>
          </div>

          <button className="primary-btn paper-submit" disabled={busy} onClick={() => void (mode === "order" ? submit() : submitConditional())}>
            {busy ? <RefreshCw className="spin" size={14} /> : <CheckCircle2 size={14} />}
            {mode === "order"
              ? `${SIDE_LABELS[side] || side} ${sel?.symbol || query || (market === "futures" ? "指定代码" : "")}`
              : `${CONDITIONAL_KIND_LABELS[condKind]}条件单 ${sel?.symbol || query || ""}`}
          </button>
          {mode === "order" ? (
            <p className="paper-hint">市价单按实时价撮合；限价买单需 ≥ 现价、卖单需 ≤ 现价才成交，未触发则挂单可撤。股票买入扣全额资金，期货开仓只扣保证金（12%）；所有开仓均先经过预交易风控。</p>
          ) : (
            <p className="paper-hint">条件单为保护性平仓单：仅对已有持仓生效，按最新价监控，触发后自动市价平仓并推送通知；移动止损按持仓期最优价回撤比例触发。挂单与触发均不产生额外费用。</p>
          )}
        </div>

        <div className="paper-lists">
          <div className="segmented paper-list-tabs">
            <button className={tab === "positions" ? "active" : ""} onClick={() => setTab("positions")}>持仓 <b>{positions.length}</b></button>
            <button className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}>今日委托 <b>{orders.length}</b></button>
            <button className={tab === "conditional" ? "active" : ""} onClick={() => setTab("conditional")}>条件单 <b>{condOrders.length}</b></button>
            <button className={tab === "trades" ? "active" : ""} onClick={() => setTab("trades")}>今日成交 <b>{trades.length}</b></button>
          </div>

          <div className="card rank-table-wrap paper-table-wrap">
            {tab === "positions" && (
              positions.length === 0 ? <PaperEmpty text="暂无持仓" /> :
              <table className="rank-table">
                <thead><tr><th>市场</th><th>标的</th><th>方向</th><th className="num">数量</th><th className="num">成本</th><th className="num">现价</th><th className="num">市值</th><th className="num">浮动盈亏</th><th className="num">当日盈亏</th><th></th></tr></thead>
                <tbody>{positions.map(p => (
                  <tr key={`${p.market}-${p.symbol}`}>
                    <td>{p.market === "a" ? "股票" : "期货"}</td>
                    <td><b className="rank-name">{p.name || "—"}</b> <code>{p.symbol}</code></td>
                    <td className={`tone-${POS_SIDE_TONE(p.side_label)}`}>{p.side_label}</td>
                    <td className="num">{Math.abs(p.quantity)}</td>
                    <td className="num">{fmtNum(p.avg_cost)}</td>
                    <td className="num">{fmtNum(p.last_price)}</td>
                    <td className="num">{fmtAmount(p.market_value)}</td>
                    <td className={`num tone-${pnl(p.unrealized_pnl)}`}>{p.unrealized_pnl >= 0 ? "+" : ""}{fmtAmount(p.unrealized_pnl)}</td>
                    <td className={`num tone-${pnl(p.day_pnl)}`}>{p.day_pnl >= 0 ? "+" : ""}{fmtAmount(p.day_pnl)}</td>
                    <td><span className="paper-pre-row">
                      <button className="secondary-btn paper-pre" onClick={() => prefill(p)}>{p.market === "a" ? "卖出" : p.side_label.includes("多") ? "平多" : "平空"}</button>
                      <button className="secondary-btn paper-pre" title="为该持仓创建止损/止盈/移动止损" onClick={() => prefillProtect(p)}>条件</button>
                    </span></td>
                  </tr>
                ))}</tbody>
              </table>
            )}

            {tab === "orders" && (
              orders.length === 0 ? <PaperEmpty text="今日暂无委托" /> :
              <table className="rank-table">
                <thead><tr><th>时间</th><th>标的</th><th>方向</th><th>类型</th><th className="num">价格</th><th className="num">数量</th><th>状态</th><th></th></tr></thead>
                <tbody>{orders.map(o => {
                  const st = STATUS_LABEL[o.status] || STATUS_LABEL.pending;
                  return (
                    <tr key={o.id}>
                      <td><small className="paper-time">{o.created_at.slice(5, 19)}</small></td>
                      <td><b className="rank-name">{o.name || "—"}</b> <code>{o.symbol}</code></td>
                      <td className={`tone-${SIDE_TONE[o.side] || "flat"}`}>{SIDE_LABELS[o.side] || o.side}</td>
                      <td>{o.order_type === "limit" ? "限价" : "市价"}</td>
                      <td className="num">{o.price != null ? fmtNum(o.price) : "市价"}</td>
                      <td className="num">{o.quantity}</td>
                      <td><span className={`paper-status st-${st.cls}`}>{st.label}</span></td>
                      <td>{o.status === "pending" ? <button className="secondary-btn paper-pre" onClick={() => void cancel(o.id)}>撤单</button> : <span className="paper-muted">—</span>}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            )}

            {tab === "conditional" && (
              condOrders.length === 0 ? <PaperEmpty text="暂无条件单" /> :
              <table className="rank-table">
                <thead><tr><th>时间</th><th>标的</th><th>类型</th><th>条件</th><th className="num">数量</th><th>状态</th><th></th></tr></thead>
                <tbody>{condOrders.map(o => {
                  const st = COND_STATUS_LABEL[o.status] || COND_STATUS_LABEL.pending;
                  const cond = o.kind === "trailing_stop"
                    ? `自峰值回撤 ${((o.trailing_pct ?? 0) * 100).toFixed(1)}%`
                    : `触发价 ${fmtNum(o.trigger_price ?? 0)}`;
                  return (
                    <tr key={o.id}>
                      <td><small className="paper-time">{o.created_at.slice(5, 19)}</small></td>
                      <td><b className="rank-name">{o.name || "—"}</b> <code>{o.symbol}</code></td>
                      <td>{CONDITIONAL_KIND_LABELS[o.kind] || o.kind}</td>
                      <td>{cond}</td>
                      <td className="num">{o.quantity}</td>
                      <td><span className={`paper-status st-${st.cls}`}>{st.label}</span></td>
                      <td>{o.status === "pending" ? <button className="secondary-btn paper-pre" onClick={() => void cancelCond(o.id)}>撤销</button> : <span className="paper-muted">—</span>}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            )}

            {tab === "trades" && (
              trades.length === 0 ? <PaperEmpty text="今日暂无成交" /> :
              <table className="rank-table">
                <thead><tr><th>时间</th><th>标的</th><th>方向</th><th className="num">价格</th><th className="num">数量</th><th className="num">手续费</th></tr></thead>
                <tbody>{trades.map(t => (
                  <tr key={t.id}>
                    <td><small className="paper-time">{t.created_at.slice(5, 19)}</small></td>
                    <td><b className="rank-name">{t.name || "—"}</b> <code>{t.symbol}</code></td>
                    <td className={`tone-${SIDE_TONE[t.side] || "flat"}`}>{SIDE_LABELS[t.side] || t.side}</td>
                    <td className="num">{fmtNum(t.price)}</td>
                    <td className="num">{t.quantity}</td>
                    <td className="num">{fmtNum(t.fee)}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PaperEmpty({ text }: { text: string }) {
  return <div className="paper-empty">{text}</div>;
}

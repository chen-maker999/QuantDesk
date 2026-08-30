// 模拟交易页 —— 桌面端 papertrade.tsx 的移动端迁移：
// 资产头、下单表单（股票搜索/期货代码、买卖开平、市价/限价）、
// 持仓 / 今日委托 / 今日成交（表格改为移动端列表）。核算逻辑在引擎侧不变。
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, RefreshCw, RotateCcw, Search, X } from "lucide-react";
import { fmtAmount, fmtNum, searchSymbols, toneOf, type SearchHit } from "../lib/market";
import {
  CONDITIONAL_KIND_LABELS, SIDE_LABELS, cancelConditionalOrder, cancelOrder, createConditionalOrder,
  getAccount, getConditionalOrders, getOrders, getPositions, getRiskGuard, getTrades, placeOrder,
  resetAccount, resumeRiskGuard,
  type ConditionalKind, type ConditionalOrder, type PaperAccount, type PaperOrder,
  type PaperPosition, type PaperTrade, type RiskGuardStatus,
} from "../lib/trade";
import { useApp } from "../App";
import PullToRefresh from "../components/PullToRefresh";

const STOCK_SIDES = ["buy", "sell"] as const;
const FUTURES_SIDES = ["open_long", "open_short", "close_long", "close_short"] as const;
type Side = string;
// 方向语义色(A股红涨绿跌): 买入/开多/平空=红, 卖出/开空/平多=绿
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

export default function TradePage() {
  const { notify, openStock } = useApp();
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
    } catch (e) { notify(e instanceof Error ? e.message : "加载模拟账户失败", "error"); }
  }, [notify]);
  useEffect(() => { void load(); }, [load]);
  // 模拟账户 20s 自动刷新（页面隐藏时暂停）
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 20000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (market === "a") return;
    setSide(FUTURES_SIDES[0]); setQuery(""); setSel(null);
  }, [market]);

  useEffect(() => {
    if (!query.trim() || market !== "a" || sel) { setResults([]); return; }
    const timer = window.setTimeout(async () => {
      try { const r = await searchSymbols(query.trim()); setResults(r.results || []); }
      catch { setResults([]); }
    }, 260);
    return () => window.clearTimeout(timer);
  }, [query, market, sel]);

  const pickSymbol = (hit: SearchHit) => { setSel(hit); setQuery(`${hit.name} ${hit.symbol}`); setResults([]); };

  const submit = async () => {
    const symbol = sel?.symbol || query.trim();
    if (!symbol) { notify("请先输入标的代码", "error"); return; }
    const quantity = Number(qty);
    if (!(quantity > 0)) { notify("请输入大于 0 的数量", "error"); return; }
    if (orderType === "limit" && !(Number(price) > 0)) { notify("限价单需要填写委托价格", "error"); return; }
    setBusy(true);
    try {
      const r = await placeOrder({
        market, symbol, name: market === "a" ? sel?.name : futName || undefined,
        side, order_type: orderType, price: orderType === "limit" ? Number(price) : null, quantity,
      });
      if (!r.ok) notify(r.error || "下单失败", "error");
      else notify(r.status === "filled"
        ? `已成交 ${SIDE_LABELS[side] || side} ${symbol} ×${quantity} @ ${r.price ?? "—"}`
        : `${SIDE_LABELS[side] || side} 委托已挂出（等待成交）`);
      setQty(""); setPrice("");
      void load();
    } catch (e) { notify(e instanceof Error ? e.message : "下单失败", "error"); }
    finally { setBusy(false); }
  };

  const cancel = async (id: number) => {
    try { const r = await cancelOrder(id); notify(r.ok ? "已撤单" : r.error || "撤单失败", r.ok ? "ok" : "error"); void load(); }
    catch (e) { notify(e instanceof Error ? e.message : "撤单失败", "error"); }
  };

  const submitConditional = async () => {
    const symbol = sel?.symbol || query.trim();
    if (!symbol) { notify("请先输入标的代码", "error"); return; }
    const quantity = Number(qty);
    if (!(quantity > 0)) { notify("请输入大于 0 的数量", "error"); return; }
    const trigger = Number(condTrigger);
    const pct = Number(condPct);
    if (condKind === "trailing_stop") {
      if (!(pct > 0 && pct < 100)) { notify("回撤比例需在 0-100 之间", "error"); return; }
    } else if (!(trigger > 0)) { notify("请填写触发价格", "error"); return; }
    setBusy(true);
    try {
      const r = await createConditionalOrder({
        market, symbol, kind: condKind, quantity,
        trigger_price: condKind === "trailing_stop" ? null : trigger,
        trailing_pct: condKind === "trailing_stop" ? pct / 100 : null,
      });
      if (!r.ok) notify(r.error || "条件单创建失败", "error");
      else notify(`条件单已创建：${CONDITIONAL_KIND_LABELS[condKind]} ${symbol} ×${quantity}`);
      setQty(""); setCondTrigger(""); setCondPct("");
      void load();
    } catch (e) { notify(e instanceof Error ? e.message : "条件单创建失败", "error"); }
    finally { setBusy(false); }
  };

  const cancelCond = async (id: number) => {
    try { const r = await cancelConditionalOrder(id); notify(r.ok ? "条件单已撤销" : r.error || "撤销失败", r.ok ? "ok" : "error"); void load(); }
    catch (e) { notify(e instanceof Error ? e.message : "撤销失败", "error"); }
  };

  const doResume = async () => {
    try { const r = await resumeRiskGuard(); notify(r.ok ? "风控熔断已恢复，可继续开仓" : r.error || "恢复失败", r.ok ? "ok" : "error"); void load(); }
    catch (e) { notify(e instanceof Error ? e.message : "恢复失败", "error"); }
  };

  const doReset = () => {
    const now = Date.now();
    if (!armed || now - armed > 3000) {
      setArmed(now);
      if (armedTimer.current) window.clearTimeout(armedTimer.current);
      armedTimer.current = window.setTimeout(() => setArmed(0), 3000);
      return;
    }
    if (armedTimer.current) window.clearTimeout(armedTimer.current);
    setArmed(0);
    void (async () => {
      try { const r = await resetAccount(); notify(r.ok ? "模拟账户已重置（100 万初始资金）" : r.error || "重置失败", r.ok ? "ok" : "error"); void load(); }
      catch (e) { notify(e instanceof Error ? e.message : "重置失败", "error"); }
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
    window.scrollTo({ top: 0, behavior: "smooth" });
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
  const pnl = (v: number | null | undefined) => toneOf(v);

  return <PullToRefresh onRefresh={load}><div className="page">
    <header className="page-head with-actions">
      <div className="ph-title"><h1>模拟交易</h1><p>股票与期货模拟盘 · 只模拟，不接真实券商</p></div>
      <div className="ph-actions">
        <button className="icon-btn" onClick={() => void load()}><RefreshCw size={17} /></button>
        <button className={`icon-btn${armed ? " danger" : ""}`} onClick={doReset}><RotateCcw size={17} /></button>
      </div>
    </header>
    {armed ? <div className="confirm-strip">再点一次右上角按钮确认重置账户（3 秒内）</div> : null}

    <div className="asset-grid">
      <div className="card stat"><small>模拟资产</small><strong className={assetDelta !== 0 ? `tone-${toneOf(assetDelta)}` : ""}>{fmtAmount(acc?.total_asset)}</strong><em>初始 {fmtAmount(acc?.initial_cash)}</em></div>
      <div className="card stat"><small>可用资金</small><strong>{fmtAmount(acc?.cash)}</strong><em>{acc ? `${acc.positions_count} 个持仓` : "—"}</em></div>
      <div className="card stat"><small>持仓市值</small><strong>{fmtAmount(acc?.market_value)}</strong></div>
      <div className="card stat"><small>浮动盈亏</small><strong className={`tone-${pnl(acc?.unrealized_pnl)}`}>{(acc?.unrealized_pnl ?? 0) >= 0 ? "+" : ""}{fmtAmount(acc?.unrealized_pnl)}</strong></div>
      <div className="card stat"><small>当日盈亏</small><strong className={`tone-${pnl(acc?.day_pnl)}`}>{(acc?.day_pnl ?? 0) >= 0 ? "+" : ""}{fmtAmount(acc?.day_pnl)}</strong></div>
      <div className="card stat"><small>已实现</small><strong className={`tone-${pnl(acc?.realized_pnl)}`}>{(acc?.realized_pnl ?? 0) >= 0 ? "+" : ""}{fmtAmount(acc?.realized_pnl)}</strong></div>
    </div>
    {acc?.risk_limits && <div className="risk-policy">风控：单笔 ≤ {(acc.risk_limits.max_order_notional_pct * 100).toFixed(0)}% · 单标的 ≤ {(acc.risk_limits.max_single_position_pct * 100).toFixed(0)}% · 总敞口 ≤ {(acc.risk_limits.max_gross_exposure_pct * 100).toFixed(0)}%</div>}
    {guard && (guard.halted ? (
      <div className="guard-banner halted">
        <div className="gb-text"><b>账户风控熔断中 — 新开仓已禁止</b><span>{guard.halt_reason}（{guard.halted_at}）。平仓不受影响。</span></div>
        <button className="ghost-btn" onClick={() => void doResume()}>恢复交易</button>
      </div>
    ) : (
      <div className="guard-banner ok"><b>风控正常</b><span>日亏熔断 {(guard.config.daily_max_loss_pct * 100).toFixed(0)}% · 连亏 {guard.config.consecutive_loss_limit} 笔熔断</span></div>
    ))}

    <div className="card order-form">
      <div className="form-head">
        <h2>下单</h2>
        <div className="segmented">
          <button className={market === "a" ? "active" : ""} onClick={() => setMarket("a")}>股票</button>
          <button className={market === "futures" ? "active" : ""} onClick={() => setMarket("futures")}>期货</button>
        </div>
      </div>

      <label className="field">模式
        <div className="segmented grow">
          <button className={mode === "order" ? "active" : ""} onClick={() => setMode("order")}>普通单</button>
          <button className={mode === "conditional" ? "active" : ""} onClick={() => setMode("conditional")}>条件单</button>
        </div>
      </label>

      {mode === "conditional" && (
        <label className="field">条件类型
          <div className="segmented grow">
            {COND_KINDS.map(k => <button key={k} className={condKind === k ? "active" : ""} onClick={() => setCondKind(k)}>{CONDITIONAL_KIND_LABELS[k]}</button>)}
          </div>
        </label>
      )}

      <label className="field">标的
        {market === "a" ? (
          <div className="search-box in-form">
            <Search size={14} />
            <input value={query} onChange={e => { setQuery(e.target.value); setSel(null); }} placeholder="代码 / 名称，如 600519 或 茅台" />
            {query && <button className="clear-btn" onClick={() => { setQuery(""); setSel(null); setResults([]); }}><X size={12} /></button>}
            {query && !sel && results.length > 0 && <div className="search-drop">
              {results.map(hit => (
                <button key={`${hit.type}-${hit.symbol}`} onClick={() => pickSymbol(hit)}>
                  <b>{hit.name}</b><code>{hit.symbol}</code><em>{hit.type === "index" ? "指数" : "股票"}</em>
                </button>
              ))}
            </div>}
          </div>
        ) : (
          <div className="fut-inputs">
            <input value={query} onChange={e => { setQuery(e.target.value); setSel(null); }} placeholder="期货代码，如 AU2608" />
            <input value={futName} onChange={e => setFutName(e.target.value)} placeholder="名称（可选）" />
          </div>
        )}
      </label>

      {mode === "order" && (
        <label className="field">方向
          <div className="segmented grow">
            {sides.map(s => <button key={s} className={`${side === s ? "active" : ""} side-${SIDE_TONE[s]}`} onClick={() => setSide(s)}>{SIDE_LABELS[s]}</button>)}
          </div>
        </label>
      )}

      {mode === "order" && (
        <label className="field">类型
          <div className="segmented grow">
            <button className={orderType === "market" ? "active" : ""} onClick={() => setOrderType("market")}>市价</button>
            <button className={orderType === "limit" ? "active" : ""} onClick={() => setOrderType("limit")}>限价</button>
          </div>
        </label>
      )}

      <div className="field-duo">
        {mode === "order" ? (
          <label className="field">{orderType === "limit" ? "委托价" : "现价"}
            <input className="num-input" value={orderType === "limit" ? price : ""} disabled={orderType === "market"} onChange={e => setPrice(e.target.value)} placeholder={orderType === "market" ? "市价成交" : "价格"} inputMode="decimal" />
          </label>
        ) : condKind === "trailing_stop" ? (
          <label className="field">回撤比例 (%)
            <input className="num-input" value={condPct} onChange={e => setCondPct(e.target.value)} placeholder="如 3 表示 3%" inputMode="decimal" />
          </label>
        ) : (
          <label className="field">触发价
            <input className="num-input" value={condTrigger} onChange={e => setCondTrigger(e.target.value)} placeholder={condKind === "stop_loss" ? "低于此价触发" : "高于此价触发"} inputMode="decimal" />
          </label>
        )}
        <label className="field">数量
          <input className="num-input" value={qty} onChange={e => setQty(e.target.value)} placeholder="手 / 股" inputMode="numeric" />
        </label>
      </div>

      <button className="primary-btn" disabled={busy} onClick={() => void (mode === "order" ? submit() : submitConditional())}>
        {busy ? <RefreshCw className="spin" size={14} /> : <CheckCircle2 size={14} />}
        {mode === "order"
          ? `${SIDE_LABELS[side] || side} ${sel?.symbol || query || (market === "futures" ? "指定代码" : "")}`
          : `${CONDITIONAL_KIND_LABELS[condKind]}条件单 ${sel?.symbol || query || ""}`}
      </button>
      {mode === "order" ? (
        <p className="form-hint">市价单按实时价撮合；限价买单需 ≥ 现价、卖单需 ≤ 现价才成交，未触发则挂单可撤。股票买入扣全额资金，期货开仓只扣保证金（12%）。</p>
      ) : (
        <p className="form-hint">条件单为保护性平仓单：仅对已有持仓生效，触发后自动市价平仓并推送通知；移动止损按持仓期最优价回撤比例触发。</p>
      )}
    </div>

    <div className="segmented grow sticky-tabs">
      <button className={tab === "positions" ? "active" : ""} onClick={() => setTab("positions")}>持仓 <b>{positions.length}</b></button>
      <button className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}>委托 <b>{orders.length}</b></button>
      <button className={tab === "conditional" ? "active" : ""} onClick={() => setTab("conditional")}>条件 <b>{condOrders.length}</b></button>
      <button className={tab === "trades" ? "active" : ""} onClick={() => setTab("trades")}>成交 <b>{trades.length}</b></button>
    </div>

    <div className="card list-card">
      {tab === "positions" && (positions.length === 0 ? <div className="list-empty">暂无持仓</div> : positions.map(p => (
        <div className="row multi" key={`${p.market}-${p.symbol}`}>
          <div className="row-top">
            <span className="row-main"><b>{p.name || "—"}</b><code>{p.symbol}</code><em className={`tone-${POS_SIDE_TONE(p.side_label)}`}>{p.side_label}</em></span>
            <span className="row-side">
              <b>{fmtAmount(p.market_value)}</b>
              <em className={`tone-${pnl(p.unrealized_pnl)}`}>{p.unrealized_pnl >= 0 ? "+" : ""}{fmtAmount(p.unrealized_pnl)}</em>
            </span>
          </div>
          <div className="row-sub">
            <span>{Math.abs(p.quantity)} @ 成本 {fmtNum(p.avg_cost)}</span>
            <span>现价 {fmtNum(p.last_price)} · 当日 <em className={`tone-${pnl(p.day_pnl)}`}>{p.day_pnl >= 0 ? "+" : ""}{fmtAmount(p.day_pnl)}</em></span>
            {p.market === "a" && <button className="ghost-btn" onClick={() => openStock({ market: "a", symbol: p.symbol, name: p.name || undefined })}>K线</button>}
            <button className="ghost-btn" onClick={() => prefillProtect(p)}>条件</button>
            <button className="ghost-btn" onClick={() => prefill(p)}>{p.market === "a" ? "卖出" : p.side_label.includes("多") ? "平多" : "平空"}</button>
          </div>
        </div>
      )))}

      {tab === "orders" && (orders.length === 0 ? <div className="list-empty">今日暂无委托</div> : orders.map(o => {
        const st = STATUS_LABEL[o.status] || STATUS_LABEL.pending;
        return <div className="row multi" key={o.id}>
          <div className="row-top">
            <span className="row-main"><b>{o.name || "—"}</b><code>{o.symbol}</code><em className={`tone-${SIDE_TONE[o.side] || "flat"}`}>{SIDE_LABELS[o.side] || o.side}</em></span>
            <span className="row-side"><span className={`st ${st.cls}`}>{st.label}</span></span>
          </div>
          <div className="row-sub">
            <span>{o.created_at.slice(5, 19)} · {o.order_type === "limit" ? `限价 ${fmtNum(o.price)}` : "市价"}</span>
            <span>× {o.quantity}</span>
            {o.status === "pending" ? <button className="ghost-btn" onClick={() => void cancel(o.id)}>撤单</button> : null}
          </div>
        </div>;
      }))}

      {tab === "conditional" && (condOrders.length === 0 ? <div className="list-empty">暂无条件单</div> : condOrders.map(o => {
        const st = COND_STATUS_LABEL[o.status] || COND_STATUS_LABEL.pending;
        const cond = o.kind === "trailing_stop"
          ? `自峰值回撤 ${((o.trailing_pct ?? 0) * 100).toFixed(1)}%`
          : `触发价 ${fmtNum(o.trigger_price ?? 0)}`;
        return <div className="row multi" key={o.id}>
          <div className="row-top">
            <span className="row-main"><b>{o.name || "—"}</b><code>{o.symbol}</code><em>{CONDITIONAL_KIND_LABELS[o.kind] || o.kind}</em></span>
            <span className="row-side"><span className={`st ${st.cls}`}>{st.label}</span></span>
          </div>
          <div className="row-sub">
            <span>{o.created_at.slice(5, 19)} · {cond}</span>
            <span>× {o.quantity}</span>
            {o.status === "pending" ? <button className="ghost-btn" onClick={() => void cancelCond(o.id)}>撤销</button> : null}
          </div>
        </div>;
      }))}

      {tab === "trades" && (trades.length === 0 ? <div className="list-empty">今日暂无成交</div> : trades.map(t => (
        <div className="row multi" key={t.id}>
          <div className="row-top">
            <span className="row-main"><b>{t.name || "—"}</b><code>{t.symbol}</code><em className={`tone-${SIDE_TONE[t.side] || "flat"}`}>{SIDE_LABELS[t.side] || t.side}</em></span>
            <span className="row-side"><b>{fmtNum(t.price)}</b><em>× {t.quantity}</em></span>
          </div>
          <div className="row-sub"><span>{t.created_at.slice(5, 19)}</span><span>手续费 {fmtNum(t.fee)}</span></div>
        </div>
      )))}
    </div>
  </div></PullToRefresh>;
}

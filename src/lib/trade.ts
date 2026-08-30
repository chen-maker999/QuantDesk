// 模拟交易 fetch 层: 股票 + 期货。统一走 backend.engineFetch(自动附带引擎鉴权头)。
import { engineFetch } from "./backend";

export type PaperPosition = {
  market: "a" | "index" | "futures"; symbol: string; name: string | null;
  quantity: number; avg_cost: number; last_price: number;
  market_value: number; unrealized_pnl: number; day_pnl: number;
  side_label: string;
};
export type PaperAccount = {
  ok: boolean; error?: string; updated_at?: string;
  initial_cash: number; cash: number; realized_pnl: number;
  unrealized_pnl: number; market_value: number; total_asset: number;
  day_pnl: number; positions_count: number;
  risk_limits?: PaperRiskLimits;
};
export type PaperRiskLimits = {
  max_order_notional_pct: number; max_single_position_pct: number; max_gross_exposure_pct: number;
  max_futures_margin_pct: number; max_pending_orders: number;
};
export type PaperOrder = {
  id: number; market: string; symbol: string; name: string | null;
  side: string; order_type: string; price: number | null; quantity: number;
  status: "pending" | "filled" | "cancelled"; filled_qty: number; filled_avg: number | null;
  created_at: string; updated_at: string;
};
export type PaperTrade = {
  id: number; order_id: number; market: string; symbol: string; name: string | null;
  side: string; price: number; quantity: number; fee: number; created_at: string;
};
export type OrderPayload = {
  market?: string; symbol: string; name?: string; side: string;
  order_type?: "market" | "limit"; price?: number | null; quantity: number;
};
export type OrderResp = { ok: boolean; error?: string; order_id?: number; status?: string; reason?: string; price?: number; fee?: number; realized_pnl?: number; risk?: Record<string, unknown> };

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await engineFetch(path, init);
  if (!response.ok) throw new Error(`请求失败：${response.status}`);
  return response.json() as Promise<T>;
}
const jsonInit = (body: unknown): RequestInit => ({
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

export const getAccount = (): Promise<PaperAccount> => j("/trade/account");
export const getRiskLimits = (): Promise<{ ok: boolean; limits: PaperRiskLimits }> => j("/trade/risk-limits");
export const updateRiskLimits = (limits: Partial<PaperRiskLimits>): Promise<{ ok: boolean; error?: string; limits?: PaperRiskLimits }> => j("/trade/risk-limits", jsonInit(limits));
export const getPositions = (): Promise<{ ok: boolean; error?: string; positions: PaperPosition[]; market_value: number; unrealized_pnl: number }> => j("/trade/positions");
export const getOrders = (status = ""): Promise<{ ok: boolean; error?: string; orders: PaperOrder[] }> => j(`/trade/orders${status ? `?status=${status}` : ""}`);
export const getTrades = (limit = 50): Promise<{ ok: boolean; error?: string; trades: PaperTrade[] }> => j(`/trade/trades?limit=${limit}`);
export const placeOrder = (p: OrderPayload): Promise<OrderResp> => j("/trade/order", jsonInit(p));
export const cancelOrder = (orderId: number): Promise<OrderResp> => j("/trade/cancel", jsonInit({ order_id: orderId }));
export const resetAccount = (): Promise<{ ok: boolean; error?: string }> => j("/trade/reset", { method: "POST" });

// 账户级风控熔断（risk guard）
export type RiskGuardStatus = {
  ok: boolean; error?: string;
  config: { daily_max_loss_pct: number; consecutive_loss_limit: number };
  halted: boolean; halt_reason: string; halted_at: string; consec_losses: number;
  day_date: string; day_baseline_equity: number | null;
};
export const getRiskGuard = (): Promise<RiskGuardStatus> => j("/trade/risk-guard");
export const updateRiskGuard = (updates: Partial<{ daily_max_loss_pct: number; consecutive_loss_limit: number }>): Promise<RiskGuardStatus> => j("/trade/risk-guard", { ...jsonInit(updates), method: "PUT" });
export const resumeRiskGuard = (): Promise<{ ok: boolean; error?: string }> => j("/trade/risk-guard/resume", { method: "POST" });

// 条件单（止损 / 止盈 / 移动止损，保护性平仓）
export type ConditionalKind = "stop_loss" | "take_profit" | "trailing_stop";
export type ConditionalOrder = {
  id: number; market: string; symbol: string; name: string | null;
  kind: ConditionalKind; trigger_price: number | null; trailing_pct: number | null;
  quantity: number; status: "pending" | "triggered" | "cancelled";
  peak_price: number | null; triggered_order_id: number | null;
  created_at: string; triggered_at: string | null;
};
export const CONDITIONAL_KIND_LABELS: Record<ConditionalKind, string> = {
  stop_loss: "止损", take_profit: "止盈", trailing_stop: "移动止损",
};
export const getConditionalOrders = (status = ""): Promise<{ ok: boolean; error?: string; orders: ConditionalOrder[] }> => j(`/trade/conditional-orders${status ? `?status=${status}` : ""}`);
export const createConditionalOrder = (p: { market: string; symbol: string; kind: ConditionalKind; quantity: number; trigger_price?: number | null; trailing_pct?: number | null }): Promise<{ ok: boolean; error?: string; order_id?: number }> => j("/trade/conditional", jsonInit(p));
export const cancelConditionalOrder = (orderId: number): Promise<{ ok: boolean; error?: string }> => j("/trade/conditional/cancel", jsonInit({ order_id: orderId }));

// 侧边标签映射
export const SIDE_LABELS: Record<string, string> = {
  buy: "买入", sell: "卖出",
  open_long: "开多", open_short: "开空", close_long: "平多", close_short: "平空",
};

// 实盘 OMS fetch 层。凭据不经这里传给引擎：仅由 Tauri 从 Credential Manager 注入。
import { invoke } from "@tauri-apps/api/core";
import { jsonRequest, startEngine } from "./backend";

export type BrokerId = "alpaca" | "ibkr";
export type BrokerStatus = {
  broker: BrokerId; configured: boolean; connected: boolean; trading_mode?: "paper" | "live";
  max_order_notional?: number; max_open_orders?: number; account_id?: string | null;
  gateway_url?: string | null; live_armed_until?: number | null;
  max_daily_loss_pct?: number; max_orders_per_hour?: number; max_position_notional?: number;
  risk?: { orders_last_hour: number; day_start_equity: number | null; breaker_tripped: string | null };
};
export type BrokerOrder = {
  id: string; symbol: string; side: string; order_type: string; quantity: number; filled_quantity: number;
  limit_price: number | null; status: string; submitted_at?: string | null; filled_avg_price: number | null;
};
export type BrokerPosition = {
  symbol: string; contract_id: string; quantity: number; average_price: number; market_price: number;
  market_value: number; unrealized_pnl: number; side: string;
};
export type BrokerCredentials = {
  api_key?: string; api_secret?: string; gateway_url?: string; account_id?: string;
  trading_mode: "paper" | "live"; max_order_notional: number; max_open_orders?: number;
  max_daily_loss_pct?: number; max_orders_per_hour?: number; max_position_notional?: number;
};
export type BrokerOrderInput = {
  symbol: string; side: "buy" | "sell"; quantity: number; order_type: "market" | "limit" | "stop" | "stop_limit";
  estimated_price: number; limit_price?: number; stop_price?: number; contract_id?: string; time_in_force?: "day" | "gtc";
};

const serviceFor = (broker: BrokerId) => broker === "alpaca" ? "BrokerAlpaca" : "BrokerIBKR";

export async function saveBrokerCredentials(broker: BrokerId, credentials: BrokerCredentials): Promise<void> {
  // 通过原有安全 keyring 命令写入；JSON 中的 secret 不进入 localStorage 或后端数据库。
  await invoke("store_api_key", { provider: serviceFor(broker), secret: JSON.stringify(credentials) });
}
export async function hasBrokerCredentials(broker: BrokerId): Promise<boolean> {
  return invoke<boolean>("has_api_key", { provider: serviceFor(broker) });
}
export async function configureBrokerEngine(broker: BrokerId): Promise<void> {
  await startEngine();
  await invoke("configure_broker_engine", { broker });
}

export const listOmsDrafts = (): Promise<{ ok: boolean; drafts: Array<{ id: string; created_at: number; status: string; payload: { note?: string; orders?: Array<Record<string, unknown>> } }> }> => jsonRequest("/brokers/drafts");
export const listBrokers = (): Promise<{ brokers: BrokerStatus[]; live_confirmation: string; live_arm_seconds: number }> => jsonRequest("/brokers");
export const connectBroker = (broker: BrokerId): Promise<BrokerStatus & { account?: Record<string, unknown> }> => jsonRequest(`/brokers/${broker}/connect`, { method: "POST" });
export const getBrokerAccount = (broker: BrokerId): Promise<{ broker: BrokerId; account?: Record<string, unknown>; account_id?: string; summary?: unknown }> => jsonRequest(`/brokers/${broker}/account`);
export const getBrokerPositions = (broker: BrokerId): Promise<{ broker: BrokerId; positions: BrokerPosition[] }> => jsonRequest(`/brokers/${broker}/positions`);
export const getBrokerOrders = (broker: BrokerId): Promise<{ broker: BrokerId; orders: BrokerOrder[] }> => jsonRequest(`/brokers/${broker}/orders`);
export const getBrokerTrades = (broker: BrokerId): Promise<{ broker: BrokerId; trades: unknown[] }> => jsonRequest(`/brokers/${broker}/trades`);
export const lookupIbkrContracts = (symbol: string): Promise<{ contracts: Array<{ contract_id: string; symbol: string; description?: string; asset_class?: string; listing_exchange?: string }> }> => jsonRequest(`/brokers/ibkr/contracts?symbol=${encodeURIComponent(symbol)}`);
export const armBrokerLive = (broker: BrokerId, confirmation: string): Promise<{ live_armed_until: number }> => jsonRequest(`/brokers/${broker}/arm-live`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation }) });
export const disarmBrokerLive = (broker: BrokerId): Promise<{ live_armed_until: null }> => jsonRequest(`/brokers/${broker}/disarm-live`, { method: "POST" });
export const resetBrokerBreaker = (broker: BrokerId): Promise<BrokerStatus> => jsonRequest(`/brokers/${broker}/reset-breaker`, { method: "POST" });
export const placeBrokerOrder = (broker: BrokerId, input: BrokerOrderInput): Promise<{ ok: boolean; response: unknown }> => jsonRequest(`/brokers/${broker}/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
export const cancelBrokerOrder = (broker: BrokerId, orderId: string): Promise<{ ok: boolean }> => jsonRequest(`/brokers/${broker}/orders/${encodeURIComponent(orderId)}`, { method: "DELETE" });

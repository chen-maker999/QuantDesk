// 行情中心 fetch 层: 统一走 backend.engineFetch(自动附带引擎鉴权头)。
import { engineFetch } from "./backend";

export type MarketQuote = {
  market: string; symbol: string; name: string;
  price: number | null; change_pct: number | null; change_amt: number | null;
  open: number | null; high: number | null; low: number | null; prev_close: number | null;
  volume: number | null; amount: number | null; turnover_rate: number | null;
  pe: number | null; pb: number | null; source?: string;
};
export type MarketBar = {
  ts: string; open: number; high: number; low: number; close: number;
  volume: number | null; amount: number | null; change_pct: number | null; turnover_rate: number | null;
};
export type IntradayPoint = { ts: string; price: number | null; avg_price: number | null; volume: number | null };
export type NewsItem = { id: string; title: string; content: string; source: string; time: string; url: string; image?: string };
export type NewsDetail = { ok: boolean; error?: string; title?: string; content?: string; image?: string };
export type SearchHit = { market: string; symbol: string; name: string; type: string };
export type MarketResp<T> = { ok: boolean; error?: string; source?: string; updated_at?: string; stale?: boolean; cached_from_db?: boolean } & T;

async function marketRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await engineFetch(path, init);
  if (!response.ok) throw new Error(`请求失败：${response.status}`);
  return response.json() as Promise<T>;
}

export function getIndices(): Promise<MarketResp<{ indices: MarketQuote[] }>> {
  return marketRequest("/market/indices");
}
export function getQuotes(symbols: string[], market?: string): Promise<MarketResp<{ quotes: MarketQuote[] }>> {
  const query = `symbols=${encodeURIComponent(symbols.join(","))}` + (market ? `&market=${market}` : "");
  return marketRequest(`/market/quotes?${query}`);
}
export type KlineOpts = { market?: "a" | "index"; period?: string; adjust?: string; limit?: number };
export function getKline(symbol: string, opts: KlineOpts = {}): Promise<MarketResp<{ bars: Array<MarketBar | IntradayPoint> }>> {
  const p = new URLSearchParams({ symbol });
  if (opts.market) p.set("market", opts.market);
  if (opts.period) p.set("period", opts.period);
  if (opts.adjust !== undefined) p.set("adjust", opts.adjust);
  if (opts.limit) p.set("limit", String(opts.limit));
  return marketRequest(`/market/kline?${p.toString()}`);
}
export function getRankings(sort = "change_pct", order = "desc", limit = 20): Promise<MarketResp<{ rankings: MarketQuote[] }>> {
  return marketRequest(`/market/rankings?sort=${sort}&order=${order}&limit=${limit}`);
}
export function getNews(limit = 30): Promise<MarketResp<{ news: NewsItem[] }>> {
  return marketRequest(`/market/news?limit=${limit}`);
}
export function getNewsDetail(url: string): Promise<NewsDetail> {
  return marketRequest(`/market/news/detail?url=${encodeURIComponent(url)}`);
}
export function searchSymbols(q: string): Promise<MarketResp<{ results: SearchHit[] }>> {
  return marketRequest(`/market/search?q=${encodeURIComponent(q)}`);
}

// ---------- 富化行情 / 资金流 / 北向 ----------
export type MoneyFlow = {
  main_net: number | null; xl_in: number | null; xl_out: number | null; xl_net: number | null;
  big_in: number | null; big_out: number | null; big_net: number | null;
  mid_in: number | null; mid_out: number | null; mid_net: number | null;
  small_in: number | null; small_out: number | null; small_net: number | null;
};
export type MarketDetail = {
  ok: boolean; error?: string;
  market: string; symbol: string; name?: string;
  price: number | null; open: number | null; high: number | null; low: number | null;
  amount: number | null; price_avg: number | null;
  pb: number | null; pe: number | null;
  market_cap: number | null; float_cap: number | null;
  volume_ratio_raw: number | null; turnover_rate?: number | null;
  money_flow?: MoneyFlow; main_net_5d?: Array<{ ts: string; value: number }> | null;
};
export function getDetail(symbol: string, market = "a"): Promise<MarketDetail> {
  return marketRequest(`/market/detail?symbol=${encodeURIComponent(symbol)}&market=${market}`);
}

export type FflowItem = { ts: string; main_net: number | null; small_net: number | null; mid_net: number | null; big_net: number | null; xl_net: number | null };
export function getFflow(symbol: string, market = "a", limit = 30): Promise<MarketResp<{ items: FflowItem[] }>> {
  return marketRequest(`/market/fflow?symbol=${encodeURIComponent(symbol)}&market=${market}&limit=${limit}`);
}

export type ImportPricesResp = MarketResp<{ symbol: string; market: string; adjust: string; rows: number; start?: string; end?: string; source?: string }>;
export function importDailyPrices(symbol: string, market = "a", adjust = "qfq", limit = 320): Promise<ImportPricesResp> {
  const p = new URLSearchParams({ symbol, market, adjust, limit: String(limit) });
  return marketRequest(`/market/import-prices?${p.toString()}`, { method: "POST" });
}

export type HsgtRow = { name: string; net_buy: number | null; turnover: number | null; quota_left: number | null };
export type HsgtResp = MarketResp<{ available?: boolean; realtime_discontinued?: boolean; net_unavailable?: boolean; rows: HsgtRow[] }>;
export function getHsgt(): Promise<HsgtResp> {
  return marketRequest("/market/hsgt");
}

// ---------- 格式化 / 涨跌色 ----------
// A 股约定: 红涨绿跌(仅行情模块内使用)
export function toneOf(pct: number | null | undefined): "up" | "down" | "flat" {
  if (pct === null || pct === undefined || pct === 0) return "flat";
  return pct > 0 ? "up" : "down";
}
export function fmtPct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return "—";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}
export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "—";
  return v.toFixed(digits);
}
export function fmtAmount(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(2)}万`;
  return v.toFixed(0);
}
export function fmtVolume(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)}亿手`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(2)}万手`;
  return v.toFixed(0);
}

import { invoke } from "@tauri-apps/api/core";

const ENGINE_URL = "http://127.0.0.1:8765";

export type WorkspaceStatus = {
  market_rows: number; market_symbols: number; market_latest: string | null;
  holding_count: number; portfolio_value: number | null; experiment_count: number;
  model_count: number; audit_count: number; agent_configured: boolean;
  market_provider_configured: boolean; market_provider: string | null;
  deepseek_configured: boolean; qwen_configured: boolean;
  tushare_configured: boolean;
};

export type AgentEvent = {
  type: "status" | "narration" | "tool_start" | "tool_result" | "approval" | "message_delta" | "done" | "error" | "cancelled";
  name?: string; label?: string; detail?: string; status?: "running" | "completed"; text?: string;
};

export async function saveApiKey(provider: string, key: string): Promise<void> {
  await invoke("store_api_key", { provider, secret: key });
}

export async function hasApiKey(provider: string): Promise<boolean> {
  return invoke<boolean>("has_api_key", { provider });
}

export async function configureEngine(provider: string): Promise<void> {
  // The key can be stored while autostart is disabled or while the engine was
  // replaced by another process. Always make sure an engine exists before
  // hydrating its in-memory provider state.
  await startEngine();
  let lastError: unknown;
  for(let attempt=0;attempt<12;attempt++){
    try { await invoke("configure_engine", { provider }); return }
    catch(error) { lastError=error; await new Promise(resolve=>setTimeout(resolve,350)) }
  }
  const detail=lastError instanceof Error?lastError.message:String(lastError||"");
  throw new Error(`无法把密钥配置到本地 Agent 引擎${detail?`：${detail}`:""}`);
}

export async function startEngine(): Promise<void> {
  let lastError: unknown;
  for(let attempt=0;attempt<4;attempt++){
    try { await invoke("start_engine"); return }
    catch(error) { lastError=error; await new Promise(resolve=>setTimeout(resolve,300)) }
  }
  throw new Error(lastError instanceof Error?lastError.message:String(lastError||"本地算法引擎启动失败"));
}

// 引擎随机 token 仅由 Tauri 主进程和引擎子进程持有；前端通过受控命令临时取得请求头。
let cachedToken: string | null = null;
async function engineToken(): Promise<string> {
  if (cachedToken === null) {
    try { cachedToken = (await invoke<string>("engine_token")) || "" }
    catch { cachedToken = "" }
  }
  return cachedToken;
}
function invalidateToken(): void { cachedToken = null }

export async function engineFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await engineToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("X-QuantDesk-Token", token);
  const response = await fetch(`${ENGINE_URL}${path}`, { ...init, headers });
  // 引擎重启会换 token：401 时刷新缓存重试一次
  if (response.status === 401 && retry) {
    invalidateToken();
    return engineFetch(path, init, false);
  }
  return response;
}

export async function cancelEngineRun(threadId: string): Promise<void> {
  // 尽力而为：连接中断(abort)通常已让 uvicorn 取消流式生成器，
  // 这里再显式通知引擎在下一个安全点退出，双保险。
  try { await engineFetch(`/agent/cancel/${encodeURIComponent(threadId)}`, { method: "POST" }) } catch { /* ignore */ }
}

// ---------- 因子研究 ----------

export type FactorResult = {
  available: boolean;
  reason?: string;
  factor_name?: string;
  symbols?: string[];
  periods?: number;
  ic_mean?: number;
  ic_ir?: number;
  ic_positive_ratio?: number;
  t_stat?: number;
  long_short_annual?: number;
  layers?: Array<{ layer: number; annual_return: number; sharpe: number }>;
  decay?: Array<{ horizon: number; ic: number }>;
  data_coverage?: { required_columns: string[]; symbols_with_complete_data: number; excluded_symbols: Record<string, string[]> };
};

export async function evaluateFactor(input: { name?: string; code: string; horizon?: number; quantiles?: number }): Promise<FactorResult> {
  return jsonRequest<FactorResult>("/factors/evaluate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: input.name || "custom_factor", code: input.code, horizon: input.horizon ?? 1, quantiles: input.quantiles ?? 5 }) });
}

// ---------- 组合回测 ----------

export type PortfolioBacktestResult = {
  available: boolean;
  reason?: string;
  symbols?: string[];
  weights?: Record<string, number>;
  days?: number;
  start?: string | null;
  end?: string | null;
  nav?: number[];
  nav_dates?: string[];
  benchmark_nav?: number[];
  benchmark_annual_return?: number;
  metrics?: { total_return: number; annual_return: number; annual_volatility: number; sharpe: number; max_drawdown: number; win_rate: number; avg_turnover_per_rebal: number; rebalances: number; total_cost_drag: number };
  attribution?: Record<string, number>;
};

export async function runPortfolioBacktest(input: { weights: Record<string, number>; rebalanceDays?: number; costBps?: number; slippageBps?: number }): Promise<PortfolioBacktestResult> {
  return jsonRequest<PortfolioBacktestResult>("/backtests/portfolio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ weights: input.weights, rebalance_days: input.rebalanceDays ?? 20, cost_bps: input.costBps ?? 12, slippage_bps: input.slippageBps ?? 5 }) });
}

// ---------- 价格/风险预警 ----------

export type PriceAlert = {
  id: string; symbol: string; market: "a" | "index" | "futures";
  kind: string; threshold: number; note: string | null;
  enabled: boolean; createdAt: number; lastTriggeredAt: number | null;
};

export const listAlerts = (): Promise<PriceAlert[]> => jsonRequest("/alerts");

export const saveAlert = (input: Partial<PriceAlert> & { symbol: string; kind: string; threshold: number }): Promise<PriceAlert> =>
  jsonRequest("/alerts", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });

export const deleteAlert = (id: string): Promise<{ ok: boolean }> => jsonRequest(`/alerts/${encodeURIComponent(id)}`, { method: "DELETE" });

// ---------- 通知中心 ----------

export type EngineNotification = { id: number; source: string; title: string; body: string | null; read: boolean; createdAt: number };

export const listNotifications = (limit = 30): Promise<{ notifications: EngineNotification[]; unread: number }> =>
  jsonRequest(`/notifications/recent?limit=${limit}`);

export const markNotificationsRead = (): Promise<{ ok: boolean }> => jsonRequest("/notifications/read", { method: "POST" });

// ---------- 对话线程镜像 ----------

export const fetchServerChats = (): Promise<Array<{ threadId: string; data: string; updatedAt: number }>> => jsonRequest("/chats");

export const pushServerChat = (threadId: string, data: string, updatedAt: number): Promise<{ ok: boolean }> =>
  jsonRequest(`/chats/${encodeURIComponent(threadId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data, updatedAt }) });

export const deleteServerChat = (threadId: string): Promise<{ ok: boolean }> => jsonRequest(`/chats/${encodeURIComponent(threadId)}`, { method: "DELETE" });

// ---------- Webhook 通知设置 ----------

export const getWebhook = (): Promise<{ url: string }> => jsonRequest("/settings/webhook");

export const setWebhook = (url: string): Promise<{ ok: boolean }> =>
  jsonRequest("/settings/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });

export async function jsonRequest<T>(path:string, init?:RequestInit):Promise<T>{
  const response=await engineFetch(path,init);
  if(!response.ok){const body=await response.text();throw new Error(body||`请求失败：${response.status}`)}
  return response.json() as Promise<T>;
}

export async function getWorkspaceStatus():Promise<WorkspaceStatus>{
  return jsonRequest<WorkspaceStatus>("/workspace/status");
}

export async function importMarketRows(rows:Array<{symbol:string;date:string;close:number;open?:number;high?:number;low?:number;volume?:number;amount?:number}>):Promise<WorkspaceStatus>{
  return jsonRequest<WorkspaceStatus>("/workspace/market/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({rows,source:"csv"})});
}

export async function syncMarketData(input:{asset_type:"stock";symbol:string}|{asset_type:"fx";from_symbol:string;to_symbol:string}):Promise<{status:WorkspaceStatus;imported_rows:number;symbol:string;source:string}>{
  return jsonRequest("/workspace/market/sync",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
}

export async function syncTushareData(input:{asset_type:"stock"|"future";symbol:string}):Promise<{status:WorkspaceStatus;imported_rows:number;symbol:string;source:string}>{
  return jsonRequest("/workspace/tushare/sync",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
}

export async function importHoldingRows(rows:Array<{symbol:string;name?:string;quantity:number;avg_cost?:number;market_value?:number}>):Promise<WorkspaceStatus>{
  return jsonRequest<WorkspaceStatus>("/workspace/holdings/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({rows})});
}

export async function runBacktest(returns:number[],signals:number[],costBps:number):Promise<Record<string,unknown>>{
  return jsonRequest<Record<string,unknown>>("/backtests",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({returns,signals,cost_bps:costBps})});
}

export async function getRecentAudit():Promise<Array<{event:string;payload:Record<string,unknown>;created_at:string}>>{
  return jsonRequest("/audit/recent");
}

export type ReasoningLevel = "off" | "low" | "medium" | "high";
export type AccessMode = "ask" | "approve" | "full";

export type EnsembleModel = {
  available: boolean;
  reason?: string;
  rows?: number;
  window?: { start: string; end: string };
  forecast?: { next_return: number; direction: "up" | "down"; ahead_days: number };
  ensemble_weights?: Record<string, number>;
  validation_rmse?: Record<string, number>;
  walk_forward?: { folds: number; backtest?: { hit_rate?: number; annual_return?: number; sharpe?: number; max_drawdown?: number; win_rate?: number } };
};
export type EnsembleResult = {
  available: boolean;
  reason?: string;
  method?: string;
  predict_ahead?: number;
  symbols?: string[];
  models?: Record<string, EnsembleModel>;
};
export async function runEnsemble(symbol?: string, predictAhead = 1): Promise<EnsembleResult> {
  return jsonRequest<EnsembleResult>("/models/ensemble", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: symbol ?? null, predict_ahead: predictAhead }) });
}

export async function syncPublicQuotes(symbols:string[]):Promise<{status:WorkspaceStatus;imported_rows:number;symbols:string[];source:string;errors?:string[]}>{
  return jsonRequest("/workspace/market/public-sync",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({symbols})});
}

export type AgentStreamOptions = {
  prompt: string;
  threadId?: string | null;
  model?: string;
  provider?: string;
  reasoning?: ReasoningLevel;
  accessMode?: AccessMode;
  signal?: AbortSignal;
};

export async function streamAgent(opts: AgentStreamOptions, onEvent: (event: AgentEvent)=>void): Promise<void> {
  const { prompt, threadId, model="gpt-5.4-mini", provider="openai", reasoning: reasoningLevel="medium", accessMode: accessModeOption="ask", signal } = opts;
  const credentialProvider=provider==="deepseek"?"DeepSeek":provider==="qwen"?"Qwen":"OpenAI";
  const hydrate=async()=>{
    await startEngine();
    if(await hasApiKey(credentialProvider))await configureEngine(credentialProvider);
  };
  let receivedAnyEvent=false;
  for(let attempt=0;attempt<2;attempt++){
    if(signal?.aborted)throw new DOMException("Aborted","AbortError");
    try {
      if(attempt===0)await hydrate().catch(()=>undefined);
      const response = await engineFetch("/agent/run", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({prompt,model,provider,reasoning:reasoningLevel,access_mode:accessModeOption,thread_id:threadId||null}), signal });
      if (!response.ok || !response.body) throw new Error(await response.text()||"Agent 引擎不可用");
      const reader=response.body.getReader(); const decoder=new TextDecoder(); let buffer=""; let missingKey=false;
      while(true){
        if(signal?.aborted){await reader.cancel().catch(()=>undefined);throw new DOMException("Aborted","AbortError")}
        const {done,value}=await reader.read(); if(done)break; buffer+=decoder.decode(value,{stream:true});
        const lines=buffer.split("\n"); buffer=lines.pop()||"";
        for(const line of lines){
          if(!line.startsWith("data: "))continue;
          try{
            const event=JSON.parse(line.slice(6)) as AgentEvent;
            if(event.type==="error"&&/尚未配置/.test(event.text||"")&&attempt===0){missingKey=true;continue}
            receivedAnyEvent=true;onEvent(event);
          }catch{/* invalid event ignored */}
        }
      }
      if(missingKey&&attempt===0){await hydrate();continue}
      return;
    } catch(error){
      if(error instanceof DOMException&&error.name==="AbortError")throw error;
      if(attempt===0&&!receivedAnyEvent&&!signal?.aborted){
        try{await hydrate();await new Promise(resolve=>setTimeout(resolve,450));continue}catch{/* the second request reports a stable user-facing error */}
      }
      const detail=error instanceof Error?error.message:String(error||"");
      const connectionError=detail==="Failed to fetch"||error instanceof TypeError;
      onEvent({type:"error",text:connectionError?"无法连接本地 Agent 引擎。已自动重试，请重新启动 QuantDesk 后再试。":detail||"Agent 请求失败"});
      return;
    }
  }
}

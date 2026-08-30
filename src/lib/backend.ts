import { invoke } from "@tauri-apps/api/core";

// 引擎固定监听本机 8765（由桌面端 spawn）；Agent 图表等静态资源也从这里取
export const ENGINE_URL = "http://127.0.0.1:8765";

/** markdown 图片相对路径（/charts/...）补全为引擎绝对地址，供 ReactMarkdown urlTransform 使用。 */
export function resolveEngineAssetUrl(url: string): string {
  return url.startsWith("/charts/") ? `${ENGINE_URL}${url}` : url;
}

export type WorkspaceStatus = {
  market_rows: number; market_symbols: number; market_latest: string | null;
  holding_count: number; portfolio_value: number | null; experiment_count: number;
  model_count: number; audit_count: number; agent_configured: boolean;
  market_provider_configured: boolean; market_provider: string | null;
  deepseek_configured: boolean; qwen_configured: boolean;
  openrouter_configured: boolean;
  tushare_configured: boolean;
};

export type AgentEvent = {
  type: "status" | "narration" | "tool_start" | "tool_result" | "approval" | "message_delta" | "done" | "error" | "cancelled" | "incomplete" | "compacting";
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

// ---------- 账户会话（X-QuantDesk-Session） ----------

export type AuthStatus = { initialized: boolean; authenticated: boolean; user: { username: string } | null };
export type AuthSession = { token: string; expires_at: number; user: { username: string; created_at: number } };

const SESSION_KEY = "quantdesk-session";

function loadStoredSession(): { token: string; expiresAt: number; username: string } | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: string; expiresAt?: number; username?: string };
    if (!parsed.token || !parsed.expiresAt || Date.now() >= parsed.expiresAt) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return { token: parsed.token, expiresAt: parsed.expiresAt, username: parsed.username || "" };
  } catch { return null; }
}

let currentSession = loadStoredSession();
const unauthorizedListeners = new Set<() => void>();

function notifyUnauthorized(): void { for (const listener of unauthorizedListeners) listener(); }

/** 会话失效（401 且令牌重试仍失败）时收到通知；返回取消订阅函数。 */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => { unauthorizedListeners.delete(listener); };
}

function persistSession(session: AuthSession | null): void {
  currentSession = session
    ? { token: session.token, expiresAt: session.expires_at, username: session.user.username }
    : null;
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(currentSession));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* ignore */ }
}

/** 当前登录用户名（未登录为 null）。 */
export function currentUsername(): string | null {
  return currentSession && currentSession.username ? currentSession.username : null;
}

export const getAuthStatus = (): Promise<AuthStatus> => jsonRequest<AuthStatus>("/auth/status");

export async function authLogin(username: string, password: string, totp = ""): Promise<AuthSession> {
  const session = await jsonRequest<AuthSession>("/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, totp }),
  });
  persistSession(session);
  return session;
}

export const totpSetup = (): Promise<{ ok: boolean; secret: string; otpauth_url: string; enabled: boolean }> =>
  jsonRequest("/auth/totp/setup", { method: "POST" });
export const totpConfirm = (totp: string): Promise<{ ok: boolean; enabled: boolean }> =>
  jsonRequest("/auth/totp/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ totp }) });

export async function authRegister(username: string, password: string): Promise<AuthSession> {
  const session = await jsonRequest<AuthSession>("/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  persistSession(session);
  return session;
}

/** 退出登录：尽力通知引擎销毁会话，并清除本地会话。 */
export async function authLogout(): Promise<void> {
  try { await engineFetch("/auth/logout", { method: "POST" }); } catch { /* ignore */ }
  persistSession(null);
}

export async function engineFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await engineToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("X-QuantDesk-Token", token);
  if (currentSession) headers.set("X-QuantDesk-Session", currentSession.token);
  const response = await fetch(`${ENGINE_URL}${path}`, { ...init, headers });
  // 引擎重启会换 token：401 时刷新缓存重试一次（登录/注册等认证接口不重试）
  if (response.status === 401 && retry && !path.startsWith("/auth/")) {
    invalidateToken();
    const retried = await engineFetch(path, init, false);
    if (retried.status === 401) notifyUnauthorized();
    return retried;
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

export type BenchmarkComparison = {
  excess_annual_return: number; alpha_annual: number; beta: number;
  information_ratio: number; tracking_error: number;
};

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
  relative_nav?: number[];
  benchmark?: string;
  benchmark_annual_return?: number;
  comparison?: BenchmarkComparison;
  monthly_returns?: Array<{ month: string; return: number }>;
  metrics?: { total_return: number; annual_return: number; annual_volatility: number; sharpe: number; max_drawdown: number; win_rate: number; avg_turnover_per_rebal: number; rebalances: number; deferred_trades: number; total_cost_drag: number };
  attribution?: Record<string, number>;
};

export async function runPortfolioBacktest(input: { weights: Record<string, number>; rebalanceDays?: number; costBps?: number; slippageBps?: number; benchmark?: string }): Promise<PortfolioBacktestResult> {
  return jsonRequest<PortfolioBacktestResult>("/backtests/portfolio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ weights: input.weights, rebalance_days: input.rebalanceDays ?? 20, cost_bps: input.costBps ?? 12, slippage_bps: input.slippageBps ?? 5, benchmark: input.benchmark?.trim() || "" }) });
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

// ---------- 提供商模型目录（实时 /models，带引擎侧缓存） ----------
export type ProviderModel = { id: string; context?: number; free?: boolean };
export const getProviderModels = (provider: "openai" | "deepseek" | "qwen" | "openrouter"): Promise<{ models: ProviderModel[]; provider: string }> =>
  jsonRequest(`/providers/models?provider=${provider}`);

// Auto 模式当前实际使用的免费模型
export const getAutoModel = (): Promise<{ model: string; preferred: string[] }> =>
  jsonRequest("/providers/auto-model");

export const setWebhook = (url: string): Promise<{ ok: boolean }> =>
  jsonRequest("/settings/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });

// ---------- Web Push（Agent 消息/预警推送到系统通知） ----------

export type PushEngineState = { available: boolean; publicKey?: string; reason?: string; subscriptions?: number };
export const getPushPublicKey = (): Promise<PushEngineState> => jsonRequest("/push/public-key");
export const pushSubscribe = (sub: { endpoint: string; keys: { p256dh: string; auth: string }; userAgent: string }): Promise<{ ok: boolean }> =>
  jsonRequest("/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub) });
export const pushUnsubscribe = (endpoint: string): Promise<{ ok: boolean }> =>
  jsonRequest("/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint }) });
export const pushTest = (): Promise<{ ok: boolean }> => jsonRequest("/push/test", { method: "POST" });

// 引擎错误响应统一为 {"detail": "..."}；提取可读信息
function extractErrorDetail(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
    if (Array.isArray(parsed.detail)) {
      const first = parsed.detail[0] as { msg?: string } | undefined;
      if (first && typeof first.msg === "string") return first.msg;
    }
  } catch { /* plain text */ }
  return body;
}

export async function jsonRequest<T>(path:string, init?:RequestInit):Promise<T>{
  const response=await engineFetch(path,init);
  if(!response.ok){const body=await response.text().catch(()=>"");throw new Error(extractErrorDetail(body)||`请求失败：${response.status}`)}
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

// ---------- Walk-Forward 滚动检验（防过拟合） ----------

export type WalkForwardWindow = {
  train: { start: string; end: string };
  test: { start: string; end: string };
  params: { lookback: number };
  is_sharpe: number;
  oos_sharpe: number;
  oos_annual_return: number;
  oos_max_drawdown: number;
};
export type WalkForwardResult = {
  n_windows: number;
  oos_days: number;
  windows: WalkForwardWindow[];
  combined: { annual_return: number; annual_volatility: number; sharpe: number; max_drawdown: number; win_rate: number; equity_curve: number[] };
  overfit_check: { mean_is_sharpe: number; mean_oos_sharpe: number; degradation: number };
  assumptions: Record<string, unknown>;
};

export async function runWalkForward(input: { returns: number[]; lookbacks: number[]; trainDays: number; testDays: number; costBps: number }): Promise<WalkForwardResult> {
  return jsonRequest<WalkForwardResult>("/backtests/walk-forward", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returns: input.returns, lookbacks: input.lookbacks, train_days: input.trainDays, test_days: input.testDays, cost_bps: input.costBps }) });
}

export async function getRecentAudit():Promise<Array<{event:string;payload:Record<string,unknown>;created_at:string}>>{
  return jsonRequest("/audit/recent");
}

// ---------- Agent 审批中心（pending 提案 + approve/reject） ----------

export type AgentApproval = {
  id: string; tool: string; arguments: Record<string, unknown> | string; thread_id: string | null;
  status: "pending" | "approved" | "rejected"; reason: string | null; result: string | null;
  created_at: number; decided_at: number | null;
  impact?: { destructive?: boolean; warning?: string; [key: string]: unknown };
};
export type AgentApprovalsState = {
  approvals: AgentApproval[]; pending_count: number;
  usage: { day: string; tool_calls: number; runs: number };
  quota: { max_tool_calls: number; max_seconds: number; daily_tool_calls: number };
};
export const listAgentApprovals = (status: "pending" | "approved" | "rejected" | "all" = "pending"): Promise<AgentApprovalsState> =>
  jsonRequest(`/agent/approvals?status=${status}`);
export const approveAgentApproval = (id: string): Promise<{ ok: boolean; tool: string; label: string; detail: string; result: unknown }> =>
  jsonRequest(`/agent/approvals/${encodeURIComponent(id)}/approve`, { method: "POST" });
export const rejectAgentApproval = (id: string): Promise<{ ok: boolean }> =>
  jsonRequest(`/agent/approvals/${encodeURIComponent(id)}/reject`, { method: "POST" });

// ---------- Agent 用量看板（最近 N 天 runs / tool_calls / tokens） ----------

export type AgentUsageDay = { day: string; tool_calls: number; runs: number; tokens: number };
export type AgentUsageStats = {
  totalTokens: number; peakTokens: number; longestChatSeconds: number;
  currentStreak: number; longestStreak: number;
};
export type AgentUsageResult = {
  days: number;
  series: AgentUsageDay[];
  total: { tool_calls: number; runs: number; tokens: number };
  quota: { max_tool_calls: number; max_seconds: number; daily_tool_calls: number };
  stats: AgentUsageStats;
};
export const getAgentUsage = (days = 14): Promise<AgentUsageResult> =>
  jsonRequest(`/agent/usage?days=${days}`);

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
  role?: string;
  signal?: AbortSignal;
};

export async function streamAgent(opts: AgentStreamOptions, onEvent: (event: AgentEvent)=>void): Promise<void> {
  const { prompt, threadId, model="gpt-5.4-mini", provider="openai", reasoning: reasoningLevel="medium", accessMode: accessModeOption="ask", role="general", signal } = opts;
  const credentialProvider=provider==="deepseek"?"DeepSeek":provider==="qwen"?"Qwen":provider==="openrouter"?"OpenRouter":"OpenAI";
  const hydrate=async()=>{
    await startEngine();
    if(await hasApiKey(credentialProvider))await configureEngine(credentialProvider);
  };
  let receivedAnyEvent=false;
  for(let attempt=0;attempt<2;attempt++){
    if(signal?.aborted)throw new DOMException("Aborted","AbortError");
    try {
      if(attempt===0)await hydrate().catch(()=>undefined);
      const response = await engineFetch("/agent/run", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({prompt,model,provider,reasoning:reasoningLevel,access_mode:accessModeOption,role,thread_id:threadId||null}), signal });
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

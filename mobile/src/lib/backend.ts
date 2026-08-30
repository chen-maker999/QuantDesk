// 移动端引擎访问层 —— 由桌面端 src/lib/backend.ts 迁移适配：
// 差异点：手机无法启动本地引擎，也没有 Tauri invoke 可用，改为
// 「引擎地址 + 访问令牌」均保存在 localStorage（设置页可改），
// 作为远程客户端连接局域网/云端正在运行的 QuantDesk 引擎。
// 模型 API Key 仍在桌面端配置（引擎进程内存持有），移动端只读状态。

export const ENGINE_URL_KEY = "mobile-engine-url";
export const ENGINE_TOKEN_KEY = "mobile-engine-token";

export function normalizeEngineUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return "";
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

export function getEngineUrl(): string {
  return normalizeEngineUrl(localStorage.getItem(ENGINE_URL_KEY) || "") || "http://127.0.0.1:8765";
}

export function setEngineUrl(url: string): void {
  const normalized = normalizeEngineUrl(url);
  if (normalized) localStorage.setItem(ENGINE_URL_KEY, normalized);
  else localStorage.removeItem(ENGINE_URL_KEY);
}

export function getEngineToken(): string {
  return (localStorage.getItem(ENGINE_TOKEN_KEY) || "").trim();
}

export function setEngineToken(token: string): void {
  const value = token.trim();
  if (value) localStorage.setItem(ENGINE_TOKEN_KEY, value);
  else localStorage.removeItem(ENGINE_TOKEN_KEY);
}

export type WorkspaceStatus = {
  market_rows: number; market_symbols: number; market_latest: string | null;
  holding_count: number; portfolio_value: number | null; experiment_count: number;
  model_count: number; audit_count: number; agent_configured: boolean;
  market_provider_configured: boolean; market_provider: string | null;
  deepseek_configured: boolean; qwen_configured: boolean;
  openrouter_configured?: boolean;
  tushare_configured: boolean;
};

export type AgentEvent = {
  type: "status" | "narration" | "tool_start" | "tool_result" | "approval" | "message_delta" | "done" | "error" | "cancelled" | "incomplete" | "compacting";
  name?: string; label?: string; detail?: string; status?: "running" | "completed"; text?: string;
};

export type ReasoningLevel = "off" | "low" | "medium" | "high";
export type AccessMode = "ask" | "approve" | "full";

export const emptyStatus: WorkspaceStatus = {
  market_rows: 0, market_symbols: 0, market_latest: null, holding_count: 0, portfolio_value: null,
  experiment_count: 0, model_count: 0, audit_count: 0, agent_configured: false,
  market_provider_configured: false, market_provider: null, deepseek_configured: false,
  qwen_configured: false, tushare_configured: false,
};

// 桌面端把密钥存进 Windows Credential Manager；移动端以引擎内存状态为准
export type ApiProvider = "OpenAI" | "DeepSeek" | "Qwen" | "AlphaVantage" | "Tushare";
export const providerForModel = (model: string): "openai" | "deepseek" | "qwen" | "openrouter" =>
  model === "auto" || model.includes("/") ? "openrouter"
    : model.startsWith("deepseek-") ? "deepseek" : model.startsWith("qwen") ? "qwen" : "openai";
export const providerLabel = (model: string) =>
  providerForModel(model) === "openai" ? "OpenAI" : providerForModel(model) === "deepseek" ? "DeepSeek" : providerForModel(model) === "qwen" ? "Qwen" : "OpenRouter";
export const providerReady = (status: WorkspaceStatus, model: string): boolean => {
  const provider = providerForModel(model);
  return provider === "openai" ? status.agent_configured : provider === "deepseek" ? status.deepseek_configured : provider === "qwen" ? status.qwen_configured : !!status.openrouter_configured;
};

export async function engineFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getEngineToken();
  if (token) headers.set("X-QuantDesk-Token", token);
  if (currentSession) headers.set("X-QuantDesk-Session", currentSession.token);
  let response: Response;
  try {
    response = await fetch(`${getEngineUrl()}${path}`, { ...init, headers });
  } catch {
    throw new Error("无法连接引擎：请检查引擎地址与手机网络（设置 → 引擎连接 → 测试连接）");
  }
  if (response.status === 401) {
    // 登录/注册接口的 401 是业务错误（密码错误等），不触发会话失效
    if (!path.startsWith("/auth/")) notifyUnauthorized();
    throw new Error(currentSession ? "登录会话已过期，请重新登录" : "未登录或访问令牌不匹配：请先登录，或在设置中核对访问令牌");
  }
  return response;
}

// ---------- 账户会话（X-QuantDesk-Session，与桌面端共用引擎账户体系） ----------

export type AuthStatus = { initialized: boolean; authenticated: boolean; user: { username: string } | null };
export type AuthSession = { token: string; expires_at: number; user: { username: string; created_at: number } };

const SESSION_KEY = "mobile-session";

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

/** 会话失效（401）时收到通知；返回取消订阅函数。 */
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

// ---------- 移动端配对码（桌面端「设置 → 安全边界」生成，手机端兑换移动端令牌） ----------

/** 用一次性配对码换取移动端访问令牌并保存。配对接口本身免鉴权，直接裸 fetch。 */
export async function pairRedeem(code: string): Promise<void> {
  const value = code.trim();
  let response: Response;
  try {
    response = await fetch(`${getEngineUrl()}/pair/redeem`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: value }),
    });
  } catch {
    throw new Error("无法连接引擎：请先在上方填写并保存引擎地址");
  }
  const body = await response.text().catch(() => "");
  if (!response.ok) throw new Error(extractErrorDetail(body) || `配对失败：${response.status}`);
  let data: { ok?: boolean; token?: string };
  try { data = JSON.parse(body) as { ok?: boolean; token?: string }; } catch { throw new Error("配对响应异常"); }
  if (!data.ok || !data.token) throw new Error("配对响应异常");
  setEngineToken(data.token);
}

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

export async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await engineFetch(path, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(extractErrorDetail(body) || `请求失败：${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function getWorkspaceStatus(): Promise<WorkspaceStatus> {
  return jsonRequest<WorkspaceStatus>("/workspace/status");
}

// ---------- 提供商模型目录（实时 /models，带引擎侧缓存） ----------
export type ProviderModel = { id: string; context?: number; free?: boolean };
export const getProviderModels = (provider: "openai" | "deepseek" | "qwen" | "openrouter"): Promise<{ models: ProviderModel[]; provider: string }> =>
  jsonRequest(`/providers/models?provider=${provider}`);

// Auto 模式当前实际使用的免费模型
export const getAutoModel = (): Promise<{ model: string; preferred: string[] }> =>
  jsonRequest("/providers/auto-model");

export async function cancelEngineRun(threadId: string): Promise<void> {
  try { await engineFetch(`/agent/cancel/${encodeURIComponent(threadId)}`, { method: "POST" }); } catch { /* ignore */ }
}

export async function testEngineConnection(): Promise<{ ok: boolean; error?: string; status?: WorkspaceStatus; auth?: AuthStatus }> {
  try {
    // 连通性以 /auth/status（免鉴权）为准；数据状态仅在已授权时附带
    const auth = await getAuthStatus();
    try {
      const status = await getWorkspaceStatus();
      return { ok: true, status, auth };
    } catch (e) {
      return { ok: true, auth, error: e instanceof Error ? e.message : "引擎已连接，但尚未授权" };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "连接失败" };
  }
}

// ---------- 引擎通知（桌面端同款 API） ----------

export type EngineNotification = { id: number; source: string; title: string; body: string | null; read: boolean; createdAt: number };
export const listNotifications = (limit = 30): Promise<{ notifications: EngineNotification[]; unread: number }> =>
  jsonRequest(`/notifications/recent?limit=${limit}`);
export const markNotificationsRead = (): Promise<{ ok: boolean }> => jsonRequest("/notifications/read", { method: "POST" });

// ---------- 回测 / 因子研究 / 预警（与桌面端 backend.ts 同款 API） ----------

export async function runBacktest(returns: number[], signals: number[], costBps: number): Promise<Record<string, unknown>> {
  return jsonRequest("/backtests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returns, signals, cost_bps: costBps }) });
}

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
  return jsonRequest("/factors/evaluate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: input.name || "custom_factor", code: input.code, horizon: input.horizon ?? 1, quantiles: input.quantiles ?? 5 }) });
}

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
  return jsonRequest("/backtests/portfolio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ weights: input.weights, rebalance_days: input.rebalanceDays ?? 20, cost_bps: input.costBps ?? 12, slippage_bps: input.slippageBps ?? 5, benchmark: input.benchmark?.trim() || "" }) });
}

export type PriceAlert = {
  id: string; symbol: string; market: "a" | "index" | "futures";
  kind: string; threshold: number; note: string | null;
  enabled: boolean; createdAt: number; lastTriggeredAt: number | null;
};

export const listAlerts = (): Promise<PriceAlert[]> => jsonRequest("/alerts");

export const saveAlert = (input: Partial<PriceAlert> & { symbol: string; kind: string; threshold: number }): Promise<PriceAlert> =>
  jsonRequest("/alerts", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });

export const deleteAlert = (id: string): Promise<{ ok: boolean }> => jsonRequest(`/alerts/${encodeURIComponent(id)}`, { method: "DELETE" });

// ---------- Web Push（Agent 消息/预警推送到手机系统通知） ----------

export type PushEngineState = { available: boolean; publicKey?: string; reason?: string; subscriptions?: number };
export const getPushPublicKey = (): Promise<PushEngineState> => jsonRequest("/push/public-key");
export const pushSubscribe = (sub: { endpoint: string; keys: { p256dh: string; auth: string }; userAgent: string }): Promise<{ ok: boolean }> =>
  jsonRequest("/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub) });
export const pushUnsubscribe = (endpoint: string): Promise<{ ok: boolean }> =>
  jsonRequest("/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint }) });
export const pushTest = (): Promise<{ ok: boolean }> => jsonRequest("/push/test", { method: "POST" });

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

// ---------- Agent 用量看板（最近 N 天 runs / tool_calls） ----------

export type AgentUsageDay = { day: string; tool_calls: number; runs: number };
export type AgentUsageResult = {
  days: number;
  series: AgentUsageDay[];
  total: { tool_calls: number; runs: number };
  quota: { max_tool_calls: number; max_seconds: number; daily_tool_calls: number };
};
export const getAgentUsage = (days = 14): Promise<AgentUsageResult> =>
  jsonRequest(`/agent/usage?days=${days}`);

// ---------- 对话线程镜像（与桌面端共用引擎 SQLite） ----------

export const fetchServerChats = (): Promise<Array<{ threadId: string; data: string; updatedAt: number }>> => jsonRequest("/chats");
export const pushServerChat = (threadId: string, data: string, updatedAt: number): Promise<{ ok: boolean }> =>
  jsonRequest(`/chats/${encodeURIComponent(threadId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data, updatedAt }) });
export const deleteServerChat = (threadId: string): Promise<{ ok: boolean }> =>
  jsonRequest(`/chats/${encodeURIComponent(threadId)}`, { method: "DELETE" });

// ---------- Agent 流式运行（SSE，与桌面端协议一致） ----------

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

export async function streamAgent(opts: AgentStreamOptions, onEvent: (event: AgentEvent) => void): Promise<void> {
  const { prompt, threadId, model = "gpt-5.4-mini", provider = "openai", reasoning: reasoningLevel = "medium", accessMode: accessModeOption = "ask", role = "general", signal } = opts;
  const response = await engineFetch("/agent/run", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, model, provider, reasoning: reasoningLevel, access_mode: accessModeOption, role, thread_id: threadId || null }),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(await response.text() || "Agent 引擎不可用");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    if (signal?.aborted) { await reader.cancel().catch(() => undefined); throw new DOMException("Aborted", "AbortError"); }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try { onEvent(JSON.parse(line.slice(6)) as AgentEvent); } catch { /* invalid event ignored */ }
    }
  }
}

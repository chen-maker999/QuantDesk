import { deleteServerChat, fetchServerChats, pushServerChat, type AgentEvent } from "./backend";

export type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  events: AgentEvent[];
  at: number;
};

export type ChatThread = {
  id: string;
  title: string;
  turns: ChatTurn[];
  model: string;
  updatedAt: number;
};

const LIST_KEY = "quant-chats";
const ACTIVE_KEY = "quant-chat-active";
// 对话同时镜像到本地引擎 SQLite(见 syncThreadsFromServer / pushServerChat),
// localStorage 仅作快速缓存;上限放宽到 200 条。
const MAX_THREADS = 200;

export function chatId(): string {
  return `c${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function saveThreadsRaw(threads: ChatThread[]): void {
  localStorage.setItem(LIST_KEY, JSON.stringify(threads.slice(0, MAX_THREADS)));
}

export function loadThreads(): ChatThread[] {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatThread[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 兼容旧调用: 只写本地缓存。 */
export function saveThreads(threads: ChatThread[]): void {
  saveThreadsRaw(threads);
}

export function upsertThread(thread: ChatThread): void {
  saveThreadsRaw([thread, ...loadThreads().filter(item => item.id !== thread.id)]);
  // 镜像到引擎 SQLite(尽力而为, 失败静默——下次启动会重新合并)
  void pushServerChat(thread.id, JSON.stringify(thread), thread.updatedAt || Date.now()).catch(() => undefined);
}

export function deleteThread(id: string): void {
  saveThreadsRaw(loadThreads().filter(item => item.id !== id));
  if (getActiveChatId() === id) setActiveChatId(null);
  void deleteServerChat(id).catch(() => undefined);
}

/**
 * 启动时把引擎 SQLite 里保存的对话合并回本地(按 updatedAt 取新)。
 * 解决 localStorage 容量小、被清理即丢历史的问题。
 */
export async function syncThreadsFromServer(): Promise<void> {
  try {
    const rows = await fetchServerChats();
    const byId = new Map<string, ChatThread>();
    for (const t of loadThreads()) byId.set(t.id, t);
    for (const row of rows) {
      try {
        const remote = JSON.parse(row.data) as ChatThread;
        if (!remote?.id) continue;
        const current = byId.get(remote.id);
        if (!current || (remote.updatedAt || 0) > (current.updatedAt || 0)) byId.set(remote.id, { ...remote, updatedAt: row.updatedAt || remote.updatedAt });
      } catch { /* 单条损坏忽略 */ }
    }
    const merged = [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    saveThreadsRaw(merged);
  } catch { /* 引擎不可用: 继续用本地缓存 */ }
}

export function getActiveChatId(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

export function setActiveChatId(id: string | null): void {
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
}

export function loadThread(id: string | null): ChatThread | null {
  if (!id) return null;
  return loadThreads().find(item => item.id === id) || null;
}

export function titleFromPrompt(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.slice(0, 28) || "新对话";
}

export function assistantText(events: AgentEvent[]): string {
  return events.filter(event => event.type === "done" || event.type === "narration").map(event => event.text || "").join("\n").trim();
}

export function mergeAgentEvent(current: AgentEvent[], event: AgentEvent): AgentEvent[] {
  if (event.type === "narration") {
    const last = current[current.length - 1];
    if (last?.type === "narration") return [...current.slice(0, -1), { ...last, text: (last.text || "") + (event.text || "") }];
    return [...current, event];
  }
  if (event.type === "message_delta") {
    const last = current[current.length - 1];
    if (last?.type === "done") return [...current.slice(0, -1), { ...last, text: (last.text || "") + (event.text || "") }];
    return [...current, { type: "done", text: event.text || "" }];
  }
  if (event.type === "done" && current[current.length - 1]?.type === "done") return current;
  if (event.type === "compacting") {
    // 压缩进度成对到达（running→completed）：完成事件合并进最近一条未完成的分割线
    if (event.status === "completed") {
      const index = [...current].map((item, i) => ({ item, i })).reverse().find(entry => entry.item.type === "compacting" && entry.item.status === "running")?.i;
      if (index !== undefined) {
        const next = [...current];
        next[index] = { ...next[index], status: "completed" };
        return next;
      }
    }
    return [...current, event];
  }
  if (event.type === "tool_result") {
    const index = [...current].map((item, i) => ({ item, i })).reverse().find(entry => entry.item.type === "tool_start" && entry.item.name === event.name)?.i;
    if (index !== undefined) {
      const next = [...current];
      next[index] = event;
      return next;
    }
  }
  return [...current, event];
}

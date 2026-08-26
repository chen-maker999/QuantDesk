// 定时任务调度：引擎 SQLite 持久化(前端与 Agent 共用) + 前台 setInterval 轮询。
// 引擎不可达时回退 localStorage 缓存,引擎恢复后再同步。
// 类似 ChatGPT 的定时任务：到点自动运行 Agent，并记录运行历史。
import { jsonRequest } from "./backend";
export type TaskFrequency = "once" | "hourly" | "daily" | "weekly" | "interval";
export type TaskRunStatus = "done" | "error";

export type ScheduledTask = {
  id: string;
  name: string;
  prompt: string;
  frequency: TaskFrequency;
  hour?: number;          // 0-23，用于 once/daily/weekly
  minute?: number;        // 0-59
  weekdays?: number[];    // 0=周日 … 6=周六，用于 weekly
  intervalMinutes?: number; // 用于 interval
  model?: string;         // 留空则用当前默认模型
  provider?: string;      // 留空则按模型推断（openai | deepseek | qwen）
  reasoning?: "off" | "low" | "medium" | "high";
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastStatus?: "idle" | "running" | "done" | "error";
  lastResult?: string;
  history: Array<{ at: number; status: TaskRunStatus; preview: string }>;
};

const KEY = "quant-scheduled-tasks";

// 引擎返回的字段允许 null,统一归一成可选字段,避免类型不严谨。
function normalize(t: ScheduledTask): ScheduledTask {
  return {
    ...t,
    weekdays: t.weekdays?.length ? t.weekdays : undefined,
    model: t.model || undefined,
    provider: t.provider || undefined,
    reasoning: t.reasoning || undefined,
    lastRunAt: t.lastRunAt ?? undefined,
    lastStatus: t.lastStatus ?? undefined,
    lastResult: t.lastResult ?? undefined,
  };
}

export async function getTasks(): Promise<ScheduledTask[]> {
  const data = await jsonRequest<{ ok: boolean; tasks: ScheduledTask[] }>("/scheduler/tasks");
  return (data.tasks || []).map(normalize);
}

export async function putTask(task: ScheduledTask): Promise<void> {
  await jsonRequest<{ ok: boolean }>("/scheduler/tasks", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(normalize(task)),
  });
}

export async function deleteTask(id: string): Promise<void> {
  await jsonRequest<{ ok: boolean }>(`/scheduler/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// 立即运行: 引擎侧执行(无 SSE), 返回时任务状态已落库。
export async function runTaskNow(id: string): Promise<void> {
  await jsonRequest<{ ok: boolean }>(`/scheduler/tasks/${encodeURIComponent(id)}/run`, { method: "POST" });
}

// 内存缓存:引擎离线时仍能返回最近一次已知列表,避免每次轮询都穿透到 localStorage。
let cached: ScheduledTask[] | null = null;

export async function loadTasks(): Promise<ScheduledTask[]> {
  try {
    const list = (await getTasks()).map(normalize);
    cached = list;
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* 忽略存储失败 */ }
    return list;
  } catch {
    if (cached) return cached;
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? (JSON.parse(raw) as ScheduledTask[]) : [];
      return Array.isArray(parsed) ? parsed.map(normalize) : [];
    } catch {
      return [];
    }
  }
}

export async function saveTasks(tasks: ScheduledTask[]): Promise<void> {
  cached = tasks;
  try { localStorage.setItem(KEY, JSON.stringify(tasks)); } catch { /* 忽略存储失败 */ }
  // 只做 upsert,不做 diff 删除:引擎是与 Agent 共享的单一事实源,
  // Agent 可能刚创建了前端尚未加载的任务,这里的删除只该由 deleteTask 显式触发。
  try {
    await Promise.all(tasks.map(t => putTask(t).catch(() => undefined)));
  } catch { /* 引擎离线 — localStorage 缓存继续生效,引擎恢复后自动同步 */ }
}

// 用于调度轮询判断列表是否实质变化(避免每 15s 无条件触发一次 re-render)。
export function tasksEqual(a: ScheduledTask[], b: ScheduledTask[]): boolean {
  if (a.length !== b.length) return false;
  const key = (t: ScheduledTask) => `${t.id}|${t.enabled}|${t.lastStatus}|${t.lastRunAt ?? ""}`;
  const keys = new Set(a.map(key));
  return b.every(t => keys.has(key(t)));
}

// 计算任务下一次触发时间戳；disabled 或一次性已过期返回 null。
export function nextRun(task: ScheduledTask): number | null {
  if (!task.enabled) return null;
  const now = new Date();
  if (task.frequency === "once") {
    const d = new Date(now);
    d.setHours(task.hour ?? 9, task.minute ?? 0, 0, 0);
    return d.getTime() > now.getTime() ? d.getTime() : null;
  }
  if (task.frequency === "interval") {
    const step = Math.max(1, task.intervalMinutes || 60) * 60 * 1000;
    const last = task.lastRunAt;
    if (!last) return now.getTime() + step; // 首次运行在创建后一个间隔
    return last + step; // 可能已过期 → 下一次检查时立即触发
  }
  if (task.frequency === "hourly") {
    const d = new Date(now);
    d.setMinutes(task.minute ?? 0, 0, 0);
    if (d.getTime() <= now.getTime()) d.setHours(d.getHours() + 1);
    return d.getTime();
  }
  if (task.frequency === "daily") {
    const d = new Date(now);
    d.setHours(task.hour ?? 9, task.minute ?? 0, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // weekly
  const weekdays = task.weekdays?.length ? task.weekdays : [now.getDay()];
  for (let i = 0; i < 8; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    d.setHours(task.hour ?? 9, task.minute ?? 0, 0, 0);
    if (d.getTime() <= now.getTime()) continue;
    if (weekdays.includes(d.getDay())) return d.getTime();
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function describeNext(task: ScheduledTask): string {
  const t = nextRun(task);
  if (t === null) return task.enabled ? "已到期/不再运行" : "已关闭";
  const d = new Date(t);
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 ${weekday} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function describeFrequency(task: ScheduledTask): string {
  switch (task.frequency) {
    case "once": return "一次性";
    case "hourly": return "每小时";
    case "daily": return "每天";
    case "weekly": return "每周";
    case "interval": return `每 ${Math.max(1, task.intervalMinutes || 60)} 分钟`;
  }
}

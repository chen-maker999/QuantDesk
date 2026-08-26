// 后台 Agent 运行 store:与"正在显示的线程"解耦。
// 一次运行绑定到发起它的 threadId,事件持续写入该线程(localStorage);
// 切换会话/离开 Agent 页都不中断。完成时若用户不在看该线程则记 unread,
// 历史卡片据此显示蓝点。
//
// Codex 风格能力:
// - 取消: 每个运行中的线程持有 AbortController,取消时中断 fetch 并通知引擎;
// - 排队: 线程忙时新任务进入该线程的队列(消息先以"排队"胶囊展示,不入正文),
//   当前运行结束后自动按序启动下一条。
import { cancelEngineRun, streamAgent, type AccessMode, type AgentEvent, type ReasoningLevel } from "./backend";
import { assistantText, loadThread, mergeAgentEvent, upsertThread } from "./chats";

export type RunStatus = "queued" | "running" | "done" | "error" | "cancelled";

type RunInfo = { status: RunStatus; at: number; unread: boolean };

export type QueuedRun = { displayText: string };

type LaunchOptions = {
  threadId: string;
  prompt: string; // 给引擎的完整 prompt(含权限/角色等前缀)
  displayText: string; // 用户输入的原始文本(排队胶囊展示用)
  model: string;
  provider: string;
  reasoning: ReasoningLevel;
  accessMode: AccessMode;
  onError?: (message: string) => void;
  onFinished?: () => void;
  onStart?: () => void; // 实际启动时调用(排队任务等到此刻才写入正文)
};

const runs = new Map<string, RunInfo>();
const controllers = new Map<string, AbortController>();
const pendingOpts = new Map<string, LaunchOptions[]>();
const listeners = new Set<() => void>();
let activeThreadId: string | null = null;

function emit() {
  for (const cb of listeners) cb();
}

export function onRunsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getRunInfo(threadId: string): RunInfo | undefined {
  return runs.get(threadId);
}

export function isThreadRunning(threadId: string | null | undefined): boolean {
  return !!threadId && runs.get(threadId)?.status === "running";
}

export function isThreadBusy(threadId: string | null | undefined): boolean {
  const status = threadId ? runs.get(threadId)?.status : undefined;
  return status === "running" || status === "queued";
}

/** 该线程是否有一条"已完成但还没点开"的运行(历史卡片蓝点)。 */
export function hasUnreadRun(threadId: string): boolean {
  return runs.get(threadId)?.unread ?? false;
}

/** 汇报当前正在查看的线程;点开某线程时顺带清除它的未读标记。 */
export function setActiveThread(threadId: string | null): void {
  activeThreadId = threadId;
  if (threadId) {
    const info = runs.get(threadId);
    if (info?.unread) {
      info.unread = false;
      emit();
    }
  }
}

/** 删除线程时清掉它的运行记录与队列(取消写回 + 中断 fetch)。 */
export function forgetRun(threadId: string): void {
  const controller = controllers.get(threadId);
  if (controller) {
    controller.abort();
    controllers.delete(threadId);
    void cancelEngineRun(threadId);
  }
  pendingOpts.delete(threadId);
  runs.delete(threadId);
}

function applyEvent(threadId: string, event: AgentEvent): void {
  // 引擎的 cancelled 事件统一转成 status 文本块展示
  const normalized: AgentEvent = event.type === "cancelled" ? { type: "status", text: event.text || "已取消本次运行。" } : event;
  const current = loadThread(threadId);
  if (!current) return; // 线程已被删除 → 不再写回,避免"复活"
  const turns = [...current.turns];
  const last = turns[turns.length - 1];
  if (last?.role !== "assistant") return;
  const events = mergeAgentEvent(last.events, normalized);
  const next = { ...current, turns: [...turns.slice(0, -1), { ...last, events, text: assistantText(events) }], updatedAt: Date.now() };
  upsertThread(next);
}

function launch(opts: LaunchOptions): void {
  const { threadId } = opts;
  const controller = new AbortController();
  controllers.set(threadId, controller);
  runs.set(threadId, { status: "running", at: Date.now(), unread: false });
  opts.onStart?.();
  emit();
  let failed = false;
  let aborted = false;
  const finish = (status: RunStatus) => {
    if (controllers.get(threadId) === controller) controllers.delete(threadId);
    runs.set(threadId, { status, at: Date.now(), unread: status === "done" && threadId !== activeThreadId });
    emit();
    opts.onFinished?.();
    // 队列:当前运行结束后自动启动同线程的下一条
    const list = pendingOpts.get(threadId);
    const next = list?.shift();
    if (list && list.length === 0) pendingOpts.delete(threadId);
    if (next) launch(next);
    else emit();
  };
  streamAgent(
    { prompt: opts.prompt, threadId, model: opts.model, provider: opts.provider, reasoning: opts.reasoning, accessMode: opts.accessMode, signal: controller.signal },
    event => {
      if (event.type === "error" && !failed && !aborted) {
        failed = true;
        opts.onError?.(event.text || "Agent 任务失败");
      }
      applyEvent(threadId, event);
      emit();
    },
  )
    .then(() => finish(aborted ? "cancelled" : failed ? "error" : "done"))
    .catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        aborted = true;
        applyEvent(threadId, { type: "cancelled", text: "已停止本次运行。" });
        finish("cancelled");
        return;
      }
      const message = error instanceof Error ? error.message : String(error || "Agent 运行失败");
      if (!failed && !aborted) {
        failed = true;
        opts.onError?.(message);
      }
      applyEvent(threadId, { type: "error", text: message });
      finish("error");
    });
}

/**
 * 启动一次 Agent 运行。线程空闲 → 立即启动(onStart 同步回调,负责写入用户/助手占位轮);
 * 线程忙 → 进入队列,onStart 延迟到实际启动时才触发。
 */
export function startAgentRun(opts: LaunchOptions): void {
  const { threadId } = opts;
  const current = runs.get(threadId);
  if (current?.status === "running") {
    const list = pendingOpts.get(threadId) || [];
    list.push(opts);
    pendingOpts.set(threadId, list);
    runs.set(threadId, { status: "queued", at: current.at, unread: false });
    emit();
    return;
  }
  launch(opts);
}

/** 取消运行中的任务:中断 fetch + 请求引擎在安全点退出。 */
export function cancelAgentRun(threadId: string): void {
  const controller = controllers.get(threadId);
  if (!controller) return;
  controller.abort();
  void cancelEngineRun(threadId);
}

/** 移除队列中第 index 条排队任务(尚未入正文,直接丢弃即可)。 */
export function removeQueuedRun(threadId: string, index: number): void {
  const list = pendingOpts.get(threadId);
  if (list && index >= 0 && index < list.length) {
    list.splice(index, 1);
    if (list.length === 0) {
      pendingOpts.delete(threadId);
      if (!isThreadRunning(threadId)) runs.delete(threadId);
    }
    emit();
  }
}

/** 展示用:某线程的排队消息列表。 */
export function getQueue(threadId: string | null | undefined): QueuedRun[] {
  if (!threadId) return [];
  return (pendingOpts.get(threadId) || []).map(item => ({ displayText: item.displayText }));
}

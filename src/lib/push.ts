// 桌面端 Web Push 订阅流程（WebView2 下 tauri.localhost 为安全上下文可用）。
// 与 mobile/src/lib/push.ts 逻辑一致；引擎调用由调用方以回调注入。
export type PushPermission = "granted" | "denied" | "default";
export type PushEngineState = { available: boolean; publicKey?: string; reason?: string; subscriptions?: number };

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function currentPermission(): PushPermission {
  if (!pushSupported()) return "denied";
  return Notification.permission as PushPermission;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return null;
  }
}

export async function existingSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = window.atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const PUSH_ENABLED_KEY = "quant-push-enabled";

export function pushEnabledFlag(): boolean {
  return localStorage.getItem(PUSH_ENABLED_KEY) === "1";
}

export async function enablePush(
  fetchPublicKey: () => Promise<PushEngineState>,
  reportSubscription: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) => Promise<unknown>,
): Promise<{ ok: boolean; error?: string }> {
  if (!pushSupported()) return { ok: false, error: "当前环境不支持 Web Push（需 WebView2/Chromium 安全上下文）" };
  let permission = currentPermission();
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, error: permission === "denied" ? "通知权限已被拒绝，请在系统设置中允许通知" : "通知权限未授予" };

  const reg = (await registerServiceWorker()) || (await navigator.serviceWorker.getRegistration());
  if (!reg) return { ok: false, error: "Service Worker 注册失败" };

  const engine = await fetchPublicKey();
  if (!engine.available || !engine.publicKey) return { ok: false, error: engine.reason || "引擎未启用 Web Push（需安装 pywebpush）" };

  const old = await reg.pushManager.getSubscription();
  if (old) await old.unsubscribe().catch(() => undefined);

  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(engine.publicKey) });
  const json = sub.toJSON();
  const keys = (json.keys || {}) as { p256dh?: string; auth?: string };
  if (!keys.p256dh || !keys.auth) return { ok: false, error: "订阅缺少加密密钥" };

  await reportSubscription({ endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
  localStorage.setItem(PUSH_ENABLED_KEY, "1");
  return { ok: true };
}

export async function disablePush(
  revokeSubscription: (endpoint: string) => Promise<unknown>,
): Promise<void> {
  const sub = await existingSubscription();
  if (sub) {
    await revokeSubscription(sub.endpoint).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
  localStorage.setItem(PUSH_ENABLED_KEY, "0");
}

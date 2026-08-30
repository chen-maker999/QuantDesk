// QuantDesk Mobile Service Worker
// 负责 Web Push 展示与点击聚焦；无缓存逻辑（行情数据必须实时，不做离线拦截）。
const ICON = "./icon-512.png";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { title: "QuantDesk", body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(data.title || "QuantDesk", {
      body: data.body || "",
      tag: data.tag || `quantdesk-${data.source || "general"}`,
      icon: ICON,
      badge: ICON,
      data: { url: data.url || "./" },
      renotify: true,
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});

// 订阅被推送服务吊销时，通知页面重新订阅
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) client.postMessage({ type: "push-subscription-expired" });
    }),
  );
});

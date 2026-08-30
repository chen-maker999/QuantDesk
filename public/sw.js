// QuantDesk Desktop Service Worker（WebView2/Chromium 安全上下文下启用 Web Push）
// 仅负责系统通知展示与点击聚焦；不做资源缓存（行情数据必须实时）。
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
      data: { url: data.url || "/" },
      renotify: true,
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});

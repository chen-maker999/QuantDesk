// 自选股列表（移动端特色功能）：localStorage 持久化，桌面端暂不涉及。
// 行情页「自选」Tab 与个股页 ★ 按钮共用。
export type WatchItem = { market: "a" | "index"; symbol: string; name: string };

const KEY = "mobile-watchlist";
const listeners = new Set<() => void>();

export function loadWatchlist(): WatchItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x: WatchItem) => x && x.symbol) : [];
  } catch { return []; }
}

function save(items: WatchItem[]) {
  localStorage.setItem(KEY, JSON.stringify(items));
  listeners.forEach(fn => fn());
}

export const isWatched = (market: string, symbol: string) =>
  loadWatchlist().some(x => x.market === market && x.symbol === symbol);

export function toggleWatch(item: WatchItem): boolean {
  const items = loadWatchlist();
  const exists = items.findIndex(x => x.market === item.market && x.symbol === item.symbol);
  if (exists >= 0) { items.splice(exists, 1); save(items); return false; }
  items.unshift({ market: item.market, symbol: item.symbol, name: item.name || item.symbol });
  save(items);
  return true;
}

export function removeFromWatchlist(market: string, symbol: string) {
  save(loadWatchlist().filter(x => !(x.market === market && x.symbol === symbol)));
}

export function onWatchlistChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

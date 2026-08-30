// 移动端下拉刷新：在页面根部监听触摸，仅当滚动容器位于顶部且向下拖动时触发。
// 拖动距离 0.45 阻尼、超过 44px 松手刷新。依赖 body 的 overscroll-behavior 抑制原生回弹。
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

export default function PullToRefresh({ onRefresh, children }: { onRefresh: () => Promise<unknown> | unknown; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [dist, setDist] = useState(0);
  const [busy, setBusy] = useState(false);
  const state = useRef({ startY: 0, pulling: false, dist: 0 });

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const scrollerOf = (target: EventTarget | null): HTMLElement | null =>
      target instanceof Element ? target.closest(".app-main") : null;

    const onStart = (e: TouchEvent) => {
      if (busy) return;
      const scroller = scrollerOf(e.target);
      if (!scroller || scroller.scrollTop > 2) return;
      state.current.startY = e.touches[0].clientY;
      state.current.pulling = true;
    };
    const onMove = (e: TouchEvent) => {
      if (!state.current.pulling || busy) return;
      const scroller = scrollerOf(e.target);
      if (!scroller || scroller.scrollTop > 2) { state.current.pulling = false; setDist(0); state.current.dist = 0; return; }
      const dy = e.touches[0].clientY - state.current.startY;
      if (dy <= 0) { setDist(0); state.current.dist = 0; return; }
      const d = Math.min(Math.round(dy * 0.45), 64);
      state.current.dist = d;
      setDist(d);
    };
    const onEnd = async () => {
      if (!state.current.pulling) return;
      state.current.pulling = false;
      const d = state.current.dist;
      state.current.dist = 0;
      if (d >= 44 && !busy) {
        setBusy(true);
        setDist(40);
        try { await onRefresh(); } catch { /* 页面自行提示 */ }
        setBusy(false);
      }
      setDist(0);
    };

    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: true });
    root.addEventListener("touchend", onEnd, { passive: true });
    root.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchmove", onMove);
      root.removeEventListener("touchend", onEnd);
      root.removeEventListener("touchcancel", onEnd);
    };
  }, [onRefresh, busy]);

  return <div ref={ref}>
    <div className="ptr-indicator" style={{ height: dist }}>
      {(dist > 0 || busy) && <RefreshCw size={16} className={busy ? "spin" : dist >= 44 ? "ptr-ready" : ""} />}
      {dist >= 44 && !busy && <span>松开刷新</span>}
    </div>
    {children}
  </div>;
}

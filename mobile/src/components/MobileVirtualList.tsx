/**
 * 移动端虚拟滚动列表 - 优化大数据集渲染性能
 *
 * 适用场景：
 * - 持仓列表（50+标的）
 * - 订单历史（200+条）
 * - 成交记录（500+条）
 * - 新闻列表（100+条）
 */
import { useEffect, useRef, useState } from 'react';

interface MobileVirtualListProps<T> {
  items: T[];
  itemHeight: number;
  containerHeight?: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  overscan?: number;
  className?: string;
  emptyText?: string;
}

export function MobileVirtualList<T>({
  items,
  itemHeight,
  containerHeight = window.innerHeight - 200,
  renderItem,
  overscan = 5,
  className = '',
  emptyText = '暂无数据',
}: MobileVirtualListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  if (items.length === 0) {
    return (
      <div className={`mobile-empty ${className}`}>
        <p>{emptyText}</p>
      </div>
    );
  }

  const totalHeight = items.length * itemHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const endIndex = Math.min(
    items.length - 1,
    Math.ceil((scrollTop + containerHeight) / itemHeight) + overscan
  );

  const visibleItems = items.slice(startIndex, endIndex + 1);
  const offsetY = startIndex * itemHeight;

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  };

  return (
    <div
      ref={containerRef}
      className={`mobile-virtual-list ${className}`}
      onScroll={handleScroll}
      style={{
        height: containerHeight,
        overflow: 'auto',
        position: 'relative',
        WebkitOverflowScrolling: 'touch', // iOS 平滑滚动
      }}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ transform: `translateY(${offsetY}px)` }}>
          {visibleItems.map((item, index) => (
            <div key={startIndex + index} style={{ height: itemHeight }}>
              {renderItem(item, startIndex + index)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 使用示例 - 移动端订单列表：
 *
 * <MobileVirtualList
 *   items={orders}
 *   itemHeight={88}
 *   containerHeight={window.innerHeight - 160}
 *   emptyText="今日暂无委托"
 *   renderItem={(order) => (
 *     <div className="order-card">
 *       <div className="order-header">
 *         <span>{order.symbol}</span>
 *         <span className={`status-${order.status}`}>{order.statusText}</span>
 *       </div>
 *       <div className="order-body">
 *         <span>{order.side}</span>
 *         <span>{order.quantity}</span>
 *         <span>{order.price}</span>
 *       </div>
 *     </div>
 *   )}
 * />
 */

/**
 * 虚拟滚动表格组件 - 专为大数据量表格优化
 *
 * 适用场景：
 * - 订单历史（500+条）
 * - 成交记录（1000+条）
 * - 持仓列表（100+标的）
 * - K线数据表格视图（2000行）
 */
import { useEffect, useRef, useState } from 'react';

interface VirtualTableProps<T> {
  items: T[];
  rowHeight: number;
  containerHeight: number;
  renderRow: (item: T, index: number) => React.ReactNode;
  renderHeader?: () => React.ReactNode;
  emptyText?: string;
  overscan?: number;
  className?: string;
}

export function VirtualTable<T>({
  items,
  rowHeight,
  containerHeight,
  renderRow,
  renderHeader,
  emptyText = '暂无数据',
  overscan = 5,
  className = '',
}: VirtualTableProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  if (items.length === 0) {
    return (
      <div className={`virtual-table-empty ${className}`}>
        {emptyText}
      </div>
    );
  }

  const totalHeight = items.length * rowHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endIndex = Math.min(
    items.length - 1,
    Math.ceil((scrollTop + containerHeight) / rowHeight) + overscan
  );

  const visibleItems = items.slice(startIndex, endIndex + 1);
  const offsetY = startIndex * rowHeight;

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  };

  return (
    <div className={`virtual-table-container ${className}`}>
      {renderHeader && (
        <div className="virtual-table-header">
          <table className="rank-table">
            <thead>{renderHeader()}</thead>
          </table>
        </div>
      )}
      <div
        ref={containerRef}
        className="virtual-table-body"
        onScroll={handleScroll}
        style={{
          height: containerHeight,
          overflow: 'auto',
          position: 'relative',
        }}
      >
        <div style={{ height: totalHeight, position: 'relative' }}>
          <div style={{ transform: `translateY(${offsetY}px)` }}>
            <table className="rank-table">
              <tbody>
                {visibleItems.map((item, index) => renderRow(item, startIndex + index))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 使用示例 - 订单列表：
 *
 * <VirtualTable
 *   items={orders}
 *   rowHeight={44}
 *   containerHeight={500}
 *   emptyText="今日暂无委托"
 *   renderHeader={() => (
 *     <tr>
 *       <th>时间</th>
 *       <th>标的</th>
 *       <th>方向</th>
 *       <th>价格</th>
 *       <th>数量</th>
 *       <th>状态</th>
 *     </tr>
 *   )}
 *   renderRow={(order) => (
 *     <tr key={order.id}>
 *       <td>{order.created_at}</td>
 *       <td>{order.symbol}</td>
 *       <td>{order.side}</td>
 *       <td>{order.price}</td>
 *       <td>{order.quantity}</td>
 *       <td>{order.status}</td>
 *     </tr>
 *   )}
 * />
 */

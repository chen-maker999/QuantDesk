// 资产页 —— 桌面端 OverviewPage + PortfolioPage 的移动端合并迁移：
// 工作区真实状态（本地数据库）+ 模拟账户摘要 + 快捷入口 + 引擎通知中心（铃铛/未读/全部已读）。
import { useCallback, useEffect, useState } from "react";
import { Activity, Bell, Bot, CheckCheck, Database, FlaskConical, Landmark } from "lucide-react";
import { fmtAmount } from "../lib/market";
import { getAccount, type PaperAccount } from "../lib/trade";
import { listNotifications, markNotificationsRead, type EngineNotification } from "../lib/backend";
import { useApp } from "../App";
import PullToRefresh from "../components/PullToRefresh";

export default function PortfolioPage() {
  const { status, goto, notify } = useApp();
  const [acc, setAcc] = useState<PaperAccount | null>(null);
  const [notifs, setNotifs] = useState<EngineNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [notifOpen, setNotifOpen] = useState(false);

  const loadAccount = useCallback(async () => {
    try { setAcc(await getAccount()); } catch { /* 引擎未连接时保持空 */ }
  }, []);
  const loadNotifs = useCallback(async () => {
    try {
      const res = await listNotifications(30);
      setNotifs(res.notifications || []);
      setUnread(res.unread || 0);
    } catch { /* 静默 */ }
  }, []);
  useEffect(() => { void loadAccount(); void loadNotifs(); }, [loadAccount, loadNotifs, status]);

  const markAll = async () => {
    try {
      await markNotificationsRead();
      setNotifs(list => list.map(n => ({ ...n, read: true })));
      setUnread(0);
      notify("已全部标记为已读");
    } catch (e) { notify(e instanceof Error ? e.message : "操作失败", "error"); }
  };

  const pullRefresh = useCallback(async () => {
    await Promise.all([loadAccount(), loadNotifs()]);
  }, [loadAccount, loadNotifs]);

  const stats = [
    { label: "市场数据", value: status.market_rows.toLocaleString(), sub: status.market_latest || "未导入", icon: Database, tab: "market" as const },
    { label: "真实持仓", value: String(status.holding_count), sub: status.portfolio_value ? `¥${status.portfolio_value.toLocaleString()}` : "未导入", icon: Landmark, tab: "portfolio" as const },
    { label: "回测实验", value: String(status.experiment_count), sub: "本地数据库", icon: FlaskConical, tab: "agent" as const },
    { label: "审计记录", value: String(status.audit_count), sub: "Agent 与工具", icon: Activity, tab: "agent" as const },
  ];
  const dayPnl = acc?.day_pnl ?? 0;

  return <PullToRefresh onRefresh={pullRefresh}><div className="page">
    <header className="page-head with-actions">
      <div className="ph-title"><h1>资产总览</h1><p>只显示来自本地数据库的真实状态</p></div>
      <div className="ph-actions">
        <button className="icon-btn bell-btn" onClick={() => { setNotifOpen(true); void loadNotifs(); }}>
          <Bell size={19} />
          {unread > 0 && <i className="badge">{unread > 99 ? "99+" : unread}</i>}
        </button>
      </div>
    </header>

    <div className="stat-grid">
      {stats.map(({ label, value, sub, icon: Icon, tab: target }) => (
        <button className="card stat tap" key={label} onClick={() => goto(target)}>
          <Icon size={16} />
          <small>{label}</small>
          <strong>{value}</strong>
          <em>{sub}</em>
        </button>
      ))}
    </div>

    <div className="section-head"><h2>模拟账户</h2><button className="link-btn" onClick={() => goto("trade")}>去交易</button></div>
    <button className="card paper-card" onClick={() => goto("trade")}>
      <div className="pc-main">
        <small>总资产</small>
        <strong>{fmtAmount(acc?.total_asset)}</strong>
        <em>当日 <b className={dayPnl !== 0 ? dayPnl > 0 ? "tone-up" : "tone-down" : ""}>{(dayPnl >= 0 ? "+" : "") + fmtAmount(dayPnl)}</b></em>
      </div>
      <div className="pc-side">
        <span><small>持仓市值</small><b>{fmtAmount(acc?.market_value)}</b></span>
        <span><small>可用资金</small><b>{fmtAmount(acc?.cash)}</b></span>
        <span><small>持仓数</small><b>{acc?.positions_count ?? 0}</b></span>
      </div>
    </button>

    <div className="section-head"><h2>快捷分析</h2></div>
    <div className="card list-card">
      <button className="row" onClick={() => { navigator.clipboard?.writeText("对我的真实组合执行完整风险分析（VaR/回撤/压力测试）").catch(() => undefined); notify("指令已复制，去 Agent 页粘贴发送"); }}>
        <span className="row-main"><b>组合风险分析</b><small>VaR / 回撤 / 压力测试</small></span>
        <Bot size={16} />
      </button>
      <button className="row" onClick={() => { navigator.clipboard?.writeText("结合最新行情复盘我的持仓风险，并给出下一步行动计划").catch(() => undefined); notify("指令已复制，去 Agent 页粘贴发送"); }}>
        <span className="row-main"><b>持仓复盘</b><small>结合最新行情给出行动计划</small></span>
        <Bot size={16} />
      </button>
    </div>
    {status.market_rows === 0 && <p className="page-tip">工作区还没有真实市场数据 —— 在桌面端导入 CSV 或同步行情后，Agent 的所有分析都会基于真实数据。</p>}

    {notifOpen && <div className="sheet-mask" onClick={() => setNotifOpen(false)}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="sheet-head">
          <h2>通知中心{unread > 0 ? `（${unread} 未读）` : ""}</h2>
          {unread > 0 && <button className="ghost-btn" onClick={() => void markAll()}><CheckCheck size={13} />全部已读</button>}
        </div>
        <div className="sheet-body">
          {notifs.length === 0 ? <p className="sheet-empty">暂无通知</p>
            : notifs.map(n => (
              <div key={n.id} className={`notif-row${n.read ? "" : " unread"}`}>
                <span className="notif-dot" />
                <div className="notif-main">
                  <b>{n.title}</b>
                  {n.body && <p>{n.body}</p>}
                  <small>{n.source} · {new Date(n.createdAt).toLocaleString()}</small>
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>}
  </div></PullToRefresh>;
}

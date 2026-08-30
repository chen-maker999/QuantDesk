// QuantDesk Mobile —— 桌面端 App.tsx 的移动端迁移版。
// 布局改为「底部 Tab + 页面栈」，业务交互逻辑（状态轮询、主题、涨跌色、
// Agent 运行、模拟交易、行情刷新）与桌面端保持一致。
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { BarChart3, Bot, BriefcaseBusiness, CheckCircle2, FlaskConical, Landmark, RefreshCw, Settings as SettingsIcon, TriangleAlert } from "lucide-react";
import {
  authLogout, emptyStatus, getAuthStatus, getPushPublicKey, getWorkspaceStatus, onUnauthorized, pushSubscribe,
  type ApiProvider, type AuthStatus, type WorkspaceStatus,
} from "./lib/backend";
import { enablePush, pushEnabledFlag, registerServiceWorker } from "./lib/push";
import AuthScreen from "./AuthScreen";
import MarketPage from "./pages/MarketPage";
import StockPage from "./pages/StockPage";
import AgentPage from "./pages/AgentPage";
import TradePage from "./pages/TradePage";
import ResearchPage from "./pages/ResearchPage";
import PortfolioPage from "./pages/PortfolioPage";
import SettingsPage from "./pages/SettingsPage";

export type Tab = "market" | "trade" | "agent" | "research" | "portfolio" | "settings";
export type StockTarget = { market: "a" | "index"; symbol: string; name?: string };
export type Notify = (message: string, tone?: "ok" | "error") => void;
export type Theme = "light" | "dark" | "system";

type AppCtxValue = {
  status: WorkspaceStatus;
  refresh: () => Promise<void>;
  notify: Notify;
  model: string;
  setModel: (m: string) => void;
  openStock: (t: StockTarget) => void;
  goto: (tab: Tab) => void;
};

const AppCtx = createContext<AppCtxValue>(null as unknown as AppCtxValue);
export const useApp = () => useContext(AppCtx);

const TABS: Array<{ id: Tab; label: string; icon: typeof BarChart3 }> = [
  { id: "market", label: "行情", icon: BarChart3 },
  { id: "trade", label: "交易", icon: Landmark },
  { id: "agent", label: "Agent", icon: Bot },
  { id: "research", label: "研究", icon: FlaskConical },
  { id: "portfolio", label: "资产", icon: BriefcaseBusiness },
  { id: "settings", label: "我的", icon: SettingsIcon },
];

function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export default function App() {
  const [tab, setTab] = useState<Tab>("market");
  const [stock, setStock] = useState<StockTarget | null>(null);
  const [status, setStatus] = useState<WorkspaceStatus>(emptyStatus);
  const [model, setModel] = useState(() => localStorage.getItem("quant-model") || "qwen3.7-flash");
  const [toast, setToast] = useState<{ message: string; tone: string } | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [theme, setThemeState] = useState<Theme>(() => (localStorage.getItem("quant-theme") as Theme) || "system");
  // 账户门控：checking=探测中 gate=登录/注册 ready=已登录
  const [authPhase, setAuthPhase] = useState<"checking" | "gate" | "ready">("checking");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authNote, setAuthNote] = useState("");
  const [authProbeFailed, setAuthProbeFailed] = useState(false);
  const [user, setUser] = useState<string | null>(null);

  const probeAuth = useCallback(async () => {
    setAuthPhase("checking");
    setAuthNote("");
    let probe: AuthStatus | null = null;
    for (let i = 0; i < 12; i++) {
      try { probe = await getAuthStatus(); break; } catch { await new Promise(r => setTimeout(r, 500)); }
    }
    if (!probe) {
      setAuthProbeFailed(true);
      setAuthNote("无法连接引擎，请检查引擎地址与网络后重试");
      setAuthPhase("gate");
      return;
    }
    setAuthProbeFailed(false);
    if (!probe.initialized) { setAuthMode("register"); setAuthPhase("gate"); return; }
    if (!probe.authenticated) { setAuthMode("login"); setAuthPhase("gate"); return; }
    setUser(probe.user?.username ?? null);
    setAuthPhase("ready");
  }, []);

  useEffect(() => { void probeAuth(); }, [probeAuth]);

  // 任何接口 401（会话过期/令牌失效）→ 回到登录页
  useEffect(() => onUnauthorized(() => {
    setUser(null);
    setAuthMode("login");
    setAuthNote("登录会话已失效，请重新登录");
    setAuthPhase("gate");
  }), []);

  const notify: Notify = useCallback((message, tone = "ok") => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(current => (current && current.message === message ? null : current)), 3200);
  }, []);

  const refresh = useCallback(async () => {
    try { setStatus(await getWorkspaceStatus()); setEngineError(null); }
    catch (e) { setEngineError(e instanceof Error ? e.message : "无法连接引擎"); }
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    localStorage.setItem("quant-theme", next);
    applyTheme(next);
  }, []);

  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => { if ((localStorage.getItem("quant-theme") as Theme) === "system") applyTheme("system"); };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  // 涨跌色语义（A股红涨绿跌 / 国际绿涨红跌），与桌面端一致
  useEffect(() => {
    const tone = localStorage.getItem("quant-tone") === "intl" ? "intl" : "cn";
    document.documentElement.dataset.tone = tone;
  }, []);

  // Web Push：预注册 Service Worker（推送订阅本身也会再确保注册）
  useEffect(() => { void registerServiceWorker(); }, []);

  // 推送服务吊销订阅时（pushsubscriptionchange），若用户开启过推送则静默重订阅
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "push-subscription-expired" && pushEnabledFlag()) {
        void enablePush(getPushPublicKey, sub => pushSubscribe({ endpoint: sub.endpoint, keys: sub.keys, userAgent: navigator.userAgent.slice(0, 290) })).catch(() => undefined);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  // 工作区状态轮询：15s 一次 + 回到前台/切 Tab 立即刷新（仅登录后启用）
  useEffect(() => {
    if (authPhase !== "ready") return;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh, authPhase]);

  const openStock = useCallback((target: StockTarget) => { setStock(target); }, []);
  const goto = useCallback((next: Tab) => { setStock(null); setTab(next); }, []);
  const setModelPersist = useCallback((next: string) => {
    setModel(next);
    localStorage.setItem("quant-model", next);
  }, []);

  const ctx = useMemo<AppCtxValue>(() => ({ status, refresh, notify, model, setModel: setModelPersist, openStock, goto }), [status, refresh, notify, model, setModelPersist, openStock, goto]);

  const handleLogout = useCallback(async () => {
    await authLogout();
    setUser(null);
    setAuthMode("login");
    setAuthNote("已退出登录");
    setAuthPhase("gate");
  }, []);

  // 账户门控：登录/注册完成前不渲染工作区
  if (authPhase === "checking") {
    return <div className="auth-screen"><div className="auth-boot"><span className="auth-mark">Q</span><span className="auth-boot-text">正在连接引擎…</span></div></div>;
  }
  if (authPhase === "gate") {
    return <AuthScreen
      mode={authMode}
      note={authNote}
      connectionFailed={authProbeFailed}
      onRetry={() => void probeAuth()}
      onAuthed={username => { setUser(username); setAuthPhase("ready"); setAuthNote(""); void refresh(); }}
    />;
  }

  return <AppCtx.Provider value={ctx}>
    <div className="app">
      <main className="app-main">
        {stock
          ? <StockPage target={stock} onBack={() => setStock(null)} />
          : <>
            {tab === "market" && <MarketPage />}
            {tab === "trade" && <TradePage />}
            {tab === "agent" && <AgentPage />}
            {tab === "research" && <ResearchPage />}
            {tab === "portfolio" && <PortfolioPage />}
            {tab === "settings" && <SettingsPage theme={theme} setTheme={setTheme} user={user} onLogout={handleLogout} />}
          </>}
      </main>

      {engineError && !stock && <div className="engine-banner" onClick={() => goto("settings")}>
        <TriangleAlert size={13} />
        <span>无法连接引擎 · 点击前往设置</span>
        <button className="banner-retry" onClick={e => { e.stopPropagation(); void refresh(); }}>
          <RefreshCw size={11} />重试
        </button>
      </div>}

      {!stock && <nav className="tabbar">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            <Icon size={20} strokeWidth={tab === id ? 2.2 : 1.8} />
            <span>{label}</span>
          </button>
        ))}
      </nav>}

      {toast && <div className={`toast ${toast.tone}`}>
        {toast.tone === "error" ? <TriangleAlert size={14} /> : <CheckCircle2 size={14} />}
        <span>{toast.message}</span>
      </div>}
    </div>
  </AppCtx.Provider>;
}

// 供设置页跳转外链申请 Key 等场景复用
export function openExternal(url: string) {
  window.open(url, "_blank", "noopener");
}

export type { ApiProvider, WorkspaceStatus };

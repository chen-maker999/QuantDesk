// 设置页 —— 桌面端 SettingsPage 的移动端迁移（子集）：
// 引擎连接（地址 + 访问令牌 + 测试连接）、Agent 模型与行为、外观、缓存管理。
// 模型 API Key 出于安全考虑仍在桌面端配置（Windows Credential Manager），
// 移动端复用引擎进程内存里已配置的凭据。
import { useState } from "react";
import { Bell, BellOff, Check, ExternalLink, Eye, EyeOff, KeyRound, Loader2, LogOut, PlugZap, RefreshCw, Send, Smartphone, UserRound } from "lucide-react";
import {
  getEngineToken, getEngineUrl, getPushPublicKey, normalizeEngineUrl, pairRedeem, pushSubscribe, pushTest, pushUnsubscribe,
  setEngineToken, setEngineUrl, testEngineConnection,
  type WorkspaceStatus,
} from "../lib/backend";
import { currentPermission, disablePush, enablePush, pushEnabledFlag, pushSupported, type PushPermission } from "../lib/push";
import { useApp, type Theme } from "../App";

export default function SettingsPage({ theme, setTheme, user, onLogout }: {
  theme: Theme; setTheme: (t: Theme) => void; user: string | null; onLogout: () => Promise<void> | void;
}) {
  const { notify, model, status } = useApp();
  const [url, setUrl] = useState(() => getEngineUrl());
  const [token, setToken] = useState(() => getEngineToken());
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string>("");
  const [pairCode, setPairCode] = useState("");
  const [pairBusy, setPairBusy] = useState(false);
  const [verbosity, setVerbosity] = useState(() => localStorage.getItem("quant-verbosity") || "balanced");
  const [personality, setPersonality] = useState(() => localStorage.getItem("quant-personality") || "professional");
  const [customInstructions, setCustomInstructions] = useState(() => localStorage.getItem("quant-custom-instructions") || "");
  const [tone, setToneState] = useState<"cn" | "intl">(() => (localStorage.getItem("quant-tone") === "intl" ? "intl" : "cn"));
  const [pushOn, setPushOn] = useState(() => pushEnabledFlag());
  const [pushBusy, setPushBusy] = useState(false);
  const [pushTesting, setPushTesting] = useState(false);

  const saveConnection = () => {
    const normalized = normalizeEngineUrl(url);
    if (!normalized) { notify("请输入有效的引擎地址", "error"); return; }
    setEngineUrl(normalized);
    setUrl(normalized);
    setEngineToken(token);
    notify("连接配置已保存");
  };

  const runTest = async () => {
    setTesting(true); setTestResult("");
    setEngineUrl(normalizeEngineUrl(url));
    setEngineToken(token);
    const started = performance.now();
    const res = await testEngineConnection();
    const ms = Math.round(performance.now() - started);
    setTesting(false);
    if (!res.ok) {
      setTestResult(res.error || "连接失败");
      notify("引擎连接失败", "error");
      return;
    }
    if (!res.status) {
      // 引擎可达但未授权：未登录（无会话）或访问令牌不匹配
      setTestResult(res.error || "引擎已连接，但尚未登录（或访问令牌不匹配）");
      return;
    }
    const s = res.status;
    setTestResult(`连接成功（${ms}ms）· ${s.market_rows.toLocaleString()} 行市场数据 · ${s.holding_count} 个持仓 · ${s.agent_configured || s.deepseek_configured || s.qwen_configured ? "模型已配置" : "模型未配置（桌面端设置）"}`);
    notify("引擎连接成功");
  };

  const setTone = (next: "cn" | "intl") => {
    setToneState(next);
    localStorage.setItem("quant-tone", next);
    document.documentElement.dataset.tone = next;
    notify("涨跌颜色已更新");
  };

  // 配对码连接：桌面端「设置 → 安全边界」生成 6 位一次性配对码（90 秒有效），
  // 输入即可自动换取并保存移动端访问令牌，免去手工拷贝令牌。
  const runPairing = async () => {
    const code = pairCode.trim();
    if (!/^\d{4,12}$/.test(code)) { notify("请输入桌面端生成的数字配对码", "error"); return; }
    setPairBusy(true);
    try {
      setEngineUrl(normalizeEngineUrl(url));
      await pairRedeem(code);
      setToken(getEngineToken());
      setPairCode("");
      notify("配对成功，访问令牌已保存");
      await runTest();
    } catch (e) {
      notify(e instanceof Error ? e.message : "配对失败", "error");
    } finally {
      setPairBusy(false);
    }
  };

  const clearCache = () => {
    localStorage.removeItem("quant-chats");
    localStorage.removeItem("quant-chat-active");
    notify("本地对话缓存已清除（引擎侧历史不受影响）");
  };

  const togglePush = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      if (pushOn) {
        await disablePush(pushUnsubscribe);
        setPushOn(false);
        notify("推送通知已关闭");
      } else {
        const res = await enablePush(getPushPublicKey, sub => pushSubscribe({ ...sub, userAgent: navigator.userAgent.slice(0, 290) }));
        if (res.ok) { setPushOn(true); notify("推送通知已开启"); }
        else notify(res.error || "开启失败", "error");
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : "推送设置失败", "error");
    } finally {
      setPushBusy(false);
    }
  };

  const runPushTest = async () => {
    if (pushTesting) return;
    setPushTesting(true);
    try {
      await pushTest();
      notify("测试通知已发送，请留意系统通知栏");
    } catch (e) {
      notify(e instanceof Error ? e.message : "测试发送失败", "error");
    } finally {
      setPushTesting(false);
    }
  };

  return <div className="page">
    <header className="page-head"><h1>设置</h1><p>账户 · 引擎连接 · Agent · 外观</p></header>

    <section className="card settings-card account-card">
      <div className="account-row">
        <span className="account-avatar"><UserRound size={16} /></span>
        <div className="account-info">
          <strong>{user || "未登录"}</strong>
          <small>{user ? "已登录 · 会话有效期 30 天" : "使用账户密码登录引擎"}</small>
        </div>
        {user && (
          <button className="secondary-btn account-logout" onClick={() => void onLogout()}>
            <LogOut size={13} />退出登录
          </button>
        )}
      </div>
    </section>

    <section className="card settings-card">
      <h2><PlugZap size={15} />引擎连接</h2>
      <p className="settings-hint">手机作为远程客户端连接正在运行的 QuantDesk 引擎（局域网 PC 或云服务器）。桌面端正常启动即带引擎；局域网共享可用 mobile 目录下的启动脚本。</p>
      <label className="field">引擎地址
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://192.168.1.100:8765" inputMode="url" autoCapitalize="off" autoCorrect="off" />
      </label>
      <label className="field">访问令牌
        <span className="token-box">
          <KeyRound size={14} />
          <input type={showToken ? "text" : "password"} value={token} onChange={e => setToken(e.target.value)} placeholder="QUANTDESK_MOBILE_TOKEN" autoCapitalize="off" autoCorrect="off" />
          <button className="clear-btn" onClick={() => setShowToken(v => !v)}>{showToken ? <EyeOff size={14} /> : <Eye size={14} />}</button>
        </span>
      </label>
      <label className="field">配对码连接
        <span className="token-box">
          <Smartphone size={14} />
          <input value={pairCode} onChange={e => setPairCode(e.target.value.replace(/\D/g, ""))} placeholder="桌面端「设置 → 安全边界」生成，90 秒有效" inputMode="numeric" autoCapitalize="off" autoCorrect="off" maxLength={12} />
        </span>
      </label>
      <div className="btn-row">
        <button className="secondary-btn" onClick={() => void runPairing()} disabled={pairBusy}>
          {pairBusy ? <Loader2 className="spin" size={13} /> : <Smartphone size={13} />}一键配对
        </button>
      </div>
      <div className="btn-row">
        <button className="secondary-btn" onClick={saveConnection}><Check size={13} />保存</button>
        <button className="primary-btn" onClick={() => void runTest()} disabled={testing}>
          {testing ? <Loader2 className="spin" size={14} /> : <PlugZap size={14} />}测试连接
        </button>
      </div>
      {testResult && <p className={`test-result${testResult.startsWith("连接成功") ? " ok" : " err"}`}>{testResult}</p>}
      <ProviderStatus status={status} />
    </section>

    <section className="card settings-card">
      <h2><RefreshCw size={15} />Agent 与模型</h2>
      <div className="field"><span className="field-static">当前模型：{model === "auto" ? "Auto（免费模型）" : model}</span>
        <span className="field-hint">与桌面端共享；请在对话页「高级 → 模型」中切换。</span></div>
      <label className="field">回答详略
        <select value={verbosity} onChange={e => { setVerbosity(e.target.value); localStorage.setItem("quant-verbosity", e.target.value); notify("设置已保存"); }}>
          <option value="concise">简洁</option><option value="balanced">平衡</option><option value="detailed">详细</option>
        </select>
      </label>
      <label className="field">表达风格
        <select value={personality} onChange={e => { setPersonality(e.target.value); localStorage.setItem("quant-personality", e.target.value); notify("设置已保存"); }}>
          <option value="professional">专业审慎</option><option value="direct">直接务实</option><option value="teaching">教学解释</option>
        </select>
      </label>
      <label className="field">自定义指令
        <textarea value={customInstructions} rows={3} onChange={e => setCustomInstructions(e.target.value)} onBlur={() => { localStorage.setItem("quant-custom-instructions", customInstructions); notify("自定义指令已保存"); }} placeholder="例如：默认使用人民币计价；所有建议必须列出数据日期与主要风险。" />
      </label>
      <div className="key-hint">
        <KeyRound size={13} />
        <span>模型 API Key 请在桌面端「设置 → Agent 与模型」中配置，凭据保存在 Windows Credential Manager，引擎进程内存持有，移动端直接复用。
          <a href="https://bailian.console.aliyun.com/?apiKey=1" target="_blank" rel="noopener noreferrer">申请 Key <ExternalLink size={10} /></a>
        </span>
      </div>
    </section>

    <section className="card settings-card">
      <h2>外观</h2>
      <label className="field">主题
        <div className="segmented grow">
          <button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>浅色</button>
          <button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>深色</button>
          <button className={theme === "system" ? "active" : ""} onClick={() => setTheme("system")}>跟随系统</button>
        </div>
      </label>
      <label className="field">涨跌颜色
        <div className="segmented grow">
          <button className={tone === "cn" ? "active" : ""} onClick={() => setTone("cn")}>红涨绿跌</button>
          <button className={tone === "intl" ? "active" : ""} onClick={() => setTone("intl")}>绿涨红跌</button>
        </div>
      </label>
    </section>

    <section className="card settings-card">
      <h2><Bell size={15} />推送通知</h2>
      <p className="settings-hint">把 Agent 定时任务结果与价格/风险预警推送到手机系统通知。需要引擎安装 pywebpush，且本页通过 HTTPS 或 localhost 访问；iOS 需先「添加到主屏幕」。</p>
      <div className="btn-row">
        <button className={pushOn ? "secondary-btn" : "primary-btn"} onClick={() => void togglePush()} disabled={pushBusy || !pushSupported()}>
          {pushBusy ? <Loader2 className="spin" size={14} /> : pushOn ? <BellOff size={14} /> : <Bell size={14} />}
          {pushOn ? "关闭推送" : "开启推送"}
        </button>
        {pushOn && (
          <button className="secondary-btn" onClick={() => void runPushTest()} disabled={pushTesting}>
            {pushTesting ? <Loader2 className="spin" size={14} /> : <Send size={14} />}发送测试
          </button>
        )}
      </div>
      {!pushSupported() && <p className="settings-hint">当前浏览器不支持 Web Push（需 HTTPS 或 localhost）。</p>}
      {pushSupported() && currentPermission() === ("denied" as PushPermission) && <p className="settings-hint">通知权限已被浏览器拒绝 —— 请在站点设置中允许通知后重试。</p>}
    </section>

    <section className="card settings-card">
      <h2>数据</h2>
      <div className="btn-row">
        <button className="secondary-btn" onClick={clearCache}>清除本地对话缓存</button>
      </div>
      <p className="settings-hint">QuantDesk Mobile v0.3.5 · 与桌面端共用引擎与数据，删除 App 不影响桌面端数据。</p>
    </section>
  </div>;
}

function ProviderStatus({ status }: { status: WorkspaceStatus }) {
  const providers = [
    { name: "OpenAI", ok: status.agent_configured },
    { name: "DeepSeek", ok: status.deepseek_configured },
    { name: "Qwen", ok: status.qwen_configured },
    { name: "行情数据", ok: status.market_provider_configured },
  ];
  return <div className="provider-status">
    {providers.map(p => (
      <span key={p.name} className={p.ok ? "ok" : ""}><i />{p.name}{p.ok ? " 已配置" : " 未配置"}</span>
    ))}
  </div>;
}

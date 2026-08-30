// 登录/注册门控 —— 与桌面端 AuthScreen 同一套引擎账户体系：
// 未初始化 → 注册首个管理员；已初始化 → 登录（会话有效期 30 天）。
import { useState } from "react";
import { Eye, EyeOff, Loader2, LogIn, RefreshCw, ShieldCheck, UserPlus } from "lucide-react";
import { authLogin, authRegister } from "./lib/backend";

type Props = {
  mode: "login" | "register";
  note?: string;
  connectionFailed?: boolean;
  onRetry: () => void;
  onAuthed: (username: string) => void;
};

export default function AuthScreen({ mode, note, connectionFailed, onRetry, onAuthed }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isRegister = mode === "register";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (isRegister && password !== confirm) { setError("两次输入的密码不一致"); return; }
    setBusy(true);
    try {
      const session = isRegister ? await authRegister(username, password) : await authLogin(username, password, totp);
      onAuthed(session.user.username);
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-decor" aria-hidden="true" />
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <span className="auth-mark">Q</span>
          <span className="auth-name">QuantDesk</span>
        </div>
        <h1>{isRegister ? "创建管理员账户" : "欢迎回来"}</h1>
        <p className="auth-sub">
          {isRegister
            ? "首次连接引擎：设置管理员账户，保护你的工作区与交易凭据"
            : "登录你的 QuantDesk 账户，继续访问量化工作区"}
        </p>
        {note ? <div className="auth-note">{note}</div> : null}
        {connectionFailed ? (
          <button type="button" className="auth-retry" onClick={onRetry}>
            <RefreshCw size={13} />重新检测引擎
          </button>
        ) : null}
        <label className="auth-field">
          <span>用户名</span>
          <div className="auth-input">
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="2-32 位字母、数字、下划线或中文"
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              enterKeyHint="next"
              maxLength={64}
            />
          </div>
        </label>
        <label className="auth-field">
          <span>密码</span>
          <div className="auth-input">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={isRegister ? "至少 8 位，不含空格" : "输入密码"}
              autoComplete={isRegister ? "new-password" : "current-password"}
              enterKeyHint={isRegister ? "next" : "go"}
              maxLength={128}
            />
            <button type="button" className="auth-eye" onClick={() => setShowPassword(v => !v)}>
              {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </label>
        {isRegister ? (
          <label className="auth-field">
            <span>确认密码</span>
            <div className="auth-input">
              <input
                type={showPassword ? "text" : "password"}
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="再次输入密码"
                autoComplete="new-password"
                enterKeyHint="go"
                maxLength={128}
              />
            </div>
          </label>
        ) : null}
        {!isRegister && <label className="auth-field">
          <span>两步验证码（如已开启）</span>
          <div className="auth-input">
            <input value={totp} onChange={e => setTotp(e.target.value)} placeholder="6 位数字，未开启可留空" inputMode="numeric" maxLength={12} autoComplete="one-time-code" />
          </div>
        </label>}
        {error ? <div className="auth-error">{error}</div> : null}
        <button className="auth-submit" type="submit" disabled={busy || !username.trim() || !password}>
          {busy ? <Loader2 size={15} className="auth-spin" /> : isRegister ? <UserPlus size={15} /> : <LogIn size={15} />}
          <span>{busy ? "请稍候…" : isRegister ? "创建账户并进入" : "登录"}</span>
        </button>
        <p className="auth-foot">
          <ShieldCheck size={11} />
          会话有效期 30 天 · 密码经 PBKDF2 加密存储
        </p>
      </form>
    </div>
  );
}

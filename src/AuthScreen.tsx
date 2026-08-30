import { useState } from "react";
import { Eye, EyeOff, Loader2, LogIn, ShieldCheck, User, UserPlus } from "lucide-react";
import { authLogin, authRegister } from "./lib/backend";
import altasLight from "./assets/altas-light.png";
import altasDark from "./assets/altas-dark.png";

type Props = {
  mode: "login" | "register";
  note?: string;
  onAuthed: (username: string) => void;
};

export default function AuthScreen({ mode, note, onAuthed }: Props) {
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
      <div className="auth-decor" aria-hidden="true"/>
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <img className="auth-logo" src={altasDark} alt="QuantDesk" draggable={false}/>
          <img className="auth-logo dark" src={altasLight} alt="" aria-hidden="true" draggable={false}/>
        </div>
        <h1>{isRegister ? "创建管理员账户" : "登录 QuantDesk"}</h1>
        <p className="auth-sub">
          {isRegister ? "首次使用：设置管理员账户，保护你的本地工作区与交易凭据" : "输入账户密码，继续访问本地量化工作区"}
        </p>
        {note ? <div className="auth-note">{note}</div> : null}
        <label className="auth-field">
          <span>用户名</span>
          <div className="auth-input">
            <User size={14}/>
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="2-32 位字母、数字、下划线或中文"
              autoComplete="username"
              autoFocus
              maxLength={64}
            />
          </div>
        </label>
        <label className="auth-field">
          <span>密码</span>
          <div className="auth-input">
            <ShieldCheck size={14}/>
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={isRegister ? "至少 8 位，不含空格" : "输入密码"}
              autoComplete={isRegister ? "new-password" : "current-password"}
              maxLength={128}
            />
            <button type="button" className="auth-eye" title={showPassword ? "隐藏密码" : "显示密码"} onClick={() => setShowPassword(v => !v)}>
              {showPassword ? <EyeOff size={14}/> : <Eye size={14}/>}
            </button>
          </div>
        </label>
        {isRegister ? (
          <label className="auth-field">
            <span>确认密码</span>
            <div className="auth-input">
              <ShieldCheck size={14}/>
              <input
                type={showPassword ? "text" : "password"}
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="再次输入密码"
                autoComplete="new-password"
                maxLength={128}
              />
            </div>
          </label>
        ) : null}
        {!isRegister && <label className="auth-field">
          <span>两步验证码（如已开启）</span>
          <div className="auth-input">
            <ShieldCheck size={14}/>
            <input value={totp} onChange={e => setTotp(e.target.value)} placeholder="6 位数字，未开启可留空" inputMode="numeric" maxLength={12} autoComplete="one-time-code"/>
          </div>
        </label>}
        {error ? <div className="auth-error">{error}</div> : null}
        <button className="auth-submit" type="submit" disabled={busy || !username.trim() || !password}>
          {busy ? <Loader2 size={15} className="auth-spin"/> : isRegister ? <UserPlus size={15}/> : <LogIn size={15}/>}
          <span>{busy ? "请稍候…" : isRegister ? "创建账户并进入" : "登录"}</span>
        </button>
        <p className="auth-foot">会话有效期 7 天 · 密码经 PBKDF2 加密存储，不会明文上传</p>
      </form>
    </div>
  );
}

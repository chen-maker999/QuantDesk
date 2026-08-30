use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Emitter;

struct EngineProcess(Mutex<Option<Child>>);
struct EngineToken(Mutex<Option<String>>);

impl Drop for EngineProcess {
    fn drop(&mut self) {
        // 应用退出时结束本会话拉起的引擎子进程，避免其成为占用 8765 端口的孤儿进程，
        // 否则下次启动会复用旧实例，导致"改的代码不生效"。
        if let Ok(mut guard) = self.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

#[tauri::command]
fn store_api_key(provider: String, secret: String) -> Result<(), String> {
    if provider.trim().is_empty() || secret.trim().is_empty() {
        return Err("Provider and secret are required".into());
    }
    let entry = keyring::Entry::new("QuantDesk", &provider).map_err(|e| e.to_string())?;
    entry.set_password(&secret).map_err(|e| e.to_string())
}

#[tauri::command]
fn has_api_key(provider: String) -> Result<bool, String> {
    let entry = keyring::Entry::new("QuantDesk", &provider).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(!value.is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn delete_api_key(provider: String) -> Result<(), String> {
    let entry = keyring::Entry::new("QuantDesk", &provider).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn engine_alive() -> bool {
    use std::net::TcpStream;
    TcpStream::connect_timeout(
        &"127.0.0.1:8765".parse().unwrap(),
        std::time::Duration::from_millis(250),
    )
    .is_ok()
}

#[tauri::command]
fn engine_token(state: tauri::State<EngineToken>) -> Result<String, String> {
    state
        .0
        .lock()
        .map_err(|_| "Engine token state is unavailable")?
        .clone()
        .ok_or_else(|| "本地引擎尚未由当前应用启动".into())
}

#[tauri::command]
async fn configure_engine(
    provider: String,
    token_state: tauri::State<'_, EngineToken>,
) -> Result<(), String> {
    let entry = keyring::Entry::new("QuantDesk", &provider).map_err(|e| e.to_string())?;
    let secret = entry.get_password().map_err(|e| e.to_string())?;
    let token = token_state
        .0
        .lock()
        .map_err(|_| "Engine token state is unavailable")?
        .clone()
        .ok_or_else(|| "本地引擎尚未由当前应用启动".to_string())?;
    let request = reqwest::Client::new()
        .post("http://127.0.0.1:8765/providers/configure")
        .header("X-QuantDesk-Token", token)
        .json(&serde_json::json!({"provider": provider, "api_key": secret}));
    request
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 券商凭据由 Windows Credential Manager 保管。仅在当前桌面进程通过本地回环
/// 鉴权交给引擎，绝不落入 SQLite、日志或前端状态。
#[tauri::command]
async fn configure_broker_engine(
    broker: String,
    token_state: tauri::State<'_, EngineToken>,
) -> Result<(), String> {
    let service = match broker.as_str() {
        "alpaca" => "BrokerAlpaca",
        "ibkr" => "BrokerIBKR",
        _ => return Err("Unsupported broker".into()),
    };
    let entry = keyring::Entry::new("QuantDesk", service).map_err(|e| e.to_string())?;
    let raw_credentials = entry.get_password().map_err(|e| e.to_string())?;
    let credentials: serde_json::Value = serde_json::from_str(&raw_credentials)
        .map_err(|_| "Broker credential is invalid; please configure it again".to_string())?;
    let token = token_state
        .0
        .lock()
        .map_err(|_| "Engine token state is unavailable")?
        .clone()
        .ok_or_else(|| "本地引擎尚未由当前应用启动".to_string())?;
    reqwest::Client::new()
        .post("http://127.0.0.1:8765/brokers/configure")
        .header("X-QuantDesk-Token", token)
        .json(&serde_json::json!({"broker": broker, "credentials": credentials}))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn start_engine(
    app: tauri::AppHandle,
    state: tauri::State<EngineProcess>,
    token_state: tauri::State<EngineToken>,
) -> Result<String, String> {
    use tauri::Manager;
    let mut guard = state.0.lock().map_err(|_| "Engine state is unavailable")?;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok("already-running".into());
        }
    }
    // 不复用无法证明所有权的进程：它的令牌不在内存中，复用会把本应用请求交给未知服务。
    if engine_alive() {
        return Err("8765 端口已有非当前 QuantDesk 引擎进程；请先关闭该进程后重试".into());
    }
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let executable_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|p| p.to_path_buf()));
    let resource_engine = resource_dir.join("engine-bin").join("quant-engine.exe");
    let adjacent_engine = executable_dir
        .as_ref()
        .map(|dir| dir.join("engine-bin").join("quant-engine.exe"));
    let bundled_engine = if resource_engine.exists() {
        resource_engine
    } else {
        adjacent_engine
            .filter(|path| path.exists())
            .unwrap_or_else(|| resource_dir.join("engine-bin").join("quant-engine.exe"))
    };
    let resource_script = resource_dir.join("engine").join("main.py");
    let adjacent_script = executable_dir
        .as_ref()
        .map(|dir| dir.join("engine").join("main.py"));
    let script_found = resource_script.exists()
        || adjacent_script.as_ref().map(|p| p.exists()).unwrap_or(false);
    let packaged_script = if resource_script.exists() {
        resource_script
    } else {
        adjacent_script.unwrap_or(resource_dir.join("engine").join("main.py"))
    };
    // 开发模式（cwd 为 src-tauri 且 ../engine/main.py 存在）永远优先跑项目根的最新
    // Python 源码；resource_dir 下的 engine/ 与 engine-bin/ 都是构建期拷贝，可能过期，
    // 优先用它们会把开发中的引擎改动（新提供商/新端点）全部丢掉。
    let dev_script = std::path::Path::new("../engine/main.py");
    let (script, cwd) = if dev_script.exists() {
        (
            std::path::PathBuf::from("engine/main.py"),
            Some(std::path::PathBuf::from("..")),
        )
    } else if packaged_script.exists() {
        (packaged_script, None)
    } else if std::path::Path::new("engine/main.py").exists() {
        (
            std::path::PathBuf::from("engine/main.py"),
            Some(std::path::PathBuf::from(".")),
        )
    } else {
        (std::path::PathBuf::from("engine/main.py"), None)
    };
    let bundled_python = resource_dir.join("python").join("python.exe");
    let dev_py1 = std::path::PathBuf::from(".venv/Scripts/python.exe");
    let dev_py2 = std::path::PathBuf::from("../.venv/Scripts/python.exe");
    let python = if bundled_python.exists() {
        bundled_python
    } else if dev_py1.exists() {
        dev_py1
    } else if dev_py2.exists() {
        dev_py2
    } else {
        std::path::PathBuf::from("python")
    };
    // 仅在找不到 Python 源码（真正的打包安装形态）时才用捆绑引擎二进制：
    // target/debug 里可能残留旧构建拷贝的 engine-bin/quant-engine.exe，
    // 优先用它会把开发中的引擎改动（新提供商/新端点）全部丢掉。
    let dev_script_present = std::path::Path::new("engine/main.py").exists()
        || std::path::Path::new("../engine/main.py").exists();
    let mut command = if bundled_engine.exists() && !script_found && !dev_script_present {
        Command::new(bundled_engine)
    } else {
        let mut fallback = Command::new(python);
        if let Some(dir) = cwd {
            fallback.current_dir(dir);
        }
        fallback.arg(script);
        fallback
    };
    let engine_token = uuid::Uuid::new_v4().to_string();
    command.env("QUANTDESK_ENGINE_TOKEN", &engine_token);
    // 桌面端拉起的引擎沿用 HTTP+令牌鉴权；用户机器上常设 QUANTDESK_ENGINE_HOST=0.0.0.0
    // （手机局域网访问），引擎会因"非回环监听必须 TLS"拒绝启动，这里显式放行。
    // 需要加密传输时用户可自行设置 QUANTDESK_ENGINE_TLS=1，守卫同样放行。
    command.env("QUANTDESK_ALLOW_INSECURE_LAN", "1");
    if let Ok(entry) = keyring::Entry::new("QuantDesk", "OpenAI") {
        if let Ok(secret) = entry.get_password() {
            command.env("OPENAI_API_KEY", secret);
        }
    }
    if let Ok(entry) = keyring::Entry::new("QuantDesk", "AlphaVantage") {
        if let Ok(secret) = entry.get_password() {
            command.env("ALPHAVANTAGE_API_KEY", secret);
        }
    }
    if let Ok(entry) = keyring::Entry::new("QuantDesk", "Tushare") {
        if let Ok(secret) = entry.get_password() {
            command.env("TUSHARE_TOKEN", secret);
        }
    }
    if let Ok(entry) = keyring::Entry::new("QuantDesk", "DeepSeek") {
        if let Ok(secret) = entry.get_password() {
            command.env("DEEPSEEK_API_KEY", secret);
        }
    }
    if let Ok(entry) = keyring::Entry::new("QuantDesk", "Qwen") {
        if let Ok(secret) = entry.get_password() {
            command.env("DASHSCOPE_API_KEY", secret);
        }
    }
    if let Ok(entry) = keyring::Entry::new("QuantDesk", "OpenRouter") {
        if let Ok(secret) = entry.get_password() {
            command.env("OPENROUTER_API_KEY", secret);
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    // 引擎 stdout/stderr 落盘到 logs/spawn.log（追加），不再静默丢弃——
    // 引擎启动失败（端口占用、Python 异常等）事后可查。
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let spawn_log_dir = exe_dir.join("logs");
    let _ = std::fs::create_dir_all(&spawn_log_dir);
    let spawn_log_path = spawn_log_dir.join("spawn.log");
    let open_append = || {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&spawn_log_path)
            .ok()
    };
    let stdout_log = open_append();
    let stderr_log = open_append();
    if let Some(mut file) = open_append() {
        use std::io::Write;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "[{ts}] spawning engine");
    }
    let child = command
        .stdin(Stdio::null())
        .stdout(stdout_log.map(Stdio::from).unwrap_or(Stdio::null()))
        .stderr(stderr_log.map(Stdio::from).unwrap_or(Stdio::null()))
        .spawn()
        .map_err(|e| format!("Unable to start Python engine: {e}"))?;
    *guard = Some(child);
    *token_state
        .0
        .lock()
        .map_err(|_| "Engine token state is unavailable")? = Some(engine_token);
    // 释放 guard 前先克隆必要信息用于就绪等待；等待期间允许其它线程查看状态。
    drop(guard);
    // 就绪握手：轮询 TCP 就绪（最多 60s），并提前发现引擎异常退出。
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        if engine_alive() {
            break;
        }
        {
            let mut guard = state.0.lock().map_err(|_| "Engine state is unavailable")?;
            match guard.as_mut() {
                Some(child) => {
                    if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                        return Err(format!(
                            "引擎进程启动后立即退出，请查看 {}",
                            spawn_log_path.display()
                        ));
                    }
                }
                None => return Err("引擎进程状态丢失".into()),
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err("引擎 60 秒内未就绪（端口未监听），请查看 spawn.log".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    // 引擎意外退出监控：通知前端展示提示，而不是让用户面对无法解释的连接错误。
    let app_handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let state = app_handle.state::<EngineProcess>();
        let exited = {
            let mut guard = match state.0.lock() {
                Ok(g) => g,
                Err(_) => break,
            };
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        *guard = None;
                        Some(status)
                    }
                    _ => None,
                },
                None => break, // 应用退出或已重启监控
            }
        };
        if let Some(status) = exited {
            let _ = app_handle.emit(
                "engine-exited",
                serde_json::json!({ "code": status.code() }),
            );
            break;
        }
    });
    Ok("started".into())
}

// ---- 内置浏览器：主窗口内的子 webview ----
// 用 tauri 核心的 Window::add_child（需要 unstable feature）在主窗口内创建子 webview，
// 完全在应用内、不产生独立窗口，也不依赖需联网下载的 tauri-plugin-webview。
// 注意：tauri 在该版本对 add_child 子 webview 的 hide/show/set_bounds/close 是静默空操作
//（消息处理不到子 webview，见 url() 返回 "failed to receive message from webview"）。
// 因此这里在创建后捕获子窗口的 HWND，直接用 Win32（ShowWindow/SetWindowPos/DestroyWindow）
// 驱动原生窗口，保证折叠、拖动、关闭真正生效。
use std::collections::HashMap;
use tauri::{LogicalPosition, LogicalSize, Manager, Position, Rect, Size, WebviewUrl};

/// label -> 原生 WRY_WEBVIEW 窗口句柄
struct BrowserHwnds(Mutex<HashMap<String, isize>>);

#[cfg(windows)]
mod hwnd_browser {
    use std::collections::HashSet;
    use std::ffi::c_void;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyWindow, EnumChildWindows, GetClassNameW, GetClientRect, GetWindow, GetWindowRect,
        IsWindowVisible, SetWindowPos, ShowWindow, GW_CHILD, GW_HWNDNEXT, SWP_ASYNCWINDOWPOS,
        SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE, SW_SHOW,
    };

    const CLASS_WEBVIEW: &str = "WRY_WEBVIEW";

    fn to_hwnd(h: isize) -> HWND {
        HWND(h as *mut c_void)
    }

    /// capture_new 的遍历上下文：已知句柄集合 + 结果槽（每次调用独立，避免并发竞态）
    struct FindCtx<'a> {
        known: &'a HashSet<isize>,
        found: Option<isize>,
    }

    unsafe extern "system" fn enum_collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let set = &mut *(lparam.0 as *mut HashSet<isize>);
        let mut buf = [0u16; 128];
        let len = GetClassNameW(hwnd, &mut buf);
        let class = String::from_utf16_lossy(&buf[..len.max(0) as usize]);
        if class == CLASS_WEBVIEW {
            set.insert(hwnd.0 as isize);
        }
        BOOL(1)
    }

    unsafe extern "system" fn enum_find_new(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut FindCtx);
        let mut buf = [0u16; 128];
        let len = GetClassNameW(hwnd, &mut buf);
        let class = String::from_utf16_lossy(&buf[..len.max(0) as usize]);
        if class == CLASS_WEBVIEW && !ctx.known.contains(&(hwnd.0 as isize)) {
            ctx.found = Some(hwnd.0 as isize);
            return BOOL(0); // 找到即停止枚举
        }
        BOOL(1)
    }

    /// 枚举主窗口下所有 WRY_WEBVIEW 子窗口句柄
    pub fn collect_webviews(parent: HWND) -> HashSet<isize> {
        let mut set = HashSet::new();
        unsafe {
            let _ = EnumChildWindows(
                Some(parent),
                Some(enum_collect),
                LPARAM(&mut set as *mut HashSet<isize> as isize),
            );
        }
        set
    }

    /// 创建后枚举，找出不属于 known 集合的新增 WRY_WEBVIEW 句柄
    pub fn capture_new(parent: HWND, known: &HashSet<isize>) -> Option<isize> {
        let mut ctx = FindCtx { known, found: None };
        unsafe {
            let _ = EnumChildWindows(
                Some(parent),
                Some(enum_find_new),
                LPARAM(&mut ctx as *mut FindCtx as isize),
            );
        }
        ctx.found
    }

    pub fn set_visible(h: isize, visible: bool) {
        unsafe {
            let _ = ShowWindow(to_hwnd(h), if visible { SW_SHOW } else { SW_HIDE });
        }
    }

    pub fn set_bounds(h: isize, x: i32, y: i32, w: i32, hgt: i32) {
        unsafe {
            let hwnd = to_hwnd(h);
            let _ = SetWindowPos(
                hwnd,
                None,
                x,
                y,
                w,
                hgt,
                SWP_ASYNCWINDOWPOS | SWP_NOZORDER | SWP_NOACTIVATE,
            );
            // WebView2 的合成窗口是 WRY_WEBVIEW 的直接子窗口。只移动容器 HWND
            // 而不同步子窗口时，页面光栅会停在旧尺寸/旧偏移，看起来和工具栏对不齐。
            let mut rc = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if GetClientRect(hwnd, &mut rc).is_ok() {
                let cw = rc.right - rc.left;
                let ch = rc.bottom - rc.top;
                let mut child = GetWindow(hwnd, GW_CHILD).ok();
                while let Some(child_hwnd) = child {
                    let _ = SetWindowPos(
                        child_hwnd,
                        None,
                        0,
                        0,
                        cw,
                        ch,
                        SWP_ASYNCWINDOWPOS | SWP_NOZORDER | SWP_NOACTIVATE,
                    );
                    child = GetWindow(child_hwnd, GW_HWNDNEXT).ok();
                }
            }
        }
    }

    pub fn destroy(h: isize) {
        unsafe {
            let _ = DestroyWindow(to_hwnd(h));
        }
    }

    /// (是否可见, 屏幕矩形 (x, y, w, h))
    pub fn query(h: isize) -> (bool, (i32, i32, i32, i32)) {
        unsafe {
            let vis = IsWindowVisible(to_hwnd(h)).as_bool();
            let mut r = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if GetWindowRect(to_hwnd(h), &mut r).is_ok() {
                (vis, (r.left, r.top, r.right - r.left, r.bottom - r.top))
            } else {
                (vis, (0, 0, 0, 0))
            }
        }
    }
}

#[cfg(not(windows))]
mod hwnd_browser {
    pub fn set_visible(_h: isize, _visible: bool) {}
    pub fn set_bounds(_h: isize, _x: i32, _y: i32, _w: i32, _h: i32) {}
    pub fn destroy(_h: isize) {}
    pub fn query(_h: isize) -> (bool, (i32, i32, i32, i32)) {
        (false, (0, 0, 0, 0))
    }
}

#[tauri::command]
async fn browser_open(
    app: tauri::AppHandle,
    label: String,
    url: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    #[cfg(windows)]
    let parent = window.hwnd().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let known = hwnd_browser::collect_webviews(parent);
    let parsed = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    let builder = tauri::WebviewBuilder::new(&label, WebviewUrl::External(parsed));
    window
        .add_child(
            builder,
            Position::Logical(LogicalPosition::new(x as f64, y as f64)),
            Size::Logical(LogicalSize::new(width as f64, height as f64)),
        )
        .map_err(|e| format!("create webview failed: {e}"))?;
    #[cfg(windows)]
    if let Some(h) = hwnd_browser::capture_new(parent, &known) {
        app.state::<BrowserHwnds>()
            .0
            .lock()
            .unwrap()
            .insert(label.clone(), h);
    }
    apply_browser_bounds(&app, &label, x, y, width, height);
    Ok(())
}

#[tauri::command]
async fn browser_navigate(app: tauri::AppHandle, label: String, url: String) -> Result<(), String> {
    let parsed = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    match app.get_webview(&label) {
        Some(wv) => wv.navigate(parsed).map_err(|e| e.to_string()),
        None => Err(format!("webview '{label}' not found")),
    }
}

fn browser_hwnd(app: &tauri::AppHandle, label: &str) -> Result<isize, String> {
    app.state::<BrowserHwnds>()
        .0
        .lock()
        .unwrap()
        .get(label)
        .copied()
        .ok_or_else(|| format!("browser '{label}' has no native handle"))
}

fn apply_browser_bounds(
    app: &tauri::AppHandle,
    label: &str,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) {
    // Tauri 的 set_bounds 会同时更新 WebView2 controller 与容器 HWND。
    // 该版本对子 webview 的部分消息可能丢失，因此下面再用 Win32 兜底。
    if let Some(wv) = app.get_webview(label) {
        let _ = wv.set_bounds(Rect {
            position: Position::Logical(LogicalPosition::new(x as f64, y as f64)),
            size: Size::Logical(LogicalSize::new(width as f64, height as f64)),
        });
    }
    if let Ok(h) = browser_hwnd(app, label) {
        if let Some(window) = app.get_window("main") {
            if let Ok(scale) = window.scale_factor() {
                let px = |v: f64| (v * scale).round() as i32;
                hwnd_browser::set_bounds(
                    h,
                    px(x as f64),
                    px(y as f64),
                    px(width as f64),
                    px(height as f64),
                );
            }
        }
    }
}

#[tauri::command]
async fn browser_bounds(
    app: tauri::AppHandle,
    label: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    apply_browser_bounds(&app, &label, x, y, width, height);
    Ok(())
}

#[tauri::command]
async fn browser_close(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(h) = app.state::<BrowserHwnds>().0.lock().unwrap().remove(&label) {
        // DestroyWindow 只能由拥有该窗口的线程（主/UI 线程）调用，跨线程会静默失败；
        // 因此把原生窗口销毁调度到主线程执行。
        let _ = app.run_on_main_thread(move || hwnd_browser::destroy(h));
    }
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.close();
    }
    Ok(())
}

#[tauri::command]
async fn browser_close_all(app: tauri::AppHandle) -> Result<(), String> {
    // 前端整页刷新时卸载清理不会执行，旧的子 webview（主窗口子 HWND）会残留浮在页面上，
    // 且新 JS 上下文不知道其 label，无法单独关闭。前端在检测到整页刷新后调用本命令：
    // 关闭所有浏览器子 webview，但绝不碰主窗口自身的 webview。
    let main_label = app.get_window("main").map(|w| w.label().to_string());
    // 1) 销毁登记过的原生窗口 HWND（DestroyWindow 只能在主线程调用）
    let hwnds: Vec<String> = app
        .state::<BrowserHwnds>()
        .0
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    for label in hwnds {
        if let Some(h) = app.state::<BrowserHwnds>().0.lock().unwrap().remove(&label) {
            let _ = app.run_on_main_thread(move || hwnd_browser::destroy(h));
        }
    }
    // 2) 关闭所有非主窗口的 webview（覆盖 capture_new 未登记 HWND 的孤儿）
    for (label, wv) in app.webviews() {
        if Some(label.as_str()) != main_label.as_deref() {
            let _ = wv.close();
        }
    }
    Ok(())
}

#[tauri::command]
async fn browser_hide(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let h = browser_hwnd(&app, &label)?;
    hwnd_browser::set_visible(h, false);
    Ok(())
}

#[tauri::command]
async fn browser_show(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let h = browser_hwnd(&app, &label)?;
    hwnd_browser::set_visible(h, true);
    Ok(())
}

#[tauri::command]
async fn browser_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    Ok(app
        .webviews()
        .into_iter()
        .map(|(_, w)| w.label().to_string())
        .collect())
}

/// 供验证用：返回原生窗口的可见性与矩形
#[tauri::command]
async fn browser_state(app: tauri::AppHandle, label: String) -> Result<serde_json::Value, String> {
    match browser_hwnd(&app, &label) {
        Ok(h) => {
            let (visible, rect) = hwnd_browser::query(h);
            Ok(serde_json::json!({
                "hwnd": h,
                "visible": visible,
                "rect": { "x": rect.0, "y": rect.1, "w": rect.2, "h": rect.3 },
            }))
        }
        Err(_) => Ok(serde_json::json!({ "hwnd": null, "visible": false, "rect": null })),
    }
}

pub fn run() {
    tauri::Builder::default()
        // 单实例互斥：二次启动只激活已有窗口并退出，杜绝两个实例并发拉起引擎抢端口。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(EngineProcess(Mutex::new(None)))
        .manage(EngineToken(Mutex::new(None)))
        .manage(BrowserHwnds(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            store_api_key,
            has_api_key,
            delete_api_key,
            configure_engine,
            configure_broker_engine,
            start_engine,
            engine_token,
            browser_open,
            browser_navigate,
            browser_bounds,
            browser_close,
            browser_close_all,
            browser_hide,
            browser_show,
            browser_list,
            browser_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running QuantDesk");
}

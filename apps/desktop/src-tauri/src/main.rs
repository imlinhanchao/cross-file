// CrossFile desktop shell (Tauri 2).
//
// Responsibilities kept on the native side:
//   1. native save sink for large files (AC9): open / random-offset write / close / abort
//   2. "transfering, do not close" guard on the window close button
//   3. native menu (房间 / 编辑 / 设置 / 帮助) with external help links
//   4. server-address settings page (self-hosted instances), see server_config.rs
//
// The web app talks to these through Tauri IPC (`window.__TAURI__.core.invoke`
// because `app.withGlobalTauri` is on, or `@tauri-apps/api/core` if it is added).
// See docs/desktop.md for the JS-side contract.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server_config;

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Emitter, Manager, State, Webview, Window, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use server_config::{
    normalize_server_input, ServerSettingsSnapshot, OFFICIAL_ORIGIN, OFFICIAL_SIGNALING_URL,
};

/// Official instance doubles as the project home until a marketing site exists.
const DEFAULT_HOMEPAGE_URL: &str = "https://file.time-pack.com/";
/// The privacy statement is a route in the web app (`apps/web/src/pages/PrivacyPage.tsx`).
const DEFAULT_PRIVACY_URL: &str = "https://file.time-pack.com/privacy";
/// URI scheme serving the shell-owned settings page (local origin -> IPC allowed).
const SETTINGS_SCHEME: &str = "crossfile-settings";
const SETTINGS_MENU_ID: &str = "server-settings";

#[derive(serde::Serialize)]
struct ShellConfig {
    shell: &'static str,
    platform: &'static str,
    signaling_url: String,
    save_strategy: &'static str,
    /// Debug builds only: lets an automated acceptance run auto-accept without taps.
    debug_auto_accept: bool,
    version: &'static str,
}

/// The web app calls this at connect time so a packaged shell can point at a
/// self-hosted signaling server without rebuilding the frontend.
#[tauri::command]
fn get_shell_config(app: AppHandle) -> ShellConfig {
    ShellConfig {
        shell: "desktop",
        platform: std::env::consts::OS,
        signaling_url: server_config::effective_choice(&app).signaling_url,
        save_strategy: "native",
        debug_auto_accept: cfg!(debug_assertions)
            && std::env::var("CROSSFILE_DEV_AUTOACCEPT").is_ok_and(|value| value == "1"),
        version: env!("CARGO_PKG_VERSION"),
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct SaveHandle {
    file: File,
    path: PathBuf,
}

#[derive(Default)]
struct AppState {
    /// Set by the web app while bytes are in flight; blocks CloseRequested.
    transfer_active: AtomicBool,
    next_handle: AtomicU64,
    saves: Mutex<HashMap<u64, SaveHandle>>,
}

/// Shell UI state for the settings page round-trip.
#[derive(Default)]
struct ShellUiState {
    /// Last URL of the bundled web app page (where the settings page returns to).
    app_url: Mutex<Option<String>>,
    /// True until the first server choice is saved: 取消/关闭 exits the app.
    first_run: AtomicBool,
}

// ---------------------------------------------------------------------------
// Native save sink (AC9): open / write@offset / close / abort
// ---------------------------------------------------------------------------

/// Turn an untrusted file name into a single safe path component.
fn safe_file_name(raw: &str) -> String {
    // Split on both separators so Windows-style paths are handled on every OS.
    let base = raw
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .next_back()
        .unwrap_or("");
    let mut cleaned = String::with_capacity(base.len());
    for ch in base.chars() {
        match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => cleaned.push('_'),
            c if (c as u32) < 0x20 => cleaned.push('_'),
            c => cleaned.push(c),
        }
    }
    let cleaned = cleaned
        .trim_matches(|c: char| c.is_whitespace() || c == '.')
        .to_string();
    if cleaned.is_empty() {
        "crossfile-download.bin".to_string()
    } else {
        cleaned
    }
}

/// Never overwrite: append " (n)" before the extension, like a browser download.
fn unique_path(dir: &Path, file_name: &str) -> PathBuf {
    let first = dir.join(file_name);
    if !first.exists() {
        return first;
    }
    let name = Path::new(file_name);
    let stem = name
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("crossfile-download");
    let ext = name.extension().and_then(|s| s.to_str());
    for n in 1..10_000u32 {
        let candidate = match ext {
            Some(ext) => dir.join(format!("{stem} ({n}).{ext}")),
            None => dir.join(format!("{stem} ({n})")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-{}", std::process::id()))
}

fn lock_saves(
    state: &AppState,
) -> Result<std::sync::MutexGuard<'_, HashMap<u64, SaveHandle>>, String> {
    state
        .saves
        .lock()
        .map_err(|_| "保存句柄表已损坏（panic 后中毒）".to_string())
}

fn io_err(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}: {error}")
}

/// Open a save target in the OS download directory and return its handle id.
#[tauri::command]
async fn save_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<u64, String> {
    let dir = app
        .path()
        .download_dir()
        .map_err(|error| io_err("无法定位下载目录", error))?;
    fs::create_dir_all(&dir).map_err(|error| io_err("无法创建下载目录", error))?;

    let file_name = safe_file_name(&name);
    let path = unique_path(&dir, &file_name);
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .read(true)
        .open(&path)
        .map_err(|error| io_err(&format!("无法创建 {}", path.display()), error))?;

    let handle = state.next_handle.fetch_add(1, Ordering::Relaxed) + 1;
    lock_saves(&state)?.insert(handle, SaveHandle { file, path });
    Ok(handle)
}

/// Write one chunk at its absolute offset (resume-safe, order-independent).
#[tauri::command]
async fn save_write(
    state: State<'_, AppState>,
    handle: u64,
    offset: u64,
    bytes_b64: String,
) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let bytes = STANDARD
        .decode(bytes_b64.as_bytes())
        .map_err(|error| format!("invalid write payload: {error}"))?;
    let mut saves = lock_saves(&state)?;
    let entry = saves
        .get_mut(&handle)
        .ok_or_else(|| format!("未知的保存句柄 {handle}"))?;
    entry
        .file
        .seek(SeekFrom::Start(offset))
        .map_err(|error| io_err("保存定位失败", error))?;
    entry
        .file
        .write_all(&bytes)
        .map_err(|error| io_err("保存写入失败", error))
}

/// Flush, release the handle, and return the final path for the UI.
#[tauri::command]
async fn save_close(state: State<'_, AppState>, handle: u64) -> Result<String, String> {
    let entry = lock_saves(&state)?
        .remove(&handle)
        .ok_or_else(|| format!("未知的保存句柄 {handle}"))?;
    entry
        .file
        .sync_all()
        .map_err(|error| io_err("保存刷盘失败", error))?;
    Ok(entry.path.to_string_lossy().into_owned())
}

/// Drop the handle and delete the partial file (transfer cancelled / hash mismatch).
#[tauri::command]
async fn save_abort(state: State<'_, AppState>, handle: u64) -> Result<(), String> {
    let entry = lock_saves(&state)?
        .remove(&handle)
        .ok_or_else(|| format!("未知的保存句柄 {handle}"))?;
    let path = entry.path.clone();
    drop(entry.file);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_err(
            &format!("无法删除未完成文件 {}", path.display()),
            error,
        )),
    }
}

// ---------------------------------------------------------------------------
// Server settings (see server_config.rs)
// ---------------------------------------------------------------------------

fn transfer_active(app: &AppHandle) -> bool {
    app.state::<AppState>()
        .transfer_active
        .load(Ordering::SeqCst)
}

fn is_settings_url(url: &Url) -> bool {
    url.scheme() == SETTINGS_SCHEME
        || url.host_str() == Some(&format!("{SETTINGS_SCHEME}.localhost"))
}

/// URL of the shell-served settings page. On Windows/Android custom protocols
/// are exposed as `http://<scheme>.localhost/…`; wry maps it back to the scheme.
fn settings_page_url() -> Url {
    #[cfg(any(windows, target_os = "android"))]
    let raw = format!("http://{SETTINGS_SCHEME}.localhost/index.html");
    #[cfg(not(any(windows, target_os = "android")))]
    let raw = format!("{SETTINGS_SCHEME}://localhost/index.html");
    Url::parse(&raw).expect("static settings URL is valid")
}

/// Serve the settings page assets embedded in the binary (no files on disk).
fn settings_asset(path: &str) -> Option<(&'static str, &'static str)> {
    match path {
        "/" | "/index.html" => Some((
            "text/html; charset=utf-8",
            include_str!("../settings/index.html"),
        )),
        "/settings.css" => Some((
            "text/css; charset=utf-8",
            include_str!("../settings/settings.css"),
        )),
        "/settings.js" => Some((
            "text/javascript; charset=utf-8",
            include_str!("../settings/settings.js"),
        )),
        _ => None,
    }
}

fn settings_protocol_response(
    _context: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    let path = request.uri().path().to_string();
    match settings_asset(&path) {
        Some((mime, body)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CACHE_CONTROL, "no-store")
            .body(body.as_bytes().to_vec())
            .expect("valid settings response"),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body("not found".as_bytes().to_vec())
            .expect("valid not-found response"),
    }
}

/// The web app resolves its signaling endpoint from this injected global first
/// (then `get_shell_config`, then same-origin). Injecting it makes the saved
/// choice authoritative, exactly like the mobile shell does.
fn shell_init_script(app: &AppHandle) -> String {
    shell_init_script_for(&server_config::effective_choice(app).signaling_url)
}

fn shell_init_script_for(signaling_url: &str) -> String {
    let url = serde_json::to_string(signaling_url)
        .unwrap_or_else(|_| format!("\"{OFFICIAL_SIGNALING_URL}\""));
    format!(
        r#"(function () {{
  window.__CROSSFILE_NATIVE__ = true;
  if (!window.__CROSSFILE_SIGNALING_URL__) {{
    window.__CROSSFILE_SIGNALING_URL__ = {url};
  }}
}})();"#
    )
}

fn server_settings_snapshot(app: &AppHandle) -> ServerSettingsSnapshot {
    let shell = app.state::<ShellUiState>();
    ServerSettingsSnapshot::new(
        &server_config::effective_choice(app),
        shell.first_run.load(Ordering::SeqCst),
        transfer_active(app),
    )
}

fn remember_app_url(app: &AppHandle, url: &Url) {
    if is_settings_url(url) {
        return;
    }
    if let Ok(mut slot) = app.state::<ShellUiState>().app_url.lock() {
        *slot = Some(url.to_string());
    }
}

fn navigate_to_settings(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    let current = window.url().ok();
    if let Some(current) = current {
        remember_app_url(app, &current);
    }
    window
        .navigate(settings_page_url())
        .map_err(|error| format!("无法打开服务器设置：{error}"))
}

fn return_to_app(app: &AppHandle) -> Result<bool, String> {
    if transfer_active(app) {
        return Ok(false);
    }
    let target = app
        .state::<ShellUiState>()
        .app_url
        .lock()
        .ok()
        .and_then(|slot| slot.clone());
    let Some(target) = target else {
        return Err("找不到应用页面地址，请重新打开应用".to_string());
    };
    let url = Url::parse(&target).map_err(|error| format!("应用页面地址无效：{error}"))?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    window
        .navigate(url)
        .map_err(|error| format!("无法返回应用页面：{error}"))?;
    Ok(true)
}

fn open_settings(app: &AppHandle) -> Result<(), String> {
    if transfer_active(app) {
        return Err("正在传输文件，传输结束后才能打开服务器设置".to_string());
    }
    navigate_to_settings(app)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NormalizedServer {
    origin: String,
    signaling_url: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsMutation {
    settings: ServerSettingsSnapshot,
    applied: bool,
    message: String,
}

#[tauri::command]
fn get_server_settings(app: AppHandle) -> ServerSettingsSnapshot {
    server_settings_snapshot(&app)
}

#[tauri::command]
fn normalize_server_origin(origin: String) -> Result<NormalizedServer, String> {
    let (origin, signaling_url) = normalize_server_input(&origin)?;
    Ok(NormalizedServer {
        origin,
        signaling_url,
    })
}

#[tauri::command]
fn open_server_settings(app: AppHandle) -> Result<(), String> {
    open_settings(&app)
}

#[tauri::command]
fn save_server_settings(app: AppHandle, origin: String) -> Result<SettingsMutation, String> {
    let path = server_config::settings_path(&app)?;
    server_config::save_choice(&path, &origin)?;
    app.state::<ShellUiState>()
        .first_run
        .store(false, Ordering::SeqCst);
    let applied = return_to_app(&app)?;
    Ok(SettingsMutation {
        settings: server_settings_snapshot(&app),
        applied,
        message: if applied {
            "已保存，正在连接…".to_string()
        } else {
            "已保存；当前正在传输文件，重新打开应用后生效。".to_string()
        },
    })
}

#[tauri::command]
fn reset_server_settings(app: AppHandle) -> Result<SettingsMutation, String> {
    let path = server_config::settings_path(&app)?;
    server_config::clear_saved_choice(&path)?;
    app.state::<ShellUiState>()
        .first_run
        .store(false, Ordering::SeqCst);
    let applied = return_to_app(&app)?;
    Ok(SettingsMutation {
        settings: server_settings_snapshot(&app),
        applied,
        message: if applied {
            format!("已恢复官方实例 {OFFICIAL_ORIGIN}，正在连接…")
        } else {
            "已恢复官方实例；当前正在传输文件，重新打开应用后生效。".to_string()
        },
    })
}

#[tauri::command]
fn close_server_settings(app: AppHandle) -> Result<(), String> {
    if app.state::<ShellUiState>().first_run.load(Ordering::SeqCst) {
        app.exit(0);
        return Ok(());
    }
    return_to_app(&app).map(|_| ())
}

// ---------------------------------------------------------------------------
// Close protection
// ---------------------------------------------------------------------------

/// Web app tells the shell whether bytes are in flight.
#[tauri::command]
fn set_transfer_active(
    app: AppHandle,
    state: State<'_, AppState>,
    active: bool,
) -> Result<(), String> {
    state.transfer_active.store(active, Ordering::SeqCst);
    set_settings_menu_enabled(&app, !active);
    Ok(())
}

/// Called after the web app's own confirmation; exits for real this time.
#[tauri::command]
fn confirm_close(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.transfer_active.store(false, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

/// Close button / Cmd+Q path: ask the web app to confirm while transferring.
fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        let active = window
            .app_handle()
            .state::<AppState>()
            .transfer_active
            .load(Ordering::SeqCst);
        if active {
            api.prevent_close();
            let _ = window.emit("close-requested", ());
        }
    }
}

fn request_quit(app: &tauri::AppHandle) {
    let active = app
        .state::<AppState>()
        .transfer_active
        .load(Ordering::SeqCst);
    if active {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit("close-requested", ());
        }
    } else {
        app.exit(0);
    }
}

/// The settings page destroys the app page (and any running transfer), so its
/// menu entry is disabled while bytes are in flight.
fn set_settings_menu_enabled(app: &AppHandle, enabled: bool) {
    let Some(menu) = app.menu() else {
        return;
    };
    let Some(MenuItemKind::Submenu(submenu)) = menu.get("settings-menu") else {
        return;
    };
    if let Some(MenuItemKind::MenuItem(item)) = submenu.get(SETTINGS_MENU_ID) {
        let _ = item.set_enabled(enabled);
    }
}

// ---------------------------------------------------------------------------
// Native menu: 房间 / 编辑 / 设置 / 帮助
// ---------------------------------------------------------------------------

fn help_url(env_key: &str, fallback: &str) -> String {
    std::env::var(env_key).unwrap_or_else(|_| fallback.to_string())
}

fn open_external(app: &tauri::AppHandle, url: &str) {
    if let Err(error) = app.opener().open_url(url, None::<&str>) {
        eprintln!("[crossfile] 打开外链失败 {url}: {error}");
    }
}

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let new_room = MenuItem::with_id(app, "new-room", "新建房间", true, Some("CmdOrCtrl+N"))?;
    let end_room = MenuItem::with_id(app, "end-room", "结束房间", true, Some("CmdOrCtrl+Shift+E"))?;
    let quit = MenuItem::with_id(app, "quit", "退出 CrossFile", true, Some("CmdOrCtrl+Q"))?;
    let room = Submenu::with_items(
        app,
        "房间",
        true,
        &[
            &new_room,
            &end_room,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let undo = PredefinedMenuItem::undo(app, Some("撤销"))?;
    let redo = PredefinedMenuItem::redo(app, Some("重做"))?;
    let cut = PredefinedMenuItem::cut(app, Some("剪切"))?;
    let copy = PredefinedMenuItem::copy(app, Some("复制"))?;
    let paste = PredefinedMenuItem::paste(app, Some("粘贴"))?;
    let select_all = PredefinedMenuItem::select_all(app, Some("全选"))?;
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &undo,
            &redo,
            &PredefinedMenuItem::separator(app)?,
            &cut,
            &copy,
            &paste,
            &select_all,
        ],
    )?;

    // Self-hosted instances: open the shell-owned server-address page. The item
    // is disabled while a transfer is active (set_settings_menu_enabled).
    let server_settings = MenuItem::with_id(
        app,
        SETTINGS_MENU_ID,
        "服务器地址…",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let settings = Submenu::with_items(app, "设置", true, &[&server_settings])?;

    let privacy = MenuItem::with_id(app, "privacy", "隐私说明", true, None::<&str>)?;
    let homepage = MenuItem::with_id(app, "homepage", "项目主页", true, None::<&str>)?;
    let help = Submenu::with_items(app, "帮助", true, &[&privacy, &homepage])?;

    let menu = Menu::new(app)?;
    // macOS convention: the first submenu is the app menu.
    #[cfg(target_os = "macos")]
    {
        let about = PredefinedMenuItem::about(app, Some("关于 CrossFile"), None)?;
        let hide = PredefinedMenuItem::hide(app, Some("隐藏 CrossFile"))?;
        let app_menu = Submenu::with_items(
            app,
            "CrossFile",
            true,
            &[&about, &PredefinedMenuItem::separator(app)?, &hide],
        )?;
        menu.append(&app_menu)?;
    }
    menu.append(&room)?;
    menu.append(&edit)?;
    menu.append(&settings)?;
    menu.append(&help)?;
    Ok(menu)
}

fn on_menu_event(app: &tauri::AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    match id {
        // Forward room actions to the web app; it owns the state machine.
        "new-room" | "end-room" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("menu-action", id.to_string());
            }
        }
        SETTINGS_MENU_ID => {
            if let Err(error) = open_settings(app) {
                eprintln!("[crossfile] 无法打开服务器设置：{error}");
            }
        }
        "privacy" => open_external(app, &help_url("CROSSFILE_PRIVACY_URL", DEFAULT_PRIVACY_URL)),
        "homepage" => open_external(
            app,
            &help_url("CROSSFILE_HOMEPAGE_URL", DEFAULT_HOMEPAGE_URL),
        ),
        "quit" => request_quit(app),
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Page loads: remember the app page URL and keep the debug diagnostics
// ---------------------------------------------------------------------------

fn on_page_load(webview: &Webview, payload: &PageLoadPayload<'_>) {
    let started = payload.event() == PageLoadEvent::Started;
    let url = payload.url().clone();
    println!("[shell] page load start={} url={}", started, url);

    if started {
        // Remember where to return after the settings page.
        remember_app_url(webview.app_handle(), &url);
    }
    if is_settings_url(&url) {
        // Shell-owned page: no web-app diagnostics and no shell globals needed.
        return;
    }
    if started {
        // Install the shell globals (signaling URL, native flag) before the page
        // scripts run; the web app reads them at connect time.
        let _ = webview.eval(shell_init_script(webview.app_handle()));
        // Install an error recorder before the page scripts run.
        let _ = webview.eval(
            "window.__cfErrors=[];window.addEventListener('error',function(e){window.__cfErrors.push(String(e.message))});window.addEventListener('unhandledrejection',function(e){window.__cfErrors.push('rej:'+String(e.reason))});",
        );
    } else {
        // After load: prove JS/network work, expose mount state, and test WSS separately.
        let _ = webview.eval(
            "setTimeout(function(){var st=null;try{st=window.__crossfile&&window.__crossfile.snapshot?window.__crossfile.snapshot():null}catch(e){}var s={title:document.title,href:location.href,root:(document.getElementById('root')||{}).innerHTML?document.getElementById('root').innerHTML.length:0,hook:typeof window.__crossfile,phase:st&&st.phase,error:st&&st.error,hasKey:st&&st.hasKey,errors:(window.__cfErrors||[]).slice(-4)};fetch('https://room.net.time-pack.com/__report?tag=shell-probe&data='+encodeURIComponent(JSON.stringify(s))).catch(function(){})},3000);",
        );
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Debug acceptance runs (docs/desktop.md §6) navigate the webview themselves, so
/// the first-run settings page must not intercept them.
#[cfg(debug_assertions)]
fn dev_harness_skips_settings() -> bool {
    std::env::var("CROSSFILE_DEV_JOIN").is_ok_and(|value| !value.trim().is_empty())
}

#[cfg(not(debug_assertions))]
fn dev_harness_skips_settings() -> bool {
    false
}

/// Debug-only acceptance harness: with CROSSFILE_DEV_JOIN set, the shell navigates
/// the webview to that room link after load so an automated run can drive the real
/// GUI + native save sink without input injection. Compiled out of release builds.
#[cfg(debug_assertions)]
fn navigation_harness(app: tauri::AppHandle) {
    let Ok(link) = std::env::var("CROSSFILE_DEV_JOIN") else {
        return;
    };
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2500));
        if let Some(window) = app.get_webview_window("main") {
            let script = format!("window.location.href = {link:?};");
            let _ = window.eval(&script);
        }
    });
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .manage(ShellUiState::default())
        .register_uri_scheme_protocol(SETTINGS_SCHEME, settings_protocol_response)
        .menu(build_menu)
        .on_menu_event(on_menu_event)
        .on_page_load(on_page_load)
        .on_window_event(on_window_event)
        .invoke_handler(tauri::generate_handler![
            get_shell_config,
            set_transfer_active,
            confirm_close,
            save_open,
            save_write,
            save_close,
            save_abort,
            get_server_settings,
            normalize_server_origin,
            open_server_settings,
            save_server_settings,
            reset_server_settings,
            close_server_settings,
        ]);
    let builder = builder.setup(|app| {
        // Main window starts hidden (tauri.conf.json "visible": false) so the
        // settings page is the first thing a new user sees.
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(url) = window.url() {
                remember_app_url(&app.handle(), &url);
            }
        }
        let first_run = !dev_harness_skips_settings() && server_config::is_first_run(&app.handle());
        app.state::<ShellUiState>()
            .first_run
            .store(first_run, Ordering::SeqCst);
        #[cfg(debug_assertions)]
        navigation_harness(app.handle().clone());
        if first_run {
            if let Err(error) = navigate_to_settings(&app.handle()) {
                eprintln!("[crossfile] 无法打开服务器设置：{error}");
            }
        }
        if let Some(window) = app.get_webview_window("main") {
            if let Err(error) = window.show() {
                eprintln!("[crossfile] 无法显示主窗口：{error}");
            }
        }
        Ok(())
    });
    builder
        .run(tauri::generate_context!())
        .expect("CrossFile desktop shell failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_cannot_escape_the_download_dir() {
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("/tmp/a:b*.txt"), "a_b_.txt");
        assert_eq!(safe_file_name("..\\..\\windows\\evil.exe"), "evil.exe");
        assert_eq!(safe_file_name("C:\\Users\\me\\报告.pdf"), "报告.pdf");
        assert_eq!(safe_file_name(""), "crossfile-download.bin");
        assert_eq!(safe_file_name(".."), "crossfile-download.bin");
        assert_eq!(safe_file_name("报告 2026.pdf"), "报告 2026.pdf");
    }

    #[test]
    fn duplicate_names_do_not_overwrite() {
        let dir =
            std::env::temp_dir().join(format!("crossfile-desktop-test-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("temp dir");
        let first = unique_path(&dir, "a.bin");
        assert_eq!(first, dir.join("a.bin"));
        File::create(&first).expect("first file");
        assert_eq!(unique_path(&dir, "a.bin"), dir.join("a (1).bin"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_page_url_matches_the_platform_origin() {
        let url = settings_page_url();
        #[cfg(any(windows, target_os = "android"))]
        {
            assert_eq!(url.scheme(), "http");
            assert_eq!(url.host_str(), Some("crossfile-settings.localhost"));
        }
        #[cfg(not(any(windows, target_os = "android")))]
        {
            assert_eq!(url.scheme(), SETTINGS_SCHEME);
        }
        assert_eq!(url.path(), "/index.html");
        assert!(is_settings_url(&url));
    }

    #[test]
    fn settings_assets_are_embedded() {
        let (mime, body) = settings_asset("/index.html").expect("index");
        assert!(mime.starts_with("text/html"));
        assert!(body.contains("服务器设置"));
        assert_eq!(
            settings_asset("/settings.css").expect("css").0,
            "text/css; charset=utf-8"
        );
        assert_eq!(
            settings_asset("/settings.js").expect("js").0,
            "text/javascript; charset=utf-8"
        );
        assert!(settings_asset("/etc/passwd").is_none());
        assert!(settings_asset("/../../main.rs").is_none());
    }

    #[test]
    fn shell_init_script_contains_the_shell_globals_and_a_signaling_url() {
        let script = shell_init_script_for("wss://files.example.com/v1/ws");
        assert!(script.contains("__CROSSFILE_NATIVE__ = true"));
        assert!(script.contains("__CROSSFILE_SIGNALING_URL__"));
        assert!(script.contains("wss://files.example.com/v1/ws"));
    }

    #[test]
    fn app_urls_are_not_mistaken_for_settings_urls() {
        assert!(!is_settings_url(
            &Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(!is_settings_url(
            &Url::parse("http://tauri.localhost/index.html").unwrap()
        ));
        assert!(is_settings_url(
            &Url::parse("crossfile-settings://localhost/index.html").unwrap()
        ));
    }
}

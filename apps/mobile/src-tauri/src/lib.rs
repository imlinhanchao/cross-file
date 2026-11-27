// CrossFile mobile shell (Tauri 2, Android / iOS).
//
// Reuses the exact JS-facing command signatures of the desktop shell
// (`docs/desktop.md` §4) so `apps/web` needs no mobile-specific branch:
//
//   save_open(name) -> u64            save_write(handle, offset, bytes)
//   save_close(handle) -> path        save_abort(handle)
//   set_transfer_active(bool)         confirm_close()
//
// Mobile differences:
//   * save root is the app sandbox (`app_data_dir()/downloads`) because Android
//     scoped storage (API 29+) forbids plain writes to /sdcard/Download.
//     MediaStore export is a documented TODO (docs/mobile.md §4).
//   * signaling URL cannot be derived from `location` inside the WebView, so the
//     shell injects `window.__CROSSFILE_SIGNALING_URL__` before the web app
//     connects (see `docs/mobile.md` §7).
//   * transfer start/end also tries to keep the screen awake via the Screen Wake
//     Lock API (best effort, no change needed on the web side).
//   * server-address settings page (self-hosted instances): Android has no native
//     menu, so the shell injects a small "服务器设置" entry button into the bundled
//     web page and serves the page itself through a local custom protocol
//     (server_config.rs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server_config;

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, State, Webview};
use url::Url;

use server_config::{normalize_server_input, ServerSettingsSnapshot, OFFICIAL_ORIGIN};

/// Self-hosted / official instance endpoint, derived from the user's setting
/// (or CROSSFILE_SIGNALING_URL for self-hosted builds).
const DEFAULT_SIGNALING_URL: &str = server_config::OFFICIAL_SIGNALING_URL;

/// Name of the sub-directory the receiver writes into inside the app sandbox.
const SAVE_SUBDIR: &str = "downloads";
/// URI scheme serving the shell-owned settings page (local origin -> IPC allowed).
const SETTINGS_SCHEME: &str = "crossfile-settings";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct SaveHandle {
    file: File,
    path: PathBuf,
}

#[derive(Default)]
struct AppState {
    /// Set by the web app while bytes are in flight (mirrors the desktop shell).
    transfer_active: AtomicBool,
    /// Best-effort screen wake lock requested through the WebView.
    screen_awake: AtomicBool,
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

/// Config snapshot returned to the web app through `get_shell_config`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellConfig {
    shell: &'static str,
    platform: &'static str,
    signaling_url: String,
    save_root: String,
    save_strategy: &'static str,
    version: &'static str,
    /// Debug builds only: automated acceptance runs may auto-accept without taps.
    debug_auto_accept: bool,
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else {
        "desktop"
    }
}

fn save_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| io_err("无法定位应用数据目录", error))?;
    Ok(base.join(SAVE_SUBDIR))
}

// ---------------------------------------------------------------------------
// Native save sink (same contract as the desktop shell)
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

/// Open a save target in the app sandbox download directory and return its handle.
#[tauri::command]
async fn save_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<u64, String> {
    let dir = save_root(&app)?;
    fs::create_dir_all(&dir).map_err(|error| io_err("无法创建应用下载目录", error))?;

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
        .map_err(|error| format!("无效的写入数据：{error}"))?;
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
// Transfer lifecycle: close guard (reused by the web layer) + keep-screen-on
// ---------------------------------------------------------------------------

/// Web app tells the shell whether bytes are in flight. Also toggles the screen
/// wake lock so a long transfer does not let the phone display sleep.
#[tauri::command]
fn set_transfer_active(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    active: bool,
) -> Result<(), String> {
    state.transfer_active.store(active, Ordering::SeqCst);
    state.screen_awake.store(active, Ordering::SeqCst);
    apply_wake_lock(&app, active);
    Ok(())
}

/// Explicit keep-awake command for the web layer (not required by the web app:
/// `set_transfer_active` already drives it). Returns whether a wake lock is held.
#[tauri::command]
fn set_keep_awake(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    active: bool,
) -> Result<bool, String> {
    state.screen_awake.store(active, Ordering::SeqCst);
    apply_wake_lock(&app, active);
    Ok(active)
}

/// Called after the web app's own confirmation; finishes the Android activity.
#[tauri::command]
fn confirm_close(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.transfer_active.store(false, Ordering::SeqCst);
    state.screen_awake.store(false, Ordering::SeqCst);
    apply_wake_lock(&app, false);
    app.exit(0);
    Ok(())
}

/// Config snapshot so the web layer can show the real save directory / endpoint.
#[tauri::command]
fn get_shell_config(app: tauri::AppHandle) -> Result<ShellConfig, String> {
    Ok(ShellConfig {
        shell: "mobile",
        platform: platform_name(),
        signaling_url: server_config::effective_choice(&app).signaling_url,
        save_root: save_root(&app)?.to_string_lossy().into_owned(),
        save_strategy: "native",
        version: env!("CARGO_PKG_VERSION"),
        debug_auto_accept: cfg!(debug_assertions)
            && std::env::var("CROSSFILE_DEV_AUTOACCEPT").is_ok_and(|value| value == "1"),
    })
}

// ---------------------------------------------------------------------------
// Screen wake lock (best effort, Screen Wake Lock API inside the WebView)
// ---------------------------------------------------------------------------

/// JS helper installed once per page. `__ACTIVE__` is replaced with true/false.
///
/// Android WebView and iOS WKWebView both expose `navigator.wakeLock` on recent
/// OS versions. It keeps the display on while the app is foreground; it is not a
/// foreground service, so background survival still needs the Kotlin service
/// described in `docs/mobile.md` §5.
const WAKE_LOCK_SCRIPT: &str = r#"
(function (active) {
  var w = window;
  if (!w.__crossfileWakeLock) {
    w.__crossfileWakeLock = {
      installed: true,
      active: false,
      lock: null,
      acquire: function () {
        if (!navigator.wakeLock || w.__crossfileWakeLock.lock) return;
        navigator.wakeLock.request('screen').then(function (lock) {
          w.__crossfileWakeLock.lock = lock;
          lock.addEventListener('release', function () {
            if (w.__crossfileWakeLock.lock === lock) w.__crossfileWakeLock.lock = null;
          });
        }).catch(function () {});
      },
      release: function () {
        var lock = w.__crossfileWakeLock.lock;
        w.__crossfileWakeLock.lock = null;
        if (lock) lock.release().catch(function () {});
      }
    };
    if (document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && w.__crossfileWakeLock.active) {
          w.__crossfileWakeLock.acquire();
        }
      });
    }
  }
  w.__crossfileWakeLock.active = active;
  if (active) w.__crossfileWakeLock.acquire();
  else w.__crossfileWakeLock.release();
})("__ACTIVE__");
"#;

fn apply_wake_lock(app: &tauri::AppHandle, active: bool) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let script = WAKE_LOCK_SCRIPT.replace("__ACTIVE__", if active { "true" } else { "false" });
    let _ = window.eval(&script);
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
    if let Ok(current) = window.url() {
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
// Shell globals injected before the web app connects (signaling URL, nature)
// ---------------------------------------------------------------------------

fn shell_init_script(app: &AppHandle) -> String {
    shell_init_script_for(&server_config::effective_choice(app).signaling_url)
}

fn shell_init_script_for(signaling_url: &str) -> String {
    let url = serde_json::to_string(signaling_url)
        .unwrap_or_else(|_| format!("\"{DEFAULT_SIGNALING_URL}\""));
    format!(
        r#"(function () {{
  window.__CROSSFILE_SHELL__ = 'mobile';
  window.__CROSSFILE_NATIVE__ = true;
  if (!window.__CROSSFILE_SIGNALING_URL__) {{
    window.__CROSSFILE_SIGNALING_URL__ = {url};
  }}
}})();"#
    )
}

/// Settings entry for Android: there is no native menu, so the shell adds a
/// small, labelled button to the bundled web page (shadow DOM keeps the styles
/// scoped; no global CSS is injected). The web app is expected to grow its own
/// settings entry later — then this overlay goes away.
const SETTINGS_ENTRY_SCRIPT: &str = r#"
(function () {
  var host = 'crossfile-settings.localhost';
  if (location.protocol === 'crossfile-settings:' || location.host === host) return;
  if (document.getElementById('crossfile-settings-entry')) return;
  function mount() {
    if (document.getElementById('crossfile-settings-entry')) return;
    if (!document.body) {
      setTimeout(mount, 50);
      return;
    }
    var wrapper = document.createElement('div');
    wrapper.id = 'crossfile-settings-entry';
    wrapper.style.cssText = 'position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom, 0px));z-index:50;';
    var root = wrapper.attachShadow ? wrapper.attachShadow({ mode: 'open' }) : wrapper;
    var style = document.createElement('style');
    style.textContent = 'button{display:flex;align-items:center;justify-content:center;width:44px;height:44px;padding:0;margin:0;border:1px solid rgba(128,128,128,.45);border-radius:999px;background:rgba(24,28,36,.72);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.32);cursor:pointer;touch-action:manipulation;}button:focus-visible{outline:3px solid #6ea8ff;outline-offset:2px;}button:active{transform:scale(.96);}svg{display:block;}';
    var button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', '服务器设置');
    button.setAttribute('title', '服务器设置');
    button.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      var api = window.__TAURI__ && window.__TAURI__.core;
      if (!api || typeof api.invoke !== 'function') return;
      api.invoke('open_server_settings').catch(function (error) {
        window.alert(String(error && error.message ? error.message : error));
      });
    });
    root.appendChild(style);
    root.appendChild(button);
    document.body.appendChild(wrapper);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
"#;

/// Runs on every page load (including a WebView reload): re-assert the shell
/// globals because a reload recreates the JS global scope.
fn on_page_load(webview: &Webview, payload: &PageLoadPayload<'_>) {
    let url = payload.url().clone();
    let is_settings = is_settings_url(&url);
    if !is_settings {
        remember_app_url(webview.app_handle(), &url);
    }
    match payload.event() {
        // Inject as early as possible: after navigating to a remote page (auto-join
        // harness) the web app must still see the shell globals before it connects.
        PageLoadEvent::Started => {
            if !is_settings {
                let _ = webview.eval(&shell_init_script(webview.app_handle()));
            }
        }
        PageLoadEvent::Finished => {
            if is_settings {
                return;
            }
            let _ = webview.eval(&shell_init_script(webview.app_handle()));
            // Android has no menu: add the shell-owned settings entry.
            let _ = webview.eval(SETTINGS_ENTRY_SCRIPT);
            #[cfg(debug_assertions)]
            if let Some(script) = dev_join_script() {
                let _ = webview.eval(&script);
            }
        }
    }
}

/// Debug acceptance runs (docs/mobile.md debug hooks) navigate the webview
/// themselves, so the first-run settings page must not intercept them.
#[cfg(debug_assertions)]
fn dev_harness_skips_settings() -> bool {
    std::env::var("CROSSFILE_DEV_JOIN").is_ok_and(|value| !value.trim().is_empty())
}

#[cfg(not(debug_assertions))]
fn dev_harness_skips_settings() -> bool {
    false
}

/// Debug-only navigation harness: `CROSSFILE_DEV_JOIN=<room link>` makes the shell
/// open that room so acceptance runs need no touch input (release builds omit this).
#[cfg(debug_assertions)]
fn dev_join_script() -> Option<String> {
    let link = std::env::var("CROSSFILE_DEV_JOIN")
        .ok()
        .filter(|value| !value.trim().is_empty())?;
    let target = serde_json::to_string(&link).ok()?;
    // Navigate inside the app origin (not to the remote https page): a remote page is
    // denied the shell's own IPC by Tauri's ACL, while the local page can save. The
    // room key travels as a dev-only query parameter instead of the fragment.
    Some(format!(
        r#"(function () {{
  var target = {target};
  try {{
    var u = new URL(target);
    var key = u.hash ? u.hash.slice(1) : '';
    var room = u.pathname.split('/').filter(Boolean).pop() || '';
    var report = u.searchParams.get('report') || '';
    var next = '/?devroom=' + encodeURIComponent(room) + '&devkey=' + encodeURIComponent(key) +
      '&autoaccept=1&debug=1&relay=' + (/[?&]relay=1/.test(u.search) ? '1' : '0') +
      (report ? '&report=' + encodeURIComponent(report) : '');
    if (!/[?&]devkey=/.test(location.search)) {{
      setTimeout(function () {{ location.href = next; }}, 1200);
    }}
  }} catch (e) {{}}
}})();"#
    ))
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(ShellUiState::default())
        .register_uri_scheme_protocol(SETTINGS_SCHEME, settings_protocol_response)
        .on_page_load(on_page_load)
        .setup(|app| {
            // The main window starts hidden (tauri.conf.json "visible": false) so a
            // first-time user sees the server-address page before anything else.
            let handle = app.handle();
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(url) = window.url() {
                    remember_app_url(&handle, &url);
                }
                let first_run =
                    !dev_harness_skips_settings() && server_config::is_first_run(&handle);
                handle
                    .state::<ShellUiState>()
                    .first_run
                    .store(first_run, Ordering::SeqCst);
                if first_run {
                    if let Err(error) = navigate_to_settings(&handle) {
                        eprintln!("[crossfile] 无法打开服务器设置：{error}");
                    }
                }
                // Some platforms create the main webview before `setup`; eval once so
                // the very first page also sees the injected config.
                let _ = window.eval(&shell_init_script(&handle));
                if let Err(error) = window.show() {
                    eprintln!("[crossfile] 无法显示主窗口：{error}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_transfer_active,
            set_keep_awake,
            confirm_close,
            get_shell_config,
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
        ])
        .run(tauri::generate_context!())
        .expect("CrossFile mobile shell failed to start");
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
            std::env::temp_dir().join(format!("crossfile-mobile-test-{}", std::process::id()));
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
    }

    #[test]
    fn app_urls_are_not_mistaken_for_settings_urls() {
        assert!(!is_settings_url(
            &Url::parse("http://tauri.localhost/index.html").unwrap()
        ));
        assert!(is_settings_url(
            &Url::parse("crossfile-settings://localhost/index.html").unwrap()
        ));
    }

    #[test]
    fn init_script_embeds_the_shell_globals_and_signaling_url() {
        let script = shell_init_script_for("wss://files.example.com/v1/ws");
        assert!(script.contains("__CROSSFILE_SHELL__ = 'mobile'"));
        assert!(script.contains("__CROSSFILE_NATIVE__ = true"));
        assert!(script.contains("wss://files.example.com/v1/ws"));
    }

    #[test]
    fn settings_entry_script_is_scoped_and_labelled() {
        assert!(SETTINGS_ENTRY_SCRIPT.contains("attachShadow"));
        assert!(SETTINGS_ENTRY_SCRIPT.contains("aria-label"));
        assert!(SETTINGS_ENTRY_SCRIPT.contains("服务器设置"));
        assert!(SETTINGS_ENTRY_SCRIPT.contains("open_server_settings"));
        assert!(SETTINGS_ENTRY_SCRIPT.contains("44px"));
        assert!(SETTINGS_ENTRY_SCRIPT.contains("env(safe-area-inset-bottom"));
        // Never inject on the shell's own settings page.
        assert!(SETTINGS_ENTRY_SCRIPT.contains("crossfile-settings"));
    }
}

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
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{Manager, State, Webview};

/// Self-hosted / official instance used until the settings page lands (M4).
/// Overridable at build/run time through `CROSSFILE_SIGNALING_URL`.
const DEFAULT_SIGNALING_URL: &str = "wss://room.net.time-pack.com/v1/ws";

/// Name of the sub-directory the receiver writes into inside the app sandbox.
const SAVE_SUBDIR: &str = "downloads";

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

fn signaling_url() -> String {
    std::env::var("CROSSFILE_SIGNALING_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SIGNALING_URL.to_string())
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
    bytes: Vec<u8>,
) -> Result<(), String> {
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
        signaling_url: signaling_url(),
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
// Shell globals injected before the web app connects (signaling URL, nature)
// ---------------------------------------------------------------------------

fn shell_init_script() -> String {
    let url = serde_json::to_string(&signaling_url()).unwrap_or_else(|_| "\"\"".to_string());
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

/// Runs on every page load (including a WebView reload): re-assert the shell
/// globals because a reload recreates the JS global scope.
fn on_page_load(_webview: &Webview, payload: &PageLoadPayload<'_>) {
    if let PageLoadEvent::Finished = payload.event() {
        let _ = _webview.eval(&shell_init_script());
        #[cfg(debug_assertions)]
        if let Some(script) = dev_join_script() {
            let _ = _webview.eval(&script);
        }
    }
}

/// Debug-only navigation harness: `CROSSFILE_DEV_JOIN=<room link>` makes the shell
/// open that room so acceptance runs need no touch input (release builds omit this).
#[cfg(debug_assertions)]
fn dev_join_script() -> Option<String> {
    let link = std::env::var("CROSSFILE_DEV_JOIN")
        .ok()
        .filter(|value| !value.trim().is_empty())?;
    let target = serde_json::to_string(&link).ok()?;
    Some(format!(
        r#"(function () {{
  var target = {target};
  if (location.href !== target) {{
    setTimeout(function () {{ location.href = target; }}, 1200);
  }}
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
        .on_page_load(on_page_load)
        .setup(|app| {
            // Some platforms create the main webview before `setup`; eval once so
            // the very first page also sees the injected config.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(&shell_init_script());
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
    fn init_script_embeds_the_signaling_url() {
        let script = shell_init_script();
        assert!(script.contains("__CROSSFILE_NATIVE__ = true"));
        assert!(script.contains("wss://"));
    }
}

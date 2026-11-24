// CrossFile desktop shell (Tauri 2).
//
// Responsibilities kept on the native side:
//   1. native save sink for large files (AC9): open / random-offset write / close / abort
//   2. "transfering, do not close" guard on the window close button
//   3. native menu (房间 / 编辑 / 帮助) with external help links
//
// The web app talks to these through Tauri IPC (`window.__TAURI__.core.invoke`
// because `app.withGlobalTauri` is on, or `@tauri-apps/api/core` if it is added).
// See docs/desktop.md for the JS-side contract.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, State, Window, WindowEvent};
use tauri_plugin_opener::OpenerExt;

/// Official instance doubles as the project home until a marketing site exists.
const DEFAULT_HOMEPAGE_URL: &str = "https://room.net.time-pack.com/";
/// The privacy statement is a route in the web app (`apps/web/src/pages/PrivacyPage.tsx`).
const DEFAULT_PRIVACY_URL: &str = "https://room.net.time-pack.com/privacy";

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

fn lock_saves(state: &AppState) -> Result<std::sync::MutexGuard<'_, HashMap<u64, SaveHandle>>, String> {
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
        Err(error) => Err(io_err(&format!("无法删除未完成文件 {}", path.display()), error)),
    }
}

// ---------------------------------------------------------------------------
// Close protection
// ---------------------------------------------------------------------------

/// Web app tells the shell whether bytes are in flight.
#[tauri::command]
fn set_transfer_active(state: State<'_, AppState>, active: bool) -> Result<(), String> {
    state.transfer_active.store(active, Ordering::SeqCst);
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
    let active = app.state::<AppState>().transfer_active.load(Ordering::SeqCst);
    if active {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit("close-requested", ());
        }
    } else {
        app.exit(0);
    }
}

// ---------------------------------------------------------------------------
// Native menu: 房间 / 编辑 / 帮助
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
        &[&new_room, &end_room, &PredefinedMenuItem::separator(app)?, &quit],
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
        "privacy" => open_external(
            app,
            &help_url("CROSSFILE_PRIVACY_URL", DEFAULT_PRIVACY_URL),
        ),
        "homepage" => open_external(
            app,
            &help_url("CROSSFILE_HOMEPAGE_URL", DEFAULT_HOMEPAGE_URL),
        ),
        "quit" => request_quit(app),
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .menu(build_menu)
        .on_menu_event(on_menu_event)
        .on_window_event(on_window_event)
        .invoke_handler(tauri::generate_handler![
            set_transfer_active,
            confirm_close,
            save_open,
            save_write,
            save_close,
            save_abort,
        ])
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
        let dir = std::env::temp_dir().join(format!(
            "crossfile-desktop-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        let first = unique_path(&dir, "a.bin");
        assert_eq!(first, dir.join("a.bin"));
        File::create(&first).expect("first file");
        assert_eq!(unique_path(&dir, "a.bin"), dir.join("a (1).bin"));
        let _ = fs::remove_dir_all(&dir);
    }
}

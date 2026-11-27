// Server-address normalisation, persistence and resolution for the desktop shell.
//
// The Go single binary serves the web app and `/v1/ws` on the same origin, so the
// user only picks an origin (`https://file.time-pack.com` or a self-hosted one);
// the signaling endpoint is derived from it. The choice is stored in the app
// config directory — never secrets — and survives restarts. A saved choice that
// cannot be read or parsed counts as "nothing saved" so a corrupt file can never
// lock the user out.
//
// Precedence: CROSSFILE_SIGNALING_URL env override (self-hosted builds) > saved
// choice > default (official instance in release builds, the local dev server in
// debug builds so `tauri dev` keeps working, docs/desktop.md §2).
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use url::Url;

/// Official instance doubles as the project home until a marketing site exists.
pub const OFFICIAL_ORIGIN: &str = "https://file.time-pack.com";
pub const OFFICIAL_SIGNALING_URL: &str = "wss://file.time-pack.com/v1/ws";
/// Debug builds keep talking to the machine-local signaling server (tauri dev).
pub const DEV_SIGNALING_URL: &str = "ws://127.0.0.1:8788/v1/ws";
/// File name inside the app config directory (same shape as the Electron shell).
pub const SETTINGS_FILE: &str = "server-settings.json";
const SETTINGS_VERSION: u32 = 1;

/// Where the effective signaling address came from (shown in the settings page).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerChoice {
    pub origin: String,
    pub signaling_url: String,
    pub source: &'static str,
}

impl ServerChoice {
    pub fn is_official(&self) -> bool {
        self.origin == OFFICIAL_ORIGIN
    }

    /// Build a choice from a full signaling URL, keeping the URL verbatim (an
    /// env/self-host override may use a non-standard path).
    pub fn from_signaling(signaling_url: &str, source: &'static str) -> Result<Self, String> {
        let (origin, _) = normalize_server_input(signaling_url)?;
        Ok(Self {
            origin,
            signaling_url: signaling_url.to_string(),
            source,
        })
    }

    /// Default used when nothing is saved and no override is set.
    pub fn default_choice() -> Self {
        Self::from_signaling(default_signaling_url(), "default")
            .expect("built-in signaling URL must be valid")
    }
}

/// Release builds talk to the official instance; debug builds to the local dev
/// server so `tauri dev` behaves like the browser dev flow.
fn default_signaling_url() -> &'static str {
    if cfg!(debug_assertions) {
        DEV_SIGNALING_URL
    } else {
        OFFICIAL_SIGNALING_URL
    }
}

/// Turn user input into `(origin, signaling_url)`.
///
/// Accepts an `http(s)://` origin (trailing slash/path/query are dropped; a path
/// is ignored because the server serves the app at `/`) or a bare
/// `ws(s)://…/v1/ws` URL, which is converted back to its origin.
pub fn normalize_server_input(raw: &str) -> Result<(String, String), String> {
    let input = raw.trim();
    if input.is_empty() {
        return Err("请输入服务器地址".to_string());
    }
    if input.chars().any(char::is_whitespace) {
        return Err("服务器地址不能包含空格或换行".to_string());
    }
    let parsed = Url::parse(input).map_err(|_| {
        "地址格式不正确：请填写 https://服务器地址（例如 https://file.time-pack.com）".to_string()
    })?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("服务器地址不能包含用户名或密码".to_string());
    }
    let scheme = match parsed.scheme() {
        "http" | "ws" => "http",
        "https" | "wss" => "https",
        _ => return Err(
            "只支持 http:// 或 https:// 地址（本地开发可用 http://），也可以直接填写 wss://…/v1/ws"
                .to_string(),
        ),
    };
    let host = parsed
        .host()
        .ok_or_else(|| "地址缺少服务器主机名".to_string())?;
    // `Host` Display keeps IPv6 brackets; `port()` omits default ports.
    let authority = match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let origin = format!("{scheme}://{authority}");
    let signaling_url = format!(
        "{}://{authority}/v1/ws",
        if scheme == "https" { "wss" } else { "ws" }
    );
    Ok((origin, signaling_url))
}

/// Stored JSON shape. Mirrors the Electron shell (camelCase keys, no secrets).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings<'a> {
    version: u32,
    origin: &'a str,
    signaling_url: &'a str,
    saved_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettingsOwned {
    #[serde(default)]
    version: Option<u32>,
    origin: String,
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

/// Read the saved choice; `None` for a missing/unreadable/invalid file.
pub fn load_saved_choice(path: &Path) -> Option<ServerChoice> {
    let raw = fs::read_to_string(path).ok()?;
    let stored: StoredSettingsOwned = serde_json::from_str(&raw).ok()?;
    if let Some(version) = stored.version {
        if version < 1 {
            return None;
        }
    }
    let (origin, signaling_url) = normalize_server_input(&stored.origin).ok()?;
    Some(ServerChoice {
        origin,
        signaling_url,
        source: "saved",
    })
}

/// Persist a normalised choice atomically (tmp file + rename), so a crash
/// mid-write cannot leave a truncated config behind.
pub fn save_choice(path: &Path, raw: &str) -> Result<ServerChoice, String> {
    let (origin, signaling_url) = normalize_server_input(raw)?;
    let payload = StoredSettings {
        version: SETTINGS_VERSION,
        origin: &origin,
        signaling_url: &signaling_url,
        saved_at: unix_seconds(),
    };
    let body = serde_json::to_string_pretty(&payload)
        .map_err(|error| format!("无法序列化服务器设置：{error}"))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)
            .map_err(|error| format!("无法创建应用配置目录 {}：{error}", dir.display()))?;
    }
    let tmp = PathBuf::from(format!("{}.tmp", path.display()));
    fs::write(&tmp, format!("{body}\n")).map_err(|error| format!("无法写入服务器设置：{error}"))?;
    fs::rename(&tmp, path).map_err(|error| {
        let _ = fs::remove_file(&tmp);
        format!("无法保存服务器设置：{error}")
    })?;
    Ok(ServerChoice {
        origin,
        signaling_url,
        source: "saved",
    })
}

/// Remove the saved choice; a missing file counts as success.
pub fn clear_saved_choice(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法删除服务器设置：{error}")),
    }
}

/// App config file `…/server-settings.json` (per-platform config dir).
pub fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(SETTINGS_FILE))
        .map_err(|error| format!("无法定位应用配置目录：{error}"))
}

/// Explicit self-host/dev override, if any.
pub fn env_override() -> Option<String> {
    std::env::var("CROSSFILE_SIGNALING_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Effective choice: env override > saved choice > default.
pub fn effective_choice(app: &AppHandle) -> ServerChoice {
    if let Some(override_url) = env_override() {
        if let Ok(choice) = ServerChoice::from_signaling(&override_url, "env") {
            return choice;
        }
        eprintln!("[crossfile] 忽略无效的 CROSSFILE_SIGNALING_URL：{override_url}");
    }
    if let Ok(path) = settings_path(app) {
        if let Some(saved) = load_saved_choice(&path) {
            return saved;
        }
    }
    ServerChoice::default_choice()
}

/// True when the settings page should be shown at startup: no usable saved
/// choice and no explicit override. A corrupt config counts as "nothing saved".
pub fn is_first_run(app: &AppHandle) -> bool {
    if env_override().is_some() {
        return false;
    }
    match settings_path(app) {
        Ok(path) => load_saved_choice(&path).is_none(),
        Err(_) => false,
    }
}

/// IPC snapshot returned to the settings page (camelCase for the JS side).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSettingsSnapshot {
    pub origin: String,
    pub signaling_url: String,
    pub source: &'static str,
    pub is_official: bool,
    pub official_origin: &'static str,
    pub official_signaling_url: &'static str,
    pub env_override: bool,
    pub first_run: bool,
    pub transfer_active: bool,
}

impl ServerSettingsSnapshot {
    pub fn new(choice: &ServerChoice, first_run: bool, transfer_active: bool) -> Self {
        Self {
            origin: choice.origin.clone(),
            signaling_url: choice.signaling_url.clone(),
            source: choice.source,
            is_official: choice.is_official(),
            official_origin: OFFICIAL_ORIGIN,
            official_signaling_url: OFFICIAL_SIGNALING_URL,
            env_override: env_override().is_some(),
            first_run,
            transfer_active,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalize(input: &str) -> (String, String) {
        normalize_server_input(input).expect("should normalise")
    }

    #[test]
    fn normalizes_the_official_origin() {
        assert_eq!(
            normalize("https://file.time-pack.com"),
            (
                "https://file.time-pack.com".to_string(),
                "wss://file.time-pack.com/v1/ws".to_string()
            )
        );
    }

    #[test]
    fn strips_trailing_slash_paths_and_queries() {
        for input in [
            "https://file.time-pack.com/",
            "https://file.time-pack.com/some/path?x=1#frag",
            "  https://file.time-pack.com  ",
        ] {
            assert_eq!(normalize(input).0, "https://file.time-pack.com");
        }
    }

    #[test]
    fn keeps_explicit_ports_and_derives_ws() {
        assert_eq!(
            normalize("http://127.0.0.1:8788"),
            (
                "http://127.0.0.1:8788".to_string(),
                "ws://127.0.0.1:8788/v1/ws".to_string()
            )
        );
    }

    #[test]
    fn normalizes_default_ports_and_host_case() {
        assert_eq!(
            normalize("HTTPS://File.Time-Pack.com:443").0,
            OFFICIAL_ORIGIN
        );
        assert_eq!(
            normalize("http://Example.com:80"),
            (
                "http://example.com".to_string(),
                "ws://example.com/v1/ws".to_string()
            )
        );
    }

    #[test]
    fn accepts_pasted_ws_and_wss_urls() {
        assert_eq!(
            normalize("wss://file.time-pack.com/v1/ws"),
            (
                OFFICIAL_ORIGIN.to_string(),
                OFFICIAL_SIGNALING_URL.to_string()
            )
        );
        assert_eq!(
            normalize("ws://127.0.0.1:8788/v1/ws"),
            (
                "http://127.0.0.1:8788".to_string(),
                "ws://127.0.0.1:8788/v1/ws".to_string()
            )
        );
    }

    #[test]
    fn keeps_ipv6_brackets() {
        assert_eq!(
            normalize("http://[::1]:8788"),
            (
                "http://[::1]:8788".to_string(),
                "ws://[::1]:8788/v1/ws".to_string()
            )
        );
    }

    #[test]
    fn rejects_invalid_input_with_a_clear_message() {
        let cases: [(&str, &str); 8] = [
            ("", "请输入服务器地址"),
            ("   ", "请输入服务器地址"),
            ("file.time-pack.com", "地址格式不正确"),
            ("https://", "地址格式不正确"),
            ("ftp://example.com", "只支持 http"),
            ("javascript:alert(1)", "只支持 http"),
            ("https://user:pass@example.com", "不能包含用户名或密码"),
            ("https://exa mple.com", "不能包含空格"),
        ];
        for (input, expected) in cases {
            let error = normalize_server_input(input).expect_err(input);
            assert!(error.contains(expected), "{input} -> {error}");
        }
    }

    #[test]
    fn saved_choice_round_trips_and_corruption_is_ignored() {
        let dir =
            std::env::temp_dir().join(format!("crossfile-desktop-settings-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join(SETTINGS_FILE);

        assert!(load_saved_choice(&path).is_none());
        let saved = save_choice(&path, "https://files.example.com/").expect("save");
        assert_eq!(saved.origin, "https://files.example.com");
        assert_eq!(saved.signaling_url, "wss://files.example.com/v1/ws");

        let raw = fs::read_to_string(&path).expect("read");
        let json: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(json["origin"], "https://files.example.com");
        assert_eq!(json["signalingUrl"], "wss://files.example.com/v1/ws");
        assert!(json["savedAt"].is_number());
        assert!(json.get("secret").is_none());

        let loaded = load_saved_choice(&path).expect("load");
        assert_eq!(loaded.origin, "https://files.example.com");
        assert_eq!(loaded.source, "saved");

        fs::write(&path, "{ not json").expect("write corrupt");
        assert!(load_saved_choice(&path).is_none());

        clear_saved_choice(&path).expect("clear");
        assert!(load_saved_choice(&path).is_none());
        clear_saved_choice(&path).expect("clear twice");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_rejects_invalid_input_without_writing() {
        let dir = std::env::temp_dir().join(format!(
            "crossfile-desktop-settings-invalid-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join(SETTINGS_FILE);
        assert!(save_choice(&path, "not a url").is_err());
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_choice_matches_the_build_mode() {
        let choice = ServerChoice::default_choice();
        if cfg!(debug_assertions) {
            assert_eq!(choice.signaling_url, DEV_SIGNALING_URL);
            assert_eq!(choice.origin, "http://127.0.0.1:8788");
        } else {
            assert_eq!(choice.signaling_url, OFFICIAL_SIGNALING_URL);
            assert_eq!(choice.origin, OFFICIAL_ORIGIN);
        }
        assert_eq!(choice.source, "default");
    }
}

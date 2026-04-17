// Sidecar lifecycle management

use serde::Deserialize;
use std::net::TcpListener;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::process::CommandEvent;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::ShellExt;

const SIDECAR_NAME: &str = "openchamber-server";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_POLL_INITIAL_INTERVAL: Duration = Duration::from_millis(250);
const HEALTH_POLL_MAX_INTERVAL: Duration = Duration::from_millis(2000);
const LOCAL_SIDECAR_HEALTH_TIMEOUT: Duration = Duration::from_secs(8);
const LOCAL_SIDECAR_HEALTH_POLL_INITIAL_INTERVAL: Duration = Duration::from_millis(100);
const LOCAL_SIDECAR_HEALTH_POLL_MAX_INTERVAL: Duration = Duration::from_millis(1000);
const DEFAULT_DESKTOP_PORT: u16 = 57123;

#[derive(Default)]
pub struct SidecarState {
    pub(crate) child: Mutex<Option<CommandChild>>,
    pub(crate) url: Mutex<Option<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarNotifyPayload {
    pub(crate) title: Option<String>,
    pub(crate) body: Option<String>,
    pub(crate) tag: Option<String>,
    pub(crate) require_hidden: Option<bool>,
}

/// Pick an unused port on 127.0.0.1.
pub fn pick_unused_port() -> crate::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    Ok(port)
}

/// Build local URL from port.
pub fn build_local_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Kill the sidecar process.
pub fn kill_sidecar(app: tauri::AppHandle) {
    let Some(state) = app.try_state::<SidecarState>() else {
        return;
    };

    let sidecar_url = crate::recover_mutex(state.url.lock()).clone();
    if let Some(url) = sidecar_url {
        // Attempt graceful shutdown via a raw HTTP POST to avoid pulling in
        // reqwest::blocking (and its extra thread pool) just for this one call.
        if let Ok(parsed) = url::Url::parse(&url) {
            let host = parsed.host_str().unwrap_or("127.0.0.1");
            let port = parsed.port().unwrap_or(80);
            let path = "/api/system/shutdown";
            if let Ok(mut stream) =
                std::net::TcpStream::connect_timeout(
                    &format!("{host}:{port}").parse().unwrap(),
                    Duration::from_millis(1500),
                )
            {
                use std::io::Write;
                let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));
                let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
                let request = format!(
                    "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = stream.write_all(request.as_bytes());
                let _ = stream.flush();
                // Brief pause to let sidecar begin its shutdown sequence.
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }

    let mut guard = crate::recover_mutex(state.child.lock());
    if let Some(child) = guard.take() {
        let _ = child.kill();
    }
    *crate::recover_mutex(state.url.lock()) = None;
}

/// Kills any stale openchamber-server processes that may be lingering from
/// previous app sessions or incomplete shutdowns. This ensures a clean
/// startup and prevents port conflicts.
pub fn kill_stale_sidecar_processes() {
    let process_name = if cfg!(windows) {
        "openchamber-server.exe"
    } else {
        "openchamber-server"
    };

    let result = if cfg!(target_os = "macos") {
        // macOS: use pkill to terminate by process name
        std::process::Command::new("pkill")
            .arg("-x") // exact match
            .arg(process_name)
            .output()
    } else if cfg!(target_os = "linux") {
        // Linux: use pkill
        std::process::Command::new("pkill")
            .arg("-x")
            .arg(process_name)
            .output()
    } else if cfg!(windows) {
        // Windows: use taskkill
        std::process::Command::new("taskkill")
            .arg("/F")
            .arg("/IM")
            .arg(process_name)
            .output()
    } else {
        return;
    };

    // Log result for debugging (pkill returns 1 if no processes found, which is fine)
    if let Ok(output) = result {
        log::debug!(
            "[sidecar] cleanup result: exit_code={:?}, stdout={}, stderr={}",
            output.status.code(),
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    // Brief pause to let OS clean up processes
    std::thread::sleep(Duration::from_millis(100));
}

/// Spawn local server sidecar.
pub async fn spawn_local_server(app: &tauri::AppHandle) -> crate::Result<String> {
    // Clean up any stale sidecar processes from previous sessions
    kill_stale_sidecar_processes();

    let stored_port = crate::settings::read_desktop_local_port_from_disk();
    let mut candidates: Vec<Option<u16>> = Vec::new();
    if let Some(port) = stored_port {
        candidates.push(Some(port));
    }
    candidates.push(Some(DEFAULT_DESKTOP_PORT));
    candidates.push(None);

    let dist_dir = resolve_web_dist_dir(app)?;
    let no_proxy = "localhost,127.0.0.1";

    // macOS app launch env often lacks user PATH entries.
    let mut path_segments: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();

    let resolved_home_dir_path = app.path().home_dir().ok();
    let resolved_home_dir = resolved_home_dir_path.as_ref().and_then(|p| {
        let s = p.to_string_lossy().to_string();
        if s.trim().is_empty() {
            None
        } else {
            Some(s)
        }
    });

    let desktop_settings = crate::settings::read_desktop_settings_json();

    let opencode_binary_from_settings: Option<String> = (|| {
        let value = desktop_settings.as_ref()?.get("opencodeBinary")?.as_str()?.trim();
        if value.is_empty() {
            return None;
        }

        let mut candidate = value.to_string();
        if std::fs::metadata(&candidate)
            .map(|m| m.is_dir())
            .unwrap_or(false)
        {
            let bin_name = if cfg!(windows) {
                "opencode.exe"
            } else {
                "opencode"
            };
            candidate = std::path::PathBuf::from(candidate)
                .join(bin_name)
                .to_string_lossy()
                .to_string();
        }

        Some(candidate)
    })();

    let sidecar_bind_host = desktop_settings
        .as_ref()
        .and_then(|value| value.get("desktopLanAccessEnabled"))
        .and_then(|value| value.as_bool())
        .map(|enabled| if enabled { "0.0.0.0" } else { "127.0.0.1" })
        .unwrap_or("127.0.0.1");

    let mut push_unique = |value: String| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return;
        }
        if seen.insert(trimmed.to_string()) {
            path_segments.push(trimmed.to_string());
        }
    };

    // Respect explicit binary overrides by adding their parent dir first.
    if let Some(val) = opencode_binary_from_settings.as_deref() {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            let path = std::path::Path::new(trimmed);
            if let Some(parent) = path.parent() {
                push_unique(parent.to_string_lossy().to_string());
            }
        }
    }

    for var in [
        "OPENCHAMBER_OPENCODE_PATH",
        "OPENCHAMBER_OPENCODE_BIN",
        "OPENCODE_PATH",
        "OPENCODE_BINARY",
    ] {
        if let Ok(val) = std::env::var(var) {
            let trimmed = val.trim();
            if trimmed.is_empty() {
                continue;
            }
            let path = std::path::Path::new(trimmed);
            if let Some(parent) = path.parent() {
                push_unique(parent.to_string_lossy().to_string());
            }
        }
    }

    // Common locations.
    push_unique("/opt/homebrew/bin".to_string());
    push_unique("/usr/local/bin".to_string());
    push_unique("/usr/bin".to_string());
    push_unique("/bin".to_string());
    push_unique("/usr/sbin".to_string());
    push_unique("/sbin".to_string());

    if let Some(home) = resolved_home_dir.as_deref() {
        // OpenCode installer default.
        push_unique(format!("{home}/.opencode/bin"));
        push_unique(format!("{home}/.local/bin"));
        push_unique(format!("{home}/.bun/bin"));
        push_unique(format!("{home}/.cargo/bin"));
        push_unique(format!("{home}/bin"));
    }

    if let Ok(existing) = std::env::var("PATH") {
        for segment in existing.split(':') {
            push_unique(segment.to_string());
        }
    }

    let augmented_path = path_segments.join(":");

    for candidate in candidates {
        let port = match candidate {
            Some(p) => p,
            None => pick_unused_port()?,
        };
        let url = build_local_url(port);

        let mut cmd = app
            .shell()
            .sidecar(SIDECAR_NAME)
            .map_err(|err| anyhow::anyhow!("Failed to resolve sidecar '{SIDECAR_NAME}': {err}"))?
            .args(["--port", &port.to_string()])
            .env("OPENCHAMBER_HOST", sidecar_bind_host)
            .env("OPENCHAMBER_DIST_DIR", dist_dir.clone())
            .env("OPENCHAMBER_RUNTIME", "desktop")
            .env("OPENCHAMBER_DESKTOP_NOTIFY", "true")
            .env("PATH", augmented_path.clone())
            .env("NO_PROXY", no_proxy)
            .env("no_proxy", no_proxy);

        if let Some(home) = resolved_home_dir.as_deref() {
            cmd = cmd.env("HOME", home);
        }

        if let Some(bin) = opencode_binary_from_settings.as_deref() {
            let trimmed = bin.trim();
            if !trimmed.is_empty() {
                cmd = cmd.env("OPENCODE_BINARY", trimmed);
            }
        }

        if let Ok(password) = std::env::var("OPENCODE_SERVER_PASSWORD") {
            let trimmed = password.trim();
            if !trimmed.is_empty() {
                cmd = cmd.env("OPENCODE_SERVER_PASSWORD", trimmed);
            }
        }

        let (rx, child) = match cmd.spawn() {
            Ok(v) => v,
            Err(err) => {
                log::warn!("[sidecar] spawn failed on port {port}: {err}");
                continue;
            }
        };

        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut rx = rx;
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        let line = String::from_utf8_lossy(&bytes);
                        if let Some(rest) = line.strip_prefix(crate::SIDECAR_NOTIFY_PREFIX) {
                            if let Ok(parsed) =
                                serde_json::from_str::<SidecarNotifyPayload>(rest.trim())
                            {
                                maybe_show_sidecar_notification(&app_handle, parsed);
                            }
                        }
                    }
                    CommandEvent::Error(error) => {
                        log::warn!("[sidecar] error: {error}");
                    }
                    CommandEvent::Terminated(payload) => {
                        log::warn!(
                            "[sidecar] terminated code={:?} signal={:?}",
                            payload.code,
                            payload.signal
                        );
                        break;
                    }
                    _ => {}
                }
            }
        });

        if let Some(state) = app.try_state::<SidecarState>() {
            *crate::recover_mutex(state.child.lock()) = Some(child);
            *crate::recover_mutex(state.url.lock()) = Some(url.clone());
        }

        if !wait_for_health_with(
            &url,
            LOCAL_SIDECAR_HEALTH_TIMEOUT,
            LOCAL_SIDECAR_HEALTH_POLL_INITIAL_INTERVAL,
            LOCAL_SIDECAR_HEALTH_POLL_MAX_INTERVAL,
        )
        .await
        {
            kill_sidecar(app.clone());
            continue;
        }

        let _ = crate::settings::write_desktop_local_port_to_disk(port);
        return Ok(url);
    }

    Err(anyhow::anyhow!("Sidecar health check failed"))
}

/// Resolve web dist directory for sidecar.
pub fn resolve_web_dist_dir(app: &tauri::AppHandle) -> crate::Result<std::path::PathBuf> {
    let candidates = ["web-dist", "resources/web-dist"];
    for candidate in candidates {
        let path = app
            .path()
            .resolve(candidate, tauri::path::BaseDirectory::Resource)
            .map_err(|err| anyhow::anyhow!("Failed to resolve '{candidate}' resources: {err}"))?;
        let index = path.join("index.html");
        if std::fs::metadata(&index).is_ok() {
            return Ok(path);
        }
    }

    Err(anyhow::anyhow!(
        "Web assets missing in app resources (expected index.html under web-dist)"
    ))
}

/// Normalize server URL (alias for normalize_host_url).
pub fn normalize_server_url(input: &str) -> Option<String> {
    crate::settings::normalize_host_url(input)
}

/// Show sidecar notification if appropriate.
pub fn maybe_show_sidecar_notification(app: &tauri::AppHandle, payload: SidecarNotifyPayload) {
    use crate::commands::is_nonempty_string;

    let require_hidden = payload.require_hidden.unwrap_or(false);
    if require_hidden {
        let any_focused = app
            .try_state::<crate::WindowFocusState>()
            .map(|state| state.any_focused())
            .unwrap_or(false);
        if any_focused {
            return;
        }
    }

    let title = payload
        .title
        .filter(|t| is_nonempty_string(t))
        .unwrap_or_else(|| "OpenChamber".to_string());
    let body = payload.body.filter(|b| is_nonempty_string(b));
    let _tag = payload.tag;

    use tauri_plugin_notification::NotificationExt;

    let mut builder = app.notification().builder().title(title);
    if let Some(body) = body {
        builder = builder.body(body);
    }

    #[cfg(target_os = "macos")]
    {
        builder = builder.sound("Glass");
    }
    let _ = builder.show();
}

/// Wait for health endpoint with exponential backoff.
async fn wait_for_health_with(
    url: &str,
    timeout: Duration,
    initial_interval: Duration,
    max_interval: Duration,
) -> bool {
    let client = match reqwest::Client::builder().no_proxy().build() {
        Ok(c) => c,
        Err(_) => return false,
    };

    let deadline = std::time::Instant::now() + timeout;
    let health_url = format!("{}/health", url.trim_end_matches('/'));
    let mut interval = initial_interval;

    while std::time::Instant::now() < deadline {
        if let Ok(resp) = client.get(&health_url).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(interval).await;
        interval = (interval * 2).min(max_interval);
    }

    false
}

/// Wait for health endpoint with default timeouts.
async fn wait_for_health(url: &str) -> bool {
    wait_for_health_with(url, HEALTH_TIMEOUT, HEALTH_POLL_INITIAL_INTERVAL, HEALTH_POLL_MAX_INTERVAL).await
}

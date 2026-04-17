// Health probing and boot outcome resolution

use serde::{Deserialize, Serialize};
use std::time::Duration;
use crate::settings::{DesktopHostsConfig, LOCAL_HOST_ID};

const STARTUP_REMOTE_PROBE_SOFT_TIMEOUT: Duration = Duration::from_secs(2);
const STARTUP_REMOTE_PROBE_HARD_TIMEOUT: Duration = Duration::from_secs(10);
const LOCAL_SIDECAR_HEALTH_TIMEOUT: Duration = Duration::from_secs(8);
const LOCAL_SIDECAR_HEALTH_POLL_INITIAL_INTERVAL: Duration = Duration::from_millis(100);
const LOCAL_SIDECAR_HEALTH_POLL_MAX_INTERVAL: Duration = Duration::from_millis(1000);

/// Synthetic host ID used when the boot target is forced via
/// `OPENCHAMBER_SERVER_URL` (no config-based host entry).
pub const ENV_OVERRIDE_HOST_ID: &str = "__env";

/// Synthetic host ID used when a window is opened at an explicit URL
/// via `desktop_new_window_at_url` (no config-based host entry).
pub const DIRECT_URL_HOST_ID: &str = "__direct";

/// Authoritative desktop boot outcome injected into webview as
/// `window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBootOutcome {
    pub(crate) target: Option<String>, // "local" | "remote" | null
    pub(crate) status: String,          // "ok" | "not-configured" | "unreachable" | "wrong-service" | "missing"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) host_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
}

/// Probe status classification for boot resolution.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ProbeClass {
    Ok,
    Auth,
    Unreachable,
    WrongService,
    NoProbe,
}

impl ProbeClass {
    pub fn from_probe(probe: Option<&HostProbeResult>) -> Self {
        match probe {
            Some(p) if p.status == "ok" => ProbeClass::Ok,
            Some(p) if p.status == "auth" => ProbeClass::Auth,
            Some(p) if p.status == "wrong-service" => ProbeClass::WrongService,
            Some(_) => ProbeClass::Unreachable,
            None => ProbeClass::NoProbe,
        }
    }
}

/// Result of shared soft+hard probe policy.
pub struct ProbeWithRetryResult {
    /// Whether target is navigable (ok or auth).
    pub(crate) navigable: bool,
    /// The final probe result, if available.
    pub(crate) probe: Option<HostProbeResult>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProbeResult {
    pub(crate) status: String,
    pub(crate) latency_ms: u64,
}

/// Shared probe policy: soft probe first, hard retry on failure.
/// Used by both startup and open_new_window for consistency.
pub async fn probe_with_retry(url: &str) -> ProbeWithRetryResult {
    let soft_probe = probe_host_with_timeout(url, STARTUP_REMOTE_PROBE_SOFT_TIMEOUT).await;

    let (navigable, final_probe) = match &soft_probe {
        Ok(probe) if matches!(probe.status.as_str(), "ok" | "auth") => {
            (true, Some(probe.clone()))
        }
        Ok(_) => {
            log::warn!(
                "[desktop] host slow/unreachable ({}), retrying with extended timeout",
                url
            );
            match probe_host_with_timeout(url, STARTUP_REMOTE_PROBE_HARD_TIMEOUT).await {
                Ok(hard_probe) if matches!(hard_probe.status.as_str(), "ok" | "auth") => {
                    (true, Some(hard_probe))
                }
                Ok(hard_probe) => (false, Some(hard_probe)),
                Err(_) => (false, None),
            }
        }
        Err(_) => {
            log::warn!(
                "[desktop] host errored ({}), retrying with extended timeout",
                url
            );
            match probe_host_with_timeout(url, STARTUP_REMOTE_PROBE_HARD_TIMEOUT).await {
                Ok(hard_probe) if matches!(hard_probe.status.as_str(), "ok" | "auth") => {
                    (true, Some(hard_probe))
                }
                Ok(hard_probe) => (false, Some(hard_probe)),
                Err(_) => (false, None),
            }
        }
    };

    ProbeWithRetryResult {
        navigable,
        probe: final_probe,
    }
}

/// Determine boot outcome from desktop hosts config, optional probe
/// result, local server availability, and optional env-forced URL.
///
/// When `env_target_url` is `Some`, it overrides config-based default
/// host selection. The returned outcome always describes actual boot
/// target, including env-forced remotes.
///
/// This is the single source of truth for boot resolution logic. Both
/// initial startup and `open_new_window` should delegate to this function
/// for consistency.
pub fn resolve_boot_outcome(
    cfg: &DesktopHostsConfig,
    probe: Option<&HostProbeResult>,
    local_available: bool,
    env_target_url: Option<&str>,
) -> DesktopBootOutcome {
    let probe_class = ProbeClass::from_probe(probe);

    // Env-forced URL takes precedence over config. This is its own
    // authoritative branch — never falls through to config-based resolution.
    if let Some(env_url) = env_target_url {
        return match probe_class {
            ProbeClass::Ok | ProbeClass::Auth | ProbeClass::NoProbe => DesktopBootOutcome {
                target: Some("remote".to_string()),
                status: "ok".to_string(),
                host_id: Some(ENV_OVERRIDE_HOST_ID.to_string()),
                url: Some(env_url.to_string()),
            },
            ProbeClass::WrongService => DesktopBootOutcome {
                target: Some("remote".to_string()),
                status: "wrong-service".to_string(),
                host_id: Some(ENV_OVERRIDE_HOST_ID.to_string()),
                url: Some(env_url.to_string()),
            },
            ProbeClass::Unreachable => DesktopBootOutcome {
                target: Some("remote".to_string()),
                status: "unreachable".to_string(),
                host_id: Some(ENV_OVERRIDE_HOST_ID.to_string()),
                url: Some(env_url.to_string()),
            },
        };
    }

    // No default host configured
    let default_id = cfg.default_host_id.as_deref().unwrap_or("");
    if default_id.is_empty() {
        // Whether or not choice is completed, no default means not-configured
        return DesktopBootOutcome {
            target: None,
            status: "not-configured".to_string(),
            host_id: None,
            url: None,
        };
    }

    // Default is local
    if default_id == LOCAL_HOST_ID {
        if local_available {
            return DesktopBootOutcome {
                target: Some("local".to_string()),
                status: "ok".to_string(),
                host_id: None,
                url: None,
            };
        }
        return DesktopBootOutcome {
            target: Some("local".to_string()),
            status: "unreachable".to_string(),
            host_id: None,
            url: None,
        };
    }

    // Default is a remote host — find it
    let host = cfg
        .hosts
        .iter()
        .find(|h| h.id == default_id);

    let Some(host) = host else {
        return DesktopBootOutcome {
            target: Some("remote".to_string()),
            status: "missing".to_string(),
            host_id: Some(default_id.to_string()),
            url: None,
        };
    };

    let host_id = host.id.clone();
    let host_url = host.url.clone();

    match probe_class {
        ProbeClass::Ok | ProbeClass::Auth => DesktopBootOutcome {
            target: Some("remote".to_string()),
            status: "ok".to_string(),
            host_id: Some(host_id),
            url: Some(host_url),
        },
        ProbeClass::WrongService => DesktopBootOutcome {
            target: Some("remote".to_string()),
            status: "wrong-service".to_string(),
            host_id: Some(host_id),
            url: Some(host_url),
        },
        ProbeClass::Unreachable => DesktopBootOutcome {
            target: Some("remote".to_string()),
            status: "unreachable".to_string(),
            host_id: Some(host_id),
            url: Some(host_url),
        },
        ProbeClass::NoProbe => {
            // No probe result and choice already completed — treat as recovery
            // (the probe hasn't happened yet, but user has made a choice,
            // so this shouldn't normally occur in practice).
            DesktopBootOutcome {
                target: Some("remote".to_string()),
                status: "unreachable".to_string(),
                host_id: Some(host_id),
                url: Some(host_url),
            }
        }
    }
}

/// Compute boot outcome to display when local server fails to start.
///
/// This ensures the UI leaves splash screen and shows an appropriate
/// chooser/recovery state instead of hanging. It delegates to the existing
/// `resolve_boot_outcome` with `local_available = false` and no probe.
pub fn compute_local_startup_failure_boot_outcome(cfg: &DesktopHostsConfig) -> DesktopBootOutcome {
    resolve_boot_outcome(cfg, None, false, None)
}

/// Build init script for startup failure fallback case.
///
/// Uses an empty `local_origin` since the local server is not running;
/// UI can fall back to `window.location.origin` when needed.
pub fn build_startup_failure_init_script(boot_outcome: &DesktopBootOutcome) -> String {
    build_init_script("", Some(boot_outcome))
}

/// Probe host with timeout.
pub async fn probe_host_with_timeout(url: &str, timeout: Duration) -> std::result::Result<HostProbeResult, String> {
    let health = crate::settings::build_health_url(url).ok_or_else(|| "Invalid URL".to_string())?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .build()
        .map_err(|err| err.to_string())?;
    let started = std::time::Instant::now();

    match client.get(&health).send().await {
        Ok(resp) => {
            let status = resp.status();
            let latency_ms = started.elapsed().as_millis() as u64;
            if status.is_success() {
                Ok(HostProbeResult {
                    status: "ok".to_string(),
                    latency_ms,
                })
            } else if status.as_u16() == 401 || status.as_u16() == 403 {
                Ok(HostProbeResult {
                    status: "auth".to_string(),
                    latency_ms,
                })
            } else {
                Ok(HostProbeResult {
                    status: "unreachable".to_string(),
                    latency_ms,
                })
            }
        }
        Err(_) => Ok(HostProbeResult {
            status: "unreachable".to_string(),
            latency_ms: started.elapsed().as_millis() as u64,
        }),
    }
}

/// Wait for local OpenCode to be ready with health polling.
pub async fn wait_for_local_opencode_ready_with(
    url: &str,
    timeout: Duration,
    initial_interval: Duration,
    max_interval: Duration,
) -> Option<HostProbeResult> {
    let deadline = std::time::Instant::now() + timeout;
    let mut interval = initial_interval;
    let mut last_probe: Option<HostProbeResult> = None;

    while std::time::Instant::now() < deadline {
        match probe_host_with_timeout(url, max_interval).await {
            Ok(probe) if matches!(probe.status.as_str(), "ok" | "auth") => {
                return Some(probe);
            }
            Ok(probe) => {
                last_probe = Some(probe);
            }
            Err(_) => {}
        }

        tokio::time::sleep(interval).await;
        interval = (interval * 2).min(max_interval);
    }

    last_probe
}

#[cfg(target_os = "macos")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTasksQuitRiskResponse {
    pub(crate) has_enabled_scheduled_tasks: bool,
    pub(crate) has_running_scheduled_tasks: bool,
    #[serde(default)]
    pub(crate) enabled_scheduled_tasks_count: u32,
    #[serde(default)]
    pub(crate) running_scheduled_tasks_count: u32,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatusResponse {
    pub(crate) active: bool,
}

#[cfg(target_os = "macos")]
pub async fn refresh_quit_risk_flags(local_base_url: &str) {
    use std::sync::atomic::Ordering;

    let trimmed = local_base_url.trim_end_matches('/');
    if trimmed.is_empty() {
        return;
    }

    let client = match reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(client) => client,
        Err(_) => return,
    };

    let scheduled_url = format!("{trimmed}/api/openchamber/scheduled-tasks/status");
    let tunnel_url = format!("{trimmed}/api/openchamber/tunnel/status");

    let scheduled_future = client.get(scheduled_url).send();
    let tunnel_future = client.get(tunnel_url).send();
    let (scheduled_result, tunnel_result) = tokio::join!(scheduled_future, tunnel_future);

    if let Ok(response) = scheduled_result {
        if response.status().is_success() {
            if let Ok(payload) = response.json::<ScheduledTasksQuitRiskResponse>().await {
                let enabled_count = payload.enabled_scheduled_tasks_count;
                let running_count = payload.running_scheduled_tasks_count;
                crate::QUIT_RISK_ENABLED_SCHEDULED_TASKS_COUNT.store(enabled_count, Ordering::Relaxed);
                crate::QUIT_RISK_RUNNING_SCHEDULED_TASKS_COUNT.store(running_count, Ordering::Relaxed);
                crate::QUIT_RISK_HAS_ENABLED_SCHEDULED_TASKS
                    .store(payload.has_enabled_scheduled_tasks || enabled_count > 0, Ordering::Relaxed);
                crate::QUIT_RISK_HAS_RUNNING_SCHEDULED_TASKS
                    .store(payload.has_running_scheduled_tasks || running_count > 0, Ordering::Relaxed);
            }
        }
    }

    if let Ok(response) = tunnel_result {
        if response.status().is_success() {
            if let Ok(payload) = response.json::<TunnelStatusResponse>().await {
                crate::QUIT_RISK_HAS_ACTIVE_TUNNEL.store(payload.active, Ordering::Relaxed);
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub fn start_quit_risk_poller(local_base_url: String) {
    use std::sync::atomic::Ordering;

    if crate::QUIT_RISK_POLLER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    tauri::async_runtime::spawn(async move {
        loop {
            refresh_quit_risk_flags(&local_base_url).await;
            tokio::time::sleep(crate::QUIT_RISK_POLL_INTERVAL).await;
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn start_quit_risk_poller(_local_base_url: String) {}

/// Build initialization script injected into every webview window.
/// This is computed once and reused for all windows.
pub fn build_init_script(local_origin: &str, boot_outcome: Option<&DesktopBootOutcome>) -> String {
    let home =
        std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    let macos_major = crate::macos_major_version().unwrap_or(0);

    let home_json = serde_json::to_string(&home).unwrap_or_else(|_| "\"\"".into());
    let local_json = serde_json::to_string(local_origin).unwrap_or_else(|_| "\"\"".into());
    let boot_outcome_json = boot_outcome
        .and_then(|o| serde_json::to_string(o).ok())
        .unwrap_or_else(|| "undefined".to_string());

    let mut init_script = format!(
        "(function(){{try{{window.__OPENCHAMBER_HOME__={home_json};window.__OPENCHAMBER_MACOS_MAJOR__={macos_major};window.__OPENCHAMBER_LOCAL_ORIGIN__={local_json};window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__={boot_outcome_json};}}catch(_e){{}}}})();"
    );

    // Cleanup: older builds injected a native-ish Instance switcher button into pages.
    // Remove it if present so the UI-owned host switcher is the only one.
    init_script.push_str("\ntry{var old=document.getElementById('__oc-instance-switcher');if(old)old.remove();}catch(_e){}");

    if !cfg!(debug_assertions) {
        init_script.push_str("\ntry{document.addEventListener('contextmenu',function(e){var t=e&&e.target;if(!t||typeof t.closest!=='function'){e.preventDefault();return;}if(t.closest('.terminal-viewport-container,[data-oc-allow-native-contextmenu],a,input,textarea,[contenteditable=\"true\"]')){return;}e.preventDefault();},true);}catch(_e){}");
    }

    init_script
}

/// Parse theme override from settings.
pub fn parse_theme_override(theme_mode: Option<&str>, theme_variant: Option<&str>) -> Option<tauri::Theme> {
    match theme_mode.map(str::trim) {
        Some("system") => None,
        Some("dark") => Some(tauri::Theme::Dark),
        Some("light") => Some(tauri::Theme::Light),
        _ => match theme_variant.map(str::trim) {
            Some("dark") => Some(tauri::Theme::Dark),
            Some("light") => Some(tauri::Theme::Light),
            _ => None,
        },
    }
}

/// Read desktop theme override from settings.
pub fn read_desktop_settings_json() -> Option<serde_json::Value> {
    crate::settings::read_desktop_settings_json()
}

/// Read desktop theme override.
pub fn read_desktop_theme_override() -> Option<tauri::Theme> {
    let settings = read_desktop_settings_json();

    let use_system_theme = settings
        .as_ref()
        .and_then(|value| value.get("useSystemTheme"))
        .and_then(|value| value.as_bool());

    if matches!(use_system_theme, Some(true)) {
        return None;
    }

    let theme_mode = settings
        .as_ref()
        .and_then(|value| value.get("themeMode"))
        .and_then(|value| value.as_str());

    let theme_variant = settings
        .as_ref()
        .and_then(|value| value.get("themeVariant"))
        .and_then(|value| value.as_str());

    parse_theme_override(theme_mode, theme_variant)
}

/// Detect desktop LAN IPv4 address.
pub fn detect_desktop_lan_ipv4() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let address = socket.local_addr().ok()?;

    if address.ip().is_loopback() {
        return None;
    }

    match address.ip() {
        std::net::IpAddr::V4(ipv4) => Some(ipv4.to_string()),
        std::net::IpAddr::V6(_) => None,
    }
}

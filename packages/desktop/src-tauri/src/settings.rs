// Settings I/O shared between main.rs and remote_ssh.rs

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::env;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const LOCAL_HOST_ID: &str = "local";

/// Process-wide mutex serializing all read-modify-write operations on the
/// desktop `settings.json`.  This prevents concurrent writers (host config,
/// local port, window state, vibrancy, onboarding flag) from clobbering
/// each other's independent fields.
pub static SETTINGS_FILE_MUTEX: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopHost {
    pub id: String,
    pub label: String,
    pub url: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopHostsConfig {
    pub hosts: Vec<DesktopHost>,
    pub default_host_id: Option<String>,
    #[serde(default)]
    pub initial_host_choice_completed: bool,
}

/// Input type for `desktop_hosts_set`. Fields may be omitted to preserve
/// existing stored values, ensuring backward-compatible callers don't
/// accidentally reset onboarding state.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopHostsConfigInput {
    pub hosts: Vec<DesktopHost>,
    pub default_host_id: Option<String>,
    #[serde(default)]
    pub initial_host_choice_completed: Option<bool>,
}

/// Compare two URL strings for "same server" identity using normalized
/// origin + path. This avoids misclassification when one URL has a
/// trailing slash and the other does not (e.g. `OPENCHAMBER_SERVER_URL`
/// pointing at the local sidecar without a trailing `/`).
pub fn same_server_url(a: &str, b: &str) -> bool {
    let parsed_a = url::Url::parse(a);
    let parsed_b = url::Url::parse(b);
    match (parsed_a, parsed_b) {
        (Ok(a), Ok(b)) => {
            a.origin() == b.origin()
                && a.path().trim_end_matches('/') == b.path().trim_end_matches('/')
        }
        _ => a == b,
    }
}

/// Normalize host URL for storage and comparison.
pub fn normalize_host_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = url::Url::parse(trimmed).ok()?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host = parsed.host_str()?;
    let mut normalized = format!("{}://{}", scheme, host);
    if let Some(port) = parsed.port() {
        normalized.push(':');
        normalized.push_str(&port.to_string());
    }
    let path = parsed.path();
    if path.is_empty() {
        normalized.push('/');
    } else {
        normalized.push_str(path);
    }
    if let Some(query) = parsed.query() {
        normalized.push('?');
        normalized.push_str(query);
    }
    Some(normalized)
}

/// Sanitize host URL for storage (alias for normalize_host_url).
pub fn sanitize_host_url_for_storage(raw: &str) -> Option<String> {
    normalize_host_url(raw)
}

/// Build health URL from base URL.
pub fn build_health_url(base_url: &str) -> Option<String> {
    let normalized = normalize_host_url(base_url)?;
    let mut parsed = url::Url::parse(&normalized).ok()?;
    let current_path = parsed.path();
    let trimmed_path = current_path.trim_end_matches('/');
    let health_path = if trimmed_path.is_empty() {
        "/health".to_string()
    } else {
        format!("{trimmed_path}/health")
    };
    parsed.set_path(&health_path);
    Some(parsed.to_string())
}

/// Get settings.json file path.
pub fn settings_file_path() -> PathBuf {
    if let Ok(dir) = env::var("OPENCHAMBER_DATA_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir.trim()).join("settings.json");
        }
    }
    let home = env::var("HOME").unwrap_or_default();
    PathBuf::from(home)
        .join(".config")
        .join("openchamber")
        .join("settings.json")
}

/// Read desktop settings.json as a JSON value.
pub fn read_desktop_settings_json() -> Option<serde_json::Value> {
    std::fs::read_to_string(settings_file_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
}

/// Read desktop local port from disk.
pub fn read_desktop_local_port_from_disk() -> Option<u16> {
    read_desktop_settings_json()
        .as_ref()
        .and_then(|v| v.get("desktopLocalPort"))
        .and_then(|v| v.as_u64())
        .and_then(|v| {
            if v > 0 && v <= u16::MAX as u64 {
                Some(v as u16)
            } else {
                None
            }
        })
}

/// Write desktop local port to disk.
pub fn write_desktop_local_port_to_disk(port: u16) -> Result<()> {
    let _guard = super::recover_mutex(SETTINGS_FILE_MUTEX.lock());
    let path = settings_file_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut root: serde_json::Value = if let Ok(raw) = std::fs::read_to_string(&path) {
        serde_json::from_str(&raw).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    if !root.is_object() {
        root = serde_json::json!({});
    }

    root["desktopLocalPort"] = serde_json::Value::Number(serde_json::Number::from(port));
    std::fs::write(&path, serde_json::to_string_pretty(&root)?)?;
    Ok(())
}

/// Read desktop hosts config from disk.
pub fn read_desktop_hosts_config_from_disk() -> DesktopHostsConfig {
    read_desktop_hosts_config_from_path(&settings_file_path())
}

/// Read desktop hosts config from a specific path.
pub fn read_desktop_hosts_config_from_path(path: &Path) -> DesktopHostsConfig {
    let raw = std::fs::read_to_string(path).ok();
    let parsed = raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());

    let hosts_value = parsed
        .as_ref()
        .and_then(|v| v.get("desktopHosts"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let default_value = parsed
        .as_ref()
        .and_then(|v| v.get("desktopDefaultHostId"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let initial_host_choice_completed = parsed
        .as_ref()
        .and_then(|v| v.get("desktopInitialHostChoiceCompleted"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut hosts: Vec<DesktopHost> = Vec::new();
    if let serde_json::Value::Array(items) = hosts_value {
        for item in items {
            if let Ok(host) = serde_json::from_value::<DesktopHost>(item) {
                if host.id.trim().is_empty() || host.id == LOCAL_HOST_ID {
                    continue;
                }
                if let Some(url) = sanitize_host_url_for_storage(&host.url) {
                    hosts.push(DesktopHost {
                        id: host.id,
                        label: if host.label.trim().is_empty() {
                            url.clone()
                        } else {
                            host.label
                        },
                        url,
                    });
                }
            }
        }
    }

    DesktopHostsConfig {
        hosts,
        default_host_id: default_value,
        initial_host_choice_completed,
    }
}

/// Merge a partial input into an existing config, preserving fields that
/// the caller omitted (`None`). This is the single source of truth for
/// the merge semantics used by `desktop_hosts_set`.
pub(crate) fn merge_desktop_hosts_config(
    existing: &DesktopHostsConfig,
    input: &DesktopHostsConfigInput,
) -> DesktopHostsConfig {
    DesktopHostsConfig {
        hosts: input.hosts.clone(),
        default_host_id: input.default_host_id.clone(),
        initial_host_choice_completed: input
            .initial_host_choice_completed
            .unwrap_or(existing.initial_host_choice_completed),
    }
}

/// Atomic read-merge-write: reads existing config from `path`, merges
/// `input` into it, and writes the result — all while holding the process
/// lock. Tests and the `desktop_hosts_set` command share this path.
pub fn write_desktop_hosts_config_input_to_path(
    path: &Path,
    input: &DesktopHostsConfigInput,
) -> Result<()> {
    let _guard = super::recover_mutex(SETTINGS_FILE_MUTEX.lock());
    let existing = read_desktop_hosts_config_from_path(path);
    let merged = merge_desktop_hosts_config(&existing, input);
    write_desktop_hosts_config_to_path(path, &merged)
}

/// Write desktop hosts config to a specific path.
pub fn write_desktop_hosts_config_to_path(
    path: &Path,
    config: &DesktopHostsConfig,
) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut root: serde_json::Value = if let Ok(raw) = std::fs::read_to_string(&path) {
        serde_json::from_str(&raw).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    if !root.is_object() {
        root = serde_json::json!({});
    }

    let hosts: Vec<DesktopHost> = config
        .hosts
        .iter()
        .filter_map(|h| {
            let id = h.id.trim();
            if id.is_empty() || id == LOCAL_HOST_ID {
                return None;
            }
            let url = sanitize_host_url_for_storage(&h.url)?;
            Some(DesktopHost {
                id: id.to_string(),
                label: if h.label.trim().is_empty() {
                    url.clone()
                } else {
                    h.label.trim().to_string()
                },
                url,
            })
        })
        .collect();

    root["desktopHosts"] = serde_json::to_value(hosts).unwrap_or(serde_json::Value::Array(vec![]));
    root["desktopDefaultHostId"] = match &config.default_host_id {
        Some(id) if !id.trim().is_empty() => serde_json::Value::String(id.trim().to_string()),
        _ => serde_json::Value::Null,
    };
    root["desktopInitialHostChoiceCompleted"] =
        serde_json::Value::Bool(config.initial_host_choice_completed);

    std::fs::write(&path, serde_json::to_string_pretty(&root)?)?;
    Ok(())
}

// Installed app detection and icons

use base64::engine::general_purpose;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAppInfo {
    pub(crate) name: String,
    pub(crate) icon_data_url: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAppsCache {
    pub(crate) updated_at: u64,
    pub(crate) apps: Vec<InstalledAppInfo>,
}

const INSTALLED_APPS_CACHE_TTL_SECS: u64 = 60 * 60 * 24;
const INSTALLED_APPS_CACHE_FILE: &str = "discovered-apps.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAppsResponse {
    pub(crate) apps: Vec<InstalledAppInfo>,
    pub(crate) has_cache: bool,
    pub(crate) is_cache_stale: bool,
}

#[derive(Serialize)]
pub struct AppIconPayload {
    pub(crate) app: String,
    pub(crate) data_url: String,
}

/// Filter apps to those that are installed.
#[tauri::command]
pub fn desktop_filter_installed_apps(apps: Vec<String>) -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let mut installed: Vec<String> = Vec::new();

        for raw in apps {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }

            let bundle_name = if trimmed.ends_with(".app") {
                trimmed.to_string()
            } else {
                format!("{trimmed}.app")
            };

            if is_app_bundle_installed(&bundle_name) {
                installed.push(trimmed.to_string());
            }
        }

        return Ok(installed);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = apps;
        Err("desktop_filter_installed_apps is only supported on macOS".to_string())
    }
}

/// Get list of installed apps with caching.
#[tauri::command]
pub fn desktop_get_installed_apps(
    app: tauri::AppHandle,
    apps: Vec<String>,
    force: Option<bool>,
) -> Result<InstalledAppsResponse, String> {
    #[cfg(target_os = "macos")]
    {
        let cache_path = installed_apps_cache_path();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|err| err.to_string())?
            .as_secs();

        let cache = read_installed_apps_cache(&cache_path);
        let cached_apps = cache
            .as_ref()
            .map(|entry| entry.apps.clone())
            .unwrap_or_default();
        let has_cache = cache.is_some();
        let is_cache_stale = cache
            .as_ref()
            .map(|entry| now.saturating_sub(entry.updated_at) > INSTALLED_APPS_CACHE_TTL_SECS)
            .unwrap_or(false);

        if has_cache {
            if is_cache_stale {
                log::info!("[open-in] cache hit (stale): {} apps", cached_apps.len());
            } else {
                log::info!("[open-in] cache hit (fresh): {} apps", cached_apps.len());
            }
            if log::log_enabled!(log::Level::Info) {
                let names: Vec<String> = cached_apps.iter().map(|app| app.name.clone()).collect();
                log::info!("[open-in] cache apps: {:?}", names);
            }
        }

        if !has_cache {
            log::info!("[open-in] cache missing: refreshing app list");
            let app_handle = app.clone();
            let app_names = apps.clone();
            let force_icon_refresh = false;
            let cached_icon_map: HashMap<String, String> = HashMap::new();
            tauri::async_runtime::spawn_blocking(move || {
                log::info!("[open-in] scan start: {} candidates", app_names.len());
                let refreshed =
                    build_installed_apps(&app_names, &cached_icon_map, force_icon_refresh);
                if log::log_enabled!(log::Level::Info) {
                    let names: Vec<String> =
                        refreshed.iter().map(|entry| entry.name.clone()).collect();
                    log::info!("[open-in] scan apps: {:?}", names);
                }
                log::info!("[open-in] scan done: {} installed", refreshed.len());
                let cache_entry = InstalledAppsCache {
                    updated_at: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|value| value.as_secs())
                        .unwrap_or(0),
                    apps: refreshed.clone(),
                };
                let cache_path = installed_apps_cache_path();
                let _ = write_installed_apps_cache(&cache_path, &cache_entry);
                dispatch_installed_apps_update(&app_handle, &refreshed);
            });
        } else if force.unwrap_or(false) {
            log::info!("[open-in] manual refresh: refreshing app list");
            let app_handle = app.clone();
            let app_names = apps.clone();
            let force_icon_refresh = true;
            let cached_icon_map: HashMap<String, String> = HashMap::new();
            tauri::async_runtime::spawn_blocking(move || {
                log::info!("[open-in] scan start: {} candidates", app_names.len());
                let refreshed =
                    build_installed_apps(&app_names, &cached_icon_map, force_icon_refresh);
                if log::log_enabled!(log::Level::Info) {
                    let names: Vec<String> =
                        refreshed.iter().map(|entry| entry.name.clone()).collect();
                    log::info!("[open-in] scan apps: {:?}", names);
                }
                log::info!("[open-in] scan done: {} installed", refreshed.len());
                let cache_entry = InstalledAppsCache {
                    updated_at: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|value| value.as_secs())
                        .unwrap_or(0),
                    apps: refreshed.clone(),
                };
                let cache_path = installed_apps_cache_path();
                let _ = write_installed_apps_cache(&cache_path, &cache_entry);
                dispatch_installed_apps_update(&app_handle, &refreshed);
            });
        }

        return Ok(InstalledAppsResponse {
            apps: cached_apps,
            has_cache,
            is_cache_stale,
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = apps;
        Err("desktop_get_installed_apps is only supported on macOS".to_string())
    }
}

/// Fetch app icons for given app names.
#[tauri::command]
pub fn desktop_fetch_app_icons(apps: Vec<String>) -> Result<Vec<AppIconPayload>, String> {
    #[cfg(target_os = "macos")]
    {
        let mut results: Vec<AppIconPayload> = Vec::new();

        for raw in apps {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }

            let Some(app_path) = resolve_app_bundle_path(trimmed) else {
                continue;
            };

            let Some(icon_path) = resolve_app_icon_path(&app_path) else {
                continue;
            };

            let Some(data_url) = icon_to_data_url(&icon_path, trimmed) else {
                continue;
            };

            results.push(AppIconPayload {
                app: trimmed.to_string(),
                data_url,
            });
        }

        return Ok(results);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = apps;
        Err("desktop_fetch_app_icons is only supported on macOS".to_string())
    }
}

/// Resolve app bundle path from app name.
#[cfg(target_os = "macos")]
fn resolve_app_bundle_path(app_name: &str) -> Option<std::path::PathBuf> {
    if app_name.trim().is_empty() {
        return None;
    }

    let bundle_name = if app_name.ends_with(".app") {
        app_name.to_string()
    } else {
        format!("{app_name}.app")
    };

    let candidates = [
        format!("/Applications/{bundle_name}"),
        format!("/System/Applications/{bundle_name}"),
        format!("/System/Applications/Utilities/{bundle_name}"),
    ];

    for candidate in candidates {
        let path = std::path::PathBuf::from(&candidate);
        if path.exists() {
            return Some(path);
        }
    }

    if let Some(home) = env::var_os("HOME") {
        let user_app_path = std::path::PathBuf::from(home)
            .join("Applications")
            .join(&bundle_name);
        if user_app_path.exists() {
            return Some(user_app_path);
        }
    }

    if let Ok(output) = std::process::Command::new("mdfind")
        .args(["-name", &bundle_name])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let path = std::path::PathBuf::from(trimmed);
                if path.exists() {
                    return Some(path);
                }
            }
        }
    }

    None
}

/// Get installed apps cache file path.
#[cfg(target_os = "macos")]
fn installed_apps_cache_path() -> std::path::PathBuf {
    let home = env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("/"));
    home.join(".config")
        .join("openchamber")
        .join(INSTALLED_APPS_CACHE_FILE)
}

/// Read installed apps cache from disk.
#[cfg(target_os = "macos")]
fn read_installed_apps_cache(path: &std::path::Path) -> Option<InstalledAppsCache> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Write installed apps cache to disk.
#[cfg(target_os = "macos")]
fn write_installed_apps_cache(
    path: &std::path::Path,
    cache: &InstalledAppsCache,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let payload = serde_json::to_vec(cache).map_err(|err| err.to_string())?;
    fs::write(path, payload).map_err(|err| err.to_string())
}

/// Build list of installed apps from candidate names.
#[cfg(target_os = "macos")]
fn build_installed_apps(
    apps: &[String],
    cached_icon_map: &HashMap<String, String>,
    force_icon_refresh: bool,
) -> Vec<InstalledAppInfo> {
    let mut seen = std::collections::HashSet::new();
    let mut results = Vec::new();

    for raw in apps {
        let trimmed = raw.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            continue;
        }

        if let Some(app_path) = resolve_app_bundle_path(trimmed) {
            let icon_data_url = if force_icon_refresh {
                resolve_app_icon_path(&app_path).and_then(|icon| icon_to_data_url(&icon, trimmed))
            } else {
                cached_icon_map.get(trimmed).cloned().or_else(|| {
                    resolve_app_icon_path(&app_path)
                        .and_then(|icon| icon_to_data_url(&icon, trimmed))
                })
            };
            results.push(InstalledAppInfo {
                name: trimmed.to_string(),
                icon_data_url,
            });
        }
    }

    results
}

/// Dispatch installed apps update event to UI.
#[cfg(target_os = "macos")]
fn dispatch_installed_apps_update(app: &tauri::AppHandle, apps: &[InstalledAppInfo]) {
    let event = serde_json::to_string("openchamber:installed-apps-updated")
        .unwrap_or_else(|_| "\"openchamber:installed-apps-updated\"".into());
    let detail = serde_json::to_string(apps).unwrap_or_else(|_| "[]".into());
    let script = format!("window.dispatchEvent(new CustomEvent({event}, {{ detail: {detail} }}));");
    crate::eval_in_all_windows(app, &script);
}

/// Resolve app icon path from app bundle.
#[cfg(target_os = "macos")]
fn resolve_app_icon_path(app_path: &std::path::Path) -> Option<std::path::PathBuf> {
    if !app_path.exists() {
        return None;
    }

    if let Some(icon_file) = read_bundle_icon_file(app_path) {
        let icon_path = app_path.join("Contents").join("Resources").join(&icon_file);
        if icon_path.exists() {
            return Some(icon_path);
        }
    }

    if let Ok(output) = std::process::Command::new("mdls")
        .args([
            "-name",
            "kMDItemIconFile",
            "-raw",
            &app_path.to_string_lossy(),
        ])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let icon_name = stdout.trim();
            if !icon_name.is_empty() && icon_name != "(null)" {
                let icon_file = if icon_name.ends_with(".icns") {
                    icon_name.to_string()
                } else {
                    format!("{icon_name}.icns")
                };
                let icon_path = app_path.join("Contents").join("Resources").join(icon_file);
                if icon_path.exists() {
                    return Some(icon_path);
                }
            }
        }
    }

    let resources_path = app_path.join("Contents").join("Resources");
    if let Ok(entries) = fs::read_dir(resources_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(ext) = path.extension().and_then(|value| value.to_str()) {
                if ext.eq_ignore_ascii_case("icns") {
                    return Some(path);
                }
            }
        }
    }

    None
}

/// Read bundle icon file name from Info.plist.
#[cfg(target_os = "macos")]
fn read_bundle_icon_file(app_path: &std::path::Path) -> Option<String> {
    let plist_path = app_path.join("Contents").join("Info.plist");
    if !plist_path.exists() {
        return None;
    }

    let output = std::process::Command::new("defaults")
        .args(["read", &plist_path.to_string_lossy(), "CFBundleIconFile"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let icon_name = stdout.trim();
    if icon_name.is_empty() {
        return None;
    }

    let icon_file = if icon_name.ends_with(".icns") {
        icon_name.to_string()
    } else {
        format!("{icon_name}.icns")
    };

    Some(icon_file)
}

/// Convert icon file to data URL.
#[cfg(target_os = "macos")]
fn icon_to_data_url(icon_path: &std::path::Path, app_name: &str) -> Option<String> {
    if !icon_path.exists() {
        return None;
    }

    let sanitized: String = app_name
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let tmp_path = env::temp_dir().join(format!("openchamber-icon-{sanitized}-{timestamp}.png"));

    let status = std::process::Command::new("sips")
        .args([
            "-s",
            "format",
            "png",
            "-Z",
            "32",
            &icon_path.to_string_lossy(),
            "--out",
            &tmp_path.to_string_lossy(),
        ])
        .status()
        .ok()?;

    if !status.success() {
        return None;
    }

    let bytes = fs::read(&tmp_path).ok()?;
    let _ = fs::remove_file(&tmp_path);
    if bytes.is_empty() {
        return None;
    }

    let encoded = general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:image/png;base64,{encoded}"))
}

/// Check if app bundle is installed.
#[cfg(target_os = "macos")]
fn is_app_bundle_installed(bundle_name: &str) -> bool {
    if bundle_name.trim().is_empty() {
        return false;
    }

    if let Ok(output) = std::process::Command::new("mdfind")
        .args(["-name", bundle_name])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if !stdout.trim().is_empty() {
                return true;
            }
        }
    }

    let app_path = format!("/Applications/{bundle_name}");
    let system_app_path = format!("/System/Applications/{bundle_name}");
    let utilities_path = format!("/System/Applications/Utilities/{bundle_name}");

    if Path::new(&app_path).exists()
        || Path::new(&system_app_path).exists()
        || Path::new(&utilities_path).exists()
    {
        return true;
    }

    if let Some(home) = env::var_os("HOME") {
        let user_app_path = std::path::PathBuf::from(home)
            .join("Applications")
            .join(bundle_name);
        if user_app_path.exists() {
            return true;
        }
    }

    false
}

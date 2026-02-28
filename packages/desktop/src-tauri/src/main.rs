#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod remote_ssh;

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose, Engine as _};
use remote_ssh::DesktopSshManagerState;
use serde::{Deserialize, Serialize};
use std::env;
use std::time::{SystemTime, UNIX_EPOCH};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
use std::{
    net::TcpListener,
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Global counter for generating unique window labels.
static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_window_label() -> String {
    let n = WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed);
    if n == 1 {
        "main".to_string()
    } else {
        format!("main-{n}")
    }
}

/// Evaluate a script in all open webview windows.
fn eval_in_all_windows<R: tauri::Runtime>(app: &tauri::AppHandle<R>, script: &str) {
    for window in app.webview_windows().values() {
        let _ = window.eval(script);
    }
}

/// Evaluate a script in the currently focused window, falling back to any window.
fn eval_in_focused_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>, script: &str) {
    let windows = app.webview_windows();
    // Try the focused window first.
    for window in windows.values() {
        if window.is_focused().unwrap_or(false) {
            let _ = window.eval(script);
            return;
        }
    }
    // Fallback: try "main", then any window.
    if let Some(window) = windows.get("main") {
        let _ = window.eval(script);
    } else if let Some(window) = windows.values().next() {
        let _ = window.eval(script);
    }
}

fn dispatch_menu_action<R: tauri::Runtime>(app: &tauri::AppHandle<R>, action: &str) {
    let _ = app.emit("openchamber:menu-action", action);

    let event = serde_json::to_string("openchamber:menu-action")
        .unwrap_or_else(|_| "\"openchamber:menu-action\"".into());
    let detail = serde_json::to_string(action).unwrap_or_else(|_| "\"\"".into());
    let script = format!("window.dispatchEvent(new CustomEvent({event}, {{ detail: {detail} }}));");
    eval_in_focused_window(app, &script);
}

fn dispatch_check_for_updates<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let _ = app.emit("openchamber:check-for-updates", ());

    let event = serde_json::to_string("openchamber:check-for-updates")
        .unwrap_or_else(|_| "\"openchamber:check-for-updates\"".into());
    let script = format!("window.dispatchEvent(new Event({event}));");
    eval_in_all_windows(app, &script);
}
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};
use tauri_plugin_updater::UpdaterExt;

#[cfg(target_os = "macos")]
const MENU_ITEM_ABOUT_ID: &str = "menu_about";
#[cfg(target_os = "macos")]
const MENU_ITEM_CHECK_FOR_UPDATES_ID: &str = "menu_check_for_updates";
#[cfg(target_os = "macos")]
const MENU_ITEM_NEW_WINDOW_ID: &str = "menu_new_window";
#[cfg(target_os = "macos")]
const MENU_ITEM_SETTINGS_ID: &str = "menu_settings";
#[cfg(target_os = "macos")]
const MENU_ITEM_COMMAND_PALETTE_ID: &str = "menu_command_palette";
#[cfg(target_os = "macos")]
const MENU_ITEM_NEW_SESSION_ID: &str = "menu_new_session";
#[cfg(target_os = "macos")]
const MENU_ITEM_WORKTREE_CREATOR_ID: &str = "menu_worktree_creator";
#[cfg(target_os = "macos")]
const MENU_ITEM_CHANGE_WORKSPACE_ID: &str = "menu_change_workspace";
#[cfg(target_os = "macos")]
const MENU_ITEM_OPEN_GIT_TAB_ID: &str = "menu_open_git_tab";
#[cfg(target_os = "macos")]
const MENU_ITEM_OPEN_DIFF_TAB_ID: &str = "menu_open_diff_tab";
#[cfg(target_os = "macos")]
const MENU_ITEM_OPEN_FILES_TAB_ID: &str = "menu_open_files_tab";
#[cfg(target_os = "macos")]
const MENU_ITEM_OPEN_TERMINAL_TAB_ID: &str = "menu_open_terminal_tab";
#[cfg(target_os = "macos")]
const MENU_ITEM_COPY_ID: &str = "menu_copy";
#[cfg(target_os = "macos")]
const MENU_ITEM_THEME_LIGHT_ID: &str = "menu_theme_light";
#[cfg(target_os = "macos")]
const MENU_ITEM_THEME_DARK_ID: &str = "menu_theme_dark";
#[cfg(target_os = "macos")]
const MENU_ITEM_THEME_SYSTEM_ID: &str = "menu_theme_system";
#[cfg(target_os = "macos")]
const MENU_ITEM_TOGGLE_SIDEBAR_ID: &str = "menu_toggle_sidebar";
#[cfg(target_os = "macos")]
const MENU_ITEM_TOGGLE_MEMORY_DEBUG_ID: &str = "menu_toggle_memory_debug";
#[cfg(target_os = "macos")]
const MENU_ITEM_HELP_DIALOG_ID: &str = "menu_help_dialog";
#[cfg(target_os = "macos")]
const MENU_ITEM_DOWNLOAD_LOGS_ID: &str = "menu_download_logs";
#[cfg(target_os = "macos")]
const MENU_ITEM_REPORT_BUG_ID: &str = "menu_report_bug";
#[cfg(target_os = "macos")]
const MENU_ITEM_REQUEST_FEATURE_ID: &str = "menu_request_feature";
#[cfg(target_os = "macos")]
const MENU_ITEM_JOIN_DISCORD_ID: &str = "menu_join_discord";
#[cfg(target_os = "macos")]
const MENU_ITEM_CLEAR_CACHE_ID: &str = "menu_clear_cache";

#[cfg(target_os = "macos")]
const GITHUB_BUG_REPORT_URL: &str =
    "https://github.com/btriapitsyn/openchamber/issues/new?template=bug_report.yml";
#[cfg(target_os = "macos")]
const GITHUB_FEATURE_REQUEST_URL: &str =
    "https://github.com/btriapitsyn/openchamber/issues/new?template=feature_request.yml";
#[cfg(target_os = "macos")]
const DISCORD_INVITE_URL: &str = "https://discord.gg/ZYRSdnwwKA";

#[cfg(target_os = "macos")]
fn build_macos_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{
        Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
    };

    let pkg_info = app.package_info();

    let auto_worktree = app
        .try_state::<MenuRuntimeState>()
        .map(|state| *state.auto_worktree.lock().expect("menu state mutex"))
        .unwrap_or(false);

    let new_session_shortcut = if auto_worktree {
        "Cmd+Shift+N"
    } else {
        "Cmd+N"
    };
    let new_worktree_shortcut = if auto_worktree {
        "Cmd+N"
    } else {
        "Cmd+Shift+N"
    };

    let about = MenuItem::with_id(
        app,
        MENU_ITEM_ABOUT_ID,
        format!("About {}", pkg_info.name),
        true,
        None::<&str>,
    )?;

    let check_for_updates = MenuItem::with_id(
        app,
        MENU_ITEM_CHECK_FOR_UPDATES_ID,
        "Check for Updates",
        true,
        None::<&str>,
    )?;

    let settings = MenuItem::with_id(app, MENU_ITEM_SETTINGS_ID, "Settings", true, Some("Cmd+,"))?;

    let command_palette = MenuItem::with_id(
        app,
        MENU_ITEM_COMMAND_PALETTE_ID,
        "Command Palette",
        true,
        Some("Cmd+K"),
    )?;

    let new_window = MenuItem::with_id(
        app,
        MENU_ITEM_NEW_WINDOW_ID,
        "New Window",
        true,
        Some("Cmd+Shift+Alt+N"),
    )?;

    let new_session = MenuItem::with_id(
        app,
        MENU_ITEM_NEW_SESSION_ID,
        "New Session",
        true,
        Some(new_session_shortcut),
    )?;

    let worktree_creator = MenuItem::with_id(
        app,
        MENU_ITEM_WORKTREE_CREATOR_ID,
        "New Worktree",
        true,
        Some(new_worktree_shortcut),
    )?;

    let change_workspace = MenuItem::with_id(
        app,
        MENU_ITEM_CHANGE_WORKSPACE_ID,
        "Add Workspace",
        true,
        None::<&str>,
    )?;

    let open_git_tab =
        MenuItem::with_id(app, MENU_ITEM_OPEN_GIT_TAB_ID, "Git", true, Some("Cmd+G"))?;
    let open_diff_tab =
        MenuItem::with_id(app, MENU_ITEM_OPEN_DIFF_TAB_ID, "Diff", true, Some("Cmd+E"))?;
    let open_files_tab = MenuItem::with_id(
        app,
        MENU_ITEM_OPEN_FILES_TAB_ID,
        "Files",
        true,
        None::<&str>,
    )?;
    let open_terminal_tab = MenuItem::with_id(
        app,
        MENU_ITEM_OPEN_TERMINAL_TAB_ID,
        "Terminal",
        true,
        Some("Cmd+T"),
    )?;
    let copy = MenuItem::with_id(app, MENU_ITEM_COPY_ID, "Copy", true, Some("Cmd+C"))?;

    let theme_light = MenuItem::with_id(
        app,
        MENU_ITEM_THEME_LIGHT_ID,
        "Light Theme",
        true,
        None::<&str>,
    )?;
    let theme_dark = MenuItem::with_id(
        app,
        MENU_ITEM_THEME_DARK_ID,
        "Dark Theme",
        true,
        None::<&str>,
    )?;
    let theme_system = MenuItem::with_id(
        app,
        MENU_ITEM_THEME_SYSTEM_ID,
        "System Theme",
        true,
        None::<&str>,
    )?;

    let toggle_sidebar = MenuItem::with_id(
        app,
        MENU_ITEM_TOGGLE_SIDEBAR_ID,
        "Toggle Session Sidebar",
        true,
        Some("Cmd+L"),
    )?;

    let toggle_memory_debug = MenuItem::with_id(
        app,
        MENU_ITEM_TOGGLE_MEMORY_DEBUG_ID,
        "Toggle Memory Debug",
        true,
        Some("Cmd+Shift+D"),
    )?;

    let help_dialog = MenuItem::with_id(
        app,
        MENU_ITEM_HELP_DIALOG_ID,
        "Keyboard Shortcuts",
        true,
        Some("Cmd+."),
    )?;

    let download_logs = MenuItem::with_id(
        app,
        MENU_ITEM_DOWNLOAD_LOGS_ID,
        "Show Diagnostics",
        true,
        Some("Cmd+Shift+L"),
    )?;

    let report_bug = MenuItem::with_id(
        app,
        MENU_ITEM_REPORT_BUG_ID,
        "Report a Bug",
        true,
        None::<&str>,
    )?;
    let request_feature = MenuItem::with_id(
        app,
        MENU_ITEM_REQUEST_FEATURE_ID,
        "Request a Feature",
        true,
        None::<&str>,
    )?;
    let join_discord = MenuItem::with_id(
        app,
        MENU_ITEM_JOIN_DISCORD_ID,
        "Join Discord",
        true,
        None::<&str>,
    )?;

    let clear_cache = MenuItem::with_id(
        app,
        MENU_ITEM_CLEAR_CACHE_ID,
        "Clear Cache",
        true,
        None::<&str>,
    )?;

    let theme_submenu = Submenu::with_items(
        app,
        "Theme",
        true,
        &[&theme_light, &theme_dark, &theme_system],
    )?;

    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(
        app,
        HELP_SUBMENU_ID,
        "Help",
        true,
        &[
            &help_dialog,
            &download_logs,
            &PredefinedMenuItem::separator(app)?,
            &clear_cache,
            &PredefinedMenuItem::separator(app)?,
            &report_bug,
            &request_feature,
            &PredefinedMenuItem::separator(app)?,
            &join_discord,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                pkg_info.name.clone(),
                true,
                &[
                    &about,
                    &check_for_updates,
                    &PredefinedMenuItem::separator(app)?,
                    &settings,
                    &command_palette,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &new_window,
                    &PredefinedMenuItem::separator(app)?,
                    &new_session,
                    &worktree_creator,
                    &PredefinedMenuItem::separator(app)?,
                    &change_workspace,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &copy,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &open_git_tab,
                    &open_diff_tab,
                    &open_files_tab,
                    &open_terminal_tab,
                    &PredefinedMenuItem::separator(app)?,
                    &theme_submenu,
                    &PredefinedMenuItem::separator(app)?,
                    &toggle_sidebar,
                    &toggle_memory_debug,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::fullscreen(app, None)?,
                ],
            )?,
            &window_menu,
            &help_menu,
        ],
    )
}

#[tauri::command]
fn desktop_set_auto_worktree_menu(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let Some(state) = app.try_state::<MenuRuntimeState>() else {
        return Ok(());
    };

    {
        let mut guard = state.auto_worktree.lock().expect("menu state mutex");
        *guard = enabled;
    }

    #[cfg(target_os = "macos")]
    {
        use tauri::menu::MenuItemKind;

        let new_session_shortcut = if enabled { "Cmd+Shift+N" } else { "Cmd+N" };
        let new_worktree_shortcut = if enabled { "Cmd+N" } else { "Cmd+Shift+N" };

        if let Some(menu) = app.menu() {
            if let Some(MenuItemKind::MenuItem(item)) = menu.get(MENU_ITEM_NEW_SESSION_ID) {
                item.set_accelerator(Some(new_session_shortcut))
                    .map_err(|err| err.to_string())?;
            }
            if let Some(MenuItemKind::MenuItem(item)) = menu.get(MENU_ITEM_WORKTREE_CREATOR_ID) {
                item.set_accelerator(Some(new_worktree_shortcut))
                    .map_err(|err| err.to_string())?;
            }
        } else {
            // Should not happen on macOS, but keep as fallback.
            let menu = build_macos_menu(&app).map_err(|err| err.to_string())?;
            app.set_menu(menu).map_err(|err| err.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
fn desktop_clear_cache(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut failures: Vec<String> = Vec::new();

        for (label, window) in app.webview_windows() {
            if let Err(err) = window.clear_all_browsing_data() {
                failures.push(format!("{label}: {err}"));
            }
        }

        if !failures.is_empty() {
            return Err(format!(
                "Failed to clear browsing data for some windows: {}",
                failures.join("; ")
            ));
        }

        // Reload all windows after clearing persisted browsing data so in-memory state is reset too.
        eval_in_all_windows(&app, "window.location.reload();");

        log::info!("[desktop] Cleared all webview browsing data and reloaded windows");
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("desktop_clear_cache is only supported on macOS".to_string())
    }
}

#[tauri::command]
fn desktop_open_path(path: String, app: Option<String>) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path is required".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if let Some(app_name) = app
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            command.arg("-a").arg(app_name);
        }
        command.arg(trimmed);
        command.spawn().map_err(|err| err.to_string())?;
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("desktop_open_path is only supported on macOS".to_string())
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InstalledAppInfo {
    name: String,
    icon_data_url: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledAppsCache {
    updated_at: u64,
    apps: Vec<InstalledAppInfo>,
}

const INSTALLED_APPS_CACHE_TTL_SECS: u64 = 60 * 60 * 24;
const INSTALLED_APPS_CACHE_FILE: &str = "discovered-apps.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledAppsResponse {
    apps: Vec<InstalledAppInfo>,
    has_cache: bool,
    is_cache_stale: bool,
}

#[tauri::command]
fn desktop_filter_installed_apps(apps: Vec<String>) -> Result<Vec<String>, String> {
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

#[tauri::command]
fn desktop_get_installed_apps(
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

#[derive(Serialize)]
struct AppIconPayload {
    app: String,
    data_url: String,
}

#[tauri::command]
fn desktop_fetch_app_icons(apps: Vec<String>) -> Result<Vec<AppIconPayload>, String> {
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

#[cfg(target_os = "macos")]
fn resolve_app_bundle_path(app_name: &str) -> Option<PathBuf> {
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
        let path = PathBuf::from(&candidate);
        if path.exists() {
            return Some(path);
        }
    }

    if let Some(home) = env::var_os("HOME") {
        let user_app_path = PathBuf::from(home).join("Applications").join(&bundle_name);
        if user_app_path.exists() {
            return Some(user_app_path);
        }
    }

    if let Ok(output) = Command::new("mdfind")
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
                let path = PathBuf::from(trimmed);
                if path.exists() {
                    return Some(path);
                }
            }
        }
    }

    None
}

#[cfg(target_os = "macos")]
fn installed_apps_cache_path() -> PathBuf {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    home.join(".config")
        .join("openchamber")
        .join(INSTALLED_APPS_CACHE_FILE)
}

#[cfg(target_os = "macos")]
fn read_installed_apps_cache(path: &Path) -> Option<InstalledAppsCache> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(target_os = "macos")]
fn write_installed_apps_cache(path: &Path, cache: &InstalledAppsCache) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let payload = serde_json::to_vec(cache).map_err(|err| err.to_string())?;
    fs::write(path, payload).map_err(|err| err.to_string())
}

#[cfg(target_os = "macos")]
fn build_installed_apps(
    apps: &[String],
    cached_icon_map: &HashMap<String, String>,
    force_icon_refresh: bool,
) -> Vec<InstalledAppInfo> {
    let mut seen = HashSet::new();
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

#[cfg(target_os = "macos")]
fn dispatch_installed_apps_update(app: &tauri::AppHandle, apps: &[InstalledAppInfo]) {
    let event = serde_json::to_string("openchamber:installed-apps-updated")
        .unwrap_or_else(|_| "\"openchamber:installed-apps-updated\"".into());
    let detail = serde_json::to_string(apps).unwrap_or_else(|_| "[]".into());
    let script = format!("window.dispatchEvent(new CustomEvent({event}, {{ detail: {detail} }}));");
    eval_in_all_windows(app, &script);
}

#[cfg(target_os = "macos")]
fn resolve_app_icon_path(app_path: &Path) -> Option<PathBuf> {
    if !app_path.exists() {
        return None;
    }

    if let Some(icon_file) = read_bundle_icon_file(app_path) {
        let icon_path = app_path.join("Contents").join("Resources").join(&icon_file);
        if icon_path.exists() {
            return Some(icon_path);
        }
    }

    if let Ok(output) = Command::new("mdls")
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

#[cfg(target_os = "macos")]
fn read_bundle_icon_file(app_path: &Path) -> Option<String> {
    let plist_path = app_path.join("Contents").join("Info.plist");
    if !plist_path.exists() {
        return None;
    }

    let output = Command::new("defaults")
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

#[cfg(target_os = "macos")]
fn icon_to_data_url(icon_path: &Path, app_name: &str) -> Option<String> {
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

    let status = Command::new("sips")
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

    let encoded = general_purpose::STANDARD.encode(bytes);
    Some(format!("data:image/png;base64,{encoded}"))
}

#[cfg(target_os = "macos")]
fn is_app_bundle_installed(bundle_name: &str) -> bool {
    if bundle_name.trim().is_empty() {
        return false;
    }

    if let Ok(output) = Command::new("mdfind").args(["-name", bundle_name]).output() {
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
        let user_app_path = PathBuf::from(home).join("Applications").join(bundle_name);
        if user_app_path.exists() {
            return true;
        }
    }

    false
}

const SIDECAR_NAME: &str = "openchamber-server";
const SIDECAR_NOTIFY_PREFIX: &str = "[OpenChamberDesktopNotify] ";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(250);

const DEFAULT_DESKTOP_PORT: u16 = 57123;
const WINDOW_STATE_DEBOUNCE_MS: u64 = 300;
const MIN_WINDOW_WIDTH: u32 = 800;
const MIN_WINDOW_HEIGHT: u32 = 520;
const MIN_RESTORE_WINDOW_WIDTH: u32 = 900;
const MIN_RESTORE_WINDOW_HEIGHT: u32 = 560;

const LOCAL_HOST_ID: &str = "local";

#[derive(Default)]
struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    url: Mutex<Option<String>>,
}

/// Holds the initialization script and local origin, shared across all windows.
#[derive(Default)]
struct DesktopUiInjectionState {
    script: Mutex<Option<String>>,
    local_origin: Mutex<Option<String>>,
    /// Host URLs that were probed unreachable (e.g. at startup).
    /// `open_new_window` checks this to avoid opening windows at dead hosts.
    unreachable_hosts: Mutex<HashSet<String>>,
}

/// Tracks the set of currently-focused window labels.
/// Notification suppression triggers when ANY window is focused.
struct WindowFocusState {
    focused_windows: Mutex<HashSet<String>>,
}

impl Default for WindowFocusState {
    fn default() -> Self {
        Self {
            focused_windows: Mutex::new(HashSet::new()),
        }
    }
}

impl WindowFocusState {
    fn any_focused(&self) -> bool {
        let guard = self.focused_windows.lock().expect("focus mutex");
        !guard.is_empty()
    }

    fn set_focused(&self, label: &str, focused: bool) {
        let mut guard = self.focused_windows.lock().expect("focus mutex");
        if focused {
            guard.insert(label.to_string());
        } else {
            guard.remove(label);
        }
    }

    fn remove_window(&self, label: &str) {
        let mut guard = self.focused_windows.lock().expect("focus mutex");
        guard.remove(label);
    }
}

#[derive(Default)]
struct MenuRuntimeState {
    auto_worktree: Mutex<bool>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopHost {
    id: String,
    label: String,
    url: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopHostsConfig {
    hosts: Vec<DesktopHost>,
    default_host_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopWindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    maximized: bool,
    #[serde(default)]
    fullscreen: bool,
}

#[derive(Default)]
struct WindowGeometryDebounceState {
    revisions: Mutex<HashMap<String, u64>>,
}

fn normalize_host_url(raw: &str) -> Option<String> {
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

fn sanitize_host_url_for_storage(raw: &str) -> Option<String> {
    normalize_host_url(raw)
}

fn build_health_url(base_url: &str) -> Option<String> {
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

fn settings_file_path() -> PathBuf {
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

fn read_desktop_local_port_from_disk() -> Option<u16> {
    let path = settings_file_path();
    let raw = fs::read_to_string(path).ok();
    let parsed = raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
    parsed
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

fn write_desktop_local_port_to_disk(port: u16) -> Result<()> {
    let path = settings_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut root: serde_json::Value = if let Ok(raw) = fs::read_to_string(&path) {
        serde_json::from_str(&raw).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    if !root.is_object() {
        root = serde_json::json!({});
    }

    root["desktopLocalPort"] = serde_json::Value::Number(serde_json::Number::from(port));
    fs::write(&path, serde_json::to_string_pretty(&root)?)?;
    Ok(())
}

fn read_desktop_hosts_config_from_disk() -> DesktopHostsConfig {
    read_desktop_hosts_config_from_path(&settings_file_path())
}

fn read_desktop_hosts_config_from_path(path: &Path) -> DesktopHostsConfig {
    let raw = fs::read_to_string(path).ok();
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
    }
}

fn read_desktop_window_state_from_disk() -> Option<DesktopWindowState> {
    let path = settings_file_path();
    let raw = fs::read_to_string(path).ok();
    let parsed = raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());

    parsed
        .as_ref()
        .and_then(|v| v.get("desktopWindowState"))
        .cloned()
        .and_then(|v| serde_json::from_value::<DesktopWindowState>(v).ok())
}

fn write_desktop_window_state_to_disk(state: &DesktopWindowState) -> Result<()> {
    let path = settings_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut root: serde_json::Value = if let Ok(raw) = fs::read_to_string(&path) {
        serde_json::from_str(&raw).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    if !root.is_object() {
        root = serde_json::json!({});
    }

    root["desktopWindowState"] = serde_json::to_value(state).unwrap_or(serde_json::Value::Null);
    fs::write(&path, serde_json::to_string_pretty(&root)?)?;
    Ok(())
}

fn write_desktop_hosts_config_to_disk(config: &DesktopHostsConfig) -> Result<()> {
    write_desktop_hosts_config_to_path(&settings_file_path(), config)
}

fn write_desktop_hosts_config_to_path(path: &Path, config: &DesktopHostsConfig) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut root: serde_json::Value = if let Ok(raw) = fs::read_to_string(&path) {
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

    fs::write(&path, serde_json::to_string_pretty(&root)?)?;
    Ok(())
}

#[tauri::command]
fn desktop_hosts_get() -> Result<DesktopHostsConfig, String> {
    Ok(read_desktop_hosts_config_from_disk())
}

#[tauri::command]
fn desktop_hosts_set(config: DesktopHostsConfig) -> Result<(), String> {
    write_desktop_hosts_config_to_disk(&config).map_err(|err| err.to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostProbeResult {
    status: String,
    latency_ms: u64,
}

#[tauri::command]
async fn desktop_host_probe(url: String) -> Result<HostProbeResult, String> {
    let health = build_health_url(&url).ok_or_else(|| "Invalid URL".to_string())?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
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

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
enum UpdateProgressEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
        downloaded: u64,
        total: Option<u64>,
    },
    Finished,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateInfo {
    available: bool,
    current_version: String,
    version: Option<String>,
    body: Option<String>,
    date: Option<String>,
}

struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);

fn pick_unused_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    Ok(port)
}

fn is_nonempty_string(value: &str) -> bool {
    !value.trim().is_empty()
}

const CHANGELOG_URL: &str =
    "https://raw.githubusercontent.com/btriapitsyn/openchamber/main/CHANGELOG.md";

fn parse_semver_num(value: &str) -> Option<u32> {
    let trimmed = value.trim().trim_start_matches('v');
    let mut parts = trimmed.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    let patch: u32 = parts.next()?.parse().ok()?;
    Some(major.saturating_mul(10_000) + minor.saturating_mul(100) + patch)
}

fn is_placeholder_release_notes(body: &Option<String>) -> bool {
    let Some(body) = body.as_ref() else {
        return true;
    };
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return true;
    }
    trimmed
        .to_ascii_lowercase()
        .starts_with("see release notes at")
}

async fn fetch_changelog_notes(from_version: &str, to_version: &str) -> Option<String> {
    let from_num = parse_semver_num(from_version)?;
    let to_num = parse_semver_num(to_version)?;
    if to_num <= from_num {
        return None;
    }

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;

    let response = client.get(CHANGELOG_URL).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let changelog = response.text().await.ok()?;
    if changelog.trim().is_empty() {
        return None;
    }

    let mut markers: Vec<(usize, Option<u32>)> = Vec::new();
    let mut offset: usize = 0;
    for line in changelog.lines() {
        let line_trimmed = line.trim_end_matches('\r');
        if line_trimmed.starts_with("## [") {
            let ver = line_trimmed
                .strip_prefix("## [")
                .and_then(|rest| rest.split(']').next())
                .unwrap_or("");
            markers.push((offset, parse_semver_num(ver)));
        }
        offset = offset.saturating_add(line.len().saturating_add(1));
    }

    if markers.is_empty() {
        return None;
    }

    let mut relevant: Vec<String> = Vec::new();
    for idx in 0..markers.len() {
        let (start, ver_num) = markers[idx];
        let end = markers
            .get(idx + 1)
            .map(|m| m.0)
            .unwrap_or_else(|| changelog.len());
        let Some(ver_num) = ver_num else {
            continue;
        };
        if ver_num <= from_num || ver_num > to_num {
            continue;
        }
        if start >= changelog.len() || end <= start {
            continue;
        }
        let end_clamped = end.min(changelog.len());
        let section = changelog[start..end_clamped].trim();
        if !section.is_empty() {
            relevant.push(section.to_string());
        }
    }

    if relevant.is_empty() {
        None
    } else {
        Some(relevant.join("\n\n"))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarNotifyPayload {
    title: Option<String>,
    body: Option<String>,
    tag: Option<String>,
    require_hidden: Option<bool>,
}

fn maybe_show_sidecar_notification(app: &tauri::AppHandle, payload: SidecarNotifyPayload) {
    let require_hidden = payload.require_hidden.unwrap_or(false);
    if require_hidden {
        let any_focused = app
            .try_state::<WindowFocusState>()
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

async fn wait_for_health(url: &str) -> bool {
    let client = match reqwest::Client::builder().no_proxy().build() {
        Ok(c) => c,
        Err(_) => return false,
    };

    let deadline = std::time::Instant::now() + HEALTH_TIMEOUT;
    let health_url = format!("{}/health", url.trim_end_matches('/'));

    while std::time::Instant::now() < deadline {
        if let Ok(resp) = client.get(&health_url).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(HEALTH_POLL_INTERVAL).await;
    }

    false
}

fn kill_sidecar(app: tauri::AppHandle) {
    let Some(state) = app.try_state::<SidecarState>() else {
        return;
    };

    let sidecar_url = state.url.lock().expect("sidecar url mutex").clone();
    if let Some(url) = sidecar_url {
        let shutdown_url = format!("{}/api/system/shutdown", url.trim_end_matches('/'));
        if let Ok(client) = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(1500))
            .build()
        {
            if let Ok(resp) = client.post(shutdown_url).send() {
                if resp.status().is_success() {
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
    }

    let mut guard = state.child.lock().expect("sidecar mutex");
    if let Some(child) = guard.take() {
        let _ = child.kill();
    }
    *state.url.lock().expect("sidecar url mutex") = None;
}

fn build_local_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

async fn spawn_local_server(app: &tauri::AppHandle) -> Result<String> {
    let stored_port = read_desktop_local_port_from_disk();
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

    let opencode_binary_from_settings: Option<String> = (|| {
        let data_dir = env::var("OPENCHAMBER_DATA_DIR")
            .ok()
            .and_then(|v| {
                let t = v.trim().to_string();
                if t.is_empty() {
                    None
                } else {
                    Some(PathBuf::from(t))
                }
            })
            .or_else(|| {
                resolved_home_dir_path
                    .as_ref()
                    .map(|home| home.join(".config").join("openchamber"))
            });
        let data_dir = data_dir?;
        let settings_path = data_dir.join("settings.json");
        let raw = fs::read_to_string(&settings_path).ok()?;
        let json = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
        let value = json.get("opencodeBinary")?.as_str()?.trim();
        if value.is_empty() {
            return None;
        }

        let mut candidate = value.to_string();
        if fs::metadata(&candidate)
            .map(|m| m.is_dir())
            .unwrap_or(false)
        {
            let bin_name = if cfg!(windows) {
                "opencode.exe"
            } else {
                "opencode"
            };
            candidate = PathBuf::from(candidate)
                .join(bin_name)
                .to_string_lossy()
                .to_string();
        }

        Some(candidate)
    })();

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
        if let Ok(val) = env::var(var) {
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

    if let Ok(existing) = env::var("PATH") {
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
            .map_err(|err| anyhow!("Failed to resolve sidecar '{SIDECAR_NAME}': {err}"))?
            .args(["--port", &port.to_string()])
            .env("OPENCHAMBER_HOST", "127.0.0.1")
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

        if let Ok(password) = env::var("OPENCODE_SERVER_PASSWORD") {
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
                        if let Some(rest) = line.strip_prefix(SIDECAR_NOTIFY_PREFIX) {
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
            *state.child.lock().expect("sidecar mutex") = Some(child);
            *state.url.lock().expect("sidecar url mutex") = Some(url.clone());
        }

        if !wait_for_health(&url).await {
            kill_sidecar(app.clone());
            continue;
        }

        let _ = write_desktop_local_port_to_disk(port);
        return Ok(url);
    }

    Err(anyhow!("Sidecar health check failed"))
}

fn resolve_web_dist_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    let candidates = ["web-dist", "resources/web-dist"];
    for candidate in candidates {
        let path = app
            .path()
            .resolve(candidate, tauri::path::BaseDirectory::Resource)
            .map_err(|err| anyhow!("Failed to resolve '{candidate}' resources: {err}"))?;
        let index = path.join("index.html");
        if fs::metadata(&index).is_ok() {
            return Ok(path);
        }
    }

    Err(anyhow!(
        "Web assets missing in app resources (expected index.html under web-dist)"
    ))
}

fn normalize_server_url(input: &str) -> Option<String> {
    normalize_host_url(input)
}

#[derive(Deserialize)]
struct DesktopNotifyPayload {
    title: Option<String>,
    body: Option<String>,
    tag: Option<String>,
}

#[tauri::command]
fn desktop_notify(
    app: tauri::AppHandle,
    payload: Option<DesktopNotifyPayload>,
) -> Result<bool, String> {
    let payload = payload.unwrap_or(DesktopNotifyPayload {
        title: None,
        body: None,
        tag: None,
    });

    use tauri_plugin_notification::NotificationExt;

    let mut builder = app
        .notification()
        .builder()
        .title(payload.title.unwrap_or_else(|| "OpenChamber".to_string()));

    if let Some(body) = payload.body {
        if is_nonempty_string(&body) {
            builder = builder.body(body);
        }
    }

    if let Some(tag) = payload.tag {
        if is_nonempty_string(&tag) {
            let _ = tag;
        }
    }

    #[cfg(target_os = "macos")]
    {
        builder = builder.sound("Glass");
    }

    builder.show().map(|_| true).map_err(|err| err.to_string())
}

#[tauri::command]
async fn desktop_check_for_updates(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingUpdate>,
) -> Result<DesktopUpdateInfo, String> {
    let updater = app.updater().map_err(|err| err.to_string())?;
    let update = updater.check().await.map_err(|err| err.to_string())?;

    let current_version = app.package_info().version.to_string();

    let info = if let Some(update) = update {
        *pending.0.lock().expect("pending update mutex") = Some(update.clone());
        let mut body = update.body.clone();
        if is_placeholder_release_notes(&body) {
            if let Some(notes) = fetch_changelog_notes(&current_version, &update.version).await {
                body = Some(notes);
            }
        }
        DesktopUpdateInfo {
            available: true,
            current_version,
            version: Some(update.version.clone()),
            body,
            date: update.date.map(|date| date.to_string()),
        }
    } else {
        *pending.0.lock().expect("pending update mutex") = None;
        DesktopUpdateInfo {
            available: false,
            current_version,
            version: None,
            body: None,
            date: None,
        }
    };

    Ok(info)
}

#[tauri::command]
async fn desktop_download_and_install_update(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingUpdate>,
) -> Result<(), String> {
    let Some(update) = pending.0.lock().expect("pending update mutex").take() else {
        return Err("No pending update".to_string());
    };

    let mut downloaded: u64 = 0;
    let mut total: Option<u64> = None;
    let mut started = false;

    update
        .download_and_install(
            |chunk_length, content_length| {
                if !started {
                    total = content_length;
                    let _ = app.emit(
                        "openchamber:update-progress",
                        UpdateProgressEvent::Started { content_length },
                    );
                    started = true;
                }

                downloaded = downloaded.saturating_add(chunk_length as u64);
                let _ = app.emit(
                    "openchamber:update-progress",
                    UpdateProgressEvent::Progress {
                        chunk_length,
                        downloaded,
                        total,
                    },
                );
            },
            || {
                let _ = app.emit("openchamber:update-progress", UpdateProgressEvent::Finished);
            },
        )
        .await
        .map_err(|err| err.to_string())?;

    Ok(())
}

#[tauri::command]
fn desktop_restart(app: tauri::AppHandle) {
    app.restart();
}

/// Create a new desktop window from the UI layer.
///
/// IMPORTANT: This command MUST remain synchronous (not `async`). Tauri runs
/// sync commands on the main thread, which is required on macOS for
/// `WebviewWindowBuilder::build()`. Making this `async` would move execution
/// to the Tokio thread pool and risk crashes or undefined behavior.
#[tauri::command]
fn desktop_new_window(app: tauri::AppHandle) -> Result<(), String> {
    open_new_window(&app);
    Ok(())
}

/// Open a new window pointed at a specific URL (used by the host switcher UI).
///
/// IMPORTANT: Must remain synchronous -- see `desktop_new_window` doc comment.
#[tauri::command]
fn desktop_new_window_at_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    // Validate scheme to prevent file://, data:, javascript: etc.
    let parsed = url::Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("Unsupported URL scheme: {scheme}")),
    }

    let local_origin = app
        .try_state::<DesktopUiInjectionState>()
        .and_then(|state| {
            state
                .local_origin
                .lock()
                .expect("desktop local origin mutex")
                .clone()
        })
        .ok_or_else(|| "Local origin not yet known (sidecar may still be starting)".to_string())?;

    create_window(&app, &url, &local_origin, false).map_err(|e| e.to_string())
}

/// Read a file and return its content as base64 with mime type detection.
/// Used for drag-drop file attachments in desktop app.
#[tauri::command]
fn desktop_read_file(path: String) -> Result<FileContent, String> {
    use std::path::Path;

    let path = Path::new(&path);

    // Check file size (max 50MB)
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("Failed to read file metadata: {e}"))?;
    let size = metadata.len();
    if size > 50 * 1024 * 1024 {
        return Err("File is too large. Maximum size is 50MB.".to_string());
    }

    // Read file bytes
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read file: {e}"))?;

    // Detect mime type from extension
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "js" => "text/javascript",
        "ts" => "text/typescript",
        "tsx" => "text/typescript-jsx",
        "jsx" => "text/javascript-jsx",
        "html" => "text/html",
        "css" => "text/css",
        "py" => "text/x-python",
        _ => "application/octet-stream",
    };

    // Encode as base64
    let base64 = general_purpose::STANDARD.encode(&bytes);

    Ok(FileContent {
        mime: mime.to_string(),
        base64,
        size: bytes.len(),
    })
}

#[derive(Serialize)]
struct FileContent {
    mime: String,
    base64: String,
    size: usize,
}

#[cfg(target_os = "macos")]
fn macos_major_version() -> Option<u32> {
    fn cmd_stdout(cmd: &str, args: &[&str]) -> Option<String> {
        let output = Command::new(cmd).args(args).output().ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8(output.stdout).ok()
    }

    // Use marketing version (sw_vers), but map legacy 10.x to minor (10.15 -> 15).
    // This matches WebKit UA fallback logic in the UI.
    if let Some(raw) = cmd_stdout("/usr/bin/sw_vers", &["-productVersion"])
        .or_else(|| cmd_stdout("sw_vers", &["-productVersion"]))
    {
        let raw = raw.trim();
        let mut parts = raw.split('.');
        let major = parts.next().and_then(|v| v.parse::<u32>().ok())?;
        let minor = parts
            .next()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0);
        return Some(if major == 10 { minor } else { major });
    }

    // Fallback: derive from Darwin major (kern.osrelease major).
    let raw = cmd_stdout("/usr/sbin/sysctl", &["-n", "kern.osrelease"])
        .or_else(|| cmd_stdout("sysctl", &["-n", "kern.osrelease"]))
        .or_else(|| cmd_stdout("/usr/bin/uname", &["-r"]))
        .or_else(|| cmd_stdout("uname", &["-r"]))?;
    let raw = raw.trim();
    let major = raw.split('.').next()?.parse::<u32>().ok()?;
    if major >= 20 {
        return Some(major - 9);
    }
    if major >= 15 {
        return Some(major - 4);
    }
    Some(major)
}

#[cfg(not(target_os = "macos"))]
fn macos_major_version() -> Option<u32> {
    None
}

/// Build the initialization script injected into every webview window.
/// This is computed once and reused for all windows.
fn build_init_script(local_origin: &str) -> String {
    let home =
        std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    let macos_major = macos_major_version().unwrap_or(0);

    let home_json = serde_json::to_string(&home).unwrap_or_else(|_| "\"\"".into());
    let local_json = serde_json::to_string(local_origin).unwrap_or_else(|_| "\"\"".into());

    let mut init_script = format!(
        "(function(){{try{{window.__OPENCHAMBER_HOME__={home_json};window.__OPENCHAMBER_MACOS_MAJOR__={macos_major};window.__OPENCHAMBER_LOCAL_ORIGIN__={local_json};}}catch(_e){{}}}})();"
    );

    // Cleanup: older builds injected a native-ish Instance switcher button into pages.
    // Remove it if present so the UI-owned host switcher is the only one.
    init_script.push_str("\ntry{var old=document.getElementById('__oc-instance-switcher');if(old)old.remove();}catch(_e){}");

    if !cfg!(debug_assertions) {
        init_script.push_str("\ntry{document.addEventListener('contextmenu',function(e){var t=e&&e.target;if(!t||typeof t.closest!=='function'){e.preventDefault();return;}if(t.closest('.terminal-viewport-container,[data-oc-allow-native-contextmenu],input,textarea,[contenteditable=\"true\"]')){return;}e.preventDefault();},true);}catch(_e){}");
    }

    init_script
}

fn is_window_state_visible(app: &tauri::AppHandle, state: &DesktopWindowState) -> bool {
    if state.width == 0 || state.height == 0 {
        return false;
    }

    let Ok(monitors) = app.available_monitors() else {
        return true;
    };
    if monitors.is_empty() {
        return true;
    }

    let left = state.x as f64;
    let top = state.y as f64;
    let right = left + state.width as f64;
    let bottom = top + state.height as f64;

    for monitor in monitors {
        let scale = monitor.scale_factor();
        if !scale.is_finite() || scale <= 0.0 {
            continue;
        }

        let position = monitor.position();
        let size = monitor.size();

        let monitor_left = position.x as f64 / scale;
        let monitor_top = position.y as f64 / scale;
        let monitor_right = monitor_left + size.width as f64 / scale;
        let monitor_bottom = monitor_top + size.height as f64 / scale;

        let overlap_width = right.min(monitor_right) - left.max(monitor_left);
        let overlap_height = bottom.min(monitor_bottom) - top.max(monitor_top);
        if overlap_width > 0.0 && overlap_height > 0.0 {
            return true;
        }
    }

    false
}

fn capture_window_state(window: &tauri::Window) -> Option<DesktopWindowState> {
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    let scale = window
        .scale_factor()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(1.0);

    Some(DesktopWindowState {
        x: (position.x as f64 / scale).round() as i32,
        y: (position.y as f64 / scale).round() as i32,
        width: (size.width as f64 / scale)
            .round()
            .max(MIN_WINDOW_WIDTH as f64) as u32,
        height: (size.height as f64 / scale)
            .round()
            .max(MIN_WINDOW_HEIGHT as f64) as u32,
        maximized: window.is_maximized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
    })
}

fn schedule_window_state_persist(window: tauri::Window, immediate: bool) {
    if window.label() != "main" {
        return;
    }

    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let revision = {
        let Some(state) = app.try_state::<WindowGeometryDebounceState>() else {
            return;
        };
        let mut guard = state
            .revisions
            .lock()
            .expect("window geometry debounce mutex");
        let next = guard.get(&label).copied().unwrap_or(0).saturating_add(1);
        guard.insert(label.clone(), next);
        next
    };

    tauri::async_runtime::spawn(async move {
        if !immediate {
            tokio::time::sleep(Duration::from_millis(WINDOW_STATE_DEBOUNCE_MS)).await;
        }

        let is_latest = app
            .try_state::<WindowGeometryDebounceState>()
            .map(|state| {
                state
                    .revisions
                    .lock()
                    .map(|guard| guard.get(&label).copied() == Some(revision))
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if !is_latest {
            return;
        }

        let Some(snapshot) = capture_window_state(&window) else {
            return;
        };

        if let Err(err) = write_desktop_window_state_to_disk(&snapshot) {
            log::warn!("[desktop] failed to persist window geometry: {err}");
        }
    });
}

/// Create a new window with a unique label, pointing at the given URL.
fn create_window(
    app: &tauri::AppHandle,
    url: &str,
    local_origin: &str,
    restore_geometry: bool,
) -> Result<()> {
    let parsed = url::Url::parse(url).map_err(|err| anyhow!("Invalid URL: {err}"))?;
    let label = next_window_label();

    let init_script = build_init_script(local_origin);

    // Store the init script and local origin so new windows and page reloads can reuse it.
    if let Some(state) = app.try_state::<DesktopUiInjectionState>() {
        *state.script.lock().expect("desktop ui injection mutex") = Some(init_script.clone());
        *state
            .local_origin
            .lock()
            .expect("desktop local origin mutex") = Some(local_origin.to_string());
    }

    let restored_state = if restore_geometry {
        read_desktop_window_state_from_disk()
    } else {
        None
    };

    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed))
        .title("OpenChamber")
        .inner_size(1280.0, 800.0)
        .min_inner_size(MIN_WINDOW_WIDTH as f64, MIN_WINDOW_HEIGHT as f64)
        .decorations(true)
        .visible(false)
        .initialization_script(&init_script)
        .background_throttling(BackgroundThrottlingPolicy::Disabled);

    let apply_restored_state = restored_state
        .as_ref()
        .map(|state| is_window_state_visible(app, state))
        .unwrap_or(false);

    if let Some(state) = restored_state.as_ref().filter(|_| apply_restored_state) {
        let restored_width = state.width.max(MIN_RESTORE_WINDOW_WIDTH);
        let restored_height = state.height.max(MIN_RESTORE_WINDOW_HEIGHT);
        builder = builder
            .inner_size(restored_width as f64, restored_height as f64)
            .position(state.x as f64, state.y as f64);
    }

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .hidden_title(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .traffic_light_position(tauri::Position::Logical(tauri::LogicalPosition {
                x: 17.0,
                y: 26.0,
            }));
    }

    let window = builder.build()?;

    if let Some(state) = restored_state.as_ref().filter(|_| apply_restored_state) {
        if state.maximized || state.fullscreen {
            let _ = window.maximize();
        }
    }

    let _ = window.show();
    let _ = window.set_focus();

    Ok(())
}

/// Open a new window pointed at the default host (local or configured default).
///
/// Known multi-window limitations (acceptable for v1):
///
/// - **localStorage conflicts**: Windows sharing the same origin (e.g. both on local)
///   share `localStorage`. Zustand `persist` middleware writes full state blobs on every
///   change with no cross-tab sync, so concurrent windows can overwrite each other's
///   persisted UI preferences, session selections, and model/agent choices.
///   Server-side data is unaffected. Scoping storage keys per window or adding
///   `storage` event listeners would fix this in a future iteration.
///
/// - **Duplicate SSE connections**: Each window opens its own SSE connection to
///   `/api/global/event`, resulting in N connections for N windows. Each window
///   independently processes all events and may show duplicate toast notifications.
///   A SharedWorker, BroadcastChannel leader-election, or Rust-side SSE relay
///   would consolidate this in a future iteration.
///
/// - **Startup race**: If called before the sidecar finishes starting (local_origin
///   not yet set), this function silently bails with a log warning. The user sees
///   no feedback from clicking the dock icon during the startup window (~0-20s).
fn open_new_window(app: &tauri::AppHandle) {
    let local_origin = app
        .try_state::<DesktopUiInjectionState>()
        .and_then(|state| {
            state
                .local_origin
                .lock()
                .expect("desktop local origin mutex")
                .clone()
        });

    let Some(local_origin) = local_origin else {
        log::warn!("[desktop] cannot open new window: local origin not yet known (sidecar may still be starting)");
        return;
    };

    // Resolve the URL the same way as initial setup: default host or local.
    let local_url = app
        .try_state::<SidecarState>()
        .and_then(|state| state.url.lock().expect("sidecar url mutex").clone())
        .unwrap_or_else(|| local_origin.clone());

    let local_ui_url = if cfg!(debug_assertions) {
        // In dev mode, prefer the Vite dev server if it was used as local origin.
        local_origin.clone()
    } else {
        local_url.clone()
    };

    let mut target_url = local_ui_url.clone();

    let cfg = read_desktop_hosts_config_from_disk();
    if let Some(default_id) = cfg.default_host_id {
        if default_id == LOCAL_HOST_ID {
            target_url = local_ui_url.clone();
        } else if let Some(host) = cfg.hosts.into_iter().find(|h| h.id == default_id) {
            target_url = host.url;
        }
    }

    // If this host was previously probed unreachable (e.g. at startup), fall back to local.
    if target_url != local_ui_url {
        let is_cached_unreachable = app
            .try_state::<DesktopUiInjectionState>()
            .map(|state| {
                state
                    .unreachable_hosts
                    .lock()
                    .expect("unreachable hosts mutex")
                    .contains(&target_url)
            })
            .unwrap_or(false);

        if is_cached_unreachable {
            log::info!(
                "[desktop] new window: default host ({}) cached as unreachable, using local",
                target_url
            );
            target_url = local_ui_url;
        }
    }

    if let Err(err) = create_window(app, &target_url, &local_origin, false) {
        log::error!("[desktop] failed to create new window: {err}");
    }
}

fn main() {
    let log_builder = tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .clear_targets()
        .targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
        ]);

    let builder = tauri::Builder::default()
        .manage(SidecarState::default())
        .manage(DesktopUiInjectionState::default())
        .manage(WindowFocusState::default())
        .manage(WindowGeometryDebounceState::default())
        .manage(MenuRuntimeState::default())
        .manage(DesktopSshManagerState::default())
        .manage(PendingUpdate(Mutex::new(None)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(log_builder.build())
        .on_page_load(|window, _payload| {
            if let Some(state) = window.app_handle().try_state::<DesktopUiInjectionState>() {
                if let Ok(guard) = state.script.lock() {
                    if let Some(script) = guard.as_ref() {
                        let _ = window.eval(script);
                    }
                }
            }
        })
        .menu(|app| {
            #[cfg(target_os = "macos")]
            {
                build_macos_menu(app)
            }

            #[cfg(not(target_os = "macos"))]
            {
                tauri::menu::Menu::default(app)
            }
        })
        .on_menu_event(|app, event| {
            #[cfg(target_os = "macos")]
            {
                let id = event.id().as_ref();

                log::info!("[menu] click id={}", id);

                #[cfg(debug_assertions)]
                {
                    let msg = serde_json::to_string(id).unwrap_or_else(|_| "\"(unserializable)\"".into());
                    eval_in_focused_window(app, &format!("console.log('[menu] id=', {});", msg));
                }

                if id == MENU_ITEM_NEW_WINDOW_ID {
                    open_new_window(app);
                    return;
                }

                if id == MENU_ITEM_CHECK_FOR_UPDATES_ID {
                    dispatch_check_for_updates(app);
                    return;
                }

                if id == MENU_ITEM_REPORT_BUG_ID {
                    use tauri_plugin_shell::ShellExt;
                    #[allow(deprecated)]
                    {
                        let _ = app.shell().open(GITHUB_BUG_REPORT_URL, None);
                    }
                    return;
                }

                if id == MENU_ITEM_REQUEST_FEATURE_ID {
                    use tauri_plugin_shell::ShellExt;
                    #[allow(deprecated)]
                    {
                        let _ = app.shell().open(GITHUB_FEATURE_REQUEST_URL, None);
                    }
                    return;
                }

                if id == MENU_ITEM_JOIN_DISCORD_ID {
                    use tauri_plugin_shell::ShellExt;
                    #[allow(deprecated)]
                    {
                        let _ = app.shell().open(DISCORD_INVITE_URL, None);
                    }
                    return;
                }

                if id == MENU_ITEM_ABOUT_ID {
                    dispatch_menu_action(app, "about");
                    return;
                }
                if id == MENU_ITEM_SETTINGS_ID {
                    dispatch_menu_action(app, "settings");
                    return;
                }
                if id == MENU_ITEM_COMMAND_PALETTE_ID {
                    dispatch_menu_action(app, "command-palette");
                    return;
                }

                if id == MENU_ITEM_NEW_SESSION_ID {
                    dispatch_menu_action(app, "new-session");
                    return;
                }
                if id == MENU_ITEM_WORKTREE_CREATOR_ID {
                    dispatch_menu_action(app, "new-worktree-session");
                    return;
                }
                if id == MENU_ITEM_CHANGE_WORKSPACE_ID {
                    dispatch_menu_action(app, "change-workspace");
                    return;
                }

                if id == MENU_ITEM_OPEN_GIT_TAB_ID {
                    dispatch_menu_action(app, "open-git-tab");
                    return;
                }
                if id == MENU_ITEM_OPEN_DIFF_TAB_ID {
                    dispatch_menu_action(app, "open-diff-tab");
                    return;
                }

                if id == MENU_ITEM_OPEN_FILES_TAB_ID {
                    dispatch_menu_action(app, "open-files-tab");
                    return;
                }
                if id == MENU_ITEM_OPEN_TERMINAL_TAB_ID {
                    dispatch_menu_action(app, "open-terminal-tab");
                    return;
                }
                if id == MENU_ITEM_COPY_ID {
                    dispatch_menu_action(app, "copy");
                    return;
                }

                if id == MENU_ITEM_THEME_LIGHT_ID {
                    dispatch_menu_action(app, "theme-light");
                    return;
                }
                if id == MENU_ITEM_THEME_DARK_ID {
                    dispatch_menu_action(app, "theme-dark");
                    return;
                }
                if id == MENU_ITEM_THEME_SYSTEM_ID {
                    dispatch_menu_action(app, "theme-system");
                    return;
                }

                if id == MENU_ITEM_TOGGLE_SIDEBAR_ID {
                    dispatch_menu_action(app, "toggle-sidebar");
                    return;
                }
                if id == MENU_ITEM_TOGGLE_MEMORY_DEBUG_ID {
                    dispatch_menu_action(app, "toggle-memory-debug");
                    return;
                }

                if id == MENU_ITEM_HELP_DIALOG_ID {
                    dispatch_menu_action(app, "help-dialog");
                    return;
                }
                if id == MENU_ITEM_DOWNLOAD_LOGS_ID {
                    dispatch_menu_action(app, "download-logs");
                    return;
                }
                if id == MENU_ITEM_CLEAR_CACHE_ID {
                    let app = app.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let _ = crate::desktop_clear_cache(app);
                    });
                    return;
                }
            }
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            let label = window.label().to_string();

            if let tauri::WindowEvent::Focused(focused) = event {
                if let Some(state) = app.try_state::<WindowFocusState>() {
                    state.set_focused(&label, *focused);
                }
            }

            if let tauri::WindowEvent::Destroyed = event {
                // Clean up focus tracking for the destroyed window.
                if let Some(state) = app.try_state::<WindowFocusState>() {
                    state.remove_window(&label);
                }

                // If this was the last window, kill the sidecar and exit.
                let remaining = app.webview_windows().len();
                if remaining == 0 {
                    if let Some(state) = app.try_state::<DesktopSshManagerState>() {
                        state.shutdown_all(&app);
                    }
                    kill_sidecar(app.clone());
                    app.exit(0);
                }
            }

            if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                schedule_window_state_persist(window.clone(), false);
            }

            if let tauri::WindowEvent::CloseRequested { .. } = event {
                schedule_window_state_persist(window.clone(), true);
            }
        })
        .invoke_handler(tauri::generate_handler![
            desktop_notify,
            desktop_check_for_updates,
            desktop_download_and_install_update,
            desktop_restart,
            desktop_new_window,
            desktop_new_window_at_url,
            desktop_set_auto_worktree_menu,
            desktop_clear_cache,
            desktop_open_path,
            desktop_filter_installed_apps,
            desktop_get_installed_apps,
            desktop_fetch_app_icons,
            desktop_hosts_get,
            desktop_hosts_set,
            desktop_host_probe,
            remote_ssh::desktop_ssh_instances_get,
            remote_ssh::desktop_ssh_instances_set,
            remote_ssh::desktop_ssh_import_hosts,
            remote_ssh::desktop_ssh_connect,
            remote_ssh::desktop_ssh_disconnect,
            remote_ssh::desktop_ssh_status,
            remote_ssh::desktop_ssh_logs,
            remote_ssh::desktop_ssh_logs_clear,
            desktop_read_file,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let local_url = if cfg!(debug_assertions) {
                    let dev_url = "http://127.0.0.1:3901".to_string();
                    if wait_for_health(&dev_url).await {
                        dev_url.to_string()
                    } else {
                        match spawn_local_server(&handle).await {
                            Ok(local) => local,
                            Err(err) => {
                                log::error!("[desktop] failed to start local server: {err}");
                                return;
                            }
                        }
                    }
                } else {
                    match spawn_local_server(&handle).await {
                        Ok(local) => local,
                        Err(err) => {
                            log::error!("[desktop] failed to start local server: {err}");
                            return;
                        }
                    }
                };

                let local_ui_url = if cfg!(debug_assertions) {
                    let vite_url = "http://127.0.0.1:5173";
                    if wait_for_health(vite_url).await {
                        vite_url.to_string()
                    } else {
                        log::warn!("[desktop] Vite dev server not ready, using local API UI at {local_url}");
                        local_url.clone()
                    }
                } else {
                    local_url.clone()
                };

                // Ensure local URL is always available to desktop commands,
                // even when we are using the Vite dev server (no sidecar child).
                if let Some(state) = handle.try_state::<SidecarState>() {
                    *state.url.lock().expect("sidecar url mutex") = Some(local_url.clone());
                }

                let local_origin = url::Url::parse(&local_ui_url)
                    .ok()
                    .map(|u| u.origin().ascii_serialization())
                    .unwrap_or_else(|| local_ui_url.clone());

                // Selected host: env override first, then desktop default host, else local.
                let env_target = std::env::var("OPENCHAMBER_SERVER_URL")
                    .ok()
                    .and_then(|raw| normalize_server_url(&raw));

                let mut initial_url = env_target.unwrap_or_else(|| local_ui_url.clone());

                if initial_url == local_ui_url {
                    let cfg = read_desktop_hosts_config_from_disk();
                    if let Some(default_id) = cfg.default_host_id {
                        if default_id == LOCAL_HOST_ID {
                            initial_url = local_ui_url.clone();
                        } else if let Some(host) = cfg.hosts.into_iter().find(|h| h.id == default_id) {
                            initial_url = host.url;
                        }
                    }
                }

                if initial_url != local_ui_url {
                    let failed_url = initial_url.clone();
                    match desktop_host_probe(initial_url.clone()).await {
                        Ok(probe) if probe.status != "unreachable" => {}
                        Ok(_) => {
                            log::warn!(
                                "[desktop] startup host unreachable ({}), falling back to local ({})",
                                initial_url,
                                local_ui_url
                            );
                            initial_url = local_ui_url.clone();
                            // Cache the failure so open_new_window skips this host.
                            if let Some(state) = handle.try_state::<DesktopUiInjectionState>() {
                                state.unreachable_hosts.lock().expect("unreachable hosts mutex").insert(failed_url);
                            }
                        }
                        Err(err) => {
                            log::warn!(
                                "[desktop] startup host probe failed ({}): {}, falling back to local ({})",
                                initial_url,
                                err,
                                local_ui_url
                            );
                            initial_url = local_ui_url.clone();
                            if let Some(state) = handle.try_state::<DesktopUiInjectionState>() {
                                state.unreachable_hosts.lock().expect("unreachable hosts mutex").insert(failed_url);
                            }
                        }
                    }
                }

                if let Err(err) = create_window(&handle, &initial_url, &local_origin, true) {
                    log::error!("[desktop] failed to create window: {err}");
                }
            });

            Ok(())
        })
        ;

    let app = builder
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application");

    app.run(|app_handle, event| {
        match event {
            tauri::RunEvent::ExitRequested { .. } => {
                // Best-effort cleanup; never block shutdown.
                if let Some(state) = app_handle.try_state::<DesktopSshManagerState>() {
                    state.shutdown_all(app_handle);
                }
                kill_sidecar(app_handle.clone());
            }
            tauri::RunEvent::Exit => {
                if let Some(state) = app_handle.try_state::<DesktopSshManagerState>() {
                    state.shutdown_all(app_handle);
                }
                kill_sidecar(app_handle.clone());
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } => {
                // macOS: clicking dock icon when no windows are open opens a new one.
                if !has_visible_windows {
                    open_new_window(app_handle);
                }
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_settings_path(test_name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        std::env::temp_dir().join(format!("openchamber-{test_name}-{nanos}-settings.json"))
    }

    #[test]
    fn sanitize_host_url_for_storage_keeps_query_params() {
        let input = "https://example.com?coder_session_token=xxxxxx";
        let sanitized = sanitize_host_url_for_storage(input).expect("sanitized url");
        assert_eq!(sanitized, "https://example.com/?coder_session_token=xxxxxx");
    }

    #[test]
    fn sanitize_host_url_for_storage_strips_fragment_and_keeps_query() {
        let input = "https://example.com/workspace?coder_session_token=xxxxxx#ignored";
        let sanitized = sanitize_host_url_for_storage(input).expect("sanitized url");
        assert_eq!(
            sanitized,
            "https://example.com/workspace?coder_session_token=xxxxxx"
        );
    }

    #[test]
    fn write_and_read_hosts_config_preserves_query_params() {
        let path = unique_settings_path("desktop-hosts-query");
        let config = DesktopHostsConfig {
            hosts: vec![DesktopHost {
                id: "remote-1".to_string(),
                label: "Remote".to_string(),
                url: "https://example.com?coder_session_token=xxxxxx".to_string(),
            }],
            default_host_id: Some("remote-1".to_string()),
        };

        write_desktop_hosts_config_to_path(&path, &config).expect("write config");
        let read_back = read_desktop_hosts_config_from_path(&path);
        let _ = fs::remove_file(&path);

        assert_eq!(read_back.hosts.len(), 1);
        assert_eq!(
            read_back.hosts[0].url,
            "https://example.com/?coder_session_token=xxxxxx"
        );
        assert_eq!(read_back.default_host_id.as_deref(), Some("remote-1"));
    }
}

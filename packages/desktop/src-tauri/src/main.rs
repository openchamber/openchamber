#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod remote_ssh;
mod settings;
mod sidecar;
mod window;
mod probe;
mod menu;
mod app_discovery;

// Re-export items needed by main() and tests
pub use settings::*;
pub use sidecar::*;
pub use window::*;
pub use probe::*;
pub use menu::*;
pub use app_discovery::*;
pub use commands::*;

use anyhow::Result;
use remote_ssh::DesktopSshManagerState;
use std::env;
use std::sync::{
        atomic::{AtomicBool, AtomicU32},
        Mutex,
    };
use tauri::Manager;

// Import necessary items from modules
use crate::sidecar::{SidecarState, spawn_local_server};
use crate::window::{DesktopUiInjectionState, WindowFocusState, WindowGeometryDebounceState, open_new_window, create_startup_window};
use crate::menu::{build_macos_menu, dispatch_menu_action, request_quit_with_confirmation};
use crate::settings::{read_desktop_hosts_config_from_disk, same_server_url, LOCAL_HOST_ID, normalize_host_url};
use crate::probe::{compute_local_startup_failure_boot_outcome, build_startup_failure_init_script, start_quit_risk_poller, wait_for_local_opencode_ready_with, resolve_boot_outcome};
use crate::window::activate_main_window;

#[cfg(target_os = "macos")]
use crate::menu::QUIT_RISK_POLL_INTERVAL;

// Quit risk tracking atomic variables
pub static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);
pub static QUIT_CONFIRMATION_PENDING: AtomicBool = AtomicBool::new(false);
pub static QUIT_RISK_POLLER_STARTED: AtomicBool = AtomicBool::new(false);
pub static QUIT_RISK_HAS_ACTIVE_TUNNEL: AtomicBool = AtomicBool::new(false);
pub static QUIT_RISK_HAS_ENABLED_SCHEDULED_TASKS: AtomicBool = AtomicBool::new(false);
pub static QUIT_RISK_HAS_RUNNING_SCHEDULED_TASKS: AtomicBool = AtomicBool::new(false);
pub static QUIT_RISK_ENABLED_SCHEDULED_TASKS_COUNT: AtomicU32 = AtomicU32::new(0);
pub static QUIT_RISK_RUNNING_SCHEDULED_TASKS_COUNT: AtomicU32 = AtomicU32::new(0);

#[cfg(not(target_os = "macos"))]
pub const QUIT_RISK_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// Recover from a poisoned mutex by extracting the inner value.
/// This prevents a single panic from cascading into an app-wide crash.
pub(crate) fn recover_mutex<'a, T>(result: Result<std::sync::MutexGuard<'a, T>, std::sync::PoisonError<std::sync::MutexGuard<'a, T>>>) -> std::sync::MutexGuard<'a, T> {
    result.unwrap_or_else(|e| e.into_inner())
}

fn main() {
    // Ensure localhost traffic never routes through a system/VPN proxy.
    for key in ["NO_PROXY", "no_proxy"] {
        let existing = env::var(key).unwrap_or_default();
        let loopback = ["127.0.0.1", "localhost", "::1"];
        let missing: Vec<&str> = loopback
            .iter()
            .filter(|addr| !existing.split(',').any(|part| part.trim() == **addr))
            .copied()
            .collect();
        if !missing.is_empty() {
            let merged = if existing.is_empty() {
                missing.join(",")
            } else {
                format!("{},{}", existing, missing.join(","))
            };
            env::set_var(key, &merged);
        }
    }

    let log_builder = tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .clear_targets()
        .targets(if cfg!(debug_assertions) {
            vec![
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
            ]
        } else {
            vec![tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::Stdout,
            )]
        });

    let builder = tauri::Builder::default()
        .manage(SidecarState::default())
        .manage(DesktopUiInjectionState::default())
        .manage(WindowFocusState::default())
        .manage(WindowGeometryDebounceState::default())
        .manage(DesktopSshManagerState::default())
        .manage(commands::PendingUpdate(Mutex::new(None)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(log_builder.build())
        .on_page_load(|window, _payload| {
            if let Some(state) = window.app_handle().try_state::<DesktopUiInjectionState>() {
                let label = window.label().to_string();
                if let Ok(guard) = state.scripts.lock() {
                    if let Some(script) = guard.get(&label) {
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
                if id == MENU_ITEM_QUICK_OPEN_ID {
                    dispatch_menu_action(app, "quick-open");
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
                        let _ = crate::commands::desktop_clear_cache(app);
                    });
                    return;
                }
                if id == MENU_ITEM_QUIT_ID {
                    request_quit_with_confirmation(app);
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
                if let Some(state) = app.try_state::<WindowFocusState>() {
                    state.remove_window(&label);
                }

                if let Some(state) = app.try_state::<DesktopUiInjectionState>() {
                    let _ = state
                        .scripts
                        .lock()
                        .map(|mut guard| guard.remove(&label));
                }
            }

            if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                schedule_window_state_persist(window.clone(), false);
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                schedule_window_state_persist(window.clone(), true);

                let remaining_visible = app
                    .webview_windows()
                    .values()
                    .filter(|w| w.is_visible().unwrap_or(false))
                    .count();

                if remaining_visible <= 1 {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            desktop_notify,
            desktop_check_for_updates,
            desktop_download_and_install_update,
            desktop_restart,
            desktop_new_window,
            desktop_new_window_at_url,
            desktop_clear_cache,
            desktop_open_path,
            desktop_open_in_app,
            desktop_filter_installed_apps,
            desktop_get_installed_apps,
            desktop_fetch_app_icons,
            desktop_save_markdown_file,
            desktop_hosts_get,
            desktop_hosts_set,
            desktop_host_probe,
            desktop_set_window_theme,
            desktop_get_lan_address,
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

            if let Err(err) = create_startup_window(&handle, true) {
                log::error!("[desktop] failed to create startup window: {err}");
            }

            tauri::async_runtime::spawn(async move {
                // Helper: inject a fallback boot outcome when local server
                // cannot start, so the UI leaves splash and shows
                // chooser/recovery instead of hanging on a white screen.
                let handle_for_fallback = handle.clone();
                let inject_startup_failure = |err: String| {
                    log::error!("[desktop] failed to start local server: {err}");
                    let cfg = read_desktop_hosts_config_from_disk();
                    let boot_outcome = compute_local_startup_failure_boot_outcome(&cfg);
                    let init_script = build_startup_failure_init_script(&boot_outcome);
                    if let Some(state) = handle_for_fallback.try_state::<DesktopUiInjectionState>()
                    {
                        let _ = state
                            .scripts
                            .lock()
                            .map(|mut guard| guard.insert("main".to_string(), init_script.clone()));
                    }
                    if let Some(window) = handle_for_fallback.get_webview_window("main") {
                        let _ = window.eval(&init_script);
                    }
                };

                let local_url = if cfg!(debug_assertions) {
                    let dev_url = "http://127.0.0.1:3901".to_string();
                    if wait_for_health(&dev_url).await {
                        dev_url.to_string()
                    } else {
                        match spawn_local_server(&handle).await {
                            Ok(local) => local,
                            Err(err) => {
                                inject_startup_failure(err.to_string());
                                return;
                            }
                        }
                    }
                } else {
                    match spawn_local_server(&handle).await {
                        Ok(local) => local,
                        Err(err) => {
                            inject_startup_failure(err.to_string());
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
                // even when we are using Vite dev server (no sidecar child).
                if let Some(state) = handle.try_state::<SidecarState>() {
                    *recover_mutex(state.url.lock()) = Some(local_url.clone());
                }
                start_quit_risk_poller(local_url.clone());

                let local_origin = url::Url::parse(&local_ui_url)
                    .ok()
                    .map(|u| u.origin().ascii_serialization())
                    .unwrap_or_else(|| local_ui_url.clone());

                // Selected host: env override first, then desktop default host, else local.
                // If env override points to local server, ignore it and use
                // config-based resolution instead.
                let env_target = std::env::var("OPENCHAMBER_SERVER_URL")
                    .ok()
                    .and_then(|raw| normalize_host_url(&raw))
                    .filter(|url| !same_server_url(url.as_str(), &local_ui_url));

                let mut initial_url = env_target.as_ref().map(|s| s.as_str()).unwrap_or(&local_ui_url).to_string();

                // Compute boot outcome and legacy-upgrade if needed.
                let cfg = read_desktop_hosts_config_from_disk();

                if env_target.is_none() {
                    if let Some(default_id) = cfg.default_host_id.as_ref().map(|s| s.as_str()) {
                        if default_id != LOCAL_HOST_ID {
                            if let Some(host) = cfg.hosts.iter().find(|h| h.id == default_id) {
                                initial_url = host.url.clone();
                            }
                        }
                    }
                }

                // If remote, probe and fall back to local if unreachable.
                // Use shared probe_with_retry policy (soft + hard).
                let final_probe: Option<HostProbeResult> = if !same_server_url(initial_url.as_str(), &local_ui_url) {
                    let result = probe_with_retry(&initial_url).await;

                    if !result.navigable {
                        log::warn!(
                            "[desktop] startup host unreachable after retries ({}), falling back to local ({})",
                            initial_url,
                            local_ui_url
                        );
                        initial_url = local_ui_url.clone();
                    }

                    result.probe
                } else {
                    None
                };

                // Probe local server to verify opencode is actually running.
                // spawn_local_server only confirms the sidecar web server responded
                // HTTP 200 — it does not check whether opencode CLI is ready.
                let local_available = match wait_for_local_opencode_ready_with(
                    &local_url,
                    LOCAL_SIDECAR_HEALTH_TIMEOUT,
                    LOCAL_SIDECAR_HEALTH_POLL_INITIAL_INTERVAL,
                    LOCAL_SIDECAR_HEALTH_POLL_MAX_INTERVAL,
                )
                .await
                {
                    Some(probe) if matches!(probe.status.as_str(), "ok" | "auth") => {
                        log::info!("[desktop] local opencode verified (status={})", probe.status);
                        true
                    }
                    Some(probe) => {
                        log::warn!(
                            "[desktop] local server up but opencode not ready (status={}), treating as unavailable",
                            probe.status
                        );
                        false
                    }
                    None => {
                        log::warn!("[desktop] local opencode probe failed, treating as unavailable");
                        false
                    }
                };

                let boot_outcome = resolve_boot_outcome(
                    &cfg,
                    final_probe.as_ref(),
                    local_available,
                    env_target.as_ref().map(|s| s.as_str()),
                );

                if let Err(err) = activate_main_window(
                    &handle,
                    &initial_url,
                    &local_origin,
                    Some(&boot_outcome),
                ) {
                    log::error!("[desktop] failed to activate main window: {err}");
                }
            });

            Ok(())
        })
        ;

    let app = builder
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application");

    install_macos_quit_confirmation_hook();

    app.run(|app_handle, event| {
        match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                use std::sync::atomic::Ordering;
                if !QUIT_CONFIRMED.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    #[cfg(target_os = "macos")]
                    request_quit_with_confirmation(app_handle);
                    return;
                }
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
                if !has_visible_windows {
                    let windows = app_handle.webview_windows();
                    let hidden = windows
                        .values()
                        .find(|w| !w.is_visible().unwrap_or(true));
                    if let Some(w) = hidden {
                        let _ = w.show();
                        let _ = w.set_focus();
                    } else {
                        drop(windows);
                        open_new_window(app_handle);
                    }
                }
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
            initial_host_choice_completed: false,
        };

        write_desktop_hosts_config_to_path(&path, &config).expect("write config");
        let read_back = read_desktop_hosts_config_from_path(&path);
        let _ = fs::remove_file(&path);

        assert_eq!(read_back.hosts.len(), 1);
        assert_eq!(
            read_back.hosts[0].url,
            "https://example.com/?coder_session_token=xxxxxx"
        );
        assert_eq!(read_back.default_host_id.as_ref().map(|s| s.as_str()), Some("remote-1"));
    }

    #[test]
    fn read_hosts_config_defaults_initial_choice_flag_to_false() {
        let path = unique_settings_path("desktop-hosts-default-flag");
        std::fs::write(&path, r#"{"desktopHosts":[],"desktopDefaultHostId":null}"#).unwrap();

        let cfg = read_desktop_hosts_config_from_path(&path);
        let _ = fs::remove_file(&path);
        assert_eq!(cfg.initial_host_choice_completed, false);
    }

    #[test]
    fn write_and_read_hosts_config_preserves_initial_choice_flag() {
        let path = unique_settings_path("desktop-hosts-preserve-flag");
        let cfg = DesktopHostsConfig {
            hosts: vec![],
            default_host_id: Some(LOCAL_HOST_ID.to_string()),
            initial_host_choice_completed: true,
        };

        write_desktop_hosts_config_to_path(&path, &cfg).unwrap();
        let reread = read_desktop_hosts_config_from_path(&path);
        let _ = fs::remove_file(&path);

        assert_eq!(reread.default_host_id.as_ref().map(|s| s.as_str()), Some(LOCAL_HOST_ID));
        assert!(reread.initial_host_choice_completed);
    }

    #[test]
    fn omitted_initial_choice_flag_preserves_stored_true() {
        let path = unique_settings_path("desktop-hosts-omit-preserves");

        // Seed: write config with initialHostChoiceCompleted = true
        let seed = DesktopHostsConfig {
            hosts: vec![DesktopHost {
                id: "remote-1".to_string(),
                label: "Remote".to_string(),
                url: "https://example.com".to_string(),
            }],
            default_host_id: Some("remote-1".to_string()),
            initial_host_choice_completed: true,
        };
        write_desktop_hosts_config_to_path(&path, &seed).unwrap();

        // Call production merge-and-write path with omitted field
        let input = DesktopHostsConfigInput {
            hosts: vec![],
            default_host_id: Some("local".to_string()),
            initial_host_choice_completed: None,
        };
        write_desktop_hosts_config_input_to_path(&path, &input).unwrap();

        let reread = read_desktop_hosts_config_from_path(&path);
        let _ = fs::remove_file(&path);

        // The stored true must be preserved, not reset to false
        assert!(reread.initial_host_choice_completed);
    }

    // --- Task 2: probe validation tests ---

    /// Spawn a tiny HTTP server on a random port that responds with `status_code`
    /// and `body`. Returns the base URL (e.g. `http://127.0.0.1:{port}`).
    async fn spawn_test_http_server(status_code: u16, body: &str) -> String {
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind test server");
        let port = listener.local_addr().unwrap().port();
        let body_owned = body.to_string();

        tokio::spawn(async move {
            loop {
                let (mut stream, _) = tokio::select! {
                    res = listener.accept() => { res.expect("accept") }
                    else => break,
                };
                use tokio::io::AsyncWriteExt;
                let response = format!(
                    "HTTP/1.1 {status_code} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body_owned}",
                    body_owned.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });

        format!("http://127.0.0.1:{port}")
    }

    #[tokio::test]
    async fn probe_returns_wrong_service_for_generic_http_200_health() {
        let url = spawn_test_http_server(200, r#"{"status":"ok","uptime":42}"#).await;
        // Give the server a moment to start listening
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let result = probe_host_with_timeout(&url, Duration::from_secs(2))
            .await
            .expect("probe should not error");
        assert_eq!(result.status, "wrong-service");
    }

    #[tokio::test]
    async fn probe_returns_ok_for_valid_openchamber_health_payload() {
        let url = spawn_test_http_server(200, r#"{"openCodeRunning":true}"#).await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let result = probe_host_with_timeout(&url, Duration::from_secs(2))
            .await
            .expect("probe should not error");
        assert_eq!(result.status, "ok");
    }

    #[tokio::test]
    async fn probe_returns_auth_for_401_health() {
        let url = spawn_test_http_server(401, r#"{"message":"unauthorized"}"#).await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let result = probe_host_with_timeout(&url, Duration::from_secs(2))
            .await
            .expect("probe should not error");
        assert_eq!(result.status, "auth");
    }

    async fn spawn_flaky_openchamber_health_server() -> String {
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind flaky test server");
        let port = listener.local_addr().unwrap().port();
        let request_count = Arc::new(AtomicUsize::new(0));

        tokio::spawn({
            let request_count = Arc::clone(&request_count);
            async move {
                loop {
                    let (mut stream, _) = tokio::select! {
                        res = listener.accept() => { res.expect("accept") }
                        else => break,
                    };

                    let count = request_count.fetch_add(1, Ordering::SeqCst);
                    let body = if count == 0 {
                        r#"{"status":"ok","openCodeRunning":false,"isOpenCodeReady":false}"#
                    } else {
                        r#"{"status":"ok","openCodeRunning":true,"isOpenCodeReady":true}"#
                    };

                    use tokio::io::AsyncWriteExt;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                }
            }
        });

        format!("http://127.0.0.1:{port}")
    }

    #[tokio::test]
    async fn wait_for_local_opencode_ready_retries_until_health_payload_is_ready() {
        let url = spawn_flaky_openchamber_health_server().await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let result = wait_for_local_opencode_ready_with(
            &url,
            Duration::from_millis(200),
            Duration::from_millis(10),
            Duration::from_millis(20),
        )
        .await
        .expect("probe result");

        assert_eq!(result.status, "ok");
    }

    #[tokio::test]
    async fn wait_for_local_opencode_ready_returns_last_probe_when_server_never_becomes_ready() {
        let url = spawn_test_http_server(
            200,
            r#"{"status":"ok","openCodeRunning":false,"isOpenCodeReady":false}"#,
        )
        .await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let result = wait_for_local_opencode_ready_with(
            &url,
            Duration::from_millis(120),
            Duration::from_millis(10),
            Duration::from_millis(20),
        )
        .await
        .expect("probe result");

        assert_eq!(result.status, "wrong-service");
    }

    // --- Task 3: boot outcome resolution tests ---

    fn make_config(
        hosts: Vec<(&str, &str, &str)>,
        default_host_id: Option<&str>,
        initial_host_choice_completed: bool,
    ) -> DesktopHostsConfig {
        DesktopHostsConfig {
            hosts: hosts
                .into_iter()
                .map(|(id, label, url)| DesktopHost {
                    id: id.to_string(),
                    label: label.to_string(),
                    url: url.to_string(),
                })
                .collect(),
            default_host_id: default_host_id.map(|s| s.to_string()),
            initial_host_choice_completed,
        }
    }

    #[test]
    fn resolve_boot_outcome_returns_first_launch_when_no_default_and_choice_not_completed() {
        let cfg = make_config(vec![], None, false);
        let probe: Option<&HostProbeResult> = None;
        let outcome = resolve_boot_outcome(&cfg, probe, true, None);
        assert_eq!(outcome.target, None);
        assert_eq!(outcome.status, "not-configured");
    }

    #[test]
    fn resolve_boot_outcome_returns_recovery_no_default_host_when_choice_completed_but_default_missing() {
        let cfg = make_config(
            vec![("remote-a", "Remote A", "https://a.test")],
            None,
            true,
        );
        let probe: Option<&HostProbeResult> = None;
        let outcome = resolve_boot_outcome(&cfg, probe, true, None);
        assert_eq!(outcome.target, None);
        assert_eq!(outcome.status, "not-configured");
    }

    #[test]
    fn resolve_boot_outcome_returns_recovery_missing_default_host_when_default_id_has_no_matching_host() {
        let cfg = make_config(vec![], Some("gone-1"), true);
        let probe: Option<&HostProbeResult> = None;
        let outcome = resolve_boot_outcome(&cfg, probe, true, None);
        assert_eq!(outcome.target, Some("remote".to_string()));
        assert_eq!(outcome.status, "missing");
        assert_eq!(outcome.host_id.as_ref().map(|s| s.as_str()), Some("gone-1"));
    }

    #[test]
    fn resolve_boot_outcome_returns_main_local_when_default_is_local_and_available() {
        let cfg = make_config(vec![], Some("local"), true);
        let probe: Option<&HostProbeResult> = None;
        let outcome = resolve_boot_outcome(&cfg, probe, true, None);
        assert_eq!(outcome.target, Some("local".to_string()));
        assert_eq!(outcome.status, "ok");
    }

    #[test]
    fn resolve_boot_outcome_returns_recovery_local_unavailable_when_local_is_default_but_unavailable() {
        let cfg = make_config(vec![], Some("local"), true);
        let probe: Option<&HostProbeResult> = None;
        let outcome = resolve_boot_outcome(&cfg, probe, false, None);
        assert_eq!(outcome.target, Some("local".to_string()));
        assert_eq!(outcome.status, "unreachable");
    }

    #[test]
    fn resolve_boot_outcome_returns_main_remote_when_probe_is_ok() {
        let cfg = make_config(
            vec![("remote-a", "Remote A", "https://a.test")],
            Some("remote-a"),
            true,
        );
        let probe = HostProbeResult {
            status: "ok".to_string(),
            latency_ms: 10,
        };
        let outcome = resolve_boot_outcome(&cfg, Some(&probe), true, None);
        assert_eq!(outcome.target, Some("remote".to_string()));
        assert_eq!(outcome.status, "ok");
        assert_eq!(outcome.host_id.as_ref().map(|s| s.as_str()), Some("remote-a"));
        assert_eq!(outcome.url.as_ref().map(|s| s.as_str()), Some("https://a.test"));
    }

    #[test]
    fn resolve_boot_outcome_returns_main_remote_when_probe_is_auth() {
        let cfg = make_config(
            vec![("remote-a", "Remote A", "https://a.test")],
            Some("remote-a"),
            true,
        );
        let probe = HostProbeResult {
            status: "auth".to_string(),
            latency_ms: 10,
        };
        let outcome = resolve_boot_outcome(&cfg, Some(&probe), true, None);
        assert_eq!(outcome.target, Some("remote".to_string()));
        assert_eq!(outcome.status, "ok");
    }

    #[test]
    fn resolve_boot_outcome_returns_recovery_remote_unreachable_when_probe_fails() {
        let cfg = make_config(
            vec![("remote-a", "Remote A", "https://a.test")],
            Some("remote-a"),
            true,
        );
        let probe = HostProbeResult {
            status: "unreachable".to_string(),
            latency_ms: 2000,
        };
        let outcome = resolve_boot_outcome(&cfg, Some(&probe), true, None);
        assert_eq!(outcome.target, Some("remote".to_string()));
        assert_eq!(outcome.status, "unreachable");
        assert_eq!(outcome.host_id.as_ref().map(|s| s.as_str()), Some("remote-a"));
    }

    #[test]
    fn resolve_boot_outcome_no_probe_but_remote_default_returns_unreachable() {
        // Remote default but no probe result yet — treat as unreachable
        // (probe hasn't happened yet, but user has already chosen a remote)
        let cfg = make_config(
            vec![("remote-a", "Remote A", "https://a.test")],
            Some("remote-a"),
            false,
        );
        let probe: Option<&HostProbeResult> = None;
        let outcome = resolve_boot_outcome(&cfg, probe, true, None);
        assert_eq!(outcome.target, Some("remote".to_string()));
        assert_eq!(outcome.status, "unreachable");
        assert_eq!(outcome.host_id.as_ref().map(|s| s.as_str()), Some("remote-a"));
    }

    // --- Startup failure fallback boot outcome tests ---

    #[test]
    fn startup_failure_returns_recovery_local_unavailable_when_default_is_local() {
        let cfg = make_config(vec![], Some("local"), true);
        let outcome = compute_local_startup_failure_boot_outcome(&cfg);
        assert_eq!(outcome.target, Some("local".to_string()));
        assert_eq!(outcome.status, "unreachable");
    }

    #[test]
    fn startup_failure_returns_first_launch_when_no_default_and_choice_not_completed() {
        let cfg = make_config(vec![], None, false);
        let outcome = compute_local_startup_failure_boot_outcome(&cfg);
        assert_eq!(outcome.target, None);
        assert_eq!(outcome.status, "not-configured");
    }

    #[test]
    fn startup_failure_returns_recovery_no_default_host_when_choice_completed_but_no_default() {
        let cfg = make_config(vec![], None, true);
        let outcome = compute_local_startup_failure_boot_outcome(&cfg);
        assert_eq!(outcome.target, None);
        assert_eq!(outcome.status, "not-configured");
    }

    #[test]
    fn startup_failure_never_returns_main_outcome() {
        // When the local server fails to start, the fallback outcome must
        // never be a "main-*" variant because the startup-failure path
        // only injects globals into the already-open startup window — it
        // does NOT navigate to a remote URL. A "main-*" outcome would
        // gate splash dismissal on initialization and hang.
        let cfg = make_config(vec![], None, false);
        let outcome = compute_local_startup_failure_boot_outcome(&cfg);
        assert!(
            outcome.status != "ok",
            "startup failure fallback must not return main-* outcome, got: {:?}",
            outcome
        );
    }

    #[test]
    fn startup_failure_init_script_contains_boot_outcome_json() {
        let cfg = make_config(vec![], Some("local"), true);
        let outcome = compute_local_startup_failure_boot_outcome(&cfg);
        let script = build_startup_failure_init_script(&outcome);
        // The script must contain the serialized boot outcome JSON.
        assert!(
            script.contains(r#""target":"local""#) && script.contains(r#""status":"unreachable""#),
            "init script should embed the structured boot outcome"
        );
        // It must also set __OPENCHAMBER_DESKTOP_BOOT_OUTCOME__
        assert!(
            script.contains("__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__"),
            "init script must set __OPENCHAMBER_DESKTOP_BOOT_OUTCOME__"
        );
    }
}

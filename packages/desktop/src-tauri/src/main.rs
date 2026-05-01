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
    net::{TcpListener, UdpSocket},
    process::Command,
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Disable pinch-to-zoom / magnification gestures on macOS to avoid accidental
/// zoom and the continuous gesture event processing overhead.
#[cfg(target_os = "macos")]
fn disable_pinch_zoom(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        use objc2::rc::Retained;
        use objc2_web_kit::WKWebView;
        let wk_webview: Retained<WKWebView> =
            Retained::retain(webview.inner().cast()).unwrap();
        wk_webview.setAllowsMagnification(false);
    });
}

#[cfg(not(target_os = "macos"))]
fn disable_pinch_zoom(_window: &tauri::WebviewWindow) {}

/// Global counter for generating unique window labels.
static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_window_label<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> String {
    loop {
        let n = WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed);
        let candidate = if n == 1 {
            "main".to_string()
        } else {
            format!("main-{n}")
        };

        if !app.webview_windows().contains_key(&candidate) {
            return candidate;
        }
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
const MENU_ITEM_QUIT_ID: &str = "menu_quit";

#[cfg(target_os = "macos")]
const GITHUB_BUG_REPORT_URL: &str =
    "https://github.com/btriapitsyn/openchamber/issues/new?template=bug_report.yml";
#[cfg(target_os = "macos")]
const GITHUB_FEATURE_REQUEST_URL: &str =
    "https://github.com/btriapitsyn/openchamber/issues/new?template=feature_request.yml";
#[cfg(target_os = "macos")]
const DISCORD_INVITE_URL: &str = "https://discord.gg/ZYRSdnwwKA";

static QUIT_CONFIRMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static QUIT_CONFIRMATION_PENDING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static QUIT_RISK_HAS_ENABLED_SCHEDULED_TASKS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static QUIT_RISK_HAS_RUNNING_SCHEDULED_TASKS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static QUIT_RISK_ENABLED_SCHEDULED_TASKS_COUNT: AtomicU32 = AtomicU32::new(0);
static QUIT_RISK_RUNNING_SCHEDULED_TASKS_COUNT: AtomicU32 = AtomicU32::new(0);
static QUIT_RISK_HAS_ACTIVE_TUNNEL: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static QUIT_RISK_POLLER_STARTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "macos")]
const QUIT_RISK_POLL_INTERVAL: Duration = Duration::from_secs(5);

#[cfg(target_os = "macos")]
fn should_require_quit_confirmation() -> bool {
    use std::sync::atomic::Ordering;

    QUIT_RISK_HAS_ACTIVE_TUNNEL.load(Ordering::Relaxed)
        || QUIT_RISK_HAS_RUNNING_SCHEDULED_TASKS.load(Ordering::Relaxed)
        || QUIT_RISK_HAS_ENABLED_SCHEDULED_TASKS.load(Ordering::Relaxed)
}

#[cfg(target_os = "macos")]
fn quit_confirmation_message() -> String {
    use std::sync::atomic::Ordering;

    let has_active_tunnel = QUIT_RISK_HAS_ACTIVE_TUNNEL.load(Ordering::Relaxed);
    let running_tasks_count = QUIT_RISK_RUNNING_SCHEDULED_TASKS_COUNT.load(Ordering::Relaxed);
    let enabled_tasks_count = QUIT_RISK_ENABLED_SCHEDULED_TASKS_COUNT.load(Ordering::Relaxed);

    let mut reasons: Vec<String> = Vec::new();
    if has_active_tunnel {
        reasons.push("an active tunnel".to_string());
    }
    if running_tasks_count > 0 {
        reasons.push(format!(
            "{} running scheduled task{}",
            running_tasks_count,
            if running_tasks_count == 1 { "" } else { "s" }
        ));
    }
    if enabled_tasks_count > 0 {
        reasons.push(format!(
            "{} enabled scheduled task{}",
            enabled_tasks_count,
            if enabled_tasks_count == 1 { "" } else { "s" }
        ));
    }

    if reasons.is_empty() {
        "Background processes (sidecar, SSH sessions) will be stopped.".to_string()
    } else {
        format!(
            "OpenChamber detected {}. Quitting now will stop sidecar/background processes and may interrupt pending work.",
            reasons.join(", ")
        )
    }
}

#[cfg(target_os = "macos")]
const NS_TERMINATE_CANCEL: isize = 0;
#[cfg(target_os = "macos")]
const NS_TERMINATE_NOW: isize = 1;

#[cfg(target_os = "macos")]
unsafe extern "C-unwind" fn application_should_terminate_with_confirmation(
    _: &objc2::runtime::AnyObject,
    _: objc2::runtime::Sel,
    _: *mut std::ffi::c_void,
) -> isize {
    use std::sync::atomic::Ordering;

    if QUIT_CONFIRMED.load(Ordering::SeqCst) {
        return NS_TERMINATE_NOW;
    }

    if !should_require_quit_confirmation() {
        QUIT_CONFIRMED.store(true, Ordering::SeqCst);
        return NS_TERMINATE_NOW;
    }

    if QUIT_CONFIRMATION_PENDING.swap(true, Ordering::SeqCst) {
        return NS_TERMINATE_CANCEL;
    }

    let message = quit_confirmation_message();
    let confirmed = matches!(
        rfd::MessageDialog::new()
            .set_title("Quit OpenChamber?")
            .set_description(&message)
            .set_level(rfd::MessageLevel::Warning)
            .set_buttons(rfd::MessageButtons::OkCancel)
            .show(),
        rfd::MessageDialogResult::Ok | rfd::MessageDialogResult::Yes
    );

    QUIT_CONFIRMATION_PENDING.store(false, Ordering::SeqCst);

    if confirmed {
        QUIT_CONFIRMED.store(true, Ordering::SeqCst);
        NS_TERMINATE_NOW
    } else {
        NS_TERMINATE_CANCEL
    }
}

#[cfg(target_os = "macos")]
fn install_macos_quit_confirmation_hook() {
    use objc2::ffi;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use std::ffi::CStr;

    unsafe {
        let Some(delegate_class) = AnyClass::get(CStr::from_bytes_with_nul_unchecked(
            b"TaoAppDelegateParent\0",
        )) else {
            log::warn!("[desktop] TaoAppDelegateParent class not found; dock Quit confirmation hook skipped");
            return;
        };

        let selector = Sel::register(c"applicationShouldTerminate:");
        if !ffi::class_getInstanceMethod(delegate_class, selector).is_null() {
            return;
        }

        let imp: Imp = std::mem::transmute(
            application_should_terminate_with_confirmation
                as unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut std::ffi::c_void) -> isize,
        );

        let added = ffi::class_addMethod(
            delegate_class as *const _ as *mut _,
            selector,
            imp,
            b"q@:@\0".as_ptr().cast(),
        );

        if !added.as_bool() {
            log::warn!("[desktop] failed to install applicationShouldTerminate hook");
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn install_macos_quit_confirmation_hook() {}

#[cfg(target_os = "macos")]
fn request_quit_with_confirmation(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

    if !should_require_quit_confirmation() {
        QUIT_CONFIRMED.store(true, Ordering::SeqCst);
        app.exit(0);
        return;
    }

    if QUIT_CONFIRMATION_PENDING.swap(true, Ordering::SeqCst) {
        return;
    }

    // When app has only hidden windows (common after closing last window),
    // ensure at least one window is visible so native dialog reliably appears.
    let windows = app.webview_windows();
    let has_visible = windows.values().any(|w| w.is_visible().unwrap_or(false));
    if !has_visible {
        if let Some(hidden) = windows.values().find(|w| !w.is_visible().unwrap_or(true)) {
            let _ = hidden.show();
            let _ = hidden.set_focus();
        }
    }

    let message = quit_confirmation_message();
    let handle = app.clone();
    app.dialog()
        .message(message)
        .title("Quit OpenChamber?")
        .buttons(MessageDialogButtons::OkCancel)
        .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
        .show(move |confirmed| {
            QUIT_CONFIRMATION_PENDING.store(false, Ordering::SeqCst);
            if confirmed {
                QUIT_CONFIRMED.store(true, Ordering::SeqCst);
                handle.exit(0);
            }
        });
}

#[cfg(target_os = "macos")]
fn build_macos_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{
        Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
    };

    let pkg_info = app.package_info();

    let new_session_shortcut = "Cmd+N";
    let new_worktree_shortcut = "Cmd+Shift+N";

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
        Some("Cmd+P"),
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
        Some("CmdOrCtrl+Shift+D"),
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
                    &MenuItem::with_id(
                        app,
                        MENU_ITEM_QUIT_ID,
                        format!("Quit {}", pkg_info.name),
                        true,
                        Some("Cmd+Q"),
                    )?,
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

#[cfg(target_os = "macos")]
#[derive(Clone)]
struct OpenCommandSpec {
    program: &'static str,
    args: Vec<String>,
}

#[cfg(target_os = "macos")]
fn run_open_command_chain(specs: &[OpenCommandSpec]) -> Result<(), String> {
    let mut failures: Vec<String> = Vec::new();

    for spec in specs {
        match Command::new(spec.program).args(&spec.args).status() {
            Ok(status) if status.success() => return Ok(()),
            Ok(status) => failures.push(format!(
                "{} {} exited with status {}",
                spec.program,
                spec.args.join(" "),
                status
            )),
            Err(error) => failures.push(format!(
                "{} {} failed: {}",
                spec.program,
                spec.args.join(" "),
                error
            )),
        }
    }

    if failures.is_empty() {
        return Err("No launch strategies available".to_string());
    }

    Err(failures.join("; "))
}

#[cfg(target_os = "macos")]
fn is_jetbrains_app_id(app_id: &str) -> bool {
    matches!(
        app_id,
        "pycharm"
            | "intellij"
            | "webstorm"
            | "phpstorm"
            | "rider"
            | "rustrover"
            | "android-studio"
    )
}

#[cfg(target_os = "macos")]
fn cli_for_app_id(app_id: &str) -> Option<&'static str> {
    match app_id {
        "vscode" => Some("code"),
        "cursor" => Some("cursor"),
        "vscodium" => Some("codium"),
        "windsurf" => Some("windsurf"),
        "zed" => Some("zed"),
        _ => None,
    }
}

#[tauri::command]
fn desktop_open_in_app(
    project_path: String,
    app_id: String,
    app_name: String,
    file_path: Option<String>,
) -> Result<(), String> {
    let trimmed_project_path = project_path.trim();
    if trimmed_project_path.is_empty() {
        return Err("Project path is required".to_string());
    }

    let trimmed_app_id = app_id.trim().to_lowercase();
    if trimmed_app_id.is_empty() {
        return Err("App id is required".to_string());
    }

    let trimmed_app_name = app_name.trim();
    if trimmed_app_name.is_empty() {
        return Err("App name is required".to_string());
    }

    let normalized_file_path = file_path
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    #[cfg(target_os = "macos")]
    {
        let project = trimmed_project_path.to_string();
        let app_name_owned = trimmed_app_name.to_string();
        let file = normalized_file_path.map(|value| value.to_string());
        let mut specs: Vec<OpenCommandSpec> = Vec::new();

        if trimmed_app_id == "finder" {
            specs.push(OpenCommandSpec {
                program: "open",
                args: vec![project.clone()],
            });
            return run_open_command_chain(&specs);
        }

        if matches!(trimmed_app_id.as_str(), "terminal" | "iterm2" | "ghostty") {
            specs.push(OpenCommandSpec {
                program: "open",
                args: vec!["-a".to_string(), app_name_owned.clone(), project.clone()],
            });
            return run_open_command_chain(&specs);
        }

        if let Some(cli) = cli_for_app_id(trimmed_app_id.as_str()) {
            let mut cli_args = vec!["-n".to_string(), project.clone()];
            if let Some(file_path) = file.as_ref() {
                cli_args.push("-g".to_string());
                cli_args.push(file_path.clone());
            }
            specs.push(OpenCommandSpec {
                program: cli,
                args: cli_args,
            });
        }

        if is_jetbrains_app_id(trimmed_app_id.as_str()) {
            let mut args = vec![
                "-na".to_string(),
                app_name_owned.clone(),
                "--args".to_string(),
                project.clone(),
            ];
            if let Some(file_path) = file.as_ref() {
                args.push(file_path.clone());
            }
            specs.push(OpenCommandSpec {
                program: "open",
                args,
            });
        }

        if let Some(file_path) = file.as_ref() {
            specs.push(OpenCommandSpec {
                program: "open",
                args: vec![
                    "-na".to_string(),
                    app_name_owned.clone(),
                    "--args".to_string(),
                    project.clone(),
                    file_path.clone(),
                ],
            });
        }

        specs.push(OpenCommandSpec {
            program: "open",
            args: vec!["-a".to_string(), app_name_owned.clone(), project.clone()],
        });

        if let Some(file_path) = file {
            specs.push(OpenCommandSpec {
                program: "open",
                args: vec!["-a".to_string(), app_name_owned, file_path],
            });
        }

        return run_open_command_chain(&specs);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = normalized_file_path;
        Err("desktop_open_in_app is only supported on macOS".to_string())
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
const HEALTH_POLL_INITIAL_INTERVAL: Duration = Duration::from_millis(250);
const HEALTH_POLL_MAX_INTERVAL: Duration = Duration::from_millis(2000);
const LOCAL_SIDECAR_HEALTH_TIMEOUT: Duration = Duration::from_secs(8);
const LOCAL_SIDECAR_HEALTH_POLL_INITIAL_INTERVAL: Duration = Duration::from_millis(100);
const LOCAL_SIDECAR_HEALTH_POLL_MAX_INTERVAL: Duration = Duration::from_millis(1000);
const STARTUP_REMOTE_PROBE_SOFT_TIMEOUT: Duration = Duration::from_secs(2);
const STARTUP_REMOTE_PROBE_HARD_TIMEOUT: Duration = Duration::from_secs(10);

const DEFAULT_DESKTOP_PORT: u16 = 57123;
const WINDOW_STATE_DEBOUNCE_MS: u64 = 300;
const MIN_WINDOW_WIDTH: u32 = 800;
const MIN_WINDOW_HEIGHT: u32 = 520;
const MIN_RESTORE_WINDOW_WIDTH: u32 = 900;
const MIN_RESTORE_WINDOW_HEIGHT: u32 = 560;

const LOCAL_HOST_ID: &str = "local";

/// Synthetic host ID used when the boot target is forced via
/// `OPENCHAMBER_SERVER_URL` (no config-based host entry).
const ENV_OVERRIDE_HOST_ID: &str = "__env";

/// Synthetic host ID used when a window is opened at an explicit URL
/// via `desktop_new_window_at_url` (no config-based host entry).
const DIRECT_URL_HOST_ID: &str = "__direct";

/// Compare two URL strings for "same server" identity using normalized
/// origin + path. This avoids misclassification when one URL has a
/// trailing slash and the other does not (e.g. `OPENCHAMBER_SERVER_URL`
/// pointing at the local sidecar without a trailing `/`).
fn same_server_url(a: &str, b: &str) -> bool {
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

#[derive(Default)]
struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    url: Mutex<Option<String>>,
}

/// Holds per-window initialization scripts and a global local origin.
/// Each window gets its own init script (containing the correct boot outcome
/// for that window's target URL), so page reloads re-inject the right data.
#[derive(Default)]
struct DesktopUiInjectionState {
    /// Init scripts keyed by window label. Each window's script contains
    /// the correct `__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__` for that window.
    scripts: Mutex<std::collections::HashMap<String, String>>,
    /// Local origin — shared across all windows since the sidecar is global.
    local_origin: Mutex<Option<String>>,
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
    #[serde(default)]
    initial_host_choice_completed: bool,
}

/// Input type for `desktop_hosts_set`. Fields may be omitted to preserve
/// existing stored values, ensuring backward-compatible callers don't
/// accidentally reset onboarding state.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopHostsConfigInput {
    hosts: Vec<DesktopHost>,
    default_host_id: Option<String>,
    #[serde(default)]
    initial_host_choice_completed: Option<bool>,
}

/// Process-wide mutex serializing all read-modify-write operations on the
/// desktop `settings.json`.  This prevents concurrent writers (host config,
/// local port, window state, vibrancy, onboarding flag) from clobbering
/// each other's independent fields.
static SETTINGS_FILE_MUTEX: Mutex<()> = Mutex::new(());

/// Merge a partial input into an existing config, preserving fields that
/// the caller omitted (`None`). This is the single source of truth for
/// the merge semantics used by `desktop_hosts_set`.
fn merge_desktop_hosts_config(
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
fn write_desktop_hosts_config_input_to_path(path: &Path, input: &DesktopHostsConfigInput) -> Result<()> {
    let _guard = SETTINGS_FILE_MUTEX.lock().expect("desktop hosts mutex");
    let existing = read_desktop_hosts_config_from_path(path);
    let merged = merge_desktop_hosts_config(&existing, input);
    write_desktop_hosts_config_to_path(path, &merged)
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

fn read_desktop_settings_json() -> Option<serde_json::Value> {
    fs::read_to_string(settings_file_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
}

fn read_desktop_local_port_from_disk() -> Option<u16> {
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

fn write_desktop_local_port_to_disk(port: u16) -> Result<()> {
    let _guard = SETTINGS_FILE_MUTEX.lock().expect("settings file mutex");
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
    let _guard = SETTINGS_FILE_MUTEX.lock().expect("settings file mutex");
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
    root["desktopInitialHostChoiceCompleted"] =
        serde_json::Value::Bool(config.initial_host_choice_completed);

    fs::write(&path, serde_json::to_string_pretty(&root)?)?;
    Ok(())
}

// ── Boot outcome resolution ──

/// Authoritative desktop boot outcome injected into the webview as
/// `window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBootOutcome {
    target: Option<String>, // "local" | "remote" | null
    status: String,          // "ok" | "not-configured" | "unreachable" | "wrong-service" | "missing"
    #[serde(skip_serializing_if = "Option::is_none")]
    host_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

/// Probe status classification for boot resolution.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ProbeClass {
    Ok,
    Auth,
    Unreachable,
    WrongService,
    NoProbe,
}

impl ProbeClass {
    fn from_probe(probe: Option<&HostProbeResult>) -> Self {
        match probe {
            Some(p) if p.status == "ok" => ProbeClass::Ok,
            Some(p) if p.status == "auth" => ProbeClass::Auth,
            Some(p) if p.status == "wrong-service" => ProbeClass::WrongService,
            Some(_) => ProbeClass::Unreachable,
            None => ProbeClass::NoProbe,
        }
    }
}

/// Result of the shared soft+hard probe policy.
struct ProbeWithRetryResult {
    /// Whether the target is navigable (ok or auth).
    navigable: bool,
    /// The final probe result, if available.
    probe: Option<HostProbeResult>,
}

/// Shared probe policy: soft probe first, hard retry on failure.
/// Used by both startup and open_new_window for consistency.
async fn probe_with_retry(url: &str) -> ProbeWithRetryResult {
    let soft_probe =
        probe_host_with_timeout(url, STARTUP_REMOTE_PROBE_SOFT_TIMEOUT).await;

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

/// Determine the boot outcome from the desktop hosts config, optional probe
/// result, local server availability, and optional env-forced URL.
///
/// When `env_target_url` is `Some`, it overrides the config-based default
/// host selection. The returned outcome always describes the actual boot
/// target, including env-forced remotes.
///
/// This is the single source of truth for boot resolution logic. Both the
/// initial startup and `open_new_window` should delegate to this function
/// for consistency.
fn resolve_boot_outcome(
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
            // (the probe hasn't happened yet, but the user has made a choice,
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

/// Compute the boot outcome to display when the local server fails to start.
///
/// This ensures the UI leaves the splash screen and shows an appropriate
/// chooser/recovery state instead of hanging. It delegates to the existing
/// `resolve_boot_outcome` with `local_available = false` and no probe.
fn compute_local_startup_failure_boot_outcome(cfg: &DesktopHostsConfig) -> DesktopBootOutcome {
    resolve_boot_outcome(cfg, None, false, None)
}

/// Build the init script for the startup failure fallback case.
///
/// Uses an empty `local_origin` since the local server is not running;
/// the UI can fall back to `window.location.origin` when needed.
fn build_startup_failure_init_script(boot_outcome: &DesktopBootOutcome) -> String {
    build_init_script("", Some(boot_outcome))
}

#[tauri::command]
fn desktop_hosts_get() -> Result<DesktopHostsConfig, String> {
    Ok(read_desktop_hosts_config_from_disk())
}

#[tauri::command]
fn desktop_hosts_set(input: DesktopHostsConfigInput) -> Result<(), String> {
    write_desktop_hosts_config_input_to_path(&settings_file_path(), &input)
        .map_err(|err| err.to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostProbeResult {
    status: String,
    latency_ms: u64,
}

async fn probe_host_with_timeout(url: &str, timeout: Duration) -> Result<HostProbeResult, String> {
    let health = build_health_url(url).ok_or_else(|| "Invalid URL".to_string())?;
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

async fn wait_for_local_opencode_ready_with(
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
struct ScheduledTasksQuitRiskResponse {
    has_enabled_scheduled_tasks: bool,
    has_running_scheduled_tasks: bool,
    #[serde(default)]
    enabled_scheduled_tasks_count: u32,
    #[serde(default)]
    running_scheduled_tasks_count: u32,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelStatusResponse {
    active: bool,
}

#[cfg(target_os = "macos")]
async fn refresh_quit_risk_flags(local_base_url: &str) {
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
                QUIT_RISK_ENABLED_SCHEDULED_TASKS_COUNT.store(enabled_count, Ordering::Relaxed);
                QUIT_RISK_RUNNING_SCHEDULED_TASKS_COUNT.store(running_count, Ordering::Relaxed);
                QUIT_RISK_HAS_ENABLED_SCHEDULED_TASKS
                    .store(payload.has_enabled_scheduled_tasks || enabled_count > 0, Ordering::Relaxed);
                QUIT_RISK_HAS_RUNNING_SCHEDULED_TASKS
                    .store(payload.has_running_scheduled_tasks || running_count > 0, Ordering::Relaxed);
            }
        }
    }

    if let Ok(response) = tunnel_result {
        if response.status().is_success() {
            if let Ok(payload) = response.json::<TunnelStatusResponse>().await {
                QUIT_RISK_HAS_ACTIVE_TUNNEL.store(payload.active, Ordering::Relaxed);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn start_quit_risk_poller(local_base_url: String) {
    use std::sync::atomic::Ordering;

    if QUIT_RISK_POLLER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    tauri::async_runtime::spawn(async move {
        loop {
            refresh_quit_risk_flags(&local_base_url).await;
            tokio::time::sleep(QUIT_RISK_POLL_INTERVAL).await;
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn start_quit_risk_poller(_local_base_url: String) {}

/// Uses the same probe_with_retry policy as startup/new-window (soft + hard)
/// so that first-launch/recovery remote connect accepts slow-but-valid hosts.
#[tauri::command]
async fn desktop_host_probe(url: String) -> Result<HostProbeResult, String> {
    let result = probe_with_retry(&url).await;
    result
        .probe
        .ok_or_else(|| "Probe failed".to_string())
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

async fn wait_for_health(url: &str) -> bool {
    wait_for_health_with(url, HEALTH_TIMEOUT, HEALTH_POLL_INITIAL_INTERVAL, HEALTH_POLL_MAX_INTERVAL).await
}

fn kill_sidecar(app: tauri::AppHandle) {
    let Some(state) = app.try_state::<SidecarState>() else {
        return;
    };

    let sidecar_url = state.url.lock().expect("sidecar url mutex").clone();
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
                // Brief pause to let the sidecar begin its shutdown sequence.
                std::thread::sleep(Duration::from_millis(100));
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

/// Kills any stale openchamber-server processes that may be lingering from
/// previous app sessions or incomplete shutdowns. This ensures a clean
/// startup and prevents port conflicts.
fn kill_stale_sidecar_processes() {
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

    // Brief pause to let the OS clean up the processes
    std::thread::sleep(Duration::from_millis(100));
}

async fn spawn_local_server(app: &tauri::AppHandle) -> Result<String> {
    // Clean up any stale sidecar processes from previous sessions
    kill_stale_sidecar_processes();

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

    let desktop_settings = read_desktop_settings_json();

    let opencode_binary_from_settings: Option<String> = (|| {
        let value = desktop_settings.as_ref()?.get("opencodeBinary")?.as_str()?.trim();
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
/// For remote URLs (not matching local origin), probes the host and only opens
/// the window if the probe returns `ok` or `auth`. Falls back to local if the
/// remote is non-navigable. Window creation is dispatched to the main thread
/// and its result is propagated back to the caller.
#[tauri::command]
async fn desktop_new_window_at_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
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

    // If the URL is local, create the window directly.
    if same_server_url(&url, &local_origin) {
        let boot_outcome = DesktopBootOutcome {
            target: Some("local".to_string()),
            status: "ok".to_string(),
            host_id: None,
            url: None,
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let result = create_window(&handle, &url, &local_origin, Some(&boot_outcome), false)
                .map_err(|e| e.to_string());
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
        return rx.await.map_err(|_| "Window creation cancelled".to_string())?;
    }

    // Remote URL: probe with shared retry policy before opening.
    let result = probe_with_retry(&url).await;

    let (final_url, boot_outcome) = if result.navigable {
        let outcome = DesktopBootOutcome {
            target: Some("remote".to_string()),
            status: "ok".to_string(),
            host_id: Some(DIRECT_URL_HOST_ID.to_string()),
            url: Some(url.clone()),
        };
        (url, outcome)
    } else {
        log::info!(
            "[desktop] new_window_at_url: remote ({}) probe returned non-navigable status, falling back to local",
            url
        );
        let local_fallback = format!("{}/", local_origin);
        let outcome = match &result.probe {
            Some(probe) if probe.status == "wrong-service" => DesktopBootOutcome {
                target: Some("remote".to_string()),
                status: "wrong-service".to_string(),
                host_id: Some(DIRECT_URL_HOST_ID.to_string()),
                url: Some(url),
            },
            _ => DesktopBootOutcome {
                target: Some("remote".to_string()),
                status: "unreachable".to_string(),
                host_id: Some(DIRECT_URL_HOST_ID.to_string()),
                url: Some(url),
            },
        };
        (local_fallback, outcome)
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = create_window(&handle, &final_url, &local_origin, Some(&boot_outcome), false)
            .map_err(|e| e.to_string());
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "Window creation cancelled".to_string())?
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

#[tauri::command]
async fn desktop_save_markdown_file(
    app: tauri::AppHandle,
    default_file_name: String,
    content: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let trimmed_file_name = default_file_name.trim();
    if trimmed_file_name.is_empty() {
        return Err("Default file name is required".to_string());
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Markdown", &["md"])
        .set_file_name(trimmed_file_name)
        .save_file(move |file_path| {
            let _ = tx.send(file_path);
        });

    let Some(file_path) = rx
        .await
        .map_err(|_| "Save dialog was closed unexpectedly".to_string())?
    else {
        return Ok(None);
    };

    let path = file_path
        .into_path()
        .map_err(|_| "Selected export path is not a local filesystem path".to_string())?;

    std::fs::write(&path, content)
        .map_err(|error| format!("Failed to save exported session: {error}"))?;

    Ok(Some(path.to_string_lossy().to_string()))
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
fn build_init_script(local_origin: &str, boot_outcome: Option<&DesktopBootOutcome>) -> String {
    let home =
        std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    let macos_major = macos_major_version().unwrap_or(0);

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

fn parse_theme_override(theme_mode: Option<&str>, theme_variant: Option<&str>) -> Option<tauri::Theme> {
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

fn read_desktop_theme_override() -> Option<tauri::Theme> {
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

fn detect_desktop_lan_ipv4() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let address = socket.local_addr().ok()?;
    let ip = address.ip();

    if ip.is_loopback() {
        return None;
    }

    match ip {
        std::net::IpAddr::V4(ipv4) => Some(ipv4.to_string()),
        std::net::IpAddr::V6(_) => None,
    }
}

/// Apply platform-specific window builder configuration.
fn apply_platform_window_config<M: Manager<tauri::Wry>>(
    builder: WebviewWindowBuilder<'_, tauri::Wry, M>,
) -> WebviewWindowBuilder<'_, tauri::Wry, M> {
    #[cfg(target_os = "macos")]
    let builder = builder
        .hidden_title(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .traffic_light_position(tauri::Position::Logical(tauri::LogicalPosition {
            x: 17.0,
            y: 26.0,
        }));

    #[cfg(target_os = "windows")]
    let builder = builder.additional_browser_args(
        "--proxy-bypass-list=<-loopback> --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
    );

    builder
}

#[tauri::command]
fn desktop_set_window_theme(
    window: tauri::WebviewWindow,
    theme_mode: Option<String>,
    theme_variant: Option<String>,
) -> Result<(), String> {
    let override_theme = parse_theme_override(theme_mode.as_deref(), theme_variant.as_deref());

    window
        .set_theme(override_theme)
        .map_err(|error| format!("failed to set window theme: {error}"))?;

    Ok(())
}

#[tauri::command]
fn desktop_get_lan_address() -> Option<String> {
    detect_desktop_lan_ipv4()
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
    boot_outcome: Option<&DesktopBootOutcome>,
    restore_geometry: bool,
) -> Result<()> {
    let parsed = url::Url::parse(url).map_err(|err| anyhow!("Invalid URL: {err}"))?;
    let label = next_window_label(app);

    let init_script = build_init_script(local_origin, boot_outcome);

    // Store the init script under this window's label so page reloads
    // re-inject the correct boot outcome for this window.
    if let Some(state) = app.try_state::<DesktopUiInjectionState>() {
        state
            .scripts
            .lock()
            .expect("desktop ui injection mutex")
            .insert(label.clone(), init_script.clone());
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
        .initialization_script(&init_script);

    builder = apply_platform_window_config(builder);

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

    let window = builder.build()?;
    let _ = window.set_theme(read_desktop_theme_override());
    disable_pinch_zoom(&window);

    if let Some(state) = restored_state.as_ref().filter(|_| apply_restored_state) {
        if state.maximized || state.fullscreen {
            let _ = window.maximize();
        }
    }

    let _ = window.show();
    let _ = window.set_focus();

    Ok(())
}

fn create_startup_window(app: &tauri::AppHandle, restore_geometry: bool) -> Result<()> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }

    let restored_state = if restore_geometry {
        read_desktop_window_state_from_disk()
    } else {
        None
    };

    let splash_script = build_startup_splash_script();

    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("OpenChamber")
        .inner_size(1280.0, 800.0)
        .min_inner_size(MIN_WINDOW_WIDTH as f64, MIN_WINDOW_HEIGHT as f64)
        .decorations(true)
        .visible(true)
        .initialization_script(&splash_script);

    builder = apply_platform_window_config(builder);

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

    let window = builder.build()?;
    let _ = window.set_theme(read_desktop_theme_override());
    disable_pinch_zoom(&window);

    if let Some(state) = restored_state.as_ref().filter(|_| apply_restored_state) {
        if state.maximized || state.fullscreen {
            let _ = window.maximize();
        }
    }

    let _ = window.show();
    let _ = window.set_focus();

    Ok(())
}

fn build_startup_splash_script() -> String {
    let settings = fs::read_to_string(settings_file_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());

    let theme_mode = settings
        .as_ref()
        .and_then(|value| value.get("themeMode"))
        .and_then(|value| value.as_str())
        .and_then(|value| match value.trim() {
            "light" => Some("light"),
            "dark" => Some("dark"),
            "system" => Some("system"),
            _ => None,
        });

    let use_system_theme = settings
        .as_ref()
        .and_then(|value| value.get("useSystemTheme"))
        .and_then(|value| value.as_bool())
        .unwrap_or(true);

    let theme_variant = settings
        .as_ref()
        .and_then(|value| value.get("themeVariant"))
        .and_then(|value| value.as_str())
        .and_then(|value| match value.trim() {
            "light" => Some("light"),
            "dark" => Some("dark"),
            _ => None,
        });

    let effective_mode = theme_mode
        .or_else(|| {
            if use_system_theme {
                Some("system")
            } else {
                None
            }
        })
        .or(theme_variant)
        .unwrap_or("system");

    let splash_bg_light = settings
        .as_ref()
        .and_then(|value| value.get("splashBgLight"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    let splash_fg_light = settings
        .as_ref()
        .and_then(|value| value.get("splashFgLight"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    let splash_bg_dark = settings
        .as_ref()
        .and_then(|value| value.get("splashBgDark"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    let splash_fg_dark = settings
        .as_ref()
        .and_then(|value| value.get("splashFgDark"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("");

    let mode_json = serde_json::to_string(effective_mode).unwrap_or_else(|_| "\"system\"".into());
    let bg_light_json = serde_json::to_string(splash_bg_light).unwrap_or_else(|_| "\"\"".into());
    let fg_light_json = serde_json::to_string(splash_fg_light).unwrap_or_else(|_| "\"\"".into());
    let bg_dark_json = serde_json::to_string(splash_bg_dark).unwrap_or_else(|_| "\"\"".into());
    let fg_dark_json = serde_json::to_string(splash_fg_dark).unwrap_or_else(|_| "\"\"".into());

    format!(
        "(function(){{try{{var mode={mode_json};var bgLight={bg_light_json};var fgLight={fg_light_json};var bgDark={bg_dark_json};var fgDark={fg_dark_json};var root=document.documentElement;if(bgLight)root.style.setProperty('--splash-background-light',bgLight);if(fgLight)root.style.setProperty('--splash-stroke-light',fgLight);if(bgDark)root.style.setProperty('--splash-background-dark',bgDark);if(fgDark)root.style.setProperty('--splash-stroke-dark',fgDark);var prefersDark=false;try{{prefersDark=!!(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);}}catch(_e){{}}var dark=mode==='dark'?true:(mode==='light'?false:prefersDark);root.setAttribute('data-splash-variant',dark?'dark':'light');root.style.setProperty('color-scheme',dark?'dark':'light');}}catch(_e){{}}}})();"
    )
}

fn activate_main_window(
    app: &tauri::AppHandle,
    url: &str,
    local_origin: &str,
    boot_outcome: Option<&DesktopBootOutcome>,
) -> Result<()> {
    let parsed = url::Url::parse(url).map_err(|err| anyhow!("Invalid URL: {err}"))?;
    let init_script = build_init_script(local_origin, boot_outcome);

    if let Some(state) = app.try_state::<DesktopUiInjectionState>() {
        state
            .scripts
            .lock()
            .expect("desktop ui injection mutex")
            .insert("main".to_string(), init_script);
        *state
            .local_origin
            .lock()
            .expect("desktop local origin mutex") = Some(local_origin.to_string());
    }

    if let Some(window) = app.get_webview_window("main") {
        window.navigate(parsed).map_err(|err| anyhow!(err.to_string()))?;
        let _ = window.set_focus();
        return Ok(());
    }

    create_window(app, url, local_origin, boot_outcome, true)
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

    // Resolve the URL the same way as initial setup: env override, then default host, else local.
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

    let env_target = std::env::var("OPENCHAMBER_SERVER_URL")
        .ok()
        .and_then(|raw| normalize_server_url(&raw))
        .filter(|url| !same_server_url(url, &local_ui_url));

    let cfg = read_desktop_hosts_config_from_disk();

    let target_url = if let Some(ref env_url) = env_target {
        env_url.clone()
    } else if let Some(default_id) = cfg.default_host_id.as_deref() {
        if default_id == LOCAL_HOST_ID {
            local_ui_url.clone()
        } else {
            cfg.hosts
                .iter()
                .find(|h| h.id == default_id)
                .map(|h| h.url.clone())
                .unwrap_or(local_ui_url.clone())
        }
    } else {
        local_ui_url.clone()
    };

    // Compute boot outcome for the new window (no probe yet for sync local case).
    let boot_outcome = resolve_boot_outcome(
        &cfg,
        None,
        true,
        env_target.as_deref(),
    );

    // If the target is local, create the window immediately on this (main) thread.
    if same_server_url(&target_url, &local_ui_url) {
        if let Err(err) = create_window(app, &target_url, &local_origin, Some(&boot_outcome), false) {
            log::error!("[desktop] failed to create new window: {err}");
        }
        return;
    }

    // For remote hosts, probe asynchronously then dispatch window creation
    // back to the main thread via run_on_main_thread (required on macOS).
    // Uses the same probe_with_retry policy as startup (soft + hard).
    let handle = app.clone();
    let cfg_snapshot = cfg.clone();
    let env_target_snapshot = env_target.clone();
    tauri::async_runtime::spawn(async move {
        let result = probe_with_retry(&target_url).await;

        let final_url = if result.navigable {
            target_url
        } else {
            log::info!(
                "[desktop] new window: default host ({}) probe returned non-navigable status, using local",
                target_url
            );
            local_ui_url
        };

        // Recompute boot outcome with actual probe result, using the
        // same config/env snapshot that chose this window's target.
        let final_boot_outcome = resolve_boot_outcome(
            &cfg_snapshot,
            result.probe.as_ref(),
            true,
            env_target_snapshot.as_deref(),
        );

        let local = local_origin;
        let handle_clone = handle.clone();
        if let Err(err) = handle.run_on_main_thread(move || {
            if let Err(err) = create_window(&handle_clone, &final_url, &local, Some(&final_boot_outcome), false) {
                log::error!("[desktop] failed to create new window: {err}");
            }
        }) {
            log::error!("[desktop] failed to dispatch window creation to main thread: {err}");
        }
    });
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
        .manage(PendingUpdate(Mutex::new(None)))
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
                    state
                        .scripts
                        .lock()
                        .expect("desktop ui injection mutex")
                        .remove(&label);
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
                // Helper: inject a fallback boot outcome when the local server
                // cannot start, so the UI leaves the splash and shows
                // chooser/recovery instead of hanging on a white screen.
                let handle_for_fallback = handle.clone();
                let inject_startup_failure = |err: String| {
                    log::error!("[desktop] failed to start local server: {err}");
                    let cfg = read_desktop_hosts_config_from_disk();
                    let boot_outcome = compute_local_startup_failure_boot_outcome(&cfg);
                    let init_script = build_startup_failure_init_script(&boot_outcome);
                    if let Some(state) = handle_for_fallback.try_state::<DesktopUiInjectionState>()
                    {
                        state
                            .scripts
                            .lock()
                            .expect("desktop ui injection mutex")
                            .insert("main".to_string(), init_script.clone());
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
                // even when we are using the Vite dev server (no sidecar child).
                if let Some(state) = handle.try_state::<SidecarState>() {
                    *state.url.lock().expect("sidecar url mutex") = Some(local_url.clone());
                }
                start_quit_risk_poller(local_url.clone());

                let local_origin = url::Url::parse(&local_ui_url)
                    .ok()
                    .map(|u| u.origin().ascii_serialization())
                    .unwrap_or_else(|| local_ui_url.clone());

                // Selected host: env override first, then desktop default host, else local.
                // If env override points to the local server, ignore it and use
                // config-based resolution instead.
                let env_target = std::env::var("OPENCHAMBER_SERVER_URL")
                    .ok()
                    .and_then(|raw| normalize_server_url(&raw))
                    .filter(|url| !same_server_url(url, &local_ui_url));

                let mut initial_url = env_target.as_deref().unwrap_or(&local_ui_url).to_string();

                // Compute boot outcome and legacy-upgrade if needed.
                let cfg = read_desktop_hosts_config_from_disk();

                if env_target.is_none() {
                    if let Some(default_id) = cfg.default_host_id.as_deref() {
                        if default_id != LOCAL_HOST_ID {
                            if let Some(host) = cfg.hosts.iter().find(|h| h.id == default_id) {
                                initial_url = host.url.clone();
                            }
                        }
                    }
                }

                // If remote, probe and fall back to local if unreachable.
                // Use the shared probe_with_retry policy (soft + hard).
                let final_probe: Option<HostProbeResult> = if !same_server_url(&initial_url, &local_ui_url) {
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

                // Probe the local server to verify opencode is actually running.
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
                    env_target.as_deref(),
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
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
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
        assert_eq!(read_back.default_host_id.as_deref(), Some("remote-1"));
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

        assert_eq!(reread.default_host_id.as_deref(), Some(LOCAL_HOST_ID));
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

        // Call the production merge-and-write path with omitted field
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
        assert_eq!(outcome.host_id.as_deref(), Some("gone-1"));
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
        assert_eq!(outcome.host_id.as_deref(), Some("remote-a"));
        assert_eq!(outcome.url.as_deref(), Some("https://a.test"));
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
        assert_eq!(outcome.host_id.as_deref(), Some("remote-a"));
    }

    #[test]
    fn resolve_boot_outcome_returns_recovery_remote_wrong_service_when_probe_says_wrong_service() {
        let cfg = make_config(
            vec![("remote-a", "Remote A", "https://a.test")],
            Some("remote-a"),
            true,
        );
        let probe = HostProbeResult {
            status: "wrong-service".to_string(),
            latency_ms: 50,
        };
        let outcome = resolve_boot_outcome(&cfg, Some(&probe), true, None);
        assert_eq!(outcome.target, Some("remote".to_string()));
        assert_eq!(outcome.status, "wrong-service");
        assert_eq!(outcome.host_id.as_deref(), Some("remote-a"));
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
        assert_eq!(outcome.host_id.as_deref(), Some("remote-a"));
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

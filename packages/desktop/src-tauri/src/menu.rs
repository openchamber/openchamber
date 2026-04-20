// macOS menu construction

use tauri::{Emitter, Manager};

pub const MENU_ITEM_ABOUT_ID: &str = "menu_about";
pub const MENU_ITEM_CHECK_FOR_UPDATES_ID: &str = "menu_check_for_updates";
pub const MENU_ITEM_NEW_WINDOW_ID: &str = "menu_new_window";
pub const MENU_ITEM_SETTINGS_ID: &str = "menu_settings";
pub const MENU_ITEM_COMMAND_PALETTE_ID: &str = "menu_command_palette";
pub const MENU_ITEM_QUICK_OPEN_ID: &str = "menu_quick_open";
pub const MENU_ITEM_NEW_SESSION_ID: &str = "menu_new_session";
pub const MENU_ITEM_WORKTREE_CREATOR_ID: &str = "menu_worktree_creator";
pub const MENU_ITEM_CHANGE_WORKSPACE_ID: &str = "menu_change_workspace";
pub const MENU_ITEM_OPEN_GIT_TAB_ID: &str = "menu_open_git_tab";
pub const MENU_ITEM_OPEN_DIFF_TAB_ID: &str = "menu_open_diff_tab";
pub const MENU_ITEM_OPEN_FILES_TAB_ID: &str = "menu_open_files_tab";
pub const MENU_ITEM_OPEN_TERMINAL_TAB_ID: &str = "menu_open_terminal_tab";
pub const MENU_ITEM_COPY_ID: &str = "menu_copy";
pub const MENU_ITEM_THEME_LIGHT_ID: &str = "menu_theme_light";
pub const MENU_ITEM_THEME_DARK_ID: &str = "menu_theme_dark";
pub const MENU_ITEM_THEME_SYSTEM_ID: &str = "menu_theme_system";
pub const MENU_ITEM_TOGGLE_SIDEBAR_ID: &str = "menu_toggle_sidebar";
pub const MENU_ITEM_TOGGLE_MEMORY_DEBUG_ID: &str = "menu_toggle_memory_debug";
pub const MENU_ITEM_HELP_DIALOG_ID: &str = "menu_help_dialog";
pub const MENU_ITEM_DOWNLOAD_LOGS_ID: &str = "menu_download_logs";
pub const MENU_ITEM_REPORT_BUG_ID: &str = "menu_report_bug";
pub const MENU_ITEM_REQUEST_FEATURE_ID: &str = "menu_request_feature";
pub const MENU_ITEM_JOIN_DISCORD_ID: &str = "menu_join_discord";
pub const MENU_ITEM_CLEAR_CACHE_ID: &str = "menu_clear_cache";
pub const MENU_ITEM_QUIT_ID: &str = "menu_quit";

pub const GITHUB_BUG_REPORT_URL: &str =
    "https://github.com/btriapitsyn/openchamber/issues/new?template=bug_report.yml";
pub const GITHUB_FEATURE_REQUEST_URL: &str =
    "https://github.com/btriapitsyn/openchamber/issues/new?template=feature_request.yml";
pub const DISCORD_INVITE_URL: &str = "https://discord.gg/ZYRSdnwwKA";

#[cfg(target_os = "macos")]
pub const QUIT_RISK_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// Dispatch menu action to UI.
pub fn dispatch_menu_action<R: tauri::Runtime>(app: &tauri::AppHandle<R>, action: &str) {
    let _ = app.emit("openchamber:menu-action", action);
    crate::eval_in_focused_window(app, &crate::format_menu_action_script(action));
}

pub fn format_menu_action_script(action: &str) -> String {
    let event = serde_json::to_string("openchamber:menu-action")
        .unwrap_or_else(|_| "\"openchamber:menu-action\"".into());
    let detail = serde_json::to_string(action).unwrap_or_else(|_| "\"\"".into());
    format!("window.dispatchEvent(new CustomEvent({event}, {{ detail: {detail} }}));")
}

/// Dispatch check for updates event to UI.
pub fn dispatch_check_for_updates<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let _ = app.emit("openchamber:check-for-updates", ());

    let event = serde_json::to_string("openchamber:check-for-updates")
        .unwrap_or_else(|_| "\"openchamber:check-for-updates\"".into());
    let script = format!("window.dispatchEvent(new Event({event}));");
    crate::eval_in_all_windows(app, &script);
}

#[cfg(target_os = "macos")]
pub fn should_require_quit_confirmation() -> bool {
    use std::sync::atomic::Ordering;

    crate::QUIT_RISK_HAS_ACTIVE_TUNNEL.load(Ordering::Relaxed)
        || crate::QUIT_RISK_HAS_RUNNING_SCHEDULED_TASKS.load(Ordering::Relaxed)
        || crate::QUIT_RISK_HAS_ENABLED_SCHEDULED_TASKS.load(Ordering::Relaxed)
}

#[cfg(target_os = "macos")]
pub fn quit_confirmation_message() -> String {
    use std::sync::atomic::Ordering;

    let has_active_tunnel = crate::QUIT_RISK_HAS_ACTIVE_TUNNEL.load(Ordering::Relaxed);
    let running_tasks_count = crate::QUIT_RISK_RUNNING_SCHEDULED_TASKS_COUNT.load(Ordering::Relaxed);
    let enabled_tasks_count = crate::QUIT_RISK_ENABLED_SCHEDULED_TASKS_COUNT.load(Ordering::Relaxed);

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

    if crate::QUIT_CONFIRMED.load(Ordering::SeqCst) {
        return NS_TERMINATE_NOW;
    }

    if !should_require_quit_confirmation() {
        crate::QUIT_CONFIRMED.store(true, Ordering::SeqCst);
        return NS_TERMINATE_NOW;
    }

    if crate::QUIT_CONFIRMATION_PENDING.swap(true, Ordering::SeqCst) {
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

    crate::QUIT_CONFIRMATION_PENDING.store(false, Ordering::SeqCst);

    if confirmed {
        crate::QUIT_CONFIRMED.store(true, Ordering::SeqCst);
        NS_TERMINATE_NOW
    } else {
        NS_TERMINATE_CANCEL
    }
}

#[cfg(target_os = "macos")]
pub fn install_macos_quit_confirmation_hook() {
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
pub fn install_macos_quit_confirmation_hook() {}

#[cfg(target_os = "macos")]
pub fn request_quit_with_confirmation(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

    if !should_require_quit_confirmation() {
        crate::QUIT_CONFIRMED.store(true, Ordering::SeqCst);
        app.exit(0);
        return;
    }

    if crate::QUIT_CONFIRMATION_PENDING.swap(true, Ordering::SeqCst) {
        return;
    }

    // When the app has only hidden windows (common after closing the last window),
    // ensure at least one window is visible so the native dialog reliably appears.
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
            crate::QUIT_CONFIRMATION_PENDING.store(false, Ordering::SeqCst);
            if confirmed {
                crate::QUIT_CONFIRMED.store(true, Ordering::SeqCst);
                handle.exit(0);
            }
        });
}

/// Build macOS application menu.
#[cfg(target_os = "macos")]
pub fn build_macos_menu<R: tauri::Runtime>(
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
        Some("Cmd+K"),
    )?;

    let quick_open = MenuItem::with_id(
        app,
        MENU_ITEM_QUICK_OPEN_ID,
        "Quick Open…",
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
                    &quick_open,
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

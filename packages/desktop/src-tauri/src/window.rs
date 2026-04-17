// Window management

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{atomic::AtomicU64, Mutex};
use tauri::{WebviewWindowBuilder, WebviewUrl, Manager};

const WINDOW_STATE_DEBOUNCE_MS: u64 = 300;
const MIN_WINDOW_WIDTH: u32 = 800;
const MIN_WINDOW_HEIGHT: u32 = 520;
const MIN_RESTORE_WINDOW_WIDTH: u32 = 900;
const MIN_RESTORE_WINDOW_HEIGHT: u32 = 560;
const SIDECAR_NOTIFY_PREFIX: &str = "[OpenChamberDesktopNotify] ";

/// Global counter for generating unique window labels.
static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowState {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    #[serde(default)]
    pub(crate) maximized: bool,
    #[serde(default)]
    pub(crate) fullscreen: bool,
}

#[derive(Default)]
pub struct WindowGeometryDebounceState {
    pub(crate) revisions: Mutex<HashMap<String, u64>>,
}

#[derive(Default)]
pub struct DesktopUiInjectionState {
    /// Init scripts keyed by window label. Each window's script contains
    /// the correct `__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__` for that window.
    pub(crate) scripts: Mutex<std::collections::HashMap<String, String>>,
    /// Local origin — shared across all windows since the sidecar is global.
    pub(crate) local_origin: Mutex<Option<String>>,
}

/// Tracks the set of currently-focused window labels.
/// Notification suppression triggers when ANY window is focused.
pub struct WindowFocusState {
    pub(crate) focused_windows: Mutex<std::collections::HashSet<String>>,
}

impl Default for WindowFocusState {
    fn default() -> Self {
        Self {
            focused_windows: Mutex::new(std::collections::HashSet::new()),
        }
    }
}

impl WindowFocusState {
    pub fn any_focused(&self) -> bool {
        let guard = crate::recover_mutex(self.focused_windows.lock());
        !guard.is_empty()
    }

    pub fn set_focused(&self, label: &str, focused: bool) {
        let mut guard = crate::recover_mutex(self.focused_windows.lock());
        if focused {
            guard.insert(label.to_string());
        } else {
            guard.remove(label);
        }
    }

    pub fn remove_window(&self, label: &str) {
        let mut guard = crate::recover_mutex(self.focused_windows.lock());
        guard.remove(label);
    }
}

/// Get next unique window label.
pub fn next_window_label<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> String {
    loop {
        let n = WINDOW_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
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
pub fn eval_in_all_windows<R: tauri::Runtime>(app: &tauri::AppHandle<R>, script: &str) {
    for window in app.webview_windows().values() {
        let _ = window.eval(script);
    }
}

/// Evaluate a script in the currently focused window, falling back to any window.
pub fn eval_in_focused_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>, script: &str) {
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

/// Disable pinch-to-zoom / magnification gestures on macOS to avoid accidental
/// zoom and the continuous gesture event processing overhead.
#[cfg(target_os = "macos")]
pub fn disable_pinch_zoom(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        use objc2::rc::Retained;
        use objc2_web_kit::WKWebView;
        let wk_webview: Retained<WKWebView> =
            Retained::retain(webview.inner().cast()).unwrap();
        wk_webview.setAllowsMagnification(false);
    });
}

#[cfg(not(target_os = "macos"))]
pub fn disable_pinch_zoom(_window: &tauri::WebviewWindow) {}

/// Check if window state is visible on any monitor.
pub fn is_window_state_visible(app: &tauri::AppHandle, state: &DesktopWindowState) -> bool {
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

/// Capture window state.
pub fn capture_window_state(window: &tauri::Window) -> Option<DesktopWindowState> {
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

/// Schedule window state persistence with debounce.
pub fn schedule_window_state_persist(window: tauri::Window, immediate: bool) {
    if window.label() != "main" {
        return;
    }

    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let revision = {
        let Some(state) = app.try_state::<WindowGeometryDebounceState>() else {
            return;
        };
        let mut guard = crate::recover_mutex(state.revisions.lock());
        let next = guard.get(&label).copied().unwrap_or(0).saturating_add(1);
        guard.insert(label.clone(), next);
        next
    };

    tauri::async_runtime::spawn(async move {
        if !immediate {
            tokio::time::sleep(std::time::Duration::from_millis(WINDOW_STATE_DEBOUNCE_MS)).await;
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

/// Read desktop window state from disk.
pub fn read_desktop_window_state_from_disk() -> Option<DesktopWindowState> {
    let path = crate::settings::settings_file_path();
    let raw = std::fs::read_to_string(path).ok();
    let parsed = raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());

    parsed
        .as_ref()
        .and_then(|v| v.get("desktopWindowState"))
        .cloned()
        .and_then(|v| serde_json::from_value::<DesktopWindowState>(v).ok())
}

/// Write desktop window state to disk.
pub fn write_desktop_window_state_to_disk(state: &DesktopWindowState) -> crate::Result<()> {
    let _guard = crate::recover_mutex(crate::settings::SETTINGS_FILE_MUTEX.lock());
    let path = crate::settings::settings_file_path();
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

    root["desktopWindowState"] = serde_json::to_value(state).unwrap_or(serde_json::Value::Null);
    std::fs::write(&path, serde_json::to_string_pretty(&root)?)?;
    Ok(())
}

/// Apply platform-specific window builder configuration.
pub fn apply_platform_window_config<M: tauri::Manager<tauri::Wry>>(
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

/// Create a new window with a unique label, pointing at given URL.
pub fn create_window(
    app: &tauri::AppHandle,
    url: &str,
    local_origin: &str,
    boot_outcome: Option<&crate::probe::DesktopBootOutcome>,
    restore_geometry: bool,
) -> crate::Result<()> {
    let parsed = url::Url::parse(url).map_err(|err| anyhow::anyhow!("Invalid URL: {err}"))?;
    let label = next_window_label(app);

    let init_script = crate::probe::build_init_script(local_origin, boot_outcome);

    // Store init script under this window's label so page reloads
    // re-inject the correct boot outcome for this window.
    if let Some(state) = app.try_state::<DesktopUiInjectionState>() {
        let _ = state
            .scripts
            .lock()
            .map(|mut guard| guard.insert(label.clone(), init_script.clone()));
        *crate::recover_mutex(state.local_origin.lock()) = Some(local_origin.to_string());
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
    let _ = window.set_theme(crate::probe::parse_theme_override(
        crate::settings::read_desktop_settings_json()
            .as_ref()
            .and_then(|v| v.get("themeMode"))
            .and_then(|v| v.as_str()),
        crate::settings::read_desktop_settings_json()
            .as_ref()
            .and_then(|v| v.get("themeVariant"))
            .and_then(|v| v.as_str()),
    ));
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

/// Create startup window with splash screen.
pub fn create_startup_window(app: &tauri::AppHandle, restore_geometry: bool) -> crate::Result<()> {
    if app.webview_windows().contains_key("main") {
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
    let _ = window.set_theme(crate::probe::parse_theme_override(
        crate::settings::read_desktop_settings_json()
            .as_ref()
            .and_then(|v| v.get("themeMode"))
            .and_then(|v| v.as_str()),
        crate::settings::read_desktop_settings_json()
            .as_ref()
            .and_then(|v| v.get("themeVariant"))
            .and_then(|v| v.as_str()),
    ));
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

/// Build startup splash screen script.
pub fn build_startup_splash_script() -> String {
    let settings = std::fs::read_to_string(crate::settings::settings_file_path())
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

/// Activate main window (navigate to URL or create new).
pub fn activate_main_window(
    app: &tauri::AppHandle,
    url: &str,
    local_origin: &str,
    boot_outcome: Option<&crate::probe::DesktopBootOutcome>,
) -> crate::Result<()> {
    let parsed = url::Url::parse(url).map_err(|err| anyhow::anyhow!("Invalid URL: {err}"))?;
    let init_script = crate::probe::build_init_script(local_origin, boot_outcome);

    if let Some(state) = app.try_state::<DesktopUiInjectionState>() {
        let _ = state
            .scripts
            .lock()
            .map(|mut guard| guard.insert("main".to_string(), init_script));
        *crate::recover_mutex(state.local_origin.lock()) = Some(local_origin.to_string());
    }

    if let Some(window) = app.webview_windows().get("main") {
        window.navigate(parsed).map_err(|err| anyhow::anyhow!(err.to_string()))?;
        let _ = window.set_focus();
        return Ok(());
    }

    create_window(app, url, local_origin, boot_outcome, true)
}

/// Open a new window pointed at default host (local or configured default).
pub fn open_new_window(app: &tauri::AppHandle) {
    let local_origin = app
        .try_state::<DesktopUiInjectionState>()
        .and_then(|state| {
            state
                .local_origin
                .lock()
                .map(|guard| guard.clone())
                .unwrap_or_default()
        });

    let Some(local_origin) = local_origin else {
        log::warn!("[desktop] cannot open new window: local origin not yet known (sidecar may still be starting)");
        return;
    };

    // Resolve URL same way as initial setup: env override, then default host, else local.
    let local_url = app
        .try_state::<crate::sidecar::SidecarState>()
        .and_then(|state| state.url.lock().map(|guard| guard.clone()).unwrap_or_default())
        .unwrap_or_else(|| local_origin.clone());

    let local_ui_url = if cfg!(debug_assertions) {
        // In dev mode, prefer Vite dev server if it was used as local origin.
        local_origin.clone()
    } else {
        local_url.clone()
    };

    let env_target = std::env::var("OPENCHAMBER_SERVER_URL")
        .ok()
        .and_then(|raw| crate::settings::normalize_host_url(&raw))
        .filter(|url| !crate::settings::same_server_url(url, &local_ui_url));

    let cfg = crate::settings::read_desktop_hosts_config_from_disk();

    let target_url = if let Some(ref env_url) = env_target {
        env_url.clone()
    } else if let Some(default_id) = cfg.default_host_id.as_deref() {
        if default_id == crate::settings::LOCAL_HOST_ID {
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

    // Compute boot outcome for new window (no probe yet for sync local case).
    let boot_outcome = crate::probe::resolve_boot_outcome(
        &cfg,
        None,
        true,
        env_target.as_deref(),
    );

    // If target is local, create window immediately on this (main) thread.
    if crate::settings::same_server_url(&target_url, &local_ui_url) {
        if let Err(err) = create_window(app, &target_url, &local_origin, Some(&boot_outcome), false) {
            log::error!("[desktop] failed to create new window: {err}");
        }
        return;
    }

    // For remote hosts, probe asynchronously then dispatch window creation
    // back to main thread via run_on_main_thread (required on macOS).
    // Uses the same probe_with_retry policy as startup (soft + hard).
    let handle = app.clone();
    let cfg_snapshot = cfg.clone();
    let env_target_snapshot = env_target.clone();
    tauri::async_runtime::spawn(async move {
        let result = crate::probe::probe_with_retry(&target_url).await;

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
        let final_boot_outcome = crate::probe::resolve_boot_outcome(
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

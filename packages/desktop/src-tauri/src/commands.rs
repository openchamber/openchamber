// Tauri command wrappers that delegate to the modules above

use base64::engine::general_purpose;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::settings::{DesktopHostsConfig, DesktopHostsConfigInput};
use crate::probe::{
    DesktopBootOutcome, HostProbeResult, DIRECT_URL_HOST_ID,
    parse_theme_override,
    detect_desktop_lan_ipv4,
};

use crate::settings::same_server_url;
use crate::window::{
    DesktopUiInjectionState,
    create_window,
    open_new_window,
};


const CHANGELOG_URL: &str =
    "https://raw.githubusercontent.com/btriapitsyn/openchamber/main/CHANGELOG.md";
const STARTUP_REMOTE_PROBE_SOFT_TIMEOUT: Duration = Duration::from_secs(2);
const STARTUP_REMOTE_PROBE_HARD_TIMEOUT: Duration = Duration::from_secs(10);

/// Clear webview browsing data on macOS.
#[tauri::command]
pub fn desktop_clear_cache(app: tauri::AppHandle) -> Result<(), String> {
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
        crate::window::eval_in_all_windows(&app, "window.location.reload();");

        log::info!("[desktop] Cleared all webview browsing data and reloaded windows");
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("desktop_clear_cache is only supported on macOS".to_string())
    }
}

/// Validate a canonical path against blocked system and sensitive prefixes.
/// Returns Ok(()) if the path is allowed, or Err with a denial message.
fn validate_path_access(canonical: &std::path::Path) -> Result<(), String> {
    let path_str = canonical.to_string_lossy();
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    let blocked_prefixes = [
        "/etc/shadow",
        "/etc/passwd",
        "/etc/ssh",
        "/etc/sudoers",
        "/etc/pam.d",
        "/private/etc",
    ];
    // Canonicalize the home directory to ensure it matches canonical paths on macOS
    let home_canonical = std::path::Path::new(&home)
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(home.clone());
    let home_blocked = [
        format!("{}/.ssh", home_canonical),
        format!("{}/.gnupg", home_canonical),
        format!("{}/.keychain", home_canonical),
    ];
    for prefix in &blocked_prefixes {
        if path_str.starts_with(prefix) {
            return Err("Access denied for system path".to_string());
        }
    }
    for prefix in &home_blocked {
        if path_str.starts_with(prefix) {
            return Err("Access denied for sensitive path".to_string());
        }
    }
    Ok(())
}

/// Open a path in the default application or specified app.
#[tauri::command]
pub fn desktop_open_path(path: String, app: Option<String>) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path is required".to_string());
    }

    // Validate the path resolves to a real filesystem entry.
    let canonical = std::path::Path::new(trimmed)
        .canonicalize()
        .map_err(|e| format!("Invalid path: {e}"))?;

    validate_path_access(&canonical)?;

    #[cfg(target_os = "macos")]
    {
        let display_path = canonical.to_string_lossy().to_string();
        let mut command = Command::new("open");
        if let Some(app_name) = app
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            command.arg("-a").arg(app_name);
        }
        command.arg(&display_path);
        command.spawn().map_err(|err| err.to_string())?;
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("desktop_open_path is only supported on macOS".to_string())
    }
}

/// Open a project in a specific app.
#[cfg(target_os = "macos")]
#[derive(Clone)]
struct OpenCommandSpec {
    program: &'static str,
    args: Vec<String>,
}

/// Run a chain of open commands until one succeeds.
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

/// Check if app ID is a JetBrains IDE.
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

/// Get CLI command for an app ID.
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

/// Open a project in a specific app.
#[tauri::command]
pub fn desktop_open_in_app(
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

    // Validate project path resolves to a real directory.
    let canonical_project = std::path::Path::new(trimmed_project_path)
        .canonicalize()
        .map_err(|e| format!("Invalid project path: {e}"))?;

    // Block sensitive system and home-relative paths.
    validate_path_access(&canonical_project)?;

    // If a file path is provided, canonicalize it relative to the project root
    // and ensure it doesn't escape the project directory.
    let validated_file_path = match normalized_file_path {
        Some(fp) => {
            let file_full = if std::path::Path::new(fp).is_absolute() {
                std::path::PathBuf::from(fp)
            } else {
                canonical_project.join(fp)
            };
            let canonical = file_full
                .canonicalize()
                .map_err(|e| format!("Invalid file path '{}': {e}", fp))?;
            if !canonical.starts_with(&canonical_project) {
                return Err("File path escapes project directory".to_string());
            }
            Some(canonical.to_string_lossy().to_string())
        }
        None => None,
    };

    #[cfg(target_os = "macos")]
    {
        let project = canonical_project.to_string_lossy().to_string();
        let app_name_owned = trimmed_app_name.to_string();
        let file = validated_file_path;
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
        let _ = (normalized_file_path, validated_file_path, canonical_project);
        Err("desktop_open_in_app is only supported on macOS".to_string())
    }
}

/// Read a file and return its content as base64 with mime type detection.
#[derive(Debug, Serialize)]
pub struct FileContent {
    pub(crate) mime: String,
    pub(crate) base64: String,
    pub(crate) size: usize,
}

#[tauri::command]
pub fn desktop_read_file(path: String) -> Result<FileContent, String> {
    let raw = std::path::Path::new(&path);

    // Resolve canonical path to prevent symlink traversal attacks.
    // Only allow reading regular files (no pipes, devices, etc.).
    let canonical = raw
        .canonicalize()
        .map_err(|e| format!("Failed to resolve file path: {e}"))?;

    validate_path_access(&canonical)?;

    let metadata = std::fs::metadata(&canonical)
        .map_err(|e| format!("Failed to read file metadata: {e}"))?;

    if !metadata.is_file() {
        return Err("Path does not point to a regular file".to_string());
    }

    // Check file size (max 50MB)
    let size = metadata.len();
    if size > 50 * 1024 * 1024 {
        return Err("File is too large. Maximum size is 50MB.".to_string());
    }

    // Read file bytes
    let bytes = std::fs::read(&canonical).map_err(|e| format!("Failed to read file: {e}"))?;

    // Detect mime type from extension
    let ext = canonical
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

/// Save markdown file via file dialog.
#[tauri::command]
pub async fn desktop_save_markdown_file(
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

/// Show desktop notification.
#[derive(Deserialize)]
pub struct DesktopNotifyPayload {
    title: Option<String>,
    body: Option<String>,
    tag: Option<String>,
}

#[tauri::command]
pub fn desktop_notify(
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

/// Desktop update info.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateInfo {
    pub(crate) available: bool,
    pub(crate) current_version: String,
    pub(crate) version: Option<String>,
    pub(crate) body: Option<String>,
    pub(crate) date: Option<String>,
}

/// Pending update state.
pub struct PendingUpdate(pub std::sync::Mutex<Option<tauri_plugin_updater::Update>>);

/// Update progress event.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum UpdateProgressEvent {
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

/// Check for updates.
#[tauri::command]
pub async fn desktop_check_for_updates(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingUpdate>,
) -> Result<DesktopUpdateInfo, String> {
    let updater = app.updater().map_err(|err| err.to_string())?;
    let update = updater.check().await.map_err(|err| err.to_string())?;

    let current_version = app.package_info().version.to_string();

    let info = if let Some(update) = update {
        *crate::recover_mutex(pending.0.lock()) = Some(update.clone());
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
        *crate::recover_mutex(pending.0.lock()) = None;
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

/// Download and install update.
#[tauri::command]
pub async fn desktop_download_and_install_update(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingUpdate>,
) -> Result<(), String> {
    let Some(update) = crate::recover_mutex(pending.0.lock()).take() else {
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

/// Restart application.
#[tauri::command]
pub fn desktop_restart(app: tauri::AppHandle) {
    app.restart();
}

/// Create a new desktop window from UI layer.
#[tauri::command]
pub fn desktop_new_window(app: tauri::AppHandle) -> Result<(), String> {
    open_new_window(&app);
    Ok(())
}

/// Open a new window pointed at a specific URL (used by host switcher UI).
#[tauri::command]
pub async fn desktop_new_window_at_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
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
                .map(|guard| guard.clone())
                .unwrap_or_default()
        })
        .ok_or_else(|| "Local origin not yet known (sidecar may still be starting)".to_string())?;

    // If URL is local, create window directly.
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
    let result = crate::probe::probe_with_retry(&url).await;

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

/// Get desktop hosts configuration.
#[tauri::command]
pub fn desktop_hosts_get() -> Result<DesktopHostsConfig, String> {
    Ok(crate::settings::read_desktop_hosts_config_from_disk())
}

/// Set desktop hosts configuration.
#[tauri::command]
pub fn desktop_hosts_set(input: DesktopHostsConfigInput) -> Result<(), String> {
    crate::settings::write_desktop_hosts_config_input_to_path(&crate::settings::settings_file_path(), &input)
        .map_err(|err| err.to_string())
}

/// Probe host endpoint.
#[tauri::command]
pub async fn desktop_host_probe(url: String) -> Result<HostProbeResult, String> {
    let result = crate::probe::probe_with_retry(&url).await;
    result
        .probe
        .ok_or_else(|| "Probe failed".to_string())
}

/// Set window theme.
#[tauri::command]
pub fn desktop_set_window_theme(
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

/// Get LAN address.
#[tauri::command]
pub fn desktop_get_lan_address() -> Option<String> {
    detect_desktop_lan_ipv4()
}

/// Check if string is non-empty.
pub fn is_nonempty_string(value: &str) -> bool {
    !value.trim().is_empty()
}

/// Parse semver string to number.
fn parse_semver_num(value: &str) -> Option<u32> {
    let trimmed = value.trim().trim_start_matches('v');
    let mut parts = trimmed.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    let patch: u32 = parts.next()?.parse().ok()?;
    Some(major.saturating_mul(10_000) + minor.saturating_mul(100) + patch)
}

/// Check if release notes are placeholder.
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

/// Fetch changelog notes between versions.
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

/// Get macOS major version.
#[cfg(target_os = "macos")]
pub fn macos_major_version() -> Option<u32> {
    fn cmd_stdout(cmd: &str, args: &[&str]) -> Option<String> {
        let output = Command::new(cmd).args(args).output().ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8(output.stdout).ok()
    }

    // Use marketing version (sw_vers), but map legacy 10.x to minor (10.15 -> 15).
    // This matches WebKit UA fallback logic in UI.
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
pub fn macos_major_version() -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // --- desktop_open_path tests ---

    #[test]
    fn open_path_rejects_empty_path() {
        let result = desktop_open_path("".to_string(), None);
        assert!(result.is_err());
    }

    #[test]
    fn open_path_rejects_nonexistent_path() {
        let result = desktop_open_path("/tmp/openchamber-test-nonexistent-99999".to_string(), None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid path"));
    }

    #[test]
    fn open_path_rejects_sensitive_system_paths() {
        let cases = ["/etc/shadow", "/etc/passwd", "/etc/ssh/sshd_config"];
        for path in cases {
            // These may not exist in CI, but canonicalize will fail if they don't,
            // so test with the canonicalize success case separately
            if std::path::Path::new(path).exists() {
                let result = desktop_open_path(path.to_string(), None);
                assert!(result.is_err(), "Should reject {}", path);
                assert!(result.unwrap_err().contains("denied"), "Should say 'denied' for {}", path);
            }
        }
    }

    // --- desktop_open_in_app tests ---

    #[test]
    fn open_in_app_rejects_empty_project_path() {
        let result = desktop_open_in_app(
            "".to_string(),
            "vscode".to_string(),
            "Code".to_string(),
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn open_in_app_rejects_empty_app_id() {
        let result = desktop_open_in_app(
            "/tmp".to_string(),
            "".to_string(),
            "Code".to_string(),
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn open_in_app_rejects_nonexistent_project_path() {
        let result = desktop_open_in_app(
            "/tmp/openchamber-test-nonexistent-99999".to_string(),
            "vscode".to_string(),
            "Code".to_string(),
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn open_in_app_rejects_file_path_escaping_project() {
        // Create a temp project dir
        let dir = tempfile::Builder::new()
            .prefix("oc-test-project")
            .tempdir()
            .unwrap();
        let project_path = dir.path().to_string_lossy().to_string();

        // Try to open /etc/passwd which is outside the project dir
        let result = desktop_open_in_app(
            project_path,
            "vscode".to_string(),
            "Code".to_string(),
            Some("/etc/passwd".to_string()),
        );
        assert!(result.is_err(), "Should reject file path outside project");
        let err = result.unwrap_err();
        assert!(err.contains("escapes") || err.contains("Invalid"), "Error should mention escape or invalid: {}", err);
    }

    #[test]
    fn open_in_app_rejects_blocked_system_paths() {
        // desktop_open_in_app should reject project paths that match blocked prefixes
        let cases = ["/etc/ssh", "/etc/sudoers"];
        for path in cases {
            if std::path::Path::new(path).exists() {
                let result = desktop_open_in_app(
                    path.to_string(),
                    "finder".to_string(),
                    "Finder".to_string(),
                    None,
                );
                assert!(result.is_err(), "Should reject blocked system path: {}", path);
                assert!(result.unwrap_err().contains("denied"), "Error should say 'denied' for {}", path);
            }
        }
    }

    #[test]
    fn open_in_app_rejects_nonexistent_file_path() {
        let dir = tempfile::Builder::new()
            .prefix("oc-test-project")
            .tempdir()
            .unwrap();
        let project_path = dir.path().to_string_lossy().to_string();

        // File doesn't exist — should error instead of silently dropping
        let result = desktop_open_in_app(
            project_path,
            "vscode".to_string(),
            "Code".to_string(),
            Some("nonexistent-file.txt".to_string()),
        );
        assert!(result.is_err(), "Should reject nonexistent file path");
        assert!(result.unwrap_err().contains("Invalid file path"), "Error should mention invalid file path");
    }

    // --- desktop_read_file tests ---

    #[test]
    fn read_file_rejects_nonexistent_path() {
        let result = desktop_read_file("/tmp/openchamber-test-nonexistent-12345".to_string());
        assert!(result.is_err(), "Should reject nonexistent path");
        assert!(result.unwrap_err().contains("resolve file path"), "Error should mention path resolution");
    }

    #[test]
    fn read_file_rejects_directory() {
        let dir = tempfile::Builder::new()
            .prefix("oc-test-dir")
            .tempdir()
            .unwrap();
        let result = desktop_read_file(dir.path().to_string_lossy().to_string());
        assert!(result.is_err(), "Should reject directory");
    }

    #[test]
    fn read_file_accepts_regular_file() {
        let dir = tempfile::Builder::new()
            .prefix("oc-test-file")
            .tempdir()
            .unwrap();
        let file_path = dir.path().join("test.txt");
        fs::write(&file_path, b"hello world").unwrap();

        let result = desktop_read_file(file_path.to_string_lossy().to_string());
        assert!(result.is_ok(), "Should accept regular file: {:?}", result);
        let content = result.unwrap();
        assert_eq!(content.mime, "text/plain");
    }

    #[test]
    fn read_file_resolves_symlink_to_real_file() {
        let dir = tempfile::Builder::new()
            .prefix("oc-test-sym")
            .tempdir()
            .unwrap();
        let real_file = dir.path().join("real.txt");
        let symlink = dir.path().join("link.txt");
        fs::write(&real_file, b"symlink content").unwrap();
        std::os::unix::fs::symlink(&real_file, &symlink).unwrap();

        let result = desktop_read_file(symlink.to_string_lossy().to_string());
        assert!(result.is_ok(), "Should resolve symlink to real file");
    }

    #[test]
    fn read_file_detects_correct_mime_types() {
        let dir = tempfile::Builder::new()
            .prefix("oc-test-mime")
            .tempdir()
            .unwrap();

        let cases = [
            ("test.png", "image/png"),
            ("test.jpg", "image/jpeg"),
            ("test.pdf", "application/pdf"),
            ("test.json", "application/json"),
            ("test.py", "text/x-python"),
        ];

        for (filename, expected_mime) in cases {
            let file_path = dir.path().join(filename);
            fs::write(&file_path, b"dummy").unwrap();
            let result = desktop_read_file(file_path.to_string_lossy().to_string());
            assert!(result.is_ok(), "Failed for {}", filename);
            assert_eq!(result.unwrap().mime, expected_mime, "Mime mismatch for {}", filename);
        }
    }

    #[test]
    fn read_file_rejects_device_file() {
        // /dev/null is a character device, not a regular file
        let result = desktop_read_file("/dev/null".to_string());
        assert!(result.is_err(), "Should reject device file");
    }

    #[test]
    fn read_file_rejects_blocked_paths() {
        // Set HOME to a temp directory to test home-relative blocking
        let temp_home = tempfile::Builder::new()
            .prefix("oc-test-home")
            .tempdir()
            .unwrap();
        let home_path = temp_home.path().to_string_lossy().to_string();
        std::env::set_var("HOME", &home_path);

        // Create a .ssh directory in the temp HOME
        let ssh_dir = temp_home.path().join(".ssh");
        fs::create_dir_all(&ssh_dir).unwrap();
        let blocked_file = ssh_dir.join("test.txt");
        fs::write(&blocked_file, b"blocked content").unwrap();

        // Should block files in .ssh directory
        let result = desktop_read_file(blocked_file.to_string_lossy().to_string());
        assert!(result.is_err(), "Should reject file in .ssh directory");
        assert!(result.unwrap_err().contains("denied"), "Error should say 'denied'");

        // Create a temp file in a normal directory (not in .ssh) to verify it's NOT blocked
        let normal_file = temp_home.path().join("normal.txt");
        fs::write(&normal_file, b"normal content").unwrap();

        // Should allow files in normal directories
        let result = desktop_read_file(normal_file.to_string_lossy().to_string());
        assert!(result.is_ok(), "Should allow file in normal directory");
    }
}

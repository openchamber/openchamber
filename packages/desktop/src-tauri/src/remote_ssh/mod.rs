use std::time::{SystemTime, UNIX_EPOCH};

pub mod types;
pub mod config;
pub mod process;
pub mod remote;
pub mod manager;

// Re-export commonly used types
pub use types::*;
pub use manager::DesktopSshManagerState;

// Helper functions
pub(crate) fn default_true() -> bool {
    true
}

pub(crate) fn default_connection_timeout() -> u16 {
    60
}

pub(crate) fn default_local_bind_host() -> String {
    "127.0.0.1".to_string()
}

pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// Tauri commands
use tauri::{AppHandle, State};

#[tauri::command]
pub fn desktop_ssh_logs(
    state: State<'_, DesktopSshManagerState>,
    id: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let id = id.trim().to_string();
    if id.is_empty() || id == "local" {
        return Err("SSH instance id is required".to_string());
    }
    const MAX_LOG_LINES_PER_INSTANCE: usize = 1200;
    let cap = limit.unwrap_or(200).min(MAX_LOG_LINES_PER_INSTANCE);
    Ok(state.inner.logs_for_instance(&id, cap))
}

#[tauri::command]
pub fn desktop_ssh_logs_clear(
    state: State<'_, DesktopSshManagerState>,
    id: String,
) -> Result<(), String> {
    let id = id.trim().to_string();
    if id.is_empty() || id == "local" {
        return Err("SSH instance id is required".to_string());
    }
    state.inner.clear_logs_for_instance(&id);
    Ok(())
}

#[tauri::command]
pub fn desktop_ssh_instances_get() -> Result<DesktopSshInstancesConfig, String> {
    Ok(config::read_desktop_ssh_instances_from_disk())
}

#[tauri::command]
pub fn desktop_ssh_instances_set(config: DesktopSshInstancesConfig) -> Result<(), String> {
    config::write_desktop_ssh_instances_to_path(&crate::settings::settings_file_path(), config)
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn desktop_ssh_import_hosts() -> Result<Vec<DesktopSshImportCandidate>, String> {
    let mut candidates = Vec::new();

    if let Some(home) = std::env::var_os("HOME") {
        let user_config = std::path::PathBuf::from(home).join(".ssh").join("config");
        candidates.extend(config::parse_ssh_config_candidates(&user_config, "user"));
    }
    candidates.extend(config::parse_ssh_config_candidates(
        std::path::Path::new("/etc/ssh/ssh_config"),
        "global",
    ));

    let mut seen = std::collections::HashSet::new();
    candidates.retain(|item| seen.insert(item.host.clone()));
    candidates.sort_by(|a, b| a.host.cmp(&b.host));
    Ok(candidates)
}

#[tauri::command]
pub fn desktop_ssh_connect(
    app: AppHandle,
    state: State<'_, DesktopSshManagerState>,
    id: String,
) -> Result<(), String> {
    let id = id.trim().to_string();
    if id.is_empty() || id == "local" {
        return Err("SSH instance id is required".to_string());
    }
    state.inner.start_connect(app, id)
}

#[tauri::command]
pub fn desktop_ssh_disconnect(
    app: AppHandle,
    state: State<'_, DesktopSshManagerState>,
    id: String,
) -> Result<(), String> {
    let id = id.trim().to_string();
    if id.is_empty() || id == "local" {
        return Err("SSH instance id is required".to_string());
    }
    state.inner.disconnect_internal(&app, &id, true);
    Ok(())
}

#[tauri::command]
pub fn desktop_ssh_status(
    state: State<'_, DesktopSshManagerState>,
    id: Option<String>,
) -> Result<Vec<DesktopSshInstanceStatus>, String> {
    if let Some(instance_id) = id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return Ok(vec![state.inner.status_snapshot_for_instance(&instance_id)]);
    }

    Ok(state.inner.statuses_with_defaults())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_instance(id: &str, command: &str) -> DesktopSshInstance {
        DesktopSshInstance {
            id: id.to_string(),
            nickname: None,
            ssh_command: command.to_string(),
            ssh_parsed: None,
            connection_timeout_sec: 60,
            remote_openchamber: DesktopSshRemoteOpenchamberConfig::default(),
            local_forward: DesktopSshLocalForwardConfig::default(),
            auth: DesktopSshAuthConfig::default(),
            port_forwards: Vec::new(),
        }
    }

    #[test]
    fn parse_ssh_command_accepts_supported_options() {
        let parsed = process::parse_ssh_command(
            "ssh -J jump.example.com -o StrictHostKeyChecking=accept-new user@example.com",
        )
        .expect("parsed");
        assert_eq!(parsed.destination, "user@example.com");
        assert_eq!(
            parsed.args,
            vec![
                "-J".to_string(),
                "jump.example.com".to_string(),
                "-o".to_string(),
                "StrictHostKeyChecking=accept-new".to_string(),
            ]
        );
    }

    #[test]
    fn parse_ssh_command_rejects_disallowed_flags() {
        let err = process::parse_ssh_command("ssh -M user@example.com")
            .expect_err("should reject control master flag");
        assert!(err.to_string().contains("not allowed"));
    }

    #[test]
    fn parse_ssh_command_rejects_disallowed_controlpath_option() {
        let err = process::parse_ssh_command("ssh -o ControlPath=/tmp/ssh.sock user@example.com")
            .expect_err("should reject controlpath override");
        assert!(err.to_string().contains("not allowed"));
    }

    #[test]
    fn parse_ssh_command_keeps_ipv6_destination() {
        let parsed =
            process::parse_ssh_command("ssh user@[2001:db8::1]:2222").expect("parsed ipv6 destination");
        assert_eq!(parsed.destination, "user@[2001:db8::1]:2222");
    }

    #[test]
    fn sync_desktop_hosts_removes_deleted_ssh_hosts() {
        use serde_json::json;
        let mut root = json!({
            "desktopHosts": [
                {"id": "ssh-old", "label": "Old", "url": "http://127.0.0.1:1"},
                {"id": "http-1", "label": "HTTP", "url": "https://example.com"}
            ],
            "desktopDefaultHostId": "ssh-old"
        });

        let mut previous = std::collections::HashSet::new();
        previous.insert("ssh-old".to_string());

        let next = vec![sample_instance("ssh-new", "ssh user@example.com")];
        config::sync_desktop_hosts_for_ssh(&mut root, &previous, &next);

        let hosts = root
            .get("desktopHosts")
            .and_then(serde_json::Value::as_array)
            .expect("hosts array");
        assert_eq!(hosts.len(), 2);
        assert!(hosts
            .iter()
            .any(|item| item.get("id") == Some(&serde_json::Value::String("http-1".to_string()))));
        assert!(hosts
            .iter()
            .any(|item| item.get("id") == Some(&serde_json::Value::String("ssh-new".to_string()))));
        assert_eq!(
            root.get("desktopDefaultHostId").and_then(serde_json::Value::as_str),
            Some("local")
        );
    }

    #[test]
    fn parse_ssh_config_candidates_extracts_host_entries() {
        use std::fs;
        let temp =
            std::env::temp_dir().join(format!("openchamber-ssh-import-{}.txt", now_millis()));
        fs::write(
            &temp,
            "\nHost prod\n  HostName 10.0.0.1\nHost *.dev !skip\nHost *\n",
        )
        .expect("write temp");

        let candidates = config::parse_ssh_config_candidates(&temp, "user");
        let _ = fs::remove_file(&temp);

        assert!(candidates
            .iter()
            .any(|item| item.host == "prod" && !item.pattern));
        assert!(candidates
            .iter()
            .any(|item| item.host == "*.dev" && item.pattern));
        assert!(!candidates.iter().any(|item| item.host == "*"));
    }

    #[test]
    fn sanitize_instance_applies_defaults_and_parsed_command() {
        let mut instance = sample_instance("ssh-1", "ssh user@example.com");
        instance.connection_timeout_sec = 0;
        instance.local_forward.bind_host = "".to_string();

        let normalized = config::sanitize_instance(instance).expect("sanitize instance");
        assert_eq!(
            normalized.connection_timeout_sec,
            60
        );
        assert_eq!(normalized.local_forward.bind_host, "127.0.0.1");
        assert_eq!(
            normalized.ssh_parsed.expect("parsed").destination,
            "user@example.com"
        );
    }

    #[test]
    fn parse_probe_status_line_extracts_numeric_status() {
        assert_eq!(
            remote::parse_probe_status_line(Some("INFO_STATUS=401"), "INFO_STATUS="),
            Some(401)
        );
        assert_eq!(
            remote::parse_probe_status_line(Some("INFO_STATUS=abc"), "INFO_STATUS="),
            None
        );
        assert_eq!(
            remote::parse_probe_status_line(Some("WRONG=200"), "INFO_STATUS="),
            None
        );
    }

    #[test]
    fn liveness_status_accepts_success_and_auth_challenges() {
        assert!(remote::is_liveness_http_status(200));
        assert!(remote::is_liveness_http_status(204));
        assert!(remote::is_liveness_http_status(401));
        assert!(remote::is_liveness_http_status(403));
        assert!(!remote::is_liveness_http_status(500));
        assert!(!remote::is_liveness_http_status(0));
    }
}

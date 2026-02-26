use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};

const LOCAL_HOST_ID: &str = "local";
const SSH_STATUS_EVENT: &str = "openchamber:ssh-instance-status";
const DEFAULT_CONNECTION_TIMEOUT_SEC: u16 = 60;
const DEFAULT_LOCAL_BIND_HOST: &str = "127.0.0.1";
const DEFAULT_CONTROL_PERSIST_SEC: u16 = 300;
const DEFAULT_READY_TIMEOUT_SEC: u64 = 30;
const DEFAULT_RECONNECT_MAX_ATTEMPTS: u32 = 5;
const MAX_LOG_LINES_PER_INSTANCE: usize = 1200;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSshInstancesConfig {
    pub instances: Vec<DesktopSshInstance>,
}

impl Default for DesktopSshInstancesConfig {
    fn default() -> Self {
        Self {
            instances: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSshParsedCommand {
    pub destination: String,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopSshRemoteMode {
    Managed,
    External,
}

impl Default for DesktopSshRemoteMode {
    fn default() -> Self {
        Self::Managed
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopSshInstallMethod {
    Npm,
    Bun,
    DownloadRelease,
    UploadBundle,
}

impl Default for DesktopSshInstallMethod {
    fn default() -> Self {
        Self::Bun
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSshRemoteOpenchamberConfig {
    #[serde(default)]
    pub mode: DesktopSshRemoteMode,
    #[serde(default = "default_true")]
    pub keep_running: bool,
    pub preferred_port: Option<u16>,
    #[serde(default)]
    pub install_method: DesktopSshInstallMethod,
    #[serde(default)]
    pub upload_bundle_over_ssh: bool,
}

impl Default for DesktopSshRemoteOpenchamberConfig {
    fn default() -> Self {
        Self {
            mode: DesktopSshRemoteMode::Managed,
            keep_running: true,
            preferred_port: None,
            install_method: DesktopSshInstallMethod::Bun,
            upload_bundle_over_ssh: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSshLocalForwardConfig {
    pub preferred_local_port: Option<u16>,
    #[serde(default = "default_local_bind_host")]
    pub bind_host: String,
}

impl Default for DesktopSshLocalForwardConfig {
    fn default() -> Self {
        Self {
            preferred_local_port: None,
            bind_host: default_local_bind_host(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopSshSecretStore {
    Never,
    Settings,
}

impl Default for DesktopSshSecretStore {
    fn default() -> Self {
        Self::Never
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSshStoredSecret {
    #[serde(default)]
    pub enabled: bool,
    pub value: Option<String>,
    #[serde(default)]
    pub store: DesktopSshSecretStore,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSshAuthConfig {
    pub ssh_password: Option<DesktopSshStoredSecret>,
    pub openchamber_password: Option<DesktopSshStoredSecret>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopSshPortForwardType {
    Local,
    Remote,
    Dynamic,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSshPortForward {
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(rename = "type")]
    pub forward_type: DesktopSshPortForwardType,
    pub local_host: Option<String>,
    pub local_port: Option<u16>,
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSshInstance {
    pub id: String,
    pub nickname: Option<String>,
    pub ssh_command: String,
    pub ssh_parsed: Option<DesktopSshParsedCommand>,
    #[serde(default = "default_connection_timeout")]
    pub connection_timeout_sec: u16,
    #[serde(default)]
    pub remote_openchamber: DesktopSshRemoteOpenchamberConfig,
    #[serde(default)]
    pub local_forward: DesktopSshLocalForwardConfig,
    #[serde(default)]
    pub auth: DesktopSshAuthConfig,
    #[serde(default)]
    pub port_forwards: Vec<DesktopSshPortForward>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopSshPhase {
    Idle,
    ConfigResolved,
    AuthCheck,
    MasterConnecting,
    RemoteProbe,
    Installing,
    Updating,
    ServerDetecting,
    ServerStarting,
    Forwarding,
    Ready,
    Degraded,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSshInstanceStatus {
    pub id: String,
    pub phase: DesktopSshPhase,
    pub detail: Option<String>,
    pub local_url: Option<String>,
    pub local_port: Option<u16>,
    pub remote_port: Option<u16>,
    #[serde(default)]
    pub started_by_us: bool,
    #[serde(default)]
    pub retry_attempt: u32,
    #[serde(default)]
    pub requires_user_action: bool,
    pub updated_at_ms: u64,
}

impl DesktopSshInstanceStatus {
    fn idle(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            phase: DesktopSshPhase::Idle,
            detail: None,
            local_url: None,
            local_port: None,
            remote_port: None,
            started_by_us: false,
            retry_attempt: 0,
            requires_user_action: false,
            updated_at_ms: now_millis(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSshImportCandidate {
    pub host: String,
    pub pattern: bool,
    pub source: String,
    pub ssh_command: String,
}

#[derive(Default)]
struct DesktopSshManagerInner {
    statuses: Mutex<HashMap<String, DesktopSshInstanceStatus>>,
    logs: Mutex<HashMap<String, Vec<String>>>,
    sessions: Mutex<HashMap<String, SshSession>>,
    connect_tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    monitor_tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    reconnect_attempts: Mutex<HashMap<String, u32>>,
    connect_attempts: Mutex<HashMap<String, u32>>,
}

struct SshSession {
    instance: DesktopSshInstance,
    parsed: DesktopSshParsedCommand,
    session_dir: PathBuf,
    control_path: PathBuf,
    local_port: u16,
    remote_port: u16,
    started_by_us: bool,
    master: Child,
    master_detached: bool,
    main_forward: Child,
    main_forward_detached: bool,
    extra_forwards: Vec<Child>,
}

#[derive(Default)]
pub struct DesktopSshManagerState {
    inner: Arc<DesktopSshManagerInner>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSystemInfo {
    openchamber_version: Option<String>,
    runtime: Option<String>,
    pid: Option<u64>,
    started_at: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_connection_timeout() -> u16 {
    DEFAULT_CONNECTION_TIMEOUT_SEC
}

fn default_local_bind_host() -> String {
    DEFAULT_LOCAL_BIND_HOST.to_string()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn settings_file_path() -> PathBuf {
    if let Ok(dir) = std::env::var("OPENCHAMBER_DATA_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir.trim()).join("settings.json");
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home)
        .join(".config")
        .join("openchamber")
        .join("settings.json")
}

fn read_settings_root(path: &Path) -> Value {
    let raw = fs::read_to_string(path).unwrap_or_default();
    let parsed = serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!({}));
    if parsed.is_object() {
        parsed
    } else {
        json!({})
    }
}

fn write_settings_root(path: &Path, root: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_string_pretty(root)?)?;
    Ok(())
}

fn build_display_label(instance: &DesktopSshInstance) -> String {
    if let Some(nick) = instance
        .nickname
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        return nick.to_string();
    }
    if let Some(parsed) = instance.ssh_parsed.as_ref() {
        let destination = parsed.destination.trim();
        if !destination.is_empty() {
            return destination.to_string();
        }
    }
    instance.id.clone()
}

fn read_desktop_ssh_instances_from_path(path: &Path) -> DesktopSshInstancesConfig {
    let root = read_settings_root(path);
    let Some(items) = root
        .get("desktopSshInstances")
        .and_then(Value::as_array)
        .cloned()
    else {
        return DesktopSshInstancesConfig::default();
    };

    let mut instances = Vec::new();
    let mut seen = HashSet::new();
    for item in items {
        let Ok(mut instance) = serde_json::from_value::<DesktopSshInstance>(item) else {
            continue;
        };

        let id = instance.id.trim().to_string();
        if id.is_empty() || id == LOCAL_HOST_ID || seen.contains(&id) {
            continue;
        }
        instance.id = id.clone();
        instance.connection_timeout_sec = if instance.connection_timeout_sec == 0 {
            DEFAULT_CONNECTION_TIMEOUT_SEC
        } else {
            instance.connection_timeout_sec
        };
        if instance.local_forward.bind_host.trim().is_empty() {
            instance.local_forward.bind_host = default_local_bind_host();
        }
        if instance.ssh_parsed.is_none() {
            if let Ok(parsed) = parse_ssh_command(&instance.ssh_command) {
                instance.ssh_parsed = Some(parsed);
            }
        }
        seen.insert(id);
        instances.push(instance);
    }

    DesktopSshInstancesConfig { instances }
}

fn read_desktop_ssh_instances_from_disk() -> DesktopSshInstancesConfig {
    read_desktop_ssh_instances_from_path(&settings_file_path())
}

fn sanitize_bind_host(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return DEFAULT_LOCAL_BIND_HOST.to_string();
    }
    match trimmed {
        "127.0.0.1" | "localhost" | "0.0.0.0" => trimmed.to_string(),
        _ => DEFAULT_LOCAL_BIND_HOST.to_string(),
    }
}

fn sanitize_forward(forward: &DesktopSshPortForward) -> Option<DesktopSshPortForward> {
    let id = forward.id.trim().to_string();
    if id.is_empty() {
        return None;
    }

    let mut normalized = forward.clone();
    normalized.id = id;
    normalized.local_host = normalized
        .local_host
        .as_ref()
        .map(|v| sanitize_bind_host(v))
        .or_else(|| Some(DEFAULT_LOCAL_BIND_HOST.to_string()));

    match normalized.forward_type {
        DesktopSshPortForwardType::Local => {
            if normalized.local_port.is_none() || normalized.remote_port.is_none() {
                return None;
            }
            if normalized
                .remote_host
                .as_ref()
                .map(|v| v.trim())
                .unwrap_or("")
                .is_empty()
            {
                normalized.remote_host = Some("127.0.0.1".to_string());
            }
        }
        DesktopSshPortForwardType::Remote => {
            if normalized.local_port.is_none() || normalized.remote_port.is_none() {
                return None;
            }
            if normalized
                .remote_host
                .as_ref()
                .map(|v| v.trim())
                .unwrap_or("")
                .is_empty()
            {
                normalized.remote_host = Some("127.0.0.1".to_string());
            }
            if normalized
                .local_host
                .as_ref()
                .map(|v| v.trim())
                .unwrap_or("")
                .is_empty()
            {
                normalized.local_host = Some("127.0.0.1".to_string());
            }
        }
        DesktopSshPortForwardType::Dynamic => {
            if normalized.local_port.is_none() {
                return None;
            }
            normalized.remote_host = None;
            normalized.remote_port = None;
        }
    }

    Some(normalized)
}

fn sanitize_instance(mut instance: DesktopSshInstance) -> Result<DesktopSshInstance> {
    instance.id = instance.id.trim().to_string();
    if instance.id.is_empty() || instance.id == LOCAL_HOST_ID {
        return Err(anyhow!("SSH instance id is required"));
    }
    instance.ssh_command = instance.ssh_command.trim().to_string();
    if instance.ssh_command.is_empty() {
        return Err(anyhow!("SSH command is required"));
    }
    if instance.connection_timeout_sec == 0 {
        instance.connection_timeout_sec = DEFAULT_CONNECTION_TIMEOUT_SEC;
    }
    instance.local_forward.bind_host = sanitize_bind_host(&instance.local_forward.bind_host);
    let parsed = parse_ssh_command(&instance.ssh_command)?;
    instance.ssh_parsed = Some(parsed);

    let mut seen = HashSet::new();
    let mut forwards = Vec::new();
    for forward in &instance.port_forwards {
        let Some(normalized) = sanitize_forward(forward) else {
            continue;
        };
        if seen.contains(&normalized.id) {
            continue;
        }
        seen.insert(normalized.id.clone());
        forwards.push(normalized);
    }
    instance.port_forwards = forwards;

    Ok(instance)
}

fn sync_desktop_hosts_for_ssh(
    root: &mut Value,
    previous_ids: &HashSet<String>,
    instances: &[DesktopSshInstance],
) {
    let next_ids: HashSet<String> = instances.iter().map(|item| item.id.clone()).collect();

    let mut hosts = root
        .get("desktopHosts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    hosts.retain(|entry| {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .map(|value| value.trim())
            .unwrap_or("");
        if id.is_empty() {
            return false;
        }
        !(previous_ids.contains(id) && !next_ids.contains(id))
    });

    for instance in instances {
        let label = build_display_label(instance);
        let mut found = false;
        for host in &mut hosts {
            let host_id = host
                .get("id")
                .and_then(Value::as_str)
                .map(|value| value.trim())
                .unwrap_or("");
            if host_id != instance.id {
                continue;
            }
            if let Some(obj) = host.as_object_mut() {
                obj.insert("id".to_string(), Value::String(instance.id.clone()));
                obj.insert("label".to_string(), Value::String(label.clone()));
                let should_set_default_url = obj
                    .get("url")
                    .and_then(Value::as_str)
                    .map(|value| value.trim().is_empty())
                    .unwrap_or(true);
                if should_set_default_url {
                    obj.insert(
                        "url".to_string(),
                        Value::String("http://127.0.0.1/".to_string()),
                    );
                }
            }
            found = true;
            break;
        }

        if !found {
            hosts.push(json!({
                "id": instance.id,
                "label": label,
                "url": "http://127.0.0.1/"
            }));
        }
    }

    root["desktopHosts"] = Value::Array(hosts);

    let default_id = root
        .get("desktopDefaultHostId")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    if !default_id.is_empty()
        && previous_ids.contains(default_id.as_str())
        && !next_ids.contains(default_id.as_str())
    {
        root["desktopDefaultHostId"] = Value::String(LOCAL_HOST_ID.to_string());
    }
}

fn write_desktop_ssh_instances_to_path(
    path: &Path,
    config: DesktopSshInstancesConfig,
) -> Result<DesktopSshInstancesConfig> {
    let mut root = read_settings_root(path);
    let previous = read_desktop_ssh_instances_from_path(path);
    let previous_ids: HashSet<String> = previous
        .instances
        .iter()
        .map(|instance| instance.id.clone())
        .collect();

    let mut seen = HashSet::new();
    let mut sanitized = Vec::new();

    for instance in config.instances {
        let normalized = sanitize_instance(instance)?;
        if seen.contains(&normalized.id) {
            continue;
        }
        seen.insert(normalized.id.clone());
        sanitized.push(normalized);
    }

    sync_desktop_hosts_for_ssh(&mut root, &previous_ids, &sanitized);
    root["desktopSshInstances"] = serde_json::to_value(&sanitized)?;
    write_settings_root(path, &root)?;

    Ok(DesktopSshInstancesConfig {
        instances: sanitized,
    })
}

fn update_ssh_host_url(instance_id: &str, label: &str, local_url: &str) -> Result<()> {
    let path = settings_file_path();
    let mut root = read_settings_root(&path);
    let mut hosts = root
        .get("desktopHosts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut found = false;
    for host in &mut hosts {
        let host_id = host
            .get("id")
            .and_then(Value::as_str)
            .map(|value| value.trim())
            .unwrap_or("");
        if host_id != instance_id {
            continue;
        }
        if let Some(obj) = host.as_object_mut() {
            obj.insert("id".to_string(), Value::String(instance_id.to_string()));
            obj.insert("label".to_string(), Value::String(label.to_string()));
            obj.insert("url".to_string(), Value::String(local_url.to_string()));
            found = true;
            break;
        }
    }

    if !found {
        hosts.push(json!({
            "id": instance_id,
            "label": label,
            "url": local_url
        }));
    }

    root["desktopHosts"] = Value::Array(hosts);
    write_settings_root(&path, &root)
}

fn persist_local_port_for_instance(instance_id: &str, local_port: u16) -> Result<()> {
    let path = settings_file_path();
    let mut root = read_settings_root(&path);
    let mut changed = false;

    if let Some(items) = root
        .get_mut("desktopSshInstances")
        .and_then(Value::as_array_mut)
    {
        for item in items {
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            if id.trim() != instance_id {
                continue;
            }
            if item
                .get("localForward")
                .and_then(Value::as_object)
                .is_none()
            {
                item["localForward"] = json!({});
            }
            item["localForward"]["preferredLocalPort"] = Value::Number(local_port.into());
            changed = true;
            break;
        }
    }

    if changed {
        write_settings_root(&path, &root)?;
    }

    Ok(())
}

fn split_shell_words(input: &str) -> Result<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut chars = input.chars().peekable();
    let mut in_single = false;
    let mut in_double = false;

    while let Some(ch) = chars.next() {
        match ch {
            '\\' if !in_single => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            '\'' if !in_double => {
                in_single = !in_single;
            }
            '"' if !in_single => {
                in_double = !in_double;
            }
            c if c.is_whitespace() && !in_single && !in_double => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }

    if in_single || in_double {
        return Err(anyhow!("Unclosed quote in SSH command"));
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    Ok(tokens)
}

fn is_disallowed_primary_flag(token: &str) -> bool {
    const DISALLOWED: [&str; 17] = [
        "-M", "-S", "-O", "-N", "-t", "-T", "-f", "-G", "-W", "-v", "-V", "-q", "-n", "-s", "-e",
        "-E", "-g",
    ];
    DISALLOWED.contains(&token)
}

fn has_disallowed_o_option(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    [
        "controlmaster",
        "controlpath",
        "controlpersist",
        "batchmode",
        "proxycommand",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
}

fn parse_ssh_command(raw: &str) -> Result<DesktopSshParsedCommand> {
    let mut tokens = split_shell_words(raw)?;
    if tokens.is_empty() {
        return Err(anyhow!("SSH command is empty"));
    }

    if tokens[0] == "ssh" {
        tokens.remove(0);
    }

    if tokens.is_empty() {
        return Err(anyhow!("SSH command must include destination"));
    }

    const ALLOWED_FLAGS: [&str; 11] = [
        "-4", "-6", "-A", "-a", "-C", "-K", "-k", "-X", "-x", "-Y", "-y",
    ];
    const ALLOWED_WITH_VALUES: [&str; 14] = [
        "-B", "-b", "-c", "-D", "-F", "-I", "-i", "-J", "-l", "-m", "-o", "-P", "-p", "-R",
    ];

    let mut destination: Option<String> = None;
    let mut args = Vec::new();
    let mut idx = 0usize;

    while idx < tokens.len() {
        let token = tokens[idx].clone();
        if destination.is_some() {
            return Err(anyhow!(
                "SSH command has unsupported trailing argument: {token}"
            ));
        }

        if token.starts_with('-') {
            if is_disallowed_primary_flag(token.as_str()) {
                return Err(anyhow!("SSH option {token} is not allowed"));
            }

            if ALLOWED_FLAGS.contains(&token.as_str()) {
                args.push(token);
                idx += 1;
                continue;
            }

            let mut matched = false;
            for option in ALLOWED_WITH_VALUES {
                if token == option {
                    if idx + 1 >= tokens.len() {
                        return Err(anyhow!("SSH option {option} requires a value"));
                    }
                    let value = tokens[idx + 1].clone();
                    if option == "-o" && has_disallowed_o_option(&value) {
                        return Err(anyhow!("SSH option -o {value} is not allowed"));
                    }
                    args.push(token.clone());
                    args.push(value);
                    idx += 2;
                    matched = true;
                    break;
                }

                if token.starts_with(option) && token.len() > option.len() {
                    let value = token[option.len()..].to_string();
                    if option == "-o" && has_disallowed_o_option(&value) {
                        return Err(anyhow!("SSH option -o {value} is not allowed"));
                    }
                    args.push(token.clone());
                    idx += 1;
                    matched = true;
                    break;
                }
            }

            if !matched {
                return Err(anyhow!("Unsupported SSH option: {token}"));
            }

            continue;
        }

        destination = Some(token);
        idx += 1;
    }

    let Some(destination) = destination
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
    else {
        return Err(anyhow!("SSH command must include destination"));
    };

    Ok(DesktopSshParsedCommand { destination, args })
}

fn shell_quote(value: &str) -> String {
    let escaped = value.replace('\'', "'\\''");
    format!("'{escaped}'")
}

fn run_output(command: &mut Command) -> Result<(i32, String, String)> {
    let output = command
        .output()
        .with_context(|| format!("failed to execute command: {:?}", command))?;

    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok((code, stdout, stderr))
}

fn build_ssh_command(
    parsed: &DesktopSshParsedCommand,
    pre_destination_args: &[String],
    remote_command: Option<&str>,
) -> Command {
    let mut command = Command::new("ssh");
    command
        .args(&parsed.args)
        .args(pre_destination_args)
        .arg(&parsed.destination);
    if let Some(remote) = remote_command {
        command.arg(remote);
    }
    command
}

fn resolve_ssh_config(parsed: &DesktopSshParsedCommand) -> Result<HashMap<String, String>> {
    let args = vec!["-G".to_string()];
    let mut command = build_ssh_command(parsed, &args, None);
    let (code, stdout, stderr) = run_output(&mut command)?;
    if code != 0 {
        return Err(anyhow!(stderr.trim().to_string()));
    }

    let mut resolved = HashMap::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.splitn(2, ' ');
        let key = parts.next().unwrap_or_default().trim().to_ascii_lowercase();
        let value = parts.next().unwrap_or_default().trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        resolved.insert(key, value.to_string());
    }
    Ok(resolved)
}

fn ensure_session_dir(instance_id: &str) -> Result<PathBuf> {
    let base = settings_file_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("ssh")
        .join(instance_id);
    fs::create_dir_all(&base)?;
    Ok(base)
}

fn control_path_for_instance(_session_dir: &Path, instance_id: &str) -> PathBuf {
    let hash = {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        instance_id.hash(&mut hasher);
        hasher.finish()
    };
    std::env::temp_dir().join(format!("ocssh-{hash:x}.sock"))
}

fn askpass_script_content() -> String {
    let script = r#"#!/bin/bash
PROMPT="$1"

if [[ -n "$OPENCHAMBER_SSH_ASKPASS_VALUE" ]]; then
  if [[ "$PROMPT" == *"assword"* || "$PROMPT" == *"passphrase"* ]]; then
    printf '%s\n' "$OPENCHAMBER_SSH_ASKPASS_VALUE"
    exit 0
  fi
fi

DEFAULT_ANSWER=""
HIDDEN_INPUT="true"

if [[ "$PROMPT" == *"yes/no"* ]]; then
  DEFAULT_ANSWER="yes"
  HIDDEN_INPUT="false"
fi

/usr/bin/osascript <<'APPLESCRIPT' "$PROMPT" "$DEFAULT_ANSWER" "$HIDDEN_INPUT"
on run argv
  set promptText to item 1 of argv
  set defaultAnswer to item 2 of argv
  set hiddenInput to item 3 of argv

  try
    if hiddenInput is "true" then
      set response to display dialog promptText default answer defaultAnswer with hidden answer buttons {"Cancel", "OK"} default button "OK"
    else
      set response to display dialog promptText default answer defaultAnswer buttons {"Cancel", "OK"} default button "OK"
    end if
    return text returned of response
  on error
    error number -128
  end try
end run
APPLESCRIPT
"#;
    script.to_string()
}

fn write_askpass_script(path: &Path) -> Result<()> {
    fs::write(path, askpass_script_content())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = fs::metadata(path)?.permissions();
        perm.set_mode(0o700);
        fs::set_permissions(path, perm)?;
    }
    Ok(())
}

fn spawn_master_process(
    parsed: &DesktopSshParsedCommand,
    control_path: &Path,
    askpass_path: &Path,
    ssh_password: Option<&str>,
) -> Result<Child> {
    let args = vec![
        "-o".to_string(),
        "ControlMaster=yes".to_string(),
        "-o".to_string(),
        format!("ControlPath={}", control_path.display()),
        "-o".to_string(),
        format!("ControlPersist={DEFAULT_CONTROL_PERSIST_SEC}"),
        "-N".to_string(),
    ];
    let mut command = build_ssh_command(parsed, &args, None);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("SSH_ASKPASS", askpass_path)
        .env("DISPLAY", "1");

    if let Some(secret) = ssh_password.filter(|value| !value.trim().is_empty()) {
        command.env("OPENCHAMBER_SSH_ASKPASS_VALUE", secret.trim());
    }

    command.spawn().with_context(|| {
        format!(
            "failed to start SSH ControlMaster for {}",
            parsed.destination
        )
    })
}

fn wait_for_master_ready(
    parsed: &DesktopSshParsedCommand,
    control_path: &Path,
    timeout_sec: u16,
    master: &mut Child,
) -> Result<()> {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_sec as u64);
    while std::time::Instant::now() < deadline {
        let args = vec![
            "-o".to_string(),
            "ControlMaster=no".to_string(),
            "-o".to_string(),
            format!("ControlPath={}", control_path.display()),
            "-O".to_string(),
            "check".to_string(),
        ];

        let mut check = build_ssh_command(parsed, &args, None);
        let (code, _stdout, _stderr) = run_output(&mut check)?;
        if code == 0 {
            return Ok(());
        }

        if let Some(status) = master.try_wait().ok().flatten() {
            let mut stderr = String::new();
            if let Some(mut stream) = master.stderr.take() {
                let _ = stream.read_to_string(&mut stderr);
            }
            if stderr.trim().is_empty() {
                return Err(anyhow!(format!(
                    "SSH master process exited before ready (status: {status})"
                )));
            }
            return Err(anyhow!(stderr.trim().to_string()));
        }

        std::thread::sleep(Duration::from_millis(250));
    }

    Err(anyhow!("SSH ControlMaster connection timed out"))
}

fn control_master_operation(
    parsed: &DesktopSshParsedCommand,
    control_path: &Path,
    op: &str,
) -> Result<(i32, String, String)> {
    let args = vec![
        "-o".to_string(),
        "ControlMaster=no".to_string(),
        "-o".to_string(),
        format!("ControlPath={}", control_path.display()),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=3".to_string(),
        "-O".to_string(),
        op.to_string(),
    ];
    let mut command = build_ssh_command(parsed, &args, None);
    run_output(&mut command)
}

fn is_control_master_alive(parsed: &DesktopSshParsedCommand, control_path: &Path) -> bool {
    control_master_operation(parsed, control_path, "check")
        .map(|(code, _, _)| code == 0)
        .unwrap_or(false)
}

fn stop_control_master_best_effort(parsed: &DesktopSshParsedCommand, control_path: &Path) {
    let _ = control_master_operation(parsed, control_path, "exit");
}

fn run_remote_command(
    parsed: &DesktopSshParsedCommand,
    control_path: &Path,
    script: &str,
    timeout_sec: u16,
) -> Result<String> {
    let args = vec![
        "-o".to_string(),
        "ControlMaster=no".to_string(),
        "-o".to_string(),
        format!("ControlPath={}", control_path.display()),
        "-o".to_string(),
        format!("ConnectTimeout={timeout_sec}"),
        "-T".to_string(),
    ];
    let remote = format!("sh -lc {}", shell_quote(script));
    let mut command = build_ssh_command(parsed, &args, Some(&remote));
    let (code, stdout, stderr) = run_output(&mut command)?;
    if code != 0 {
        if stderr.trim().is_empty() {
            return Err(anyhow!("Remote command failed"));
        }
        return Err(anyhow!(stderr.trim().to_string()));
    }
    Ok(stdout)
}

fn remote_command_exists(
    parsed: &DesktopSshParsedCommand,
    control_path: &Path,
    command_name: &str,
) -> bool {
    run_remote_command(
        parsed,
        control_path,
        &format!(
            "command -v {} >/dev/null 2>&1 && echo yes || echo no",
            command_name
        ),
        DEFAULT_CONNECTION_TIMEOUT_SEC,
    )
    .map(|output| output.trim() == "yes")
    .unwrap_or(false)
}

fn parse_version_token(raw: &str) -> Option<String> {
    for token in raw.split_whitespace() {
        let mut candidate = token.trim().trim_start_matches('v').to_string();
        while candidate.ends_with(',') || candidate.ends_with(')') || candidate.ends_with('(') {
            candidate.pop();
        }
        let parts: Vec<&str> = candidate.split('.').collect();
        if parts.len() < 2 {
            continue;
        }
        if parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
        {
            return Some(candidate);
        }
    }
    None
}

fn current_remote_openchamber_version(
    parsed: &DesktopSshParsedCommand,
    control_path: &Path,
) -> Option<String> {
    run_remote_command(
        parsed,
        control_path,
        "openchamber --version 2>/dev/null || true",
        DEFAULT_CONNECTION_TIMEOUT_SEC,
    )
    .ok()
    .and_then(|value| parse_version_token(&value))
}

fn install_openchamber_managed(
    parsed: &DesktopSshParsedCommand,
    control_path: &Path,
    version: &str,
    preferred: &DesktopSshInstallMethod,
) -> Result<()> {
    let has_bun = remote_command_exists(parsed, control_path, "bun");
    let has_npm = remote_command_exists(parsed, control_path, "npm");

    let mut commands = Vec::new();

    match preferred {
        DesktopSshInstallMethod::Bun => {
            if has_bun {
                commands.push(format!("bun add -g @openchamber/web@{version}"));
            }
            if has_npm {
                commands.push(format!("npm install -g @openchamber/web@{version}"));
            }
        }
        DesktopSshInstallMethod::Npm => {
            if has_npm {
                commands.push(format!("npm install -g @openchamber/web@{version}"));
            }
            if has_bun {
                commands.push(format!("bun add -g @openchamber/web@{version}"));
            }
        }
        DesktopSshInstallMethod::DownloadRelease | DesktopSshInstallMethod::UploadBundle => {
            if has_bun {
                commands.push(format!("bun add -g @openchamber/web@{version}"));
            }
            if has_npm {
                commands.push(format!("npm install -g @openchamber/web@{version}"));
            }
        }
    }

    if commands.is_empty() {
        return Err(anyhow!("Remote host has neither bun nor npm available"));
    }

    let mut last_error: Option<anyhow::Error> = None;
    for command in commands {
        match run_remote_command(
            parsed,
            control_path,
            &command,
            DEFAULT_CONNECTION_TIMEOUT_SEC,
        ) {
            Ok(_) => return Ok(()),
            Err(err) => {
                last_error = Some(err);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow!("Failed to install OpenChamber on remote host")))
}

fn parse_probe_status_line(line: Option<&str>, prefix: &str) -> Option<u16> {
    let value = line?.strip_prefix(prefix)?.trim();
    value.parse::<u16>().ok()
}

fn is_auth_http_status(status: u16) -> bool {
    status == 401 || status == 403
}

fn is_liveness_http_status(status: u16) -> bool {
    (200..=299).contains(&status) || is_auth_http_status(status)
}

fn configured_openchamber_password(instance: &DesktopSshInstance) -> Option<&str> {
    instance
        .auth
        .openchamber_password
        .as_ref()
        .and_then(|secret| {
            if secret.enabled {
                secret.value.as_deref()
            } else {
                None
            }
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn probe_remote_system_info(
    parsed: &DesktopSshParsedCommand,
    control_path: &Path,
    port: u16,
    openchamber_password: Option<&str>,
) -> Result<RemoteSystemInfo> {
    let auth_payload = if let Some(password) = openchamber_password {
        serde_json::to_string(&json!({ "password": password })).unwrap_or_else(|_| "{}".to_string())
    } else {
        "{}".to_string()
    };

    let auth_enabled = if openchamber_password.is_some() {
        "1"
    } else {
        "0"
    };
    let script = format!(
        "AUTH_STATUS=0; INFO_STATUS=0; HEALTH_STATUS=0; BODY_FILE=\"$(mktemp)\"; COOKIE_FILE=\"$(mktemp)\"; cleanup() {{ rm -f \"$BODY_FILE\" \"$COOKIE_FILE\"; }}; trap cleanup EXIT; if command -v curl >/dev/null 2>&1; then if [ \"{auth_enabled}\" = \"1\" ]; then AUTH_STATUS=\"$(curl -sS --max-time 3 -o /dev/null -w '%{{http_code}}' -c \"$COOKIE_FILE\" -H 'content-type: application/json' --data {auth_payload} http://127.0.0.1:{port}/auth/session || true)\"; if [ \"$AUTH_STATUS\" = \"200\" ]; then INFO_STATUS=\"$(curl -sS --max-time 3 -b \"$COOKIE_FILE\" -o \"$BODY_FILE\" -w '%{{http_code}}' http://127.0.0.1:{port}/api/system/info || true)\"; else INFO_STATUS=\"$(curl -sS --max-time 3 -o \"$BODY_FILE\" -w '%{{http_code}}' http://127.0.0.1:{port}/api/system/info || true)\"; fi; else INFO_STATUS=\"$(curl -sS --max-time 3 -o \"$BODY_FILE\" -w '%{{http_code}}' http://127.0.0.1:{port}/api/system/info || true)\"; fi; HEALTH_STATUS=\"$(curl -sS --max-time 3 -o /dev/null -w '%{{http_code}}' http://127.0.0.1:{port}/health || true)\"; elif command -v wget >/dev/null 2>&1; then wget -qO \"$BODY_FILE\" http://127.0.0.1:{port}/api/system/info >/dev/null 2>&1; if [ $? -eq 0 ]; then INFO_STATUS=200; fi; wget -qO- http://127.0.0.1:{port}/health >/dev/null 2>&1; if [ $? -eq 0 ]; then HEALTH_STATUS=200; fi; else exit 127; fi; printf 'INFO_STATUS=%s\\nAUTH_STATUS=%s\\nHEALTH_STATUS=%s\\n' \"$INFO_STATUS\" \"$AUTH_STATUS\" \"$HEALTH_STATUS\"; cat \"$BODY_FILE\" 2>/dev/null || true",
        auth_payload = shell_quote(&auth_payload),
    );
    let output = run_remote_command(
        parsed,
        control_path,
        &script,
        DEFAULT_CONNECTION_TIMEOUT_SEC,
    )?;

    let mut lines = output.lines();
    let info_status = parse_probe_status_line(lines.next(), "INFO_STATUS=").unwrap_or(0);
    let auth_status = parse_probe_status_line(lines.next(), "AUTH_STATUS=").unwrap_or(0);
    let health_status = parse_probe_status_line(lines.next(), "HEALTH_STATUS=").unwrap_or(0);
    let body = lines.collect::<Vec<&str>>().join("\n");

    if is_liveness_http_status(info_status) {
        if is_auth_http_status(info_status) {
            if openchamber_password.is_some() && auth_status != 200 {
                return Err(anyhow!(format!(
                    "Remote OpenChamber requires UI authentication and configured password was rejected (auth status {auth_status})"
                )));
            }

            if is_liveness_http_status(health_status) {
                return Ok(RemoteSystemInfo::default());
            }

            return Err(anyhow!(
                "Remote OpenChamber requires UI authentication on /api/system/info; configure OpenChamber UI password"
            ));
        }
    } else if is_liveness_http_status(health_status) {
        return Ok(RemoteSystemInfo::default());
    } else {
        return Err(anyhow!(format!(
            "Remote OpenChamber probe failed (info status {info_status}, health status {health_status})"
        )));
    }

    let mut info = serde_json::from_str::<RemoteSystemInfo>(&body).unwrap_or_default();
    if info.openchamber_version.is_none() {
        if let Ok(value) = serde_json::from_str::<Value>(&body) {
            info.openchamber_version = value
                .get("openchamberVersion")
                .and_then(Value::as_str)
                .map(|v| v.to_string());
            info.runtime = value
                .get("runtime")
                .and_then(Value::as_str)
                .map(|v| v.to_string());
            info.pid = value.get("pid").and_then(Value::as_u64);
            info.started_at = value
                .get("startedAt")
                .and_then(Value::as_str)
                .map(|v| v.to_string());
        }
    }
    Ok(info)
}

fn remote_server_running(
    parsed: &DesktopSshParsedCommand,
    control_path: &Path,
    port: u16,
    openchamber_password: Option<&str>,
) -> bool {
    probe_remote_system_info(parsed, control_path, port, openchamber_password).is_ok()
}

fn random_port_candidate(seed: &str) -> u16 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    seed.hash(&mut hasher);
    now_millis().hash(&mut hasher);
    let value = hasher.finish();
    let base = 20_000u16;
    let span = 30_000u16;
    base + ((value % span as u64) as u16)
}

fn start_remote_server_managed(
    parsed: &DesktopSshParsedCommand,
    control_path: &Path,
    instance: &DesktopSshInstance,
    desired_port: u16,
) -> Result<u16> {
    let mut env_prefix = "OPENCHAMBER_RUNTIME=ssh-remote".to_string();
    if let Some(secret) = instance
        .auth
        .openchamber_password
        .as_ref()
        .and_then(|v| if v.enabled { v.value.clone() } else { None })
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        env_prefix.push(' ');
        env_prefix.push_str("OPENCHAMBER_UI_PASSWORD=");
        env_prefix.push_str(&shell_quote(&secret));
    }
    let script = format!(
        "{env_prefix} openchamber serve --daemon --hostname 127.0.0.1 --port {desired_port}"
    );
    let output = run_remote_command(
        parsed,
        control_path,
        &script,
        DEFAULT_CONNECTION_TIMEOUT_SEC,
    )?;

    if let Some(port) = output
        .split_whitespace()
        .find_map(|token| token.parse::<u16>().ok())
    {
        return Ok(port);
    }
    Ok(desired_port)
}

fn stop_remote_server_best_effort(
    parsed: &DesktopSshParsedCommand,
    control_path: &Path,
    remote_port: u16,
) {
    let script = format!(
        "if command -v curl >/dev/null 2>&1; then curl -fsS -X POST http://127.0.0.1:{remote_port}/api/system/shutdown >/dev/null 2>&1 || true; elif command -v wget >/dev/null 2>&1; then wget -qO- --method=POST http://127.0.0.1:{remote_port}/api/system/shutdown >/dev/null 2>&1 || true; fi"
    );
    let _ = run_remote_command(
        parsed,
        control_path,
        &script,
        DEFAULT_CONNECTION_TIMEOUT_SEC,
    );
}

fn spawn_main_forward(
    parsed: &DesktopSshParsedCommand,
    control_path: &Path,
    bind_host: &str,
    local_port: u16,
    remote_port: u16,
) -> Result<Child> {
    let args = vec![
        "-o".to_string(),
        "ControlMaster=no".to_string(),
        "-o".to_string(),
        format!("ControlPath={}", control_path.display()),
        "-N".to_string(),
        "-L".to_string(),
        format!("{bind_host}:{local_port}:127.0.0.1:{remote_port}"),
    ];
    let mut command = build_ssh_command(parsed, &args, None);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to start main SSH forward on local port {local_port}"))
}

fn spawn_extra_forward(
    parsed: &DesktopSshParsedCommand,
    control_path: &Path,
    forward: &DesktopSshPortForward,
) -> Result<()> {
    let mut args = vec![
        "-o".to_string(),
        "ControlMaster=no".to_string(),
        "-o".to_string(),
        format!("ControlPath={}", control_path.display()),
        "-O".to_string(),
        "forward".to_string(),
    ];

    match forward.forward_type {
        DesktopSshPortForwardType::Local => {
            let local_host = forward
                .local_host
                .as_deref()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or("127.0.0.1");
            let local_port = forward
                .local_port
                .ok_or_else(|| anyhow!("Missing local port"))?;
            let remote_host = forward
                .remote_host
                .as_deref()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or("127.0.0.1");
            let remote_port = forward
                .remote_port
                .ok_or_else(|| anyhow!("Missing remote port"))?;
            args.push("-L".to_string());
            args.push(format!(
                "{local_host}:{local_port}:{remote_host}:{remote_port}"
            ));
        }
        DesktopSshPortForwardType::Remote => {
            let remote_host = forward
                .remote_host
                .as_deref()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or("127.0.0.1");
            let remote_port = forward
                .remote_port
                .ok_or_else(|| anyhow!("Missing remote port"))?;
            let local_host = forward
                .local_host
                .as_deref()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or("127.0.0.1");
            let local_port = forward
                .local_port
                .ok_or_else(|| anyhow!("Missing local port"))?;
            args.push("-R".to_string());
            args.push(format!(
                "{remote_host}:{remote_port}:{local_host}:{local_port}"
            ));
        }
        DesktopSshPortForwardType::Dynamic => {
            let local_host = forward
                .local_host
                .as_deref()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or("127.0.0.1");
            let local_port = forward
                .local_port
                .ok_or_else(|| anyhow!("Missing local port"))?;
            args.push("-D".to_string());
            args.push(format!("{local_host}:{local_port}"));
        }
    }

    let mut command = build_ssh_command(parsed, &args, None);
    let (code, stdout, stderr) = run_output(&mut command)
        .with_context(|| format!("Failed to configure extra SSH forward {}", forward.id))?;
    if code != 0 {
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(anyhow!(format!(
            "Failed to configure extra SSH forward {}: {}",
            forward.id,
            if detail.is_empty() {
                "unknown error"
            } else {
                detail
            }
        )));
    }
    Ok(())
}

fn is_local_port_available(bind_host: &str, port: u16) -> bool {
    TcpListener::bind(format!("{bind_host}:{port}")).is_ok()
}

fn pick_unused_local_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn is_local_tunnel_reachable(local_port: u16) -> bool {
    let addr = format!("127.0.0.1:{local_port}");
    let Ok(parsed) = addr.parse() else {
        return false;
    };
    TcpStream::connect_timeout(&parsed, Duration::from_millis(500)).is_ok()
}

fn wait_local_forward_ready(local_port: u16) -> Result<()> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(1000))
        .no_proxy()
        .build()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(DEFAULT_READY_TIMEOUT_SEC);
    let target = format!("http://127.0.0.1:{local_port}/health");
    while std::time::Instant::now() < deadline {
        if let Ok(response) = client.get(&target).send() {
            if response.status().is_success() || response.status().as_u16() == 401 {
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(anyhow!(
        "Timed out waiting for forwarded OpenChamber health"
    ))
}

fn kill_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn parse_ssh_config_candidates(path: &Path, source: &str) -> Vec<DesktopSshImportCandidate> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    for line in content.lines() {
        let trimmed = line.split('#').next().map(|part| part.trim()).unwrap_or("");
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.len() < 4 {
            continue;
        }
        if !trimmed[..4].eq_ignore_ascii_case("host") {
            continue;
        }

        let rest = trimmed[4..].trim();
        if rest.is_empty() {
            continue;
        }

        for token in rest.split_whitespace() {
            let host = token.trim();
            if host.is_empty() || host.starts_with('!') {
                continue;
            }
            if host == "*" {
                continue;
            }
            let pattern = host.contains('*') || host.contains('?');
            candidates.push(DesktopSshImportCandidate {
                host: host.to_string(),
                pattern,
                source: source.to_string(),
                ssh_command: format!("ssh {host}"),
            });
        }
    }
    candidates
}

impl DesktopSshManagerInner {
    fn append_log_with_level(&self, id: &str, level: &str, message: impl Into<String>) {
        let line = format!("[{}] [{}] {}", now_millis(), level, message.into());
        let mut logs = self.logs.lock().expect("ssh logs mutex");
        let entry = logs.entry(id.to_string()).or_default();
        entry.push(line);
        if entry.len() > MAX_LOG_LINES_PER_INSTANCE {
            let overflow = entry.len() - MAX_LOG_LINES_PER_INSTANCE;
            entry.drain(0..overflow);
        }
    }

    fn append_log(&self, id: &str, message: impl Into<String>) {
        self.append_log_with_level(id, "INFO", message);
    }

    fn append_attempt_separator(&self, id: &str, connect_attempt: u32, retry_attempt: u32) {
        let scope = if retry_attempt > 0 {
            format!("retry {retry_attempt}")
        } else {
            "manual".to_string()
        };
        self.append_log_with_level(
            id,
            "INFO",
            format!("---------------- attempt #{connect_attempt} ({scope}) ----------------"),
        );
    }

    fn logs_for_instance(&self, id: &str, limit: usize) -> Vec<String> {
        let logs = self.logs.lock().expect("ssh logs mutex");
        let mut lines = logs.get(id).cloned().unwrap_or_default();
        if limit > 0 && lines.len() > limit {
            let keep_from = lines.len() - limit;
            lines.drain(0..keep_from);
        }
        lines
    }

    fn clear_logs_for_instance(&self, id: &str) {
        self.logs.lock().expect("ssh logs mutex").remove(id);
    }

    fn status_snapshot_for_instance(&self, id: &str) -> DesktopSshInstanceStatus {
        self.statuses
            .lock()
            .expect("ssh status mutex")
            .get(id)
            .cloned()
            .unwrap_or_else(|| DesktopSshInstanceStatus::idle(id))
    }

    fn set_status(
        &self,
        app: &AppHandle,
        id: &str,
        phase: DesktopSshPhase,
        detail: Option<String>,
        local_url: Option<String>,
        local_port: Option<u16>,
        remote_port: Option<u16>,
        started_by_us: bool,
        retry_attempt: u32,
        requires_user_action: bool,
    ) {
        let level = if matches!(&phase, DesktopSshPhase::Error) {
            "ERROR"
        } else if matches!(&phase, DesktopSshPhase::Degraded) {
            "WARN"
        } else {
            "INFO"
        };

        self.append_log_with_level(
            id,
            level,
            format!(
                "phase={} detail={} retry={} requires_user_action={}",
                serde_json::to_string(&phase).unwrap_or_else(|_| "\"unknown\"".to_string()),
                detail.as_deref().unwrap_or(""),
                retry_attempt,
                requires_user_action
            ),
        );

        let status = DesktopSshInstanceStatus {
            id: id.to_string(),
            phase,
            detail,
            local_url,
            local_port,
            remote_port,
            started_by_us,
            retry_attempt,
            requires_user_action,
            updated_at_ms: now_millis(),
        };

        self.statuses
            .lock()
            .expect("ssh status mutex")
            .insert(id.to_string(), status.clone());
        let _ = app.emit(SSH_STATUS_EVENT, status);
    }

    fn clear_retry_attempt(&self, id: &str) {
        self.reconnect_attempts
            .lock()
            .expect("ssh retry mutex")
            .remove(id);
    }

    fn next_retry_attempt(&self, id: &str) -> u32 {
        let mut guard = self.reconnect_attempts.lock().expect("ssh retry mutex");
        let next = guard.get(id).copied().unwrap_or(0).saturating_add(1);
        guard.insert(id.to_string(), next);
        next
    }

    fn current_retry_attempt(&self, id: &str) -> u32 {
        self.reconnect_attempts
            .lock()
            .expect("ssh retry mutex")
            .get(id)
            .copied()
            .unwrap_or(0)
    }

    fn next_connect_attempt(&self, id: &str) -> u32 {
        let mut guard = self
            .connect_attempts
            .lock()
            .expect("ssh connect-attempt mutex");
        let next = guard.get(id).copied().unwrap_or(0).saturating_add(1);
        guard.insert(id.to_string(), next);
        next
    }

    fn cancel_connect_task(&self, id: &str) {
        if let Some(handle) = self
            .connect_tasks
            .lock()
            .expect("ssh connect task mutex")
            .remove(id)
        {
            handle.abort();
        }
    }

    fn cancel_monitor_task(&self, id: &str) {
        if let Some(handle) = self
            .monitor_tasks
            .lock()
            .expect("ssh monitor task mutex")
            .remove(id)
        {
            handle.abort();
        }
    }

    fn session_is_alive(&self, id: &str) -> bool {
        let mut sessions = self.sessions.lock().expect("ssh sessions mutex");
        let Some(session) = sessions.get_mut(id) else {
            return false;
        };

        let mut main_anchor_alive = false;

        if !session.main_forward_detached {
            if let Some(status) = session.main_forward.try_wait().ok().flatten() {
                if status.success() {
                    session.main_forward_detached = true;
                    self.append_log_with_level(
                        id,
                        "INFO",
                        "Main tunnel helper exited after ControlMaster handoff",
                    );
                } else {
                    let mut stderr = String::new();
                    if let Some(mut stream) = session.main_forward.stderr.take() {
                        let _ = stream.read_to_string(&mut stderr);
                    }
                    self.append_log_with_level(
                        id,
                        "WARN",
                        if stderr.trim().is_empty() {
                            format!("Existing main SSH forward is not running ({status})")
                        } else {
                            format!(
                                "Existing main SSH forward is not running ({status}): {}",
                                stderr.trim()
                            )
                        },
                    );
                    return false;
                }
            } else {
                main_anchor_alive = true;
            }
        }

        if main_anchor_alive {
            return true;
        }

        if session.master_detached {
            if !is_control_master_alive(&session.parsed, &session.control_path) {
                if is_local_tunnel_reachable(session.local_port) {
                    self.append_log_with_level(
                        id,
                        "WARN",
                        "SSH ControlMaster check failed but local tunnel is still reachable",
                    );
                    return true;
                }
                self.append_log_with_level(
                    id,
                    "WARN",
                    "Existing SSH ControlMaster is not reachable",
                );
                return false;
            }
        } else if let Some(status) = session.master.try_wait().ok().flatten() {
            if status.success() && is_control_master_alive(&session.parsed, &session.control_path) {
                session.master_detached = true;
                self.append_log_with_level(
                    id,
                    "INFO",
                    "SSH ControlMaster transitioned to detached background mode",
                );
            } else {
                let mut stderr = String::new();
                if let Some(mut stream) = session.master.stderr.take() {
                    let _ = stream.read_to_string(&mut stderr);
                }
                self.append_log_with_level(
                    id,
                    "WARN",
                    if stderr.trim().is_empty() {
                        format!("Existing SSH ControlMaster is not running ({status})")
                    } else {
                        format!(
                            "Existing SSH ControlMaster is not running ({status}): {}",
                            stderr.trim()
                        )
                    },
                );
                return false;
            }
        }

        true
    }

    fn disconnect_internal(&self, app: &AppHandle, id: &str, report_idle: bool) {
        self.cancel_connect_task(id);
        self.cancel_monitor_task(id);

        if let Some(mut session) = self.sessions.lock().expect("ssh sessions mutex").remove(id) {
            if session.started_by_us
                && matches!(
                    session.instance.remote_openchamber.mode,
                    DesktopSshRemoteMode::Managed
                )
                && !session.instance.remote_openchamber.keep_running
            {
                stop_remote_server_best_effort(
                    &session.parsed,
                    &session.control_path,
                    session.remote_port,
                );
            }

            stop_control_master_best_effort(&session.parsed, &session.control_path);

            kill_child(&mut session.main_forward);
            for child in &mut session.extra_forwards {
                kill_child(child);
            }
            kill_child(&mut session.master);

            let _ = fs::remove_file(&session.control_path);
            let _ = fs::remove_file(session.session_dir.join("askpass.sh"));
        }

        self.clear_retry_attempt(id);

        if report_idle {
            self.set_status(
                app,
                id,
                DesktopSshPhase::Idle,
                None,
                None,
                None,
                None,
                false,
                0,
                false,
            );
        }
    }

    fn ensure_remote_server(
        &self,
        app: &AppHandle,
        instance: &DesktopSshInstance,
        parsed: &DesktopSshParsedCommand,
        control_path: &Path,
    ) -> Result<(u16, bool)> {
        let app_version = app.package_info().version.to_string();

        match instance.remote_openchamber.mode {
            DesktopSshRemoteMode::External => {
                let Some(port) = instance.remote_openchamber.preferred_port else {
                    return Err(anyhow!(
                        "External mode requires a preferred remote OpenChamber port"
                    ));
                };
                self.set_status(
                    app,
                    &instance.id,
                    DesktopSshPhase::ServerDetecting,
                    Some("Probing external OpenChamber server".to_string()),
                    None,
                    None,
                    Some(port),
                    false,
                    0,
                    false,
                );
                probe_remote_system_info(
                    parsed,
                    control_path,
                    port,
                    configured_openchamber_password(instance),
                )
                .map_err(|err| {
                    anyhow!(format!(
                        "External OpenChamber server probe failed on configured remote port: {err}"
                    ))
                })?;
                Ok((port, false))
            }
            DesktopSshRemoteMode::Managed => {
                self.set_status(
                    app,
                    &instance.id,
                    DesktopSshPhase::RemoteProbe,
                    Some("Checking remote OpenChamber installation".to_string()),
                    None,
                    None,
                    None,
                    false,
                    0,
                    false,
                );

                let installed_version = current_remote_openchamber_version(parsed, control_path);
                if installed_version.is_none() {
                    self.set_status(
                        app,
                        &instance.id,
                        DesktopSshPhase::Installing,
                        Some("Installing OpenChamber on remote host".to_string()),
                        None,
                        None,
                        None,
                        false,
                        0,
                        false,
                    );
                    install_openchamber_managed(
                        parsed,
                        control_path,
                        &app_version,
                        &instance.remote_openchamber.install_method,
                    )?;
                } else if installed_version.as_deref() != Some(app_version.as_str()) {
                    self.set_status(
                        app,
                        &instance.id,
                        DesktopSshPhase::Updating,
                        Some(format!(
                            "Updating remote OpenChamber from {} to {}",
                            installed_version
                                .clone()
                                .unwrap_or_else(|| "unknown".to_string()),
                            app_version
                        )),
                        None,
                        None,
                        None,
                        false,
                        0,
                        false,
                    );
                    install_openchamber_managed(
                        parsed,
                        control_path,
                        &app_version,
                        &instance.remote_openchamber.install_method,
                    )?;
                }

                self.set_status(
                    app,
                    &instance.id,
                    DesktopSshPhase::ServerDetecting,
                    Some("Detecting managed OpenChamber server".to_string()),
                    None,
                    None,
                    None,
                    false,
                    0,
                    false,
                );

                let mut started_by_us = false;
                let mut remote_port = instance.remote_openchamber.preferred_port;

                if let Some(port) = remote_port {
                    if !remote_server_running(
                        parsed,
                        control_path,
                        port,
                        configured_openchamber_password(instance),
                    ) {
                        remote_port = None;
                    }
                }

                if remote_port.is_none() {
                    self.set_status(
                        app,
                        &instance.id,
                        DesktopSshPhase::ServerStarting,
                        Some("Starting managed OpenChamber server".to_string()),
                        None,
                        None,
                        None,
                        false,
                        0,
                        false,
                    );
                    let desired_port = instance
                        .remote_openchamber
                        .preferred_port
                        .unwrap_or_else(|| random_port_candidate(&instance.id));
                    let started_port =
                        start_remote_server_managed(parsed, control_path, instance, desired_port)?;
                    remote_port = Some(started_port);
                    started_by_us = true;
                }

                let Some(port) = remote_port else {
                    return Err(anyhow!("Failed to determine remote OpenChamber port"));
                };

                if !remote_server_running(
                    parsed,
                    control_path,
                    port,
                    configured_openchamber_password(instance),
                ) {
                    return Err(anyhow!(
                        "Managed OpenChamber server failed to become reachable"
                    ));
                }

                Ok((port, started_by_us))
            }
        }
    }

    fn connect_blocking(
        self: &Arc<Self>,
        app: &AppHandle,
        instance: DesktopSshInstance,
    ) -> Result<()> {
        let id = instance.id.clone();
        self.set_status(
            app,
            &id,
            DesktopSshPhase::ConfigResolved,
            Some("Resolving SSH command".to_string()),
            None,
            None,
            None,
            false,
            0,
            false,
        );

        let parsed = instance
            .ssh_parsed
            .clone()
            .or_else(|| parse_ssh_command(&instance.ssh_command).ok())
            .ok_or_else(|| anyhow!("Invalid SSH command"))?;

        let _resolved = resolve_ssh_config(&parsed)?;

        self.set_status(
            app,
            &id,
            DesktopSshPhase::AuthCheck,
            Some("Checking SSH connectivity".to_string()),
            None,
            None,
            None,
            false,
            0,
            false,
        );

        let session_dir = ensure_session_dir(&id)?;
        let control_path = control_path_for_instance(&session_dir, &id);
        let _ = fs::remove_file(&control_path);
        let askpass_path = session_dir.join("askpass.sh");
        write_askpass_script(&askpass_path)?;

        self.set_status(
            app,
            &id,
            DesktopSshPhase::MasterConnecting,
            Some("Establishing SSH ControlMaster".to_string()),
            None,
            None,
            None,
            false,
            0,
            false,
        );

        let mut master = spawn_master_process(
            &parsed,
            &control_path,
            &askpass_path,
            instance.auth.ssh_password.as_ref().and_then(|secret| {
                if secret.enabled {
                    secret.value.as_deref()
                } else {
                    None
                }
            }),
        )?;

        if let Err(err) = wait_for_master_ready(
            &parsed,
            &control_path,
            instance.connection_timeout_sec,
            &mut master,
        ) {
            kill_child(&mut master);
            return Err(err);
        }

        self.set_status(
            app,
            &id,
            DesktopSshPhase::RemoteProbe,
            Some("Probing remote platform".to_string()),
            None,
            None,
            None,
            false,
            0,
            false,
        );

        let remote_os = run_remote_command(
            &parsed,
            &control_path,
            "uname -s",
            instance.connection_timeout_sec,
        )?;

        let remote_os = remote_os.trim().to_ascii_lowercase();
        if remote_os != "linux" && remote_os != "darwin" {
            kill_child(&mut master);
            return Err(anyhow!("Unsupported remote OS: {remote_os}"));
        }

        let (remote_port, started_by_us) =
            match self.ensure_remote_server(app, &instance, &parsed, &control_path) {
                Ok(result) => result,
                Err(err) => {
                    kill_child(&mut master);
                    return Err(err);
                }
            };

        self.set_status(
            app,
            &id,
            DesktopSshPhase::Forwarding,
            Some("Setting up port forwards".to_string()),
            None,
            None,
            Some(remote_port),
            started_by_us,
            0,
            false,
        );

        let bind_host = sanitize_bind_host(&instance.local_forward.bind_host);
        let mut local_port = instance.local_forward.preferred_local_port.unwrap_or(0);
        if local_port == 0 {
            local_port = pick_unused_local_port()?;
        }
        if !is_local_port_available(&bind_host, local_port) {
            local_port = pick_unused_local_port()?;
        }

        let mut main_forward =
            match spawn_main_forward(&parsed, &control_path, &bind_host, local_port, remote_port) {
                Ok(child) => child,
                Err(err) => {
                    kill_child(&mut master);
                    return Err(err);
                }
            };
        let mut main_forward_detached = false;

        std::thread::sleep(Duration::from_millis(250));
        if let Some(status) = main_forward.try_wait().ok().flatten() {
            if status.success() {
                main_forward_detached = true;
                self.append_log_with_level(
                    &id,
                    "INFO",
                    "Main tunnel helper exited after ControlMaster handoff",
                );
            } else {
                let mut stderr = String::new();
                if let Some(mut stream) = main_forward.stderr.take() {
                    let _ = stream.read_to_string(&mut stderr);
                }
                kill_child(&mut master);
                return Err(anyhow!(format!(
                    "Failed to start main port forward (status: {status}): {}",
                    stderr.trim()
                )));
            }
        }

        let mut extra_forwards = Vec::new();
        let mut extra_errors = Vec::new();
        for forward in instance
            .port_forwards
            .iter()
            .filter(|forward| forward.enabled)
        {
            match spawn_extra_forward(&parsed, &control_path, forward) {
                Ok(()) => {
                    if matches!(forward.forward_type, DesktopSshPortForwardType::Local) {
                        if let Some(local_port) = forward.local_port {
                            std::thread::sleep(Duration::from_millis(100));
                            if !is_local_tunnel_reachable(local_port) {
                                extra_errors.push(format!(
                                    "{}: local listener 127.0.0.1:{} is not reachable",
                                    forward.id, local_port
                                ));
                            }
                        }
                    }
                }
                Err(err) => extra_errors.push(format!("{}: {}", forward.id, err)),
            }
        }

        if let Err(err) = wait_local_forward_ready(local_port) {
            kill_child(&mut main_forward);
            for child in &mut extra_forwards {
                kill_child(child);
            }
            kill_child(&mut master);
            return Err(err);
        }

        let local_url = format!("http://127.0.0.1:{local_port}");
        let label = build_display_label(&instance);
        let _ = update_ssh_host_url(&id, &label, &local_url);
        if instance.local_forward.preferred_local_port != Some(local_port) {
            let _ = persist_local_port_for_instance(&id, local_port);
        }

        self.sessions.lock().expect("ssh sessions mutex").insert(
            id.clone(),
            SshSession {
                instance: instance.clone(),
                parsed,
                session_dir,
                control_path,
                local_port,
                remote_port,
                started_by_us,
                master,
                master_detached: false,
                main_forward,
                main_forward_detached,
                extra_forwards,
            },
        );

        self.clear_retry_attempt(&id);
        self.set_status(
            app,
            &id,
            DesktopSshPhase::Ready,
            if extra_errors.is_empty() {
                Some("SSH instance is ready".to_string())
            } else {
                Some(format!(
                    "SSH instance is ready with forward warnings: {}",
                    extra_errors.join("; ")
                ))
            },
            Some(local_url),
            Some(local_port),
            Some(remote_port),
            started_by_us,
            0,
            false,
        );

        self.spawn_monitor(app.clone(), id);
        Ok(())
    }

    fn spawn_monitor(self: &Arc<Self>, app: AppHandle, id: String) {
        self.cancel_monitor_task(&id);
        let inner = Arc::clone(self);
        let id_for_task = id.clone();
        let handle = tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;

                let mut dropped_reason: Option<String> = None;
                let mut detached_notice: Option<String> = None;
                {
                    let mut sessions = inner.sessions.lock().expect("ssh sessions mutex");
                    let Some(session) = sessions.get_mut(&id_for_task) else {
                        break;
                    };

                    let mut main_anchor_alive = false;

                    if !session.main_forward_detached {
                        if let Some(status) = session.main_forward.try_wait().ok().flatten() {
                            if status.success() {
                                session.main_forward_detached = true;
                                detached_notice = Some(
                                    "Main tunnel helper exited after ControlMaster handoff"
                                        .to_string(),
                                );
                            } else {
                                let mut stderr = String::new();
                                if let Some(mut stream) = session.main_forward.stderr.take() {
                                    let _ = stream.read_to_string(&mut stderr);
                                }
                                dropped_reason = Some(if stderr.trim().is_empty() {
                                    format!("Main SSH forward exited ({status})")
                                } else {
                                    format!("Main SSH forward exited ({status}): {}", stderr.trim())
                                });
                            }
                        } else {
                            main_anchor_alive = true;
                        }
                    }

                    if dropped_reason.is_none() {
                        if main_anchor_alive {
                            if !session.master_detached {
                                if let Some(status) = session.master.try_wait().ok().flatten() {
                                    if status.success()
                                        && is_control_master_alive(
                                            &session.parsed,
                                            &session.control_path,
                                        )
                                    {
                                        session.master_detached = true;
                                        if detached_notice.is_none() {
                                            detached_notice = Some(
                                                "SSH ControlMaster transitioned to detached background mode"
                                                    .to_string(),
                                            );
                                        }
                                    } else {
                                        detached_notice = Some(
                                            "SSH ControlMaster exited while main tunnel is still active"
                                                .to_string(),
                                        );
                                    }
                                }
                            } else if !is_control_master_alive(
                                &session.parsed,
                                &session.control_path,
                            ) {
                                detached_notice = Some(
                                    "SSH ControlMaster is not reachable; main tunnel remains active"
                                        .to_string(),
                                );
                            }
                        } else if session.master_detached {
                            if !is_control_master_alive(&session.parsed, &session.control_path) {
                                if is_local_tunnel_reachable(session.local_port) {
                                    if detached_notice.is_none() {
                                        detached_notice = Some(
                                            "SSH ControlMaster check failed but local tunnel is still reachable"
                                                .to_string(),
                                        );
                                    }
                                } else {
                                    dropped_reason =
                                        Some("SSH ControlMaster is not reachable".to_string());
                                }
                            }
                        } else if let Some(status) = session.master.try_wait().ok().flatten() {
                            if status.success()
                                && is_control_master_alive(&session.parsed, &session.control_path)
                            {
                                session.master_detached = true;
                                if detached_notice.is_none() {
                                    detached_notice = Some(
                                        "SSH ControlMaster transitioned to detached background mode"
                                            .to_string(),
                                    );
                                }
                            } else {
                                let mut stderr = String::new();
                                if let Some(mut stream) = session.master.stderr.take() {
                                    let _ = stream.read_to_string(&mut stderr);
                                }
                                dropped_reason = Some(if stderr.trim().is_empty() {
                                    format!("SSH ControlMaster exited ({status})")
                                } else {
                                    format!(
                                        "SSH ControlMaster exited ({status}): {}",
                                        stderr.trim()
                                    )
                                });
                            }
                        }
                    }
                }

                if let Some(message) = detached_notice {
                    inner.append_log_with_level(&id_for_task, "INFO", message);
                }

                if dropped_reason.is_none() {
                    continue;
                }

                let dropped_reason =
                    dropped_reason.unwrap_or_else(|| "SSH connection dropped".to_string());
                inner.append_log_with_level(&id_for_task, "WARN", dropped_reason.clone());

                inner.disconnect_internal(&app, &id_for_task, false);
                let attempt = inner.next_retry_attempt(&id_for_task);

                if attempt > DEFAULT_RECONNECT_MAX_ATTEMPTS {
                    inner.set_status(
                        &app,
                        &id_for_task,
                        DesktopSshPhase::Error,
                        Some(format!("{dropped_reason}. Retry limit reached")),
                        None,
                        None,
                        None,
                        false,
                        attempt,
                        true,
                    );
                    break;
                }

                inner.set_status(
                    &app,
                    &id_for_task,
                    DesktopSshPhase::Degraded,
                    Some(format!("{dropped_reason}. Reconnecting")),
                    None,
                    None,
                    None,
                    false,
                    attempt,
                    false,
                );

                let delay_ms =
                    (2u64.saturating_pow(attempt.saturating_sub(1))).saturating_mul(1000);
                let jitter = (now_millis() % 700).saturating_add(100);
                tokio::time::sleep(Duration::from_millis(
                    delay_ms.min(30_000).saturating_add(jitter),
                ))
                .await;

                if let Err(err) = inner.start_connect(app.clone(), id_for_task.clone()) {
                    inner.set_status(
                        &app,
                        &id_for_task,
                        DesktopSshPhase::Error,
                        Some(err),
                        None,
                        None,
                        None,
                        false,
                        attempt,
                        true,
                    );
                }
                break;
            }

            inner
                .monitor_tasks
                .lock()
                .expect("ssh monitor task mutex")
                .remove(&id_for_task);
        });
        self.monitor_tasks
            .lock()
            .expect("ssh monitor task mutex")
            .insert(id, handle);
    }

    fn start_connect(self: &Arc<Self>, app: AppHandle, id: String) -> Result<(), String> {
        let config = read_desktop_ssh_instances_from_disk();
        let Some(instance) = config.instances.into_iter().find(|item| item.id == id) else {
            return Err("SSH instance not found".to_string());
        };

        if self
            .connect_tasks
            .lock()
            .expect("ssh connect task mutex")
            .contains_key(&id)
        {
            self.append_log_with_level(&id, "INFO", "Connection already in progress");
            return Ok(());
        }

        if self.session_is_alive(&id) {
            let snapshot = self.status_snapshot_for_instance(&id);
            self.set_status(
                &app,
                &id,
                DesktopSshPhase::Ready,
                Some("SSH session already active".to_string()),
                snapshot.local_url,
                snapshot.local_port,
                snapshot.remote_port,
                snapshot.started_by_us,
                snapshot.retry_attempt,
                false,
            );
            self.append_log_with_level(
                &id,
                "INFO",
                "Connection already active; reusing existing SSH session",
            );
            return Ok(());
        }

        let retry_attempt = self.current_retry_attempt(&id);
        let connect_attempt = self.next_connect_attempt(&id);
        self.append_attempt_separator(&id, connect_attempt, retry_attempt);
        self.append_log(&id, "Starting SSH connection");
        self.disconnect_internal(&app, &id, false);

        let id_for_task = id.clone();
        let inner = Arc::clone(self);
        let app_for_task = app.clone();
        let handle = tauri::async_runtime::spawn(async move {
            let result = tauri::async_runtime::spawn_blocking({
                let inner = Arc::clone(&inner);
                let app = app_for_task.clone();
                let instance = instance.clone();
                move || inner.connect_blocking(&app, instance)
            })
            .await;

            match result {
                Ok(Ok(())) => {}
                Ok(Err(err)) => {
                    inner.set_status(
                        &app_for_task,
                        &id_for_task,
                        DesktopSshPhase::Error,
                        Some(err.to_string()),
                        None,
                        None,
                        None,
                        false,
                        0,
                        true,
                    );
                    inner.disconnect_internal(&app_for_task, &id_for_task, false);
                }
                Err(err) => {
                    inner.set_status(
                        &app_for_task,
                        &id_for_task,
                        DesktopSshPhase::Error,
                        Some(format!("SSH task failed: {err}")),
                        None,
                        None,
                        None,
                        false,
                        0,
                        true,
                    );
                    inner.disconnect_internal(&app_for_task, &id_for_task, false);
                }
            }

            inner
                .connect_tasks
                .lock()
                .expect("ssh connect task mutex")
                .remove(&id_for_task);
        });

        self.connect_tasks
            .lock()
            .expect("ssh connect task mutex")
            .insert(id, handle);

        Ok(())
    }

    fn statuses_with_defaults(&self) -> Vec<DesktopSshInstanceStatus> {
        let config = read_desktop_ssh_instances_from_disk();
        let statuses = self.statuses.lock().expect("ssh status mutex");
        let mut result = Vec::new();

        for instance in config.instances {
            result.push(
                statuses
                    .get(&instance.id)
                    .cloned()
                    .unwrap_or_else(|| DesktopSshInstanceStatus::idle(instance.id)),
            );
        }

        result.sort_by(|a, b| a.id.cmp(&b.id));
        result
    }
}

#[tauri::command]
pub fn desktop_ssh_logs(
    state: State<'_, DesktopSshManagerState>,
    id: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let id = id.trim().to_string();
    if id.is_empty() || id == LOCAL_HOST_ID {
        return Err("SSH instance id is required".to_string());
    }
    let cap = limit.unwrap_or(200).min(MAX_LOG_LINES_PER_INSTANCE);
    Ok(state.inner.logs_for_instance(&id, cap))
}

#[tauri::command]
pub fn desktop_ssh_logs_clear(
    state: State<'_, DesktopSshManagerState>,
    id: String,
) -> Result<(), String> {
    let id = id.trim().to_string();
    if id.is_empty() || id == LOCAL_HOST_ID {
        return Err("SSH instance id is required".to_string());
    }
    state.inner.clear_logs_for_instance(&id);
    Ok(())
}

impl DesktopSshManagerState {
    pub fn shutdown_all(&self, app: &AppHandle) {
        let ids: Vec<String> = self
            .inner
            .sessions
            .lock()
            .expect("ssh sessions mutex")
            .keys()
            .cloned()
            .collect();
        for id in ids {
            self.inner.disconnect_internal(app, &id, false);
        }

        let connect_ids: Vec<String> = self
            .inner
            .connect_tasks
            .lock()
            .expect("ssh connect task mutex")
            .keys()
            .cloned()
            .collect();
        for id in connect_ids {
            self.inner.cancel_connect_task(&id);
        }

        let monitor_ids: Vec<String> = self
            .inner
            .monitor_tasks
            .lock()
            .expect("ssh monitor task mutex")
            .keys()
            .cloned()
            .collect();
        for id in monitor_ids {
            self.inner.cancel_monitor_task(&id);
        }
    }
}

#[tauri::command]
pub fn desktop_ssh_instances_get() -> Result<DesktopSshInstancesConfig, String> {
    Ok(read_desktop_ssh_instances_from_disk())
}

#[tauri::command]
pub fn desktop_ssh_instances_set(config: DesktopSshInstancesConfig) -> Result<(), String> {
    write_desktop_ssh_instances_to_path(&settings_file_path(), config)
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn desktop_ssh_import_hosts() -> Result<Vec<DesktopSshImportCandidate>, String> {
    let mut candidates = Vec::new();

    if let Some(home) = std::env::var_os("HOME") {
        let user_config = PathBuf::from(home).join(".ssh").join("config");
        candidates.extend(parse_ssh_config_candidates(&user_config, "user"));
    }
    candidates.extend(parse_ssh_config_candidates(
        Path::new("/etc/ssh/ssh_config"),
        "global",
    ));

    let mut seen = HashSet::new();
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
    if id.is_empty() || id == LOCAL_HOST_ID {
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
    if id.is_empty() || id == LOCAL_HOST_ID {
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
            connection_timeout_sec: DEFAULT_CONNECTION_TIMEOUT_SEC,
            remote_openchamber: DesktopSshRemoteOpenchamberConfig::default(),
            local_forward: DesktopSshLocalForwardConfig::default(),
            auth: DesktopSshAuthConfig::default(),
            port_forwards: Vec::new(),
        }
    }

    #[test]
    fn parse_ssh_command_accepts_supported_options() {
        let parsed = parse_ssh_command(
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
        let err = parse_ssh_command("ssh -M user@example.com")
            .expect_err("should reject control master flag");
        assert!(err.to_string().contains("not allowed"));
    }

    #[test]
    fn parse_ssh_command_rejects_disallowed_controlpath_option() {
        let err = parse_ssh_command("ssh -o ControlPath=/tmp/ssh.sock user@example.com")
            .expect_err("should reject controlpath override");
        assert!(err.to_string().contains("not allowed"));
    }

    #[test]
    fn parse_ssh_command_keeps_ipv6_destination() {
        let parsed =
            parse_ssh_command("ssh user@[2001:db8::1]:2222").expect("parsed ipv6 destination");
        assert_eq!(parsed.destination, "user@[2001:db8::1]:2222");
    }

    #[test]
    fn sync_desktop_hosts_removes_deleted_ssh_hosts() {
        let mut root = json!({
            "desktopHosts": [
                {"id": "ssh-old", "label": "Old", "url": "http://127.0.0.1:1"},
                {"id": "http-1", "label": "HTTP", "url": "https://example.com"}
            ],
            "desktopDefaultHostId": "ssh-old"
        });

        let mut previous = HashSet::new();
        previous.insert("ssh-old".to_string());

        let next = vec![sample_instance("ssh-new", "ssh user@example.com")];
        sync_desktop_hosts_for_ssh(&mut root, &previous, &next);

        let hosts = root
            .get("desktopHosts")
            .and_then(Value::as_array)
            .expect("hosts array");
        assert_eq!(hosts.len(), 2);
        assert!(hosts
            .iter()
            .any(|item| item.get("id") == Some(&Value::String("http-1".to_string()))));
        assert!(hosts
            .iter()
            .any(|item| item.get("id") == Some(&Value::String("ssh-new".to_string()))));
        assert_eq!(
            root.get("desktopDefaultHostId").and_then(Value::as_str),
            Some("local")
        );
    }

    #[test]
    fn parse_ssh_config_candidates_extracts_host_entries() {
        let temp =
            std::env::temp_dir().join(format!("openchamber-ssh-import-{}.txt", now_millis()));
        fs::write(
            &temp,
            "\nHost prod\n  HostName 10.0.0.1\nHost *.dev !skip\nHost *\n",
        )
        .expect("write temp");

        let candidates = parse_ssh_config_candidates(&temp, "user");
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

        let normalized = sanitize_instance(instance).expect("sanitize instance");
        assert_eq!(
            normalized.connection_timeout_sec,
            DEFAULT_CONNECTION_TIMEOUT_SEC
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
            parse_probe_status_line(Some("INFO_STATUS=401"), "INFO_STATUS="),
            Some(401)
        );
        assert_eq!(
            parse_probe_status_line(Some("INFO_STATUS=abc"), "INFO_STATUS="),
            None
        );
        assert_eq!(
            parse_probe_status_line(Some("WRONG=200"), "INFO_STATUS="),
            None
        );
    }

    #[test]
    fn liveness_status_accepts_success_and_auth_challenges() {
        assert!(is_liveness_http_status(200));
        assert!(is_liveness_http_status(204));
        assert!(is_liveness_http_status(401));
        assert!(is_liveness_http_status(403));
        assert!(!is_liveness_http_status(500));
        assert!(!is_liveness_http_status(0));
    }
}

use serde::{Deserialize, Serialize};

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
    #[serde(default = "super::default_true")]
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
    #[serde(default = "super::default_local_bind_host")]
    pub bind_host: String,
}

impl Default for DesktopSshLocalForwardConfig {
    fn default() -> Self {
        Self {
            preferred_local_port: None,
            bind_host: super::default_local_bind_host(),
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
    #[serde(default = "super::default_true")]
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
    #[serde(default = "super::default_connection_timeout")]
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
    pub(crate) fn idle(id: impl Into<String>) -> Self {
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
            updated_at_ms: super::now_millis(),
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

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteSystemInfo {
    pub(crate) openchamber_version: Option<String>,
    pub(crate) runtime: Option<String>,
    pub(crate) pid: Option<u64>,
    pub(crate) started_at: Option<String>,
}

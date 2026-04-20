use anyhow::{anyhow, Result};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Child,
    sync::{Arc, Mutex},
    time::Duration,
};
use super::now_millis;
use tauri::{AppHandle, Emitter};

use super::config::*;
use super::process::*;
use super::remote::*;
use super::types::*;

const LOCAL_HOST_ID: &str = "local";
const SSH_STATUS_EVENT: &str = "openchamber:ssh-instance-status";
const DEFAULT_RECONNECT_MAX_ATTEMPTS: u32 = 5;
const MAX_LOG_LINES_PER_INSTANCE: usize = 1200;

/// Monitor starts with fast polling and relaxes to steady-state after stabilization.
const MONITOR_INITIAL_POLL_SECS: u64 = 2;
const MONITOR_STEADY_POLL_SECS: u64 = 10;
/// Number of healthy ticks before switching from initial to steady-state polling.
const MONITOR_STABILIZE_TICKS: u32 = 5;

pub(crate) struct SshSession {
    pub(crate) instance: DesktopSshInstance,
    pub(crate) parsed: DesktopSshParsedCommand,
    pub(crate) session_dir: PathBuf,
    pub(crate) control_path: PathBuf,
    pub(crate) local_port: u16,
    pub(crate) remote_port: u16,
    pub(crate) started_by_us: bool,
    pub(crate) master: Child,
    pub(crate) master_detached: bool,
    pub(crate) main_forward: Child,
    pub(crate) main_forward_detached: bool,
    pub(crate) extra_forwards: Vec<Child>,
    pub(crate) askpass_secret_file: Option<PathBuf>,
}

#[derive(Default)]
pub(crate) struct DesktopSshManagerInner {
    pub(crate) statuses: Mutex<HashMap<String, DesktopSshInstanceStatus>>,
    pub(crate) logs: Mutex<HashMap<String, Vec<String>>>,
    pub(crate) sessions: Mutex<HashMap<String, SshSession>>,
    pub(crate) connect_tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    pub(crate) monitor_tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    pub(crate) reconnect_attempts: Mutex<HashMap<String, u32>>,
    pub(crate) connect_attempts: Mutex<HashMap<String, u32>>,
}

impl DesktopSshManagerInner {
    pub(crate) fn append_log_with_level(&self, id: &str, level: &str, message: impl Into<String>) {
        let line = format!("[{}] [{}] {}", now_millis(), level, message.into());
        let mut logs = self.logs.lock().unwrap_or_else(|e| e.into_inner());
        let entry = logs.entry(id.to_string()).or_default();
        entry.push(line);
        if entry.len() > MAX_LOG_LINES_PER_INSTANCE {
            let overflow = entry.len() - MAX_LOG_LINES_PER_INSTANCE;
            entry.drain(0..overflow);
        }
    }

    pub(crate) fn append_log(&self, id: &str, message: impl Into<String>) {
        self.append_log_with_level(id, "INFO", message);
    }

    pub(crate) fn append_attempt_separator(&self, id: &str, connect_attempt: u32, retry_attempt: u32) {
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

    pub(crate) fn logs_for_instance(&self, id: &str, limit: usize) -> Vec<String> {
        let logs = self.logs.lock().unwrap_or_else(|e| e.into_inner());
        let mut lines = logs.get(id).cloned().unwrap_or_default();
        if limit > 0 && lines.len() > limit {
            let keep_from = lines.len() - limit;
            lines.drain(0..keep_from);
        }
        lines
    }

    pub(crate) fn clear_logs_for_instance(&self, id: &str) {
        self.logs.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }

    pub(crate) fn status_snapshot_for_instance(&self, id: &str) -> DesktopSshInstanceStatus {
        self.statuses
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .unwrap_or_else(|| DesktopSshInstanceStatus::idle(id))
    }

    pub(crate) fn set_status(
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
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_string(), status.clone());
        let _ = app.emit(SSH_STATUS_EVENT, status);
    }

    pub(crate) fn clear_retry_attempt(&self, id: &str) {
        self.reconnect_attempts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }

    pub(crate) fn next_retry_attempt(&self, id: &str) -> u32 {
        let mut guard = self.reconnect_attempts.lock().unwrap_or_else(|e| e.into_inner());
        let next = guard.get(id).copied().unwrap_or(0).saturating_add(1);
        guard.insert(id.to_string(), next);
        next
    }

    pub(crate) fn current_retry_attempt(&self, id: &str) -> u32 {
        self.reconnect_attempts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .copied()
            .unwrap_or(0)
    }

    pub(crate) fn next_connect_attempt(&self, id: &str) -> u32 {
        let mut guard = self.connect_attempts.lock().unwrap_or_else(|e| e.into_inner());
        let next = guard.get(id).copied().unwrap_or(0).saturating_add(1);
        guard.insert(id.to_string(), next);
        next
    }

    pub(crate) fn cancel_connect_task(&self, id: &str) {
        if let Some(handle) = self
            .connect_tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
        {
            handle.abort();
        }
    }

    pub(crate) fn cancel_monitor_task(&self, id: &str) {
        if let Some(handle) = self
            .monitor_tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
        {
            handle.abort();
        }
    }

    pub(crate) fn session_is_alive(&self, id: &str) -> bool {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
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

    pub(crate) fn disconnect_internal(&self, app: &AppHandle, id: &str, report_idle: bool) {
        self.cancel_connect_task(id);
        self.cancel_monitor_task(id);

        if let Some(mut session) = self.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(id) {
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
            if let Some(secret_file) = session.askpass_secret_file {
                let _ = fs::remove_file(&secret_file);
            }
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

    pub(crate) fn ensure_remote_server(
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

    pub(crate) fn connect_blocking(
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
        // Clean up stale secret file from a previous crashed session.
        let _ = fs::remove_file(session_dir.join(".askpass-secret"));
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

        let (mut master, askpass_secret_file) = spawn_master_process(
            &parsed,
            &control_path,
            &askpass_path,
            &session_dir,
            instance.auth.ssh_password.as_ref().and_then(|secret| {
                if secret.enabled {
                    secret.value.as_deref()
                } else {
                    None
                }
            }),
        )?;

        // Helper: clean up secret file + kill master on early return.
        let cleanup_on_error = |master: &mut Child| {
            kill_child(master);
            if let Some(ref p) = askpass_secret_file {
                let _ = fs::remove_file(p);
            }
        };

        if let Err(err) = wait_for_master_ready(
            &parsed,
            &control_path,
            instance.connection_timeout_sec,
            &mut master,
        ) {
            cleanup_on_error(&mut master);
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
            cleanup_on_error(&mut master);
            return Err(anyhow!("Unsupported remote OS: {remote_os}"));
        }

        let (remote_port, started_by_us) =
            match self.ensure_remote_server(app, &instance, &parsed, &control_path) {
                Ok(result) => result,
                Err(err) => {
                    cleanup_on_error(&mut master);
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

        let bind_host = "127.0.0.1".to_string();
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
                    cleanup_on_error(&mut master);
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
                cleanup_on_error(&mut master);
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
            cleanup_on_error(&mut master);
            return Err(err);
        }

        let local_url = format!("http://127.0.0.1:{local_port}");
        let label = build_display_label(&instance);
        let _ = update_ssh_host_url(&id, &label, &local_url);
        if instance.local_forward.preferred_local_port != Some(local_port) {
            let _ = persist_local_port_for_instance(&id, local_port);
        }

        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).insert(
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
                askpass_secret_file,
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

    pub(crate) fn spawn_monitor(self: &Arc<Self>, app: AppHandle, id: String) {
        self.cancel_monitor_task(&id);
        let inner = Arc::clone(self);
        let id_for_task = id.clone();
        let handle = tauri::async_runtime::spawn(async move {
            let mut healthy_ticks: u32 = 0;
            loop {
                let poll_secs = if healthy_ticks >= MONITOR_STABILIZE_TICKS {
                    MONITOR_STEADY_POLL_SECS
                } else {
                    MONITOR_INITIAL_POLL_SECS
                };
                tokio::time::sleep(Duration::from_secs(poll_secs)).await;

                let mut dropped_reason: Option<String> = None;
                let mut detached_notice: Option<String> = None;
                {
                    let mut sessions = inner.sessions.lock().unwrap_or_else(|e| e.into_inner());
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
                            // Fast path: check local tunnel first (cheap TCP probe)
                            // before spawning an SSH subprocess for control master check.
                            if is_local_tunnel_reachable(session.local_port) {
                                // Tunnel is alive — skip expensive SSH check entirely.
                            } else if !is_control_master_alive(
                                &session.parsed,
                                &session.control_path,
                            ) {
                                dropped_reason =
                                    Some("SSH ControlMaster is not reachable".to_string());
                            } else {
                                detached_notice = Some(
                                    "Local tunnel unreachable but ControlMaster is alive"
                                        .to_string(),
                                );
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
                    healthy_ticks = healthy_ticks.saturating_add(1);
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
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id_for_task);
        });
        self.monitor_tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, handle);
    }

    pub(crate) fn start_connect(self: &Arc<Self>, app: AppHandle, id: String) -> Result<(), String> {
        let config = read_desktop_ssh_instances_from_disk();
        let Some(instance) = config.instances.into_iter().find(|item| item.id == id) else {
            return Err("SSH instance not found".to_string());
        };

        if self
            .connect_tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
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
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id_for_task);
        });

        self.connect_tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, handle);

        Ok(())
    }

    pub(crate) fn statuses_with_defaults(&self) -> Vec<DesktopSshInstanceStatus> {
        let config = read_desktop_ssh_instances_from_disk();
        let statuses = self.statuses.lock().unwrap_or_else(|e| e.into_inner());
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

#[derive(Default)]
pub struct DesktopSshManagerState {
    pub(crate) inner: Arc<DesktopSshManagerInner>,
}

impl DesktopSshManagerState {
    pub fn shutdown_all(&self, app: &AppHandle) {
        let ids: Vec<String> = self
            .inner
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
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
            .unwrap_or_else(|e| e.into_inner())
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
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        for id in monitor_ids {
            self.inner.cancel_monitor_task(&id);
        }
    }
}

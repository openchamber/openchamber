use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::process::DesktopSshParsedCommand;
use super::types::*;

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

pub(crate) fn current_remote_openchamber_version(
    parsed: &DesktopSshParsedCommand,
    control_path: &std::path::Path,
) -> Option<String> {
    super::process::run_remote_command(
        parsed,
        control_path,
        "openchamber --version 2>/dev/null || true",
        60,
    )
    .ok()
    .and_then(|value| parse_version_token(&value))
}

pub(crate) fn install_openchamber_managed(
    parsed: &DesktopSshParsedCommand,
    control_path: &std::path::Path,
    version: &str,
    preferred: &DesktopSshInstallMethod,
) -> Result<()> {
    let has_bun = super::process::remote_command_exists(parsed, control_path, "bun");
    let has_npm = super::process::remote_command_exists(parsed, control_path, "npm");

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
        match super::process::run_remote_command(parsed, control_path, &command, 60) {
            Ok(_) => return Ok(()),
            Err(err) => {
                last_error = Some(err);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow!("Failed to install OpenChamber on remote host")))
}

pub(crate) fn parse_probe_status_line(line: Option<&str>, prefix: &str) -> Option<u16> {
    let value = line?.strip_prefix(prefix)?.trim();
    value.parse::<u16>().ok()
}

fn is_auth_http_status(status: u16) -> bool {
    status == 401 || status == 403
}

pub(crate) fn is_liveness_http_status(status: u16) -> bool {
    (200..=299).contains(&status) || is_auth_http_status(status)
}

pub(crate) fn configured_openchamber_password(instance: &DesktopSshInstance) -> Option<&str> {
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

pub(crate) fn probe_remote_system_info(
    parsed: &DesktopSshParsedCommand,
    control_path: &std::path::Path,
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
        auth_payload = super::process::shell_quote(&auth_payload),
    );
    let output = super::process::run_remote_command(parsed, control_path, &script, 60)?;

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

pub(crate) fn remote_server_running(
    parsed: &DesktopSshParsedCommand,
    control_path: &std::path::Path,
    port: u16,
    openchamber_password: Option<&str>,
) -> bool {
    probe_remote_system_info(parsed, control_path, port, openchamber_password).is_ok()
}

pub(crate) fn random_port_candidate(seed: &str) -> u16 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    seed.hash(&mut hasher);
    super::now_millis().hash(&mut hasher);
    let value = hasher.finish();
    let base = 20_000u16;
    let span = 30_000u16;
    base + ((value % span as u64) as u16)
}

pub(crate) fn start_remote_server_managed(
    parsed: &DesktopSshParsedCommand,
    control_path: &std::path::Path,
    instance: &DesktopSshInstance,
    desired_port: u16,
) -> Result<u16> {
    let script = if let Some(secret) = instance
        .auth
        .openchamber_password
        .as_ref()
        .and_then(|v| if v.enabled { v.value.clone() } else { None })
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        // Sanitize: strip newlines and the heredoc delimiter to prevent injection.
        let safe_secret = secret.replace('\n', "").replace("OPENCHAMBER_EOF", "");
        // Write password to a mktemp file (avoids symlink races on shared /tmp),
        // source it to set the env var, then run the daemon (which inherits it),
        // and clean up the file after the daemon forks.
        format!(
            "ENV_FILE=\"$(mktemp)\" && umask 077 && chmod 600 \"$ENV_FILE\" && cat > \"$ENV_FILE\" << 'OPENCHAMBER_EOF'\nOPENCHAMBER_UI_PASSWORD={password}\nOPENCHAMBER_EOF\nOPENCHAMBER_RUNTIME=ssh-remote . \"$ENV_FILE\" && openchamber serve --daemon --hostname 127.0.0.1 --port {port} && rm -f \"$ENV_FILE\"",
            port = desired_port,
            password = safe_secret,
        )
    } else {
        format!(
            "OPENCHAMBER_RUNTIME=ssh-remote openchamber serve --daemon --hostname 127.0.0.1 --port {}",
            desired_port
        )
    };

    let output = super::process::run_remote_command(parsed, control_path, &script, 60)?;

    if let Some(port) = output
        .split_whitespace()
        .find_map(|token| token.parse::<u16>().ok())
    {
        return Ok(port);
    }
    Ok(desired_port)
}

pub(crate) fn stop_remote_server_best_effort(
    parsed: &DesktopSshParsedCommand,
    control_path: &std::path::Path,
    remote_port: u16,
) {
    let script = format!(
        "if command -v curl >/dev/null 2>&1; then curl -fsS -X POST http://127.0.0.1:{remote_port}/api/system/shutdown >/dev/null 2>&1 || true; elif command -v wget >/dev/null 2>&1; then wget -qO- --method=POST http://127.0.0.1:{remote_port}/api/system/shutdown >/dev/null 2>&1 || true; fi"
    );
    let _ = super::process::run_remote_command(parsed, control_path, &script, 60);
}

pub(crate) fn spawn_main_forward(
    parsed: &DesktopSshParsedCommand,
    control_path: &std::path::Path,
    bind_host: &str,
    local_port: u16,
    remote_port: u16,
) -> Result<std::process::Child> {
    let args = vec![
        "-o".to_string(),
        "ControlMaster=no".to_string(),
        "-o".to_string(),
        format!("ControlPath={}", control_path.display()),
        "-N".to_string(),
        "-L".to_string(),
        format!("{bind_host}:{local_port}:127.0.0.1:{remote_port}"),
    ];
    let mut command = super::process::build_ssh_command(parsed, &args, None);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to start main SSH forward on local port {local_port}"))
}

pub(crate) fn spawn_extra_forward(
    parsed: &DesktopSshParsedCommand,
    control_path: &std::path::Path,
    forward: &DesktopSshPortForward,
) -> Result<()> {
    use super::types::DesktopSshPortForwardType;

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

    let mut command = super::process::build_ssh_command(parsed, &args, None);
    let (code, stdout, stderr) = super::process::run_output(&mut command)
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

pub(crate) fn is_local_port_available(bind_host: &str, port: u16) -> bool {
    std::net::TcpListener::bind(format!("{bind_host}:{port}")).is_ok()
}

pub(crate) fn pick_unused_local_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

pub(crate) fn is_local_tunnel_reachable(local_port: u16) -> bool {
    let addr = format!("127.0.0.1:{local_port}");
    let Ok(parsed) = addr.parse() else {
        return false;
    };
    std::net::TcpStream::connect_timeout(&parsed, std::time::Duration::from_millis(500)).is_ok()
}

pub(crate) fn wait_local_forward_ready(local_port: u16) -> Result<()> {
    const DEFAULT_READY_TIMEOUT_SEC: u64 = 30;
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_secs(DEFAULT_READY_TIMEOUT_SEC);
    let addr: std::net::SocketAddr = format!("127.0.0.1:{local_port}").parse()?;
    let mut poll_ms: u64 = 250;
    while std::time::Instant::now() < deadline {
        if let Ok(mut stream) =
            std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(1000))
        {
            use std::io::{Read as IoRead, Write};
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(1000)));
            let _ = stream.set_write_timeout(Some(std::time::Duration::from_millis(1000)));
            let request = format!(
                "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{local_port}\r\nConnection: close\r\n\r\n"
            );
            if stream.write_all(request.as_bytes()).is_ok() {
                let mut buf = [0u8; 32];
                if let Ok(n) = stream.read(&mut buf) {
                    let head = std::str::from_utf8(&buf[..n]).unwrap_or("");
                    // Match "HTTP/1.x 2xx" or "HTTP/1.x 401"
                    if head.starts_with("HTTP/1.") && (head.contains(" 2") || head.contains(" 401"))
                    {
                        return Ok(());
                    }
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(poll_ms));
        poll_ms = (poll_ms * 2).min(2000);
    }
    Err(anyhow!(
        "Timed out waiting for forwarded OpenChamber health"
    ))
}

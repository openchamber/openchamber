use anyhow::{anyhow, Context, Result};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub use super::types::DesktopSshParsedCommand;

pub(crate) fn split_shell_words(input: &str) -> Result<Vec<String>> {
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

pub(crate) fn parse_ssh_command(raw: &str) -> Result<DesktopSshParsedCommand> {
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

pub(crate) fn shell_quote(value: &str) -> String {
    let escaped = value.replace('\'', "'\\''");
    format!("'{escaped}'")
}

pub(crate) fn run_output(command: &mut Command) -> Result<(i32, String, String)> {
    let output = command
        .output()
        .with_context(|| format!("failed to execute command: {:?}", command))?;

    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok((code, stdout, stderr))
}

pub(crate) fn build_ssh_command(
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

pub(crate) fn resolve_ssh_config(
    parsed: &DesktopSshParsedCommand,
) -> Result<std::collections::HashMap<String, String>> {
    let args = vec!["-G".to_string()];
    let mut command = build_ssh_command(parsed, &args, None);
    let (code, stdout, stderr) = run_output(&mut command)?;
    if code != 0 {
        return Err(anyhow!(stderr.trim().to_string()));
    }

    let mut resolved = std::collections::HashMap::new();
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

pub(crate) fn ensure_session_dir(instance_id: &str) -> Result<PathBuf> {
    let base = crate::settings::settings_file_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("ssh")
        .join(instance_id);
    fs::create_dir_all(&base)?;
    Ok(base)
}

pub(crate) fn control_path_for_instance(_session_dir: &Path, instance_id: &str) -> PathBuf {
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
ASKPASS_FILE="${OPENCHAMBER_SSH_ASKPASS_FILE:-}"

if [[ -n "$ASKPASS_FILE" && -r "$ASKPASS_FILE" ]]; then
  if [[ "$PROMPT" == *"assword"* || "$PROMPT" == *"passphrase"* ]]; then
    cat "$ASKPASS_FILE"
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

pub(crate) fn write_askpass_script(path: &Path) -> Result<()> {
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

pub(crate) fn spawn_master_process(
    parsed: &DesktopSshParsedCommand,
    control_path: &Path,
    askpass_path: &Path,
    session_dir: &Path,
    ssh_password: Option<&str>,
) -> Result<(Child, Option<PathBuf>)> {
    let mut secret_file_path: Option<PathBuf> = None;

    if let Some(secret) = ssh_password.filter(|value| !value.trim().is_empty()) {
        // Write password to a temporary file with restrictive permissions
        let secret_file = session_dir.join(".askpass-secret");
        fs::write(&secret_file, secret.trim())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perm = fs::metadata(&secret_file)?.permissions();
            perm.set_mode(0o600);
            fs::set_permissions(&secret_file, perm)?;
        }
        secret_file_path = Some(secret_file);
    }

    const DEFAULT_CONTROL_PERSIST_SEC: u16 = 300;
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

    if let Some(ref path) = secret_file_path {
        command.env("OPENCHAMBER_SSH_ASKPASS_FILE", path);
    }

    let child = command.spawn().with_context(|| {
        format!(
            "failed to start SSH ControlMaster for {}",
            parsed.destination
        )
    })?;

    Ok((child, secret_file_path))
}

pub(crate) fn wait_for_master_ready(
    parsed: &DesktopSshParsedCommand,
    control_path: &Path,
    timeout_sec: u16,
    master: &mut Child,
) -> Result<()> {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_sec as u64);
    let mut poll_ms: u64 = 250;
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

        std::thread::sleep(Duration::from_millis(poll_ms));
        poll_ms = (poll_ms * 2).min(2000);
    }

    Err(anyhow!("SSH ControlMaster connection timed out"))
}

pub(crate) fn control_master_operation(
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

pub(crate) fn is_control_master_alive(
    parsed: &DesktopSshParsedCommand,
    control_path: &Path,
) -> bool {
    control_master_operation(parsed, control_path, "check")
        .map(|(code, _, _)| code == 0)
        .unwrap_or(false)
}

pub(crate) fn stop_control_master_best_effort(
    parsed: &DesktopSshParsedCommand,
    control_path: &Path,
) {
    let _ = control_master_operation(parsed, control_path, "exit");
}

pub(crate) fn run_remote_command(
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

/// Direct variant of run_remote_command that takes parsed args instead of DesktopSshParsedCommand.
/// This is used by the SshRunner trait to enable unit testing.
pub(crate) fn run_remote_command_direct(
    parsed_args: &[String],
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
    let mut command = Command::new("ssh");
    command.args(parsed_args).args(&args).arg(&remote);
    let (code, stdout, stderr) = run_output(&mut command)?;
    if code != 0 {
        if stderr.trim().is_empty() {
            return Err(anyhow!("Remote command failed"));
        }
        return Err(anyhow!(stderr.trim().to_string()));
    }
    Ok(stdout)
}

pub(crate) fn remote_command_exists(
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
        60,
    )
    .map(|output| output.trim() == "yes")
    .unwrap_or(false)
}

pub(crate) fn kill_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

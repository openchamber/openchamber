use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, path::Path};

use super::types::*;
use crate::settings::settings_file_path;

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

pub fn build_display_label(instance: &DesktopSshInstance) -> String {
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

pub(crate) fn read_desktop_ssh_instances_from_path(path: &Path) -> DesktopSshInstancesConfig {
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
        if id.is_empty() || id == "local" || seen.contains(&id) {
            continue;
        }
        instance.id = id.clone();
        instance.connection_timeout_sec = if instance.connection_timeout_sec == 0 {
            60
        } else {
            instance.connection_timeout_sec
        };
        if instance.local_forward.bind_host.trim().is_empty() {
            instance.local_forward.bind_host = super::default_local_bind_host();
        }
        if instance.ssh_parsed.is_none() {
            if let Ok(parsed) = super::process::parse_ssh_command(&instance.ssh_command) {
                instance.ssh_parsed = Some(parsed);
            }
        }
        seen.insert(id);
        instances.push(instance);
    }

    DesktopSshInstancesConfig { instances }
}

pub(crate) fn read_desktop_ssh_instances_from_disk() -> DesktopSshInstancesConfig {
    read_desktop_ssh_instances_from_path(&settings_file_path())
}

fn sanitize_bind_host(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "127.0.0.1".to_string();
    }
    match trimmed {
        "127.0.0.1" | "localhost" | "0.0.0.0" => trimmed.to_string(),
        _ => "127.0.0.1".to_string(),
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
        .or_else(|| Some("127.0.0.1".to_string()));

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

pub(crate) fn sanitize_instance(mut instance: DesktopSshInstance) -> Result<DesktopSshInstance> {
    instance.id = instance.id.trim().to_string();
    if instance.id.is_empty() || instance.id == "local" {
        return Err(anyhow!("SSH instance id is required"));
    }
    instance.ssh_command = instance.ssh_command.trim().to_string();
    if instance.ssh_command.is_empty() {
        return Err(anyhow!("SSH command is required"));
    }
    if instance.connection_timeout_sec == 0 {
        instance.connection_timeout_sec = 60;
    }
    instance.local_forward.bind_host = sanitize_bind_host(&instance.local_forward.bind_host);
    let parsed = super::process::parse_ssh_command(&instance.ssh_command)?;
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

pub(crate) fn sync_desktop_hosts_for_ssh(
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
        root["desktopDefaultHostId"] = Value::String("local".to_string());
    }
}

pub(crate) fn write_desktop_ssh_instances_to_path(
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

pub(crate) fn update_ssh_host_url(instance_id: &str, label: &str, local_url: &str) -> Result<()> {
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

pub(crate) fn persist_local_port_for_instance(instance_id: &str, local_port: u16) -> Result<()> {
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

pub(crate) fn parse_ssh_config_candidates(
    path: &Path,
    source: &str,
) -> Vec<DesktopSshImportCandidate> {
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

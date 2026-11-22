import fs from 'fs';
import os from 'os';
import path from 'path';

import { readBoundedFileSync } from '../../server/lib/shared/bounded-file-read.js';

// CLI state files are small JSON documents the CLI itself writes; 1 MiB is
// far above any legitimate settings/state payload. Readers go through the
// shared bounded reader (#1706, design #1655): a FIFO or other non-regular
// file at a state path is refused promptly instead of blocking the CLI in
// open(), and an over-cap file yields the caller's default, never a parse.
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_TUNNEL_CLI_STATE_BYTES = 1024 * 1024;

function readBoundedJsonSync(filePath, maxBytes) {
  const result = readBoundedFileSync(filePath, maxBytes);
  if (!result.ok) {
    return undefined;
  }
  return JSON.parse(result.buffer.toString('utf8'));
}

const TUNNEL_PROFILES_FILE_NAME = 'tunnel-profiles.json';
const LEGACY_CLOUDFLARE_MANAGED_REMOTE_FILE_NAME = 'cloudflare-managed-remote-tunnels.json';
const TUNNEL_CLI_STATE_FILE_NAME = 'tunnel-cli-state.json';

function getDataDir() {
  if (typeof process.env.OPENCHAMBER_DATA_DIR === 'string' && process.env.OPENCHAMBER_DATA_DIR.trim().length > 0) {
    return path.resolve(process.env.OPENCHAMBER_DATA_DIR.trim());
  }
  return path.join(os.homedir(), '.config', 'openchamber');
}

function getLogsDir() {
  return path.join(getDataDir(), 'logs');
}

function getSettingsFilePath() {
  return path.join(getDataDir(), 'settings.json');
}

function readDesktopLocalPortFromSettings() {
  try {
    const parsed = readBoundedJsonSync(getSettingsFilePath(), MAX_SETTINGS_BYTES);
    const value = parsed?.desktopLocalPort;
    if (Number.isFinite(value) && value > 0 && value <= 65535) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

function readDesktopLocalClientTokenFromSettings() {
  try {
    const parsed = readBoundedJsonSync(getSettingsFilePath(), MAX_SETTINGS_BYTES);
    const value = parsed?.desktopLocalClientToken;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
  } catch {
    return '';
  }
}

function ensureLogsDir() {
  fs.mkdirSync(getLogsDir(), { recursive: true });
}

function getLogFilePath(port) {
  return path.join(getLogsDir(), `openchamber-${port}.log`);
}

function getTunnelProfilesFilePath() {
  return path.join(getDataDir(), TUNNEL_PROFILES_FILE_NAME);
}

function getLegacyCloudflareManagedRemoteFilePath() {
  return path.join(getDataDir(), LEGACY_CLOUDFLARE_MANAGED_REMOTE_FILE_NAME);
}

function getTunnelCliStateFilePath() {
  return path.join(getDataDir(), TUNNEL_CLI_STATE_FILE_NAME);
}

function readTunnelCliState() {
  const filePath = getTunnelCliStateFilePath();
  try {
    const parsed = readBoundedJsonSync(filePath, MAX_TUNNEL_CLI_STATE_BYTES);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function readLastManagedLocalConfigPath() {
  const state = readTunnelCliState();
  if (typeof state.lastManagedLocalConfigPath !== 'string') {
    return '';
  }
  return state.lastManagedLocalConfigPath.trim();
}

function writeLastManagedLocalConfigPath(configPath) {
  if (typeof configPath !== 'string' || configPath.trim().length === 0) {
    return;
  }
  const filePath = getTunnelCliStateFilePath();
  const current = readTunnelCliState();
  const next = {
    ...current,
    lastManagedLocalConfigPath: configPath.trim(),
    updatedAt: Date.now(),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
}


function getRunDir() {
  const dir = path.join(getDataDir(), 'run');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}


export {
  getDataDir,
  readDesktopLocalPortFromSettings,
  readDesktopLocalClientTokenFromSettings,
  ensureLogsDir,
  getLogFilePath,
  getTunnelProfilesFilePath,
  getLegacyCloudflareManagedRemoteFilePath,
  readLastManagedLocalConfigPath,
  writeLastManagedLocalConfigPath,
  getRunDir,
};

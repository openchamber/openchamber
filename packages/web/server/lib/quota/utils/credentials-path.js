/**
 * Credential path resolution
 *
 * Resolves OpenChamber data directory paths for managed credential storage
 * and legacy opencode/mystatus paths for read-only import.
 *
 * Rules:
 * - Managed credential writes MUST go under OpenChamber data dir (quota/credentials/).
 * - Legacy reads MAY discover configured files in ~/.config/opencode/ and
 *   ~/.local/share/opencode/.
 * - Must NOT write to ~/.config/opencode/.
 *
 * @module quota/utils/credentials-path
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const OPENCODE_CONFIG_DIR = path.join(os.homedir(), '.config', 'opencode');
const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');

/**
 * Resolve the OpenChamber data directory.
 *
 * Honors OPENCHAMBER_DATA_DIR env var; defaults to ~/.config/openchamber.
 *
 * @returns {string}
 */
export function getOpenChamberDataDir() {
  return process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber');
}

/**
 * Resolve the quota credentials directory under the OpenChamber data dir.
 *
 * Managed credentials MUST be written here.
 *
 * @returns {string}
 */
export function getQuotaCredentialsDir() {
  return path.join(getOpenChamberDataDir(), 'quota', 'credentials');
}

/**
 * Resolve the legacy mystatus cookie file path for a provider.
 *
 * @param {string} providerId - e.g. 'atlas'
 * @returns {string|null} - e.g. ~/.config/opencode/atlas-cookies.json
 */
export function getLegacyMystatusPath(providerId) {
  if (!providerId) return null;
  return path.join(OPENCODE_CONFIG_DIR, `${providerId}-cookies.json`);
}

/**
 * Resolve a legacy opencode config/data file path.
 *
 * Checks ~/.config/opencode/<filename> first, then ~/.local/share/opencode/<filename>.
 * Returns the first existing path, defaulting to the config path when neither exists.
 *
 * @param {string} filename
 * @returns {string|null}
 */
export function getLegacyOpenCodePath(filename) {
  if (!filename) return null;
  const configPath = path.join(OPENCODE_CONFIG_DIR, filename);
  if (fs.existsSync(configPath)) return configPath;
  const dataPath = path.join(OPENCODE_DATA_DIR, filename);
  if (fs.existsSync(dataPath)) return dataPath;
  return configPath;
}

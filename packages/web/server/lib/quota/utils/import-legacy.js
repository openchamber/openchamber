/**
 * Legacy credential import helpers
 *
 * Safely discovers and reads legacy mystatus/opencode cookie files for
 * read-only import. Returns sanitized metadata only — never raw secrets.
 *
 * @module quota/utils/import-legacy
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

import { getLegacyMystatusPath } from './credentials-path.js';

const OPENCODE_CONFIG_DIR = path.join(os.homedir(), '.config', 'opencode');
const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');

/**
 * Safely read and parse a legacy cookie JSON file.
 *
 * Returns sanitized metadata (file path + timestamp) only.
 * Never returns parsed content or raw secrets.
 *
 * @param {string} filePath
 * @returns {Promise<{filePath: string, timestamp: number} | null>}
 */
export async function readLegacyCookieFile(filePath) {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    JSON.parse(trimmed);
    const stats = await fs.promises.stat(filePath);
    return {
      filePath,
      timestamp: stats.mtimeMs,
    };
  } catch {
    return null;
  }
}

/**
 * Discover legacy cookie files for a provider.
 *
 * Tries ~/.config/opencode/<providerId>-cookies.json first, then
 * ~/.local/share/opencode/<providerId>-cookies.json.
 *
 * @param {string} providerId
 * @returns {Promise<{filePath: string, timestamp: number, providerId: string} | null>}
 */
export async function discoverLegacyCredentials(providerId) {
  if (!providerId) return null;
  const filename = `${providerId}-cookies.json`;
  const candidatePaths = [
    getLegacyMystatusPath(providerId),
    path.join(OPENCODE_DATA_DIR, filename),
  ];
  for (const candidate of candidatePaths) {
    const result = await readLegacyCookieFile(candidate);
    if (result) {
      return { ...result, providerId };
    }
  }
  return null;
}

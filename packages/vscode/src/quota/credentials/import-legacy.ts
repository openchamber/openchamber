/**
 * Legacy credential import helpers
 *
 * Safely discovers and reads legacy mystatus/opencode cookie files for
 * read-only import. Returns sanitized metadata only — never raw secrets.
 *
 * @module quota/credentials/import-legacy
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { getLegacyMystatusPath } from '../credentials-path';

const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');

export interface LegacyCredentialDiscovery {
  filePath: string;
  timestamp: number;
  providerId: string;
}

/**
 * Safely read and parse a legacy cookie JSON file.
 *
 * Returns sanitized metadata (file path + timestamp) only.
 * Never returns parsed content or raw secrets.
 */
export async function readLegacyCookieFile(filePath: string): Promise<{ filePath: string; timestamp: number } | null> {
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
 */
export async function discoverLegacyCredentials(providerId: string): Promise<LegacyCredentialDiscovery | null> {
  if (!providerId) return null;
  const filename = `${providerId}-cookies.json`;
  const candidatePaths = [
    getLegacyMystatusPath(providerId),
    path.join(OPENCODE_DATA_DIR, filename),
  ];
  for (const candidate of candidatePaths) {
    if (!candidate) continue;
    const result = await readLegacyCookieFile(candidate);
    if (result) {
      return { ...result, providerId };
    }
  }
  return null;
}
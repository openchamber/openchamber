/**
 * READ-ONLY view of OpenCode's provider credentials.
 *
 * OpenCode 2.x imports the legacy `auth.json` once into its own database and
 * never writes the file again; credentials live behind `/api/integration` and
 * `/api/credential`, and there is no HTTP route that hands a key back.
 * OpenChamber needs the raw credential for provider quota lookups, voice keys
 * and the GitHub and Linear helpers, so `readAuthFile()` answers from the
 * database OpenCode actually uses (`credential-db.js`). A successful database
 * read is authoritative, including an empty one: OpenCode never clears
 * `auth.json` after importing it, and a credential the user removed in
 * OpenCode disappears only from the database, so mixing the file back in
 * would hand out the deleted key again. The legacy file is read only when the
 * database cannot be read at all (no sqlite runtime, no file, unknown
 * schema). The shape is the legacy `auth.json` map either way. Nothing here
 * writes: a write would be invisible to the running OpenCode and drift from
 * what it uses.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { readCredentialsFromDb, resolveCredentialDbPath } from './credential-db.js';

const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'auth.json');

function readLegacyAuthFile(authFile, fileSystem) {
  if (!fileSystem.existsSync(authFile)) {
    return {};
  }
  try {
    const content = fileSystem.readFileSync(authFile, 'utf8');
    const trimmed = content.trim();
    if (!trimmed) {
      return {};
    }
    return JSON.parse(trimmed);
  } catch (error) {
    console.error('Failed to read auth file:', error);
    throw new Error('Failed to read OpenCode auth configuration');
  }
}

/**
 * The credentials OpenCode uses, keyed by provider id, in the legacy entry
 * shape. The database answer is authoritative whenever it can be read, `{}`
 * included; the legacy file is consulted only when it cannot. A corrupt
 * legacy file therefore never blocks a healthy database, and only throws when
 * it is the sole source left.
 *
 * @param {{ dbPath?: string, authFile?: string, fileSystem?: typeof fs }} [options] test seams; production callers pass nothing.
 */
function readAuthFile(options = {}) {
  const {
    dbPath = resolveCredentialDbPath({ dataDir: OPENCODE_DATA_DIR, path }),
    authFile = AUTH_FILE,
    fileSystem = fs,
  } = options;
  const stored = readCredentialsFromDb({ dbPath, fs: fileSystem });
  if (stored) return stored;
  return readLegacyAuthFile(authFile, fileSystem);
}

function getProviderAuth(providerId) {
  const auth = readAuthFile();
  return auth[providerId] || null;
}

function listProviderAuths() {
  const auth = readAuthFile();
  return Object.keys(auth);
}

export {
  readAuthFile,
  getProviderAuth,
  listProviderAuths,
  AUTH_FILE,
  OPENCODE_DATA_DIR
};

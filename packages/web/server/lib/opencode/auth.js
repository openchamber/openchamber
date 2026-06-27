import fs from 'fs';
import path from 'path';
import os from 'os';

const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'auth.json');

const GROK_AUTH_FILE = path.join(os.homedir(), '.grok', 'auth.json');

// opencode-multi profile root, ported verbatim from the canonical mystatus
// searchPaths helper. Profiles live under
//   ~/Library/Application Support/opencode-multi/profiles/<name>
// and each profile dir is a candidate opencode data dir.
const OPENCODE_MULTI_PROFILES_ROOT = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'opencode-multi',
  'profiles',
);

/**
 * Enumerate opencode-multi profile directories. Returns realpaths, deduped.
 * Returns [] when the profiles root is missing or unreadable. Ported verbatim
 * from the canonical `listProfileDirs`.
 *
 * @returns {string[]}
 */
function listProfileDirs() {
  try {
    return fs.readdirSync(OPENCODE_MULTI_PROFILES_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'opencode')
      .map((d) => {
        const p = path.join(OPENCODE_MULTI_PROFILES_ROOT, d.name);
        try {
          return fs.realpathSync(p);
        } catch {
          return p;
        }
      });
  } catch {
    return [];
  }
}

/**
 * Build the ordered, deduplicated candidate directory list for opencode data
 * files (the "data" kind from the canonical `candidateDirs`). Order:
 *   1. $XDG_DATA_HOME/opencode (when XDG_DATA_HOME is set)
 *   2. each opencode-multi profile dir (realpathed)
 *   3. ~/.local/share/opencode (the legacy path; also AUTH_FILE's dir)
 *
 * Ported verbatim from the canonical `candidateDirs("data")`.
 *
 * @returns {string[]}
 */
function candidateDataDirs() {
  const seen = new Set();
  const out = [];
  const add = (p) => {
    if (!p) return;
    let real;
    try {
      real = fs.realpathSync(p);
    } catch {
      real = p;
    }
    if (seen.has(real)) return;
    seen.add(real);
    out.push(real);
  };

  if (process.env.XDG_DATA_HOME) {
    add(path.join(process.env.XDG_DATA_HOME, 'opencode'));
  }
  for (const p of listProfileDirs()) {
    add(p);
  }
  add(OPENCODE_DATA_DIR);
  return out;
}

/**
 * Enumerate candidate `auth.json` paths across all opencode data dirs. The
 * legacy `AUTH_FILE` (~/.local/share/opencode/auth.json) is always included
 * as the final candidate. Paths that do not currently exist are filtered out,
 * matching the canonical `searchPaths` semantics.
 *
 * Accepts an optional `paths` argument so callers (and tests) can
 * dependency-inject a fixture path list without touching the real home dir.
 *
 * @param {string[]} [paths] Optional explicit candidate path list.
 * @returns {string[]}
 */
function authJsonSearchPaths(paths) {
  if (Array.isArray(paths)) {
    return paths;
  }
  return candidateDataDirs()
    .map((d) => path.join(d, 'auth.json'))
    .filter((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
}

/**
 * Return the OAuth `expires` timestamp of a credential, or `undefined` when
 * the credential is not an oauth entry or its `expires` is not a finite
 * number. Ported verbatim from the canonical `oauthExpires`.
 *
 * @param {unknown} cred
 * @returns {number | undefined}
 */
function oauthExpires(cred) {
  if (!cred || typeof cred !== 'object') return undefined;
  const c = /** @type {Record<string, unknown>} */ (cred);
  if (c.type !== 'oauth') return undefined;
  const e = c.expires;
  return typeof e === 'number' && Number.isFinite(e) ? e : undefined;
}

/**
 * Merge auth.json entries across all candidate sources, keeping the freshest
 * OAuth `expires` per provider. Ported verbatim from the canonical
 * `loadAuthMerged` semantics:
 *
 *   - For each path in order, parse JSON; for each [provider, cred]:
 *     - if no existing entry, set it;
 *     - else if cred is oauth with a finite numeric `expires` AND
 *       (existing has no oauth expires OR cred.expires > existing.expires),
 *       replace.
 *   - Non-oauth entries: first-match wins (no freshness comparison).
 *   - Unreadable / malformed / non-object files are skipped silently.
 *   - Returns {} when every candidate path is absent.
 *
 * Synchronous to match the existing module style (sync fs reads).
 *
 * @param {string[]} [paths] Optional explicit candidate path list
 *   (defaults to `authJsonSearchPaths()`).
 * @returns {Record<string, unknown>}
 */
function loadAuthMerged(paths) {
  const searchPaths = authJsonSearchPaths(paths);
  const merged = /** @type {Record<string, unknown>} */ ({});

  for (const p of searchPaths) {
    let data;
    try {
      const raw = fs.readFileSync(p, 'utf8');
      data = JSON.parse(raw);
    } catch {
      // unreadable / missing / malformed JSON — skip silently
      continue;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      // non-object payload — skip silently
      continue;
    }
    for (const [provider, cred] of Object.entries(data)) {
      const existing = merged[provider];
      if (existing === undefined) {
        merged[provider] = cred;
        continue;
      }
      const existingExp = oauthExpires(existing);
      const candidateExp = oauthExpires(cred);
      if (
        candidateExp !== undefined &&
        (existingExp === undefined || candidateExp > existingExp)
      ) {
        merged[provider] = cred;
      }
    }
  }
  return merged;
}

/**
 * Read and parse `~/.grok/auth.json`. Returns the parsed object, or `null`
 * when the file is missing, unreadable, malformed, or contains a non-object
 * payload. Accepts an optional `path` argument for dependency injection in
 * tests.
 *
 * @param {string} [filePath] Optional explicit file path
 *   (defaults to `~/.grok/auth.json`).
 * @returns {Record<string, unknown> | null}
 */
function readGrokAuth(filePath) {
  const target = filePath ?? GROK_AUTH_FILE;
  let data;
  try {
    const raw = fs.readFileSync(target, 'utf8');
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  return /** @type {Record<string, unknown>} */ (data);
}

function readAuthFile() {
  if (!fs.existsSync(AUTH_FILE)) {
    return {};
  }
  try {
    const content = fs.readFileSync(AUTH_FILE, 'utf8');
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

function writeAuthFile(auth) {
  try {
    if (!fs.existsSync(OPENCODE_DATA_DIR)) {
      fs.mkdirSync(OPENCODE_DATA_DIR, { recursive: true });
    }

    if (fs.existsSync(AUTH_FILE)) {
      const backupFile = `${AUTH_FILE}.openchamber.backup`;
      fs.copyFileSync(AUTH_FILE, backupFile);
      console.log(`Created auth backup: ${backupFile}`);
    }

    fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), 'utf8');
    console.log('Successfully wrote auth file');
  } catch (error) {
    console.error('Failed to write auth file:', error);
    throw new Error('Failed to write OpenCode auth configuration');
  }
}

function removeProviderAuth(providerId) {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('Provider ID is required');
  }

  const auth = readAuthFile();
  
  if (!auth[providerId]) {
    console.log(`Provider ${providerId} not found in auth file, nothing to remove`);
    return false;
  }

  delete auth[providerId];
  writeAuthFile(auth);
  console.log(`Removed provider auth: ${providerId}`);
  return true;
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
  writeAuthFile,
  removeProviderAuth,
  getProviderAuth,
  listProviderAuths,
  loadAuthMerged,
  oauthExpires,
  authJsonSearchPaths,
  readGrokAuth,
  AUTH_FILE,
  OPENCODE_DATA_DIR,
  candidateDataDirs
};

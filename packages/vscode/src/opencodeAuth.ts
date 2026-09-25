import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

/**
 * READ-ONLY view of OpenCode's provider credentials (mirror of
 * `packages/web/server/lib/opencode/auth.js` + `credential-db.js`).
 *
 * OpenCode 2.x imports the legacy `auth.json` once into `<data>/opencode.db`
 * (table `credential`, plain JSON values) and never writes the file again;
 * no HTTP route hands a key back. The quota providers need the raw
 * credential, so `readAuthFile()` answers from the database OpenCode actually
 * uses; the legacy file is the fallback only when the database cannot be
 * read. Rows are projected into the legacy `auth.json` entry shape. Nothing
 * here writes: a write would be invisible to the running OpenCode.
 *
 * The table layout is OpenCode's private schema (v2.0.x
 * `packages/core/src/credential/sql.ts`); a change makes the reader return
 * null and the file alone is used. `node:sqlite` needs Node 22.13+; VS Code's
 * extension host ships a newer Node, an older one silently falls back too.
 */

const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'auth.json');
const DB_FILE_NAME = 'opencode.db';

type JsonObject = { [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** A legacy `auth.json` entry: `{ type: 'api', key }` or `{ type: 'oauth', access, refresh, expires }`, plus whatever else the file carried. */
export type AuthEntry = JsonObject;
export type AuthFile = Record<string, AuthEntry>;

/** The legacy shape of an OAuth entry, as `auth.json` spelled it. */
type LegacyOAuthEntry = {
  type: 'oauth';
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  enterpriseUrl?: string;
};

/** The columns the credential query below selects, as SQLite hands them back. */
type CredentialRow = { integration_id: string | null; value: string };
type Connection = { all: (sql: string) => CredentialRow[]; close: () => void };
type SqliteModule = {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => {
    prepare: (sql: string) => { all: () => object[] };
    close: () => void;
  };
};

// ---------------------------------------------------------------------------
// JSON boundary: bytes from the file and the database enter as `JsonValue`
// here, and the guards below are the only narrowing in the module.
// ---------------------------------------------------------------------------

const parseJson = (text: string): JsonValue | null => {
  try {
    // SAFETY: JSON.parse can only produce strings, numbers, booleans, null,
    // arrays, and plain objects, which is exactly the JsonValue union.
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
};

const isJsonObject = (value: JsonValue | null | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isJsonString = (value: JsonValue | undefined): value is string => typeof value === 'string';

let openConnection: ((dbPath: string) => Connection) | null | undefined;
const loadSqlite = (): ((dbPath: string) => Connection) | null => {
  if (openConnection !== undefined) return openConnection;
  openConnection = null;
  try {
    // SAFETY: `node:sqlite` is a Node built-in with a fixed, documented
    // surface; only the two members named in SqliteModule are used.
    const sqlite = createRequire(__filename)('node:sqlite') as SqliteModule;
    openConnection = (dbPath) => {
      const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      return {
        // SAFETY: the query in readCredentialsFromDb selects exactly the
        // CredentialRow columns; `integration_id` and `value` are TEXT.
        all: (sql) => db.prepare(sql).all() as CredentialRow[],
        close: () => db.close(),
      };
    };
  } catch {
    // Node without node:sqlite; the legacy file is the only source.
  }
  return openConnection;
};

/** Where OpenCode keeps its database: `OPENCODE_DB` when set, else `opencode.db` in the data dir. */
export const resolveCredentialDbPath = (dataDir: string, env: NodeJS.ProcessEnv = process.env): string => {
  const configured = (env.OPENCODE_DB ?? '').trim();
  if (configured && configured !== ':memory:') return path.resolve(dataDir, configured);
  return path.join(dataDir, DB_FILE_NAME);
};

/** One stored `credential.value` (JSON text) → legacy `auth.json` entry, or null when unknown. */
export const projectCredentialValue = (raw: string): AuthEntry | null => {
  const value = parseJson(raw);
  if (!isJsonObject(value)) return null;
  const metadata = isJsonObject(value.metadata) ? value.metadata : {};
  if (value.type === 'key' && isJsonString(value.key)) {
    return isJsonObject(value.metadata) ? { type: 'api', key: value.key, metadata } : { type: 'api', key: value.key };
  }
  if (value.type === 'oauth' && isJsonString(value.access) && isJsonString(value.refresh)) {
    const entry: LegacyOAuthEntry = {
      type: 'oauth',
      access: value.access,
      refresh: value.refresh,
      expires: Number(value.expires) || 0,
    };
    if (isJsonString(metadata.accountID)) entry.accountId = metadata.accountID;
    if (isJsonString(metadata.enterpriseUrl)) entry.enterpriseUrl = metadata.enterpriseUrl;
    return entry;
  }
  return null;
};

/**
 * Every integration's selected credential from the database: the `active`
 * row, else the most recently updated one, which is how OpenCode picks.
 * Null when the database or the sqlite runtime is unavailable.
 */
export const readCredentialsFromDb = (dbPath: string): AuthFile | null => {
  const open = loadSqlite();
  if (!open) return null;
  if (!fs.existsSync(dbPath)) return null;

  let db: Connection | null = null;
  try {
    db = open(dbPath);
    const rows = db.all(
      'SELECT integration_id, value, active, time_updated FROM credential ' +
        'WHERE integration_id IS NOT NULL ' +
        'ORDER BY integration_id, active DESC, time_updated DESC',
    );
    const result: AuthFile = {};
    for (const row of rows) {
      const id = row.integration_id ?? '';
      if (!id || id in result) continue;
      const entry = projectCredentialValue(row.value);
      if (entry) result[id] = entry;
    }
    return result;
  } catch (error) {
    console.warn('Could not read OpenCode credentials database:', error instanceof Error ? error.message : error);
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Read-only connection; a failed close changes nothing.
    }
  }
};

const readLegacyAuthFile = (): AuthFile => {
  if (!fs.existsSync(AUTH_FILE)) {
    return {};
  }
  let content: string;
  try {
    content = fs.readFileSync(AUTH_FILE, 'utf8');
  } catch (error) {
    console.error('Failed to read auth file:', error);
    throw new Error('Failed to read OpenCode auth configuration');
  }
  const trimmed = content.trim();
  if (!trimmed) return {};
  const parsed = parseJson(trimmed);
  if (!isJsonObject(parsed)) {
    console.error('Failed to read auth file: not a JSON object');
    throw new Error('Failed to read OpenCode auth configuration');
  }
  const entries = Object.entries(parsed).flatMap(([key, entry]) => (isJsonObject(entry) ? [[key, entry] as const] : []));
  return Object.fromEntries(entries);
};

/** The credentials OpenCode uses, keyed by provider id, in the legacy entry shape. */
/**
 * A readable database is authoritative, `{}` included: OpenCode never clears
 * `auth.json` after importing it, so merging the file back in would hand out
 * a credential the user has since removed. The file is read only when the
 * database cannot be.
 */
export const readAuthFile = (): AuthFile => {
  const stored = readCredentialsFromDb(resolveCredentialDbPath(OPENCODE_DATA_DIR));
  return stored ?? readLegacyAuthFile();
};

export const getProviderAuth = (providerId: string): AuthEntry | null => {
  const auth = readAuthFile();
  return auth[providerId] || null;
};

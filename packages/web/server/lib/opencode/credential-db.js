/**
 * READ-ONLY view of the credentials OpenCode 2.x keeps in its SQLite database.
 *
 * OpenCode 2.x imports the legacy `auth.json` once and from then on stores
 * every credential in `<data>/opencode.db`, table `credential`, as plain JSON.
 * There is no HTTP route that hands a key back, so the quota providers and
 * voice keys would only ever see credentials that predate the upgrade. This
 * module reads the table directly and projects each row into the legacy
 * `auth.json` entry shape the rest of the server already understands, so a
 * key added through OpenCode after the upgrade works like one that was
 * imported. The database is opened read-only and never written.
 *
 * The table layout is OpenCode's private schema (verified against v2.0.x
 * `packages/core/src/credential/sql.ts`); a schema change makes this reader
 * return null and the caller falls back to `auth.json`.
 *
 * `node:sqlite` ships with Node 22.13+, `bun:sqlite` with Bun; a runtime
 * without either also falls back to the file, silently.
 */

import { createRequire } from 'node:module';

const DB_FILE_NAME = 'opencode.db';

/**
 * A minimal read-only connection: `all(sql)` and `close()`. Node provides it
 * through `node:sqlite`, Bun through `bun:sqlite`; both are built in. Neither
 * being available yields null and the caller falls back to `auth.json`.
 */
let openConnection;
const loadSqlite = () => {
  if (openConnection !== undefined) return openConnection;
  const require = createRequire(import.meta.url);
  openConnection = null;
  try {
    const node = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
    const { DatabaseSync } = node ?? require('node:sqlite');
    if (typeof DatabaseSync === 'function') {
      openConnection = (dbPath) => {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        return { all: (sql) => db.prepare(sql).all(), close: () => db.close() };
      };
      return openConnection;
    }
  } catch {
    // Not Node, or a Node without node:sqlite; try Bun next.
  }
  try {
    const { Database } = require('bun:sqlite');
    if (typeof Database === 'function') {
      openConnection = (dbPath) => {
        const db = new Database(dbPath, { readonly: true });
        return { all: (sql) => db.query(sql).all(), close: () => db.close() };
      };
    }
  } catch {
    // No sqlite runtime at all.
  }
  return openConnection;
};

/**
 * Where OpenCode keeps its database: `OPENCODE_DB` when set (absolute or
 * relative to the data dir), else `opencode.db` in the data dir.
 * @param {{ dataDir: string, env?: NodeJS.ProcessEnv, path: typeof import('node:path') }} options
 */
export const resolveCredentialDbPath = ({ dataDir, env = process.env, path }) => {
  const configured = (env.OPENCODE_DB ?? '').trim();
  if (configured && configured !== ':memory:') return path.resolve(dataDir, configured);
  return path.join(dataDir, DB_FILE_NAME);
};

/**
 * Project one stored `credential.value` into the legacy `auth.json` entry
 * shape (`{ type: 'api', key }` / `{ type: 'oauth', access, refresh, expires }`).
 * Returns null for a value this reader does not understand.
 */
export const projectCredentialValue = (raw) => {
  let value;
  try {
    value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  if (value.type === 'key' && typeof value.key === 'string') {
    const entry = { type: 'api', key: value.key };
    if (value.metadata && typeof value.metadata === 'object') entry.metadata = value.metadata;
    return entry;
  }
  if (value.type === 'oauth' && typeof value.access === 'string' && typeof value.refresh === 'string') {
    const entry = { type: 'oauth', access: value.access, refresh: value.refresh, expires: Number(value.expires) || 0 };
    const metadata = value.metadata && typeof value.metadata === 'object' ? value.metadata : {};
    if (typeof metadata.accountID === 'string') entry.accountId = metadata.accountID;
    if (typeof metadata.enterpriseUrl === 'string') entry.enterpriseUrl = metadata.enterpriseUrl;
    return entry;
  }
  return null;
};

/**
 * Read every integration's selected credential from the database.
 *
 * An integration may hold several credentials; the one OpenCode uses is the
 * `active` row, else the most recently updated one, which mirrors how
 * OpenCode itself picks. The result is keyed by integration id, which for
 * providers is the provider id (`openai`, `github-copilot`, ...).
 *
 * @returns {Record<string, object> | null} null when the database or the
 *   sqlite runtime is unavailable, so the caller can tell "no credentials"
 *   from "could not look".
 */
export const readCredentialsFromDb = ({ dbPath, fs }) => {
  const open = loadSqlite();
  if (!open) return null;
  if (!fs.existsSync(dbPath)) return null;

  let db;
  try {
    db = open(dbPath);
    const rows = db.all(
      'SELECT integration_id, value, active, time_updated FROM credential ' +
        'WHERE integration_id IS NOT NULL ' +
        'ORDER BY integration_id, active DESC, time_updated DESC',
    );
    const result = {};
    for (const row of rows) {
      const id = typeof row.integration_id === 'string' ? row.integration_id : '';
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
      // The connection is read-only; a failed close changes nothing.
    }
  }
};

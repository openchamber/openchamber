import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

export const MESSENGER_NOTIFY_ON_COMPLETE_DEFAULT = false;
export const MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS = 8000;
export const MESSENGER_INTERRUPT_TIMEOUT_MIN_MS = 1000;
export const MESSENGER_INTERRUPT_TIMEOUT_MAX_MS = 60000;

// Pick the SQLite driver that matches the current JS runtime. The web server
// runs under Node (the published `openchamber serve` CLI and the in-process
// server inside the Electron desktop shell) AND under Bun (the local
// `dev:server` script). `bun:sqlite` only exists under Bun, while the native
// `better-sqlite3` addon cannot be dlopen'd by Bun — so neither works
// everywhere on its own. Both expose a compatible API for what this store
// needs: `db.exec(sql)` for raw DDL and `db.prepare(sql).run/get/all(...)`.
const isBun = typeof globalThis.Bun !== 'undefined';
let Database;
if (isBun) {
  ({ Database } = await import('bun:sqlite'));
} else {
  const require = createRequire(import.meta.url);
  Database = require('better-sqlite3');
}

/**
 * SQLite-backed mapping between a messenger conversation surface
 * (Discord channel + optional thread, Telegram chat + optional topic)
 * and the OpenCode session id that owns the conversation on that surface.
 *
 * This is what turns Discord and Telegram into real OpenChamber chat
 * interfaces: when a message arrives we look up (or create) a session
 * scoped to the project's working directory, forward the text as a
 * prompt, and route OpenCode's streaming response back to the same
 * messenger thread.
 *
 * Schema:
 *   messenger_session_bindings(
 *     id INTEGER PRIMARY KEY,
 *     type TEXT,         -- 'telegram' | 'discord'
 *     target_key TEXT,   -- "channelId" or "channelId:threadId"
 *     session_id TEXT,
 *     project_path TEXT,
 *     project_label TEXT,
 *     bot_token_hash TEXT, -- so multiple bot tokens don't collide
 *     created_at TEXT,
 *     last_used_at TEXT,
 *     UNIQUE (type, bot_token_hash, target_key)
 *   )
 */

function resolveDefaultDbPath() {
  const root =
    typeof process.env.OPENCHAMBER_DATA_DIR === 'string' &&
    process.env.OPENCHAMBER_DATA_DIR.trim().length > 0
      ? path.resolve(process.env.OPENCHAMBER_DATA_DIR.trim())
      : path.join(os.homedir(), '.openchamber');
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, 'messenger-bridge.sqlite');
}

export function normalizeMessengerInterruptTimeoutMs(value) {
  if (value == null || value === '') return MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS;
  const numeric = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(numeric)) return MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS;
  return Math.min(
    MESSENGER_INTERRUPT_TIMEOUT_MAX_MS,
    Math.max(MESSENGER_INTERRUPT_TIMEOUT_MIN_MS, Math.round(numeric)),
  );
}

export class MessengerBridgeStore {
  constructor({ dbPath } = {}) {
    const resolved = dbPath ? path.resolve(dbPath) : resolveDefaultDbPath();
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messenger_session_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        target_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        project_path TEXT,
        project_label TEXT,
        bot_token_hash TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        UNIQUE (type, bot_token_hash, target_key)
      );
      CREATE INDEX IF NOT EXISTS idx_messenger_session_session
        ON messenger_session_bindings (session_id);
    `);
    // Per-surface preferences (model + agent override + verbosity + permission
    // mode) so /model, /agent, /verbosity and /yolo commands can scope a choice
    // to a channel/topic without touching the global OpenChamber settings.
    // ALTER TABLE is run as separate statements and ignored when the column
    // already exists.
    for (const col of [
      'model_override TEXT',
      'agent_override TEXT',
      'verbosity_override TEXT',
      'variant_override TEXT',
      'permission_mode TEXT',
    ]) {
      try {
        this.db.exec(`ALTER TABLE messenger_session_bindings ADD COLUMN ${col}`);
      } catch {
        // ignore — column already exists
      }
    }
    // Global bridge settings (key/value). Holds the per-messenger verbosity
    // default (key `verbosity:discord` / `verbosity:telegram`) that the
    // OpenChamber UI writes and the `/verbosity` chat command can override
    // per-surface. Both surfaces read it at render time so the UI and Discord
    // stay in sync without a listener restart.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messenger_bridge_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    // Per-project defaults. Resolution order at prompt time:
    //   surface override (channel/thread)  >  parent-channel fallback  >
    //   project default  >  OpenCode default.
    // Settable from Discord via `/model default <p/m>` and from
    // the OpenChamber UI via POST /api/messenger/bridge/project-defaults.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messenger_project_defaults (
        project_path TEXT PRIMARY KEY,
        project_label TEXT,
        model_default TEXT,
        agent_default TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    // Migrate older project-default tables that predate the verbosity/variant
    // (thinking-effort) project scopes. Ignored when the column already exists.
    for (const col of [
      'verbosity_default TEXT',
      'variant_default TEXT',
      'permission_mode_default TEXT',
      'auto_worktree_default INTEGER',
    ]) {
      try {
        this.db.exec(`ALTER TABLE messenger_project_defaults ADD COLUMN ${col}`);
      } catch {
        // ignore — column already exists
      }
    }
  }

  /** Raw key/value read from the global bridge settings table. */
  getSetting(key) {
    if (!key) return null;
    const row = this.db
      .prepare(`SELECT value FROM messenger_bridge_settings WHERE key = ?`)
      .get(key);
    return row?.value ?? null;
  }

  /** Upsert a global bridge setting. Pass `null` to clear it. */
  setSetting(key, value) {
    if (!key) return;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO messenger_bridge_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                        updated_at = excluded.updated_at`,
      )
      .run(key, value ?? null, now);
  }

  /**
   * Per-messenger default verbosity (`quiet` | `normal` | `verbose`) used when
   * a surface has no explicit `/verbosity` override. Returns `null` when never
   * configured so the caller can fall back to its own default.
   */
  getVerbosityDefault(type) {
    if (!type) return null;
    return this.getSetting(`verbosity:${type}`);
  }

  setVerbosityDefault(type, level) {
    if (!type) return;
    this.setSetting(`verbosity:${type}`, level ?? null);
  }

  /**
   * Per-messenger default permission mode (`ask` | `yolo` | `agent`) used
   * when a surface/project has no explicit override. Returns `null` when never
   * configured so the caller can fall back to its own default.
   */
  getPermissionModeDefault(type) {
    if (!type) return null;
    return this.getSetting(`permission-mode:${type}`);
  }

  setPermissionModeDefault(type, mode) {
    if (!type) return;
    this.setSetting(`permission-mode:${type}`, mode ?? null);
  }

  getNotifyOnComplete(type) {
    if (!type) return MESSENGER_NOTIFY_ON_COMPLETE_DEFAULT;
    return this.getSetting(`notify-on-complete:${type}`) === '1';
  }

  setNotifyOnComplete(type, enabled) {
    if (!type) return;
    this.setSetting(`notify-on-complete:${type}`, enabled ? '1' : null);
  }

  getInterruptTimeoutMs(type) {
    if (!type) return MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS;
    return normalizeMessengerInterruptTimeoutMs(this.getSetting(`interrupt-timeout-ms:${type}`));
  }

  setInterruptTimeoutMs(type, timeoutMs) {
    if (!type) return;
    const normalized = normalizeMessengerInterruptTimeoutMs(timeoutMs);
    this.setSetting(
      `interrupt-timeout-ms:${type}`,
      normalized === MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS ? null : String(normalized),
    );
  }

  /** Read the project-wide defaults for a working directory. */
  getProjectDefaults(projectPath) {
    if (!projectPath) return null;
    const row = this.db
      .prepare(
        `SELECT project_path AS projectPath, project_label AS projectLabel,
                model_default AS modelDefault, agent_default AS agentDefault,
                verbosity_default AS verbosityDefault, variant_default AS variantDefault,
                permission_mode_default AS permissionModeDefault,
                auto_worktree_default AS autoWorktreeDefault,
                updated_at AS updatedAt
           FROM messenger_project_defaults
          WHERE project_path = ?`,
      )
      .get(projectPath);
    return row ?? null;
  }

  /**
   * Upsert project defaults. Pass `modelDefault: null` / `agentDefault: null` /
   * `verbosityDefault: null` / `variantDefault: null` to clear that field; pass
   * `undefined` to leave it untouched.
   */
  setProjectDefaults({ projectPath, projectLabel, modelDefault, agentDefault, verbosityDefault, variantDefault, permissionModeDefault, autoWorktreeDefault }) {
    if (!projectPath) return;
    const now = new Date().toISOString();
    const existing = this.getProjectDefaults(projectPath);
    const nextModel = modelDefault === undefined ? existing?.modelDefault ?? null : modelDefault;
    const nextAgent = agentDefault === undefined ? existing?.agentDefault ?? null : agentDefault;
    const nextVerbosity =
      verbosityDefault === undefined ? existing?.verbosityDefault ?? null : verbosityDefault;
    const nextVariant = variantDefault === undefined ? existing?.variantDefault ?? null : variantDefault;
    const nextPermissionMode =
      permissionModeDefault === undefined ? existing?.permissionModeDefault ?? null : permissionModeDefault;
    const nextAutoWorktree =
      autoWorktreeDefault === undefined ? existing?.autoWorktreeDefault ?? null : autoWorktreeDefault;
    const nextLabel = projectLabel ?? existing?.projectLabel ?? null;
    this.db
      .prepare(
        `INSERT INTO messenger_project_defaults
            (project_path, project_label, model_default, agent_default,
             verbosity_default, variant_default, permission_mode_default,
             auto_worktree_default, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_path)
         DO UPDATE SET project_label           = excluded.project_label,
                       model_default           = excluded.model_default,
                       agent_default           = excluded.agent_default,
                       verbosity_default       = excluded.verbosity_default,
                       variant_default         = excluded.variant_default,
                       permission_mode_default = excluded.permission_mode_default,
                       auto_worktree_default   = excluded.auto_worktree_default,
                       updated_at              = excluded.updated_at`,
      )
      .run(projectPath, nextLabel, nextModel, nextAgent, nextVerbosity, nextVariant, nextPermissionMode, nextAutoWorktree, now);
  }

  /** List every project that has bridge defaults configured. */
  listProjectDefaults() {
    return this.db
      .prepare(
        `SELECT project_path AS projectPath, project_label AS projectLabel,
                model_default AS modelDefault, agent_default AS agentDefault,
                verbosity_default AS verbosityDefault, variant_default AS variantDefault,
                permission_mode_default AS permissionModeDefault,
                auto_worktree_default AS autoWorktreeDefault,
                updated_at AS updatedAt
           FROM messenger_project_defaults
          ORDER BY updated_at DESC`,
      )
      .all();
  }

  /**
   * @param {string} type 'telegram' | 'discord'
   * @param {string} botTokenHash short stable hash of the bot token (so identical chatIds
   *                  under different bot accounts don't collide).
   * @param {string} targetKey 'channelId' or 'channelId:threadId'
   */
  lookup({ type, botTokenHash, targetKey }) {
    const row = this.db
      .prepare(
        `SELECT session_id AS sessionId, project_path AS projectPath,
                project_label AS projectLabel, created_at AS createdAt,
                last_used_at AS lastUsedAt,
                model_override AS modelOverride,
                agent_override AS agentOverride,
                verbosity_override AS verbosityOverride,
                variant_override AS variantOverride,
                permission_mode AS permissionModeOverride
           FROM messenger_session_bindings
          WHERE type = ? AND bot_token_hash = ? AND target_key = ?`,
      )
      .get(type, botTokenHash, targetKey);
    return row ?? null;
  }

  /**
   * Update per-surface preferences without touching the session binding.
   * Used by /model and /agent in-chat commands.
   */
  setOverrides({ type, botTokenHash, targetKey, modelOverride, agentOverride, verbosityOverride, variantOverride, permissionModeOverride }) {
    const sets = [];
    const params = [];
    if (modelOverride !== undefined) {
      sets.push('model_override = ?');
      params.push(modelOverride ?? null);
    }
    if (agentOverride !== undefined) {
      sets.push('agent_override = ?');
      params.push(agentOverride ?? null);
    }
    if (verbosityOverride !== undefined) {
      sets.push('verbosity_override = ?');
      params.push(verbosityOverride ?? null);
    }
    if (variantOverride !== undefined) {
      sets.push('variant_override = ?');
      params.push(variantOverride ?? null);
    }
    if (permissionModeOverride !== undefined) {
      sets.push('permission_mode = ?');
      params.push(permissionModeOverride ?? null);
    }
    if (sets.length === 0) return;
    params.push(type, botTokenHash, targetKey);
    // Upsert an empty row first so /model + /agent work BEFORE a session
    // exists for the surface (common right after the bootstrap dialogue).
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO messenger_session_bindings
           (type, target_key, session_id, project_path, project_label,
            bot_token_hash, created_at, last_used_at)
         VALUES (?, ?, '', NULL, NULL, ?, ?, ?)
         ON CONFLICT(type, bot_token_hash, target_key) DO NOTHING`,
      )
      .run(type, targetKey, botTokenHash, now, now);
    this.db
      .prepare(
        `UPDATE messenger_session_bindings
            SET ${sets.join(', ')}, last_used_at = ?
          WHERE type = ? AND bot_token_hash = ? AND target_key = ?`,
      )
      .run(...params.slice(0, -3), now, ...params.slice(-3));
  }

  /** Clear the session id for a surface — /new uses this to force the next
   *  inbound to start a fresh OpenCode session in the same project. */
  unbindSession({ type, botTokenHash, targetKey }) {
    this.db
      .prepare(
        `UPDATE messenger_session_bindings
            SET session_id = ''
          WHERE type = ? AND bot_token_hash = ? AND target_key = ?`,
      )
      .run(type, botTokenHash, targetKey);
  }

  bind({ type, botTokenHash, targetKey, sessionId, projectPath, projectLabel }) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO messenger_session_bindings
           (type, target_key, session_id, project_path, project_label, bot_token_hash, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(type, bot_token_hash, target_key)
         DO UPDATE SET session_id = excluded.session_id,
                       project_path = excluded.project_path,
                       project_label = excluded.project_label,
                       last_used_at = excluded.last_used_at`,
      )
      .run(
        type,
        targetKey,
        sessionId,
        projectPath ?? null,
        projectLabel ?? null,
        botTokenHash,
        now,
        now,
      );
  }

  touch({ type, botTokenHash, targetKey }) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE messenger_session_bindings
            SET last_used_at = ?
          WHERE type = ? AND bot_token_hash = ? AND target_key = ?`,
      )
      .run(now, type, botTokenHash, targetKey);
  }

  /**
   * Find bindings by target key (thread ID for Discord, chat ID for Telegram).
   * Used by the thread-cleanup flow when a Discord thread is deleted, so we
   * can look up the bound session without knowing the bot token hash.
   */
  findByTargetKey({ type, targetKey }) {
    if (!type || !targetKey) return [];
    return this.db
      .prepare(
        `SELECT session_id AS sessionId, bot_token_hash AS botTokenHash,
                project_path AS projectPath
           FROM messenger_session_bindings
          WHERE type = ? AND target_key = ?`,
      )
      .all(type, targetKey);
  }

  /**
   * Lookup every messenger target bound to a given OpenCode session, so the
   * outbound fan-out can mirror assistant deltas to all of them (e.g. one
   * channel + one DM both subscribed to the same session).
   */
  lookupBySessionId(sessionId) {
    return this.db
      .prepare(
        `SELECT type, target_key AS targetKey, project_path AS projectPath,
                project_label AS projectLabel
           FROM messenger_session_bindings
          WHERE session_id = ?`,
      )
      .all(sessionId);
  }

  list({ type, botTokenHash } = {}) {
    let sql = `SELECT type, target_key AS targetKey, session_id AS sessionId,
                      project_path AS projectPath, project_label AS projectLabel,
                      created_at AS createdAt, last_used_at AS lastUsedAt
                 FROM messenger_session_bindings`;
    const params = [];
    const where = [];
    if (type) {
      where.push('type = ?');
      params.push(type);
    }
    if (botTokenHash !== undefined) {
      where.push('bot_token_hash = ?');
      params.push(botTokenHash);
    }
    if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY last_used_at DESC';
    return this.db.prepare(sql).all(...params);
  }

  unbind({ type, botTokenHash, targetKey }) {
    this.db
      .prepare(
        `DELETE FROM messenger_session_bindings
          WHERE type = ? AND bot_token_hash = ? AND target_key = ?`,
      )
      .run(type, botTokenHash, targetKey);
  }
}

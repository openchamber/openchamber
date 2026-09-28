/**
 * Re-arms OpenCode's own V1 -> V2 session migration for sessions that were
 * created after it already finished.
 *
 * OpenCode 2.x migrates the legacy `session`/`message`/`part` tables into
 * `session_v2`/`session_message` once and then writes `{"phase":"completed"}`
 * under `migration.v1-v2` in `kv`. Users who kept running OpenChamber's
 * bundled OpenCode 1.x beside a v2 install created more V1 sessions after that
 * point, and OpenCode never looks at them again: they are simply invisible in
 * v2. This module hands OpenCode a resume cursor before OpenChamber spawns the
 * MANAGED OpenCode, so OpenCode's own `run()` imports them on startup with its
 * own transform. OpenChamber never writes session rows itself.
 *
 * Two hard rules, both verified against v2.0.8
 * `packages/core/src/database/v1-migration.bun.ts`:
 *
 * 1. NEVER delete or clear the `migration.v1-v2` row. With no row at all,
 *    OpenCode treats the database as pre-migration and DELETEs the whole
 *    `event` table — v2's durable event log — before starting over.
 * 2. NEVER schedule a cursor that makes OpenCode revisit a session which has
 *    seen v2 activity. Every visited session gets its `session_message` rows
 *    deleted and replaced by the V1 transform, so a migrated session that was
 *    continued in v2 would lose that conversation.
 * 3. Only 1.x activity since the last completed import triggers a new one.
 *    A v2 delete removes the `session_v2` row but leaves the legacy `session`
 *    row behind, so "missing from v2" alone would bring deleted sessions back
 *    on every start. A legacy session counts as missing only when its
 *    `time_updated` is newer than the completion stamp OpenCode writes on
 *    `migration.v1-v2`: only OpenCode 1.x writes that table, so an unchanged
 *    table means nobody ran 1.x since and the top-up skips. Decided by the
 *    maintainer (2026-09-24). When 1.x was used again, OpenCode still walks
 *    every id below the cursor, so a deleted session sorting below a fresh one
 *    comes back with it; that needs an import route taking an explicit list.
 *
 * The loop OpenCode runs is `SELECT id FROM session WHERE id < cursor ORDER BY
 * id DESC LIMIT 1`, one session at a time, so the cursor has to be strictly
 * greater than the largest id we want imported. Session ids encode time
 * descending in a fixed-width field that wraps, so id order is NOT time order:
 * a 2026-08 session can sort far below a newer one. Everything here compares
 * ids the way SQLite does (BINARY / memcmp — neither `session.id` nor
 * `session_v2.id` declares a collation) and never assumes id order means age.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';

import { resolveCredentialDbPath } from './credential-db.js';
import { OPENCODE_DATA_DIR } from './auth.js';

/** OpenCode's key for the migration state row in `kv`. */
const MIGRATION_STATE_KEY = 'migration.v1-v2';

/**
 * The `session_message.type` values OpenCode's V1 transform can produce
 * (`transformSession` emits only these four). Any other type on a session is
 * proof the session was used in v2 after it was migrated.
 */
const V1_IMPORT_MESSAGE_TYPES = ['user', 'assistant', 'synthetic', 'compaction'];

/**
 * Appended to the largest missing id to build the cursor. SQLite compares TEXT
 * byte by byte, so `<id><anything>` sorts immediately after `<id>`, and since
 * every session id has the same length no real id can fall between the two.
 * The cursor therefore selects exactly "this id and everything below it".
 */
const CURSOR_SUFFIX = '￿';

/**
 * The smallest cursor that still makes OpenCode's `id < cursor` loop visit
 * `maxMissingId` itself.
 * @param {string} maxMissingId
 */
export const computeResumeCursor = (maxMissingId) => `${maxMissingId}${CURSOR_SUFFIX}`;

const kvRowSchema = z.object({ value: z.string(), time_updated: z.number() });
const idRowSchema = z.object({ id: z.string() });
const nameRowSchema = z.object({ name: z.string() });
const countRowSchema = z.object({ value: z.number() });
const nullableIdRowSchema = z.object({ id: z.string().nullable() });
const migrationStateSchema = z.object({ phase: z.string() });

/**
 * A minimal read-write connection: `all(sql, params)`, `run(sql, params)` and
 * `close()`. Node provides it through `node:sqlite`, Bun through `bun:sqlite`;
 * both are built in and no dependency is added. Neither being available
 * yields null and the top-up is skipped.
 */
let openConnection;
const loadSqlite = () => {
  if (openConnection !== undefined) return openConnection;
  const require = createRequire(import.meta.url);
  openConnection = null;
  try {
    const { DatabaseSync } = process.getBuiltinModule?.('node:sqlite') ?? require('node:sqlite');
    // Opening an in-memory database proves the builtin is usable before we
    // commit to it; a Node without `node:sqlite` throws here and Bun is tried.
    new DatabaseSync(':memory:').close();
    openConnection = (dbPath) => {
      const db = new DatabaseSync(dbPath);
      return {
        all: (sql, params = []) => db.prepare(sql).all(...params),
        run: (sql, params = []) => {
          db.prepare(sql).run(...params);
        },
        close: () => db.close(),
      };
    };
    return openConnection;
  } catch {
    // Not Node, or a Node without node:sqlite; try Bun next.
  }
  try {
    const { Database } = require('bun:sqlite');
    new Database(':memory:').close();
    openConnection = (dbPath) => {
      const db = new Database(dbPath);
      return {
        all: (sql, params = []) => db.query(sql).all(...params),
        run: (sql, params = []) => {
          db.query(sql).run(...params);
        },
        close: () => db.close(),
      };
    };
  } catch {
    // No sqlite runtime at all.
  }
  return openConnection;
};

const outcome = (status, reason, missing = 0, revisited = 0) =>
  reason === undefined ? { status, missing, revisited } : { status, missing, revisited, reason };

const firstRow = (schema, rows) => {
  const parsed = schema.safeParse(rows[0]);
  return parsed.success ? parsed.data : null;
};

const hasTables = (db, names) => {
  const rows = db.all(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${names.map(() => '?').join(', ')})`,
    names,
  );
  const found = new Set(
    rows.flatMap((row) => {
      const parsed = nameRowSchema.safeParse(row);
      return parsed.success ? [parsed.data.name] : [];
    }),
  );
  return names.every((name) => found.has(name));
};

/**
 * The completion timestamp of a `{"phase":"completed"}` migration row, or null
 * when the row is missing, unreadable, or the migration is not finished.
 */
const readCompletedMigration = (db) => {
  const row = firstRow(kvRowSchema, db.all('SELECT value, time_updated FROM kv WHERE key = ?', [MIGRATION_STATE_KEY]));
  if (!row) return null;
  let decoded;
  try {
    decoded = JSON.parse(row.value);
  } catch {
    return null;
  }
  const state = migrationStateSchema.safeParse(decoded);
  if (!state.success || state.data.phase !== 'completed') return null;
  return { completedAt: row.time_updated };
};

/**
 * Sessions OpenCode will revisit at this cursor that carry evidence of v2 use
 * after the migration finished: a message created after completion, a session
 * row touched after completion, or a message type the V1 transform never
 * emits. Any hit means the top-up must not run.
 */
const findRevisitedSessionsWithV2Activity = (db, cursor, completedAt) =>
  db
    .all(
      `SELECT s.id AS id FROM session s
       WHERE s.id < ?
         AND s.id IN (SELECT id FROM session_v2)
         AND (
           EXISTS (SELECT 1 FROM session_v2 v WHERE v.id = s.id AND v.time_updated > ?)
           OR EXISTS (
             SELECT 1 FROM session_message m
             WHERE m.session_id = s.id
               AND (m.time_created > ? OR m.type NOT IN (${V1_IMPORT_MESSAGE_TYPES.map(() => '?').join(', ')}))
           )
         )
       ORDER BY s.id DESC`,
      [cursor, completedAt, completedAt, ...V1_IMPORT_MESSAGE_TYPES],
    )
    .flatMap((row) => {
      const parsed = idRowSchema.safeParse(row);
      return parsed.success ? [parsed.data.id] : [];
    });

/**
 * A legacy session with no `session_v2` twin that 1.x touched after the last
 * completed import (see rule 3). Bound parameter: the completion timestamp.
 */
const MISSING_CONDITION = 'id NOT IN (SELECT id FROM session_v2) AND time_updated > ?';

const countMissingSessions = (db, completedAt) =>
  firstRow(countRowSchema, db.all(`SELECT COUNT(*) AS value FROM session WHERE ${MISSING_CONDITION}`, [completedAt]))
    ?.value ?? 0;

const countRevisitedSessions = (db, cursor) =>
  firstRow(
    countRowSchema,
    db.all('SELECT COUNT(*) AS value FROM session WHERE id < ? AND id IN (SELECT id FROM session_v2)', [cursor]),
  )?.value ?? 0;

/**
 * Schedule OpenCode's own V1 migration to pick up the V1 sessions that are
 * missing from v2, when that can be done without touching a session that has
 * v2 activity.
 *
 * Call this only for a MANAGED OpenCode, before it is spawned: writing the
 * migration state under a running OpenCode would race its own loop, and an
 * external OpenCode is not OpenChamber's to steer.
 *
 * @param {{ dbPath?: string, fileSystem?: typeof fs, logger?: Pick<Console, 'log' | 'warn'>, now?: () => number }} [options]
 * `unsafe` names the one refusal, `revisited-sessions-have-v2-activity`: an
 * already-migrated session under the cursor was used in v2 since.
 *
 * @returns {{ status: 'skipped' | 'scheduled' | 'unsafe' | 'unavailable', missing: number, revisited: number, reason?: string }}
 */
export const topUpV1Migration = (options = {}) => {
  const {
    dbPath = resolveCredentialDbPath({ dataDir: OPENCODE_DATA_DIR, path }),
    fileSystem = fs,
    logger = console,
    now = Date.now,
  } = options;

  const open = loadSqlite();
  if (!open) return outcome('unavailable', 'no-sqlite-runtime');
  if (!fileSystem.existsSync(dbPath)) return outcome('skipped', 'no-database');

  let db;
  try {
    db = open(dbPath);
    if (!hasTables(db, ['session', 'session_v2', 'session_message', 'kv'])) {
      return outcome('skipped', 'no-v1-sessions');
    }
    const migration = readCompletedMigration(db);
    if (!migration) return outcome('skipped', 'migration-not-completed');

    const missingCount = countMissingSessions(db, migration.completedAt);
    if (missingCount === 0) return outcome('skipped', 'nothing-missing');

    const maxMissing = firstRow(
      nullableIdRowSchema,
      db.all(`SELECT MAX(id) AS id FROM session WHERE ${MISSING_CONDITION}`, [migration.completedAt]),
    )?.id;
    if (!maxMissing) return outcome('skipped', 'nothing-missing');

    const cursor = computeResumeCursor(maxMissing);
    const revisitedCount = countRevisitedSessions(db, cursor);
    const unsafe = findRevisitedSessionsWithV2Activity(db, cursor, migration.completedAt);
    if (unsafe.length > 0) {
      logger.warn(
        `[OpenCode] ${missingCount} OpenCode 1.x session(s) are missing from the v2 database, but importing them ` +
          `would make OpenCode rewrite ${unsafe.length} already-migrated session(s) that have been used in v2 ` +
          `since. Leaving the migration state untouched.`,
      );
      return outcome('unsafe', 'revisited-sessions-have-v2-activity', missingCount, revisitedCount);
    }

    db.run('UPDATE kv SET value = ?, time_updated = ? WHERE key = ?', [
      JSON.stringify({ phase: 'sessions', cursor }),
      now(),
      MIGRATION_STATE_KEY,
    ]);
    logger.log(
      `[OpenCode] Scheduled the import of ${missingCount} OpenCode 1.x session(s) changed since the last v2 import; ` +
        `OpenCode will re-import ${revisitedCount} untouched session(s) on the way.`,
    );
    return outcome('scheduled', undefined, missingCount, revisitedCount);
  } catch (error) {
    logger.warn('[OpenCode] Could not check the v1 session migration:', error instanceof Error ? error.message : error);
    return outcome('unavailable', 'database-error');
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a database we are done with must never break startup.
    }
  }
};

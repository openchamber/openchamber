
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';

import { getOpenCodeDataDir } from './config-files.js';
import type { BunSqliteModule } from './dependency-contracts.js';

interface MigrationDatabase {
  all: (sql: string, params?: (string | number)[]) => unknown[];
  run: (sql: string, params?: (string | number)[]) => void;
  close: () => void;
}
export interface V1MigrationOptions {
  env?: NodeJS.ProcessEnv;
  dbPath?: string;
  fileSystem?: Pick<typeof fs, 'existsSync'>;
  logger?: Pick<Console, 'log' | 'warn'>;
  now?: () => number;
}
export interface V1MigrationOutcome {
  status: 'skipped' | 'scheduled' | 'unsafe' | 'unavailable';
  missing: number;
  revisited: number;
  reason?: string;
}

const resolveOpenCodeDbPath = (env: NodeJS.ProcessEnv) => {
  const dataDir = getOpenCodeDataDir(env);
  const configured = (env.OPENCODE_DB ?? '').trim();
  if (configured && configured !== ':memory:') return path.resolve(dataDir, configured);
  return path.join(dataDir, 'opencode.db');
};

const MIGRATION_STATE_KEY = 'migration.v1-v2';

const V1_IMPORT_MESSAGE_TYPES = ['user', 'assistant', 'synthetic', 'compaction'];

const CURSOR_SUFFIX = '￿';

export const computeResumeCursor = (maxMissingId: string) => `${maxMissingId}${CURSOR_SUFFIX}`;

const kvRowSchema = z.object({ value: z.string(), time_updated: z.number() });
const idRowSchema = z.object({ id: z.string() });
const nameRowSchema = z.object({ name: z.string() });
const countRowSchema = z.object({ value: z.number() });
const nullableIdRowSchema = z.object({ id: z.string().nullable() });
const migrationStateSchema = z.object({ phase: z.string() });

let openConnection: ((dbPath: string) => MigrationDatabase) | null | undefined;
const loadSqlite = () => {
  if (openConnection !== undefined) return openConnection;
  const require = createRequire(import.meta.url);
  openConnection = null;
  try {
    const { DatabaseSync }: typeof import('node:sqlite') = process.getBuiltinModule?.('node:sqlite') ?? require('node:sqlite');
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
    openConnection = null;
  }
  try {
    const { Database }: BunSqliteModule = require('bun:sqlite');
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
    openConnection = null;
  }
  return openConnection;
};

const outcome = (status: V1MigrationOutcome['status'], reason: string | undefined, missing = 0, revisited = 0): V1MigrationOutcome =>
  reason === undefined ? { status, missing, revisited } : { status, missing, revisited, reason };

const firstRow = <Schema extends z.ZodType>(schema: Schema, rows: unknown[]) => {
  const parsed = schema.safeParse(rows[0]);
  return parsed.success ? parsed.data : null;
};

const hasTables = (db: MigrationDatabase, names: string[]) => {
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

const readCompletedMigration = (db: MigrationDatabase) => {
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

const findRevisitedSessionsWithV2Activity = (db: MigrationDatabase, cursor: string, completedAt: number) =>
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

const MISSING_CONDITION = 'id NOT IN (SELECT id FROM session_v2) AND time_updated > ?';

const countMissingSessions = (db: MigrationDatabase, completedAt: number) =>
  firstRow(countRowSchema, db.all(`SELECT COUNT(*) AS value FROM session WHERE ${MISSING_CONDITION}`, [completedAt]))
    ?.value ?? 0;

const countRevisitedSessions = (db: MigrationDatabase, cursor: string) =>
  firstRow(
    countRowSchema,
    db.all('SELECT COUNT(*) AS value FROM session WHERE id < ? AND id IN (SELECT id FROM session_v2)', [cursor]),
  )?.value ?? 0;

export const topUpV1Migration = (options: V1MigrationOptions = {}) => {
  const {
    env = process.env,
    dbPath = resolveOpenCodeDbPath(env),
    fileSystem = fs,
    logger = console,
    now = Date.now,
  } = options;

  const open = loadSqlite();
  if (!open) return outcome('unavailable', 'no-sqlite-runtime');
  if (!fileSystem.existsSync(dbPath)) return outcome('skipped', 'no-database');

  let db: MigrationDatabase | undefined;
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
      db = undefined;
    }
  }
};

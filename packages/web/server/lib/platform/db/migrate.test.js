import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { migrate } from './migrate.js';
import { createRawTestDb, createTestPlatformDb } from './test-utils.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../db/migrations',
);

async function listTables(db) {
  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
}

describe('platform migration runner', () => {
  const tempDirs = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeTempMigrationsDir(files) {
    const dir = await mkdtemp(path.join(tmpdir(), 'platform-migrations-'));
    tempDirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(dir, name), content);
    }
    return dir;
  }

  it('applies migrations in order and records versions', async () => {
    const db = await createTestPlatformDb();
    const { rows } = await db.query('SELECT version, name FROM schema_migrations ORDER BY version');
    expect(rows.map((row) => row.version)).toEqual([
      '0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0009', '0010', '0011',
    ]);
    expect(rows[0].name).toBe('0001_users.sql');

    const tables = await listTables(db);
    for (const table of [
      'users', 'auth_sessions', 'workspaces', 'runtime_operations', 'agent_sessions',
      'user_preferences', 'audit_events', 'model_access_tokens', 'model_requests',
      'login_transactions',
    ]) {
      expect(tables).toContain(table);
    }
  });

  it('re-running migrate is a no-op', async () => {
    const db = await createTestPlatformDb();
    const result = await migrate(db);
    expect(result.applied).toEqual([]);
  });

  it('rolls back a failing migration and records nothing for it', async () => {
    const dir = await makeTempMigrationsDir({
      '0001_good.sql': 'CREATE TABLE good_table (id int);',
      '0002_bad.sql': 'CREATE TABLE bad_table (id int);\nTHIS IS NOT VALID SQL;',
      '0003_never.sql': 'CREATE TABLE never_table (id int);',
    });
    // Use a raw (unmigrated) database: applying the fixture migrations IS the
    // subject of this test.
    const db = createRawTestDb();

    await expect(migrate(db, { migrationsDir: dir })).rejects.toThrow(/migration 0002_bad\.sql failed and was rolled back/);

    // The failing migration and everything after it must not be applied.
    const tables = await listTables(db);
    expect(tables).toContain('good_table');
    expect(tables).not.toContain('bad_table');
    expect(tables).not.toContain('never_table');

    const { rows } = await db.query('SELECT version FROM schema_migrations ORDER BY version');
    expect(rows.map((row) => row.version)).toEqual(['0001']);

    // Fixing the bad file lets the runner continue from where it stopped.
    await writeFile(path.join(dir, '0002_bad.sql'), 'CREATE TABLE fixed_table (id int);');
    const result = await migrate(db, { migrationsDir: dir });
    expect(result.applied).toEqual(['0002', '0003']);
    expect(await listTables(db)).toContain('fixed_table');
  });

  it('refuses to run when an applied migration is missing on disk', async () => {
    const dir = await makeTempMigrationsDir({
      '0001_one.sql': 'CREATE TABLE one_table (id int);',
      '0002_two.sql': 'CREATE TABLE two_table (id int);',
    });
    const db = await createTestPlatformDb({ migrationsDir: dir });
    await rm(path.join(dir, '0002_two.sql'));

    await expect(migrate(db, { migrationsDir: dir })).rejects.toThrow(/0002_two\.sql\).*is missing/);
  });

  it('ignores non-migration files in the migrations directory', async () => {
    const dir = await makeTempMigrationsDir({
      '0001_one.sql': 'CREATE TABLE one_table (id int);',
      'notes.md': 'not a migration',
      'README': 'not a migration either',
    });
    const db = await createTestPlatformDb({ migrationsDir: dir });
    const { rows } = await db.query('SELECT version FROM schema_migrations');
    expect(rows.map((row) => row.version)).toEqual(['0001']);
  });

  it('uses the default migrations directory when none is given', async () => {
    const db = await createTestPlatformDb();
    const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM schema_migrations');
    expect(rows[0].count).toBeGreaterThanOrEqual(9);
    expect(MIGRATIONS_DIR).toMatch(/server\/db\/migrations$/);
  });
});

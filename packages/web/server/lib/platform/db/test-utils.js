import { newDb } from 'pg-mem';

import { createPlatformDb } from './client.js';
import { migrate } from './migrate.js';

// Test-only helper: build a platform database handle backed by pg-mem, the
// in-memory Postgres implementation. pg-mem is API-compatible with `pg`, so
// this exercises the exact production code path (createPlatformDb). Call
// migrate() explicitly unless you specifically want an unmigrated database.
// Never import this from production code.
export function createRawTestDb() {
  const mem = newDb();
  const pgModule = mem.adapters.createPg();
  return createPlatformDb({
    connectionString: 'postgres://platform:test@127.0.0.1:5432/platform_test',
    pgModule,
  });
}

export async function createTestPlatformDb({ migrationsDir } = {}) {
  const db = createRawTestDb();
  await migrate(db, migrationsDir ? { migrationsDir } : {});
  return db;
}

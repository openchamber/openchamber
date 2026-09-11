import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Versioned SQL migration runner (this project has no external migration
// framework; this module is the convention):
//   - Migration files live in server/db/migrations/ and are named
//     NNNN_<slug>.sql, where NNNN is a four-digit, zero-padded, strictly
//     increasing version. Lexicographic sort of the filenames is therefore
//     also version order.
//   - One file per schema version, in dependency order (parent tables first).
//   - Applied versions are recorded in schema_migrations and must never be
//     edited, renamed, or reordered afterwards. Every further change is a new
//     file with the next version number.
//   - Each migration runs inside its own transaction: the whole file applies
//     or nothing does. Migration files must be plain DDL/DML and must not
//     contain their own BEGIN/COMMIT/ROLLBACK.
//   - The runner is idempotent: first deploy and upgrades both call migrate()
//     once, and a re-run with no new files is a no-op.
//   - Callers must run migrations from a single deploy step per database (no
//     concurrent runners).
//
// Transaction mechanics: the migration text and the schema_migrations insert
// are executed as ONE combined query text without parameters. node-postgres
// then uses the simple query protocol, which real Postgres executes as a
// single implicit transaction, and pg-mem executes inside one bound
// transaction as well, so a failing migration leaves no partial state on
// either backend. The version/name literals are inlined (never user input;
// filenames are validated against MIGRATION_FILE_PATTERN) because the simple
// protocol does not support parameters on multi-statement text.

const DEFAULT_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations',
);

const MIGRATION_FILE_PATTERN = /^(\d{4})_[a-z0-9][a-z0-9_-]*\.sql$/;

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL
)`;

async function ensureSchemaMigrationsTable(pool) {
  // Existence check instead of CREATE TABLE IF NOT EXISTS: pg-mem (the test
  // backend) mis-parses a repeated constrained CREATE TABLE IF NOT EXISTS, and
  // this keeps behavior identical on real Postgres. Migrations run from a
  // single deploy step, so the check-then-create race does not apply.
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'schema_migrations'`,
  );
  if (rows.length === 0) {
    await pool.query(SCHEMA_MIGRATIONS_DDL);
  }
}

export async function migrate(db, { migrationsDir = DEFAULT_MIGRATIONS_DIR } = {}) {
  const pool = db.pool ?? db;
  await ensureSchemaMigrationsTable(pool);

  const { rows: appliedRows } = await pool.query('SELECT version, name FROM schema_migrations');
  const applied = new Map(appliedRows.map((row) => [row.version, row.name]));

  const files = (await readdir(migrationsDir))
    .filter((file) => MIGRATION_FILE_PATTERN.test(file))
    .sort();
  if (files.length === 0) {
    throw new Error(`no migration files found in ${migrationsDir}`);
  }

  const versionsOnDisk = new Set(files.map((file) => file.slice(0, 4)));
  for (const [version, name] of applied) {
    if (!versionsOnDisk.has(version)) {
      throw new Error(
        `applied migration ${version} (${name}) is missing from ${migrationsDir}; refusing to continue`,
      );
    }
  }

  const appliedNow = [];
  for (const file of files) {
    const version = file.slice(0, 4);
    if (applied.has(version)) {
      continue;
    }
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    const versionInsert =
      `INSERT INTO schema_migrations (version, name, applied_at) ` +
      `VALUES ('${version}', '${escapeLiteral(file)}', now());`;
    const client = await pool.connect();
    try {
      await client.query(`BEGIN;\n${sql}\n${versionInsert}\nCOMMIT;`);
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Best effort: on real Postgres this clears the aborted transaction
        // before the client is returned to the pool.
      }
      throw new Error(`migration ${file} failed and was rolled back: ${error.message}`);
    } finally {
      client.release();
    }
    appliedNow.push(version);
  }
  return { applied: appliedNow };
}

function escapeLiteral(value) {
  return value.replace(/'/g, "''");
}

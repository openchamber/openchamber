/**
 * Rewrites OpenCode's SQLite database and closes. Runs in a forked process
 * because both built-in SQLite drivers are synchronous and a large VACUUM
 * would otherwise freeze the OpenChamber server for minutes.
 *
 * Protocol over IPC: one `{ type: 'step', step }` before each statement, then
 * `{ type: 'done' }` or `{ type: 'error', message }`. The parent owns the
 * lifecycle (stopping and restarting OpenCode); this file only touches SQLite.
 */

import { loadSqlite } from '../opencode/opencode-db.js';

const step = (name) => {
  try {
    process.send?.({ type: 'step', step: name });
  } catch {
    // A disconnected parent cannot read progress anyway; the statements below
    // still need to finish or roll back cleanly.
  }
};

const fail = (message) => {
  try {
    process.send?.({ type: 'error', message });
  } catch {
    // Nothing else to report to.
  }
  process.exitCode = 1;
};

const run = () => {
  const dbPath = process.argv[2];
  if (!dbPath) {
    fail('No database path was passed to the compaction worker');
    return;
  }
  const open = loadSqlite();
  if (!open) {
    fail('No SQLite driver is available in this runtime');
    return;
  }

  let db;
  let rewritten = false;
  let failure = null;
  try {
    db = open(dbPath);

    step('checkpoint');
    // TRUNCATE also empties the `-wal` file, so the rewrite does not carry its
    // pages along. A busy checkpoint means another connection still has the
    // database open; rewriting it then would copy a moving target.
    const checkpoint = db.all('PRAGMA wal_checkpoint(TRUNCATE)');
    if (Number(checkpoint?.[0]?.busy ?? 0) !== 0) {
      throw new Error('The database is still open by another process');
    }

    step('vacuum');
    db.exec('VACUUM');

    step('integrity');
    const integrity = db.all('PRAGMA integrity_check');
    const verdict = integrity?.[0]?.integrity_check;
    if (verdict !== 'ok') {
      throw new Error(`The integrity check reported ${String(verdict ?? 'no result')}`);
    }
    rewritten = true;
  } catch (error) {
    failure = error?.message ?? 'The database rewrite failed';
  } finally {
    try {
      db?.close();
    } catch {
      // Closing after a failed statement must not hide the failure above.
    }
  }

  // Report only after the connection closed: in WAL mode the vacuumed pages
  // sit in the WAL until the last connection checkpoints them, so a parent
  // that measures the file before that sees the old size. The same ordering
  // keeps the parent from restarting OpenCode while this worker holds a lock.
  if (failure) fail(failure);
  else if (rewritten) process.send?.({ type: 'done' });
};

// A dead parent leaves a lock nobody will release; exit so the next server
// can reclaim it. SQLite rolls a partial VACUUM back on close.
process.on('disconnect', () => {
  process.exit(1);
});

run();

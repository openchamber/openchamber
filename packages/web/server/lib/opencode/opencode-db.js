/**
 * Where OpenCode 2.x keeps its SQLite database, and the built-in driver that
 * opens it.
 *
 * OpenCode resolves its data directory through `xdg-basedir`
 * (`packages/core/src/global.ts`), so `XDG_DATA_HOME` wins over
 * `~/.local/share`; `database/path.ts` then adds `openCode.db`, or
 * `OPENCODE_DB` when that variable is set. Both modules in this package that
 * touch that file (the V1 session top-up and database compaction) read the
 * path from here so they cannot drift apart.
 *
 * The driver is whichever SQLite the server runtime already ships: `node:sqlite`
 * on Node, `bun:sqlite` on Bun. Neither is a package dependency, and neither
 * being available yields `null` so callers skip instead of failing.
 */

import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DEFAULT_DATA_DIRNAME = path.join('.local', 'share', 'opencode');

/** OpenCode's data directory, following the XDG rule OpenCode itself uses. */
export const resolveOpenCodeDataDir = (env = process.env) => {
  const xdgDataHome = (env.XDG_DATA_HOME ?? '').trim();
  if (xdgDataHome) return path.join(path.resolve(xdgDataHome), 'opencode');
  return path.join(os.homedir(), DEFAULT_DATA_DIRNAME);
};

/**
 * Where OpenCode keeps its database: `OPENCODE_DB` when set (absolute or
 * relative to the data dir), else `opencode.db` in the data dir.
 */
export const resolveOpenCodeDbPath = (env = process.env) => {
  const dataDir = resolveOpenCodeDataDir(env);
  const configured = (env.OPENCODE_DB ?? '').trim();
  if (configured && configured !== ':memory:') return path.resolve(dataDir, configured);
  return path.join(dataDir, 'opencode.db');
};

/** True when OpenCode configured an in-memory database, so no file exists. */
export const isInMemoryOpenCodeDb = (env = process.env) => (env.OPENCODE_DB ?? '').trim() === ':memory:';

/**
 * A minimal connection: `all(sql, params)`, `run(sql, params)`, `exec(sql)`
 * and `close()`. `exec` covers statements SQLite will not prepare through the
 * driver's parameter binding, such as `VACUUM`.
 */
let openConnection;
export const loadSqlite = () => {
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
        exec: (sql) => db.exec(sql),
        close: () => db.close(),
      };
    };
    return openConnection;
  } catch {
    // Fall through to Bun.
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
        exec: (sql) => db.exec(sql),
        close: () => db.close(),
      };
    };
    return openConnection;
  } catch {
    return null;
  }
};

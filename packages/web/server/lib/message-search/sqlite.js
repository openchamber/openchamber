import { createRequire } from 'node:module';

/**
 * A SQLite connection from the runtime's builtin: `node:sqlite` on Node and
 * Electron, `bun:sqlite` on Bun. No dependency is added. `null` when neither
 * exists; the caller then has no index rather than a crash.
 *
 * Statements are prepared once per SQL string: the indexer inserts the same
 * few statements tens of thousands of times during a backfill.
 */
let opener;

const wrap = (db, prepare) => {
  const statements = new Map();
  const statement = (sql) => {
    let prepared = statements.get(sql);
    if (!prepared) {
      prepared = prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  };
  return {
    exec: (sql) => db.exec(sql),
    all: (sql, params = []) => statement(sql).all(...params),
    get: (sql, params = []) => statement(sql).get(...params) ?? null,
    run: (sql, params = []) => {
      statement(sql).run(...params);
    },
    transaction: (work) => {
      db.exec('BEGIN');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => {
      statements.clear();
      db.close();
    },
  };
};

export const loadSqliteOpener = () => {
  if (opener !== undefined) return opener;
  const require = createRequire(import.meta.url);
  opener = null;
  try {
    const { DatabaseSync } = process.getBuiltinModule?.('node:sqlite') ?? require('node:sqlite');
    new DatabaseSync(':memory:').close();
    opener = (dbPath) => {
      const db = new DatabaseSync(dbPath);
      return wrap(db, (sql) => db.prepare(sql));
    };
    return opener;
  } catch {
    // Not Node, or a Node without node:sqlite; try Bun next.
  }
  try {
    const { Database } = require('bun:sqlite');
    new Database(':memory:').close();
    opener = (dbPath) => {
      const db = new Database(dbPath);
      return wrap(db, (sql) => db.query(sql));
    };
  } catch {
    // No sqlite runtime at all.
  }
  return opener;
};

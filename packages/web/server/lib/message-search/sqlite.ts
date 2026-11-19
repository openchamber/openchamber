import { createRequire } from 'node:module';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

type SqliteRow = Record<string, SQLOutputValue>;

interface SqliteDatabase {
  exec(sql: string): void;
  close(): void;
}

interface SqliteStatement {
  all(...params: SQLInputValue[]): SqliteRow[];
  iterate(...params: SQLInputValue[]): IterableIterator<SqliteRow>;
  get(...params: SQLInputValue[]): SqliteRow | undefined | null;
  run(...params: SQLInputValue[]): void;
}

interface BunSqliteDatabase extends SqliteDatabase {
  query(sql: string): SqliteStatement;
}

export interface SqliteConnection {
  exec(sql: string): void;
  all(sql: string, params?: SQLInputValue[]): SqliteRow[];
  iterate(sql: string, params?: SQLInputValue[]): IterableIterator<SqliteRow>;
  get(sql: string, params?: SQLInputValue[]): SqliteRow | null;
  run(sql: string, params?: SQLInputValue[]): void;
  transaction<T>(work: () => T): T;
  close(): void;
}

export type SqliteOpener = (dbPath: string) => SqliteConnection;

let opener: SqliteOpener | null | undefined;

const wrap = (db: SqliteDatabase, prepare: (sql: string) => SqliteStatement): SqliteConnection => {
  const statements = new Map<string, SqliteStatement>();
  const statement = (sql: string) => {
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
    iterate: (sql, params = []) => statement(sql).iterate(...params),
    get: (sql, params = []) => statement(sql).get(...params) ?? null,
    run: (sql, params = []) => {
      statement(sql).run(...params);
    },
    transaction: <T>(work: () => T) => {
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
    const { DatabaseSync }: typeof import('node:sqlite') = process.getBuiltinModule?.('node:sqlite') ?? require('node:sqlite');
    new DatabaseSync(':memory:').close();
    opener = (dbPath) => {
      const db = new DatabaseSync(dbPath);
      return wrap(db, (sql) => db.prepare(sql));
    };
    return opener;
  } catch {
    opener = null;
  }
  try {
    const { Database }: { Database: new (dbPath: string) => BunSqliteDatabase } = require('bun:sqlite');
    new Database(':memory:').close();
    opener = (dbPath) => {
      const db = new Database(dbPath);
      return wrap(db, (sql) => db.query(sql));
    };
  } catch {
    opener = null;
  }
  return opener;
};

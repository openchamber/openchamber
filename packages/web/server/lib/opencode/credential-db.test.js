import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { projectCredentialValue, readCredentialsFromDb, resolveCredentialDbPath } from './credential-db.js';

const sqlite = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite');
  } catch {
    return null;
  }
})();

const seed = (dbPath, rows) => {
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, ' +
      'connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)',
  );
  const insert = db.prepare(
    'INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    insert.run(row.id, row.integration, row.label ?? 'default', JSON.stringify(row.value), row.active ?? null, row.time ?? 1, row.time ?? 1);
  }
  db.close();
};

describe('projectCredentialValue', () => {
  it('maps a stored key to the legacy api entry', () => {
    expect(projectCredentialValue({ type: 'key', key: 'sk-1', metadata: { region: 'eu' } })).toEqual({
      type: 'api',
      key: 'sk-1',
      metadata: { region: 'eu' },
    });
  });

  it('maps a stored oauth credential, including the account and enterprise fields', () => {
    expect(
      projectCredentialValue({
        type: 'oauth',
        methodID: 'chatgpt-browser',
        access: 'a',
        refresh: 'r',
        expires: 42,
        metadata: { accountID: 'acc', enterpriseUrl: 'https://ghe.example' },
      }),
    ).toEqual({ type: 'oauth', access: 'a', refresh: 'r', expires: 42, accountId: 'acc', enterpriseUrl: 'https://ghe.example' });
  });

  it('rejects shapes it does not understand instead of guessing', () => {
    expect(projectCredentialValue('not json')).toBeNull();
    expect(projectCredentialValue({ type: 'oauth', access: 'a' })).toBeNull();
    expect(projectCredentialValue({ type: 'something-new', key: 'x' })).toBeNull();
  });
});

describe('resolveCredentialDbPath', () => {
  it('defaults to opencode.db in the data dir and honours OPENCODE_DB', () => {
    expect(resolveCredentialDbPath({ dataDir: '/data', env: {}, path })).toBe(path.join('/data', 'opencode.db'));
    expect(resolveCredentialDbPath({ dataDir: '/data', env: { OPENCODE_DB: 'other.db' }, path })).toBe(path.resolve('/data', 'other.db'));
    expect(resolveCredentialDbPath({ dataDir: '/data', env: { OPENCODE_DB: '/abs/x.db' }, path })).toBe(path.resolve('/abs/x.db'));
  });
});

describe.skipIf(!sqlite)('readCredentialsFromDb', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-cred-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when there is no database, so the caller can fall back', () => {
    expect(readCredentialsFromDb({ dbPath: path.join(dir, 'opencode.db'), fs })).toBeNull();
  });

  it('picks the active credential per integration, else the newest one', () => {
    const dbPath = path.join(dir, 'opencode.db');
    seed(dbPath, [
      { id: 'c1', integration: 'openai', value: { type: 'oauth', access: 'old', refresh: 'r1', expires: 1 }, active: 0, time: 5 },
      { id: 'c2', integration: 'openai', value: { type: 'oauth', access: 'new', refresh: 'r2', expires: 2 }, active: 1, time: 2 },
      { id: 'c3', integration: 'opencode-go', value: { type: 'key', key: 'go-old' }, time: 1 },
      { id: 'c4', integration: 'opencode-go', value: { type: 'key', key: 'go-new' }, time: 9 },
      { id: 'c5', integration: 'weird', value: { type: 'future' }, time: 1 },
    ]);
    expect(readCredentialsFromDb({ dbPath, fs })).toEqual({
      openai: { type: 'oauth', access: 'new', refresh: 'r2', expires: 2 },
      'opencode-go': { type: 'api', key: 'go-new' },
    });
  });

  it('returns null rather than throwing when the schema is not what it expects', () => {
    const dbPath = path.join(dir, 'opencode.db');
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec('CREATE TABLE credential (id TEXT PRIMARY KEY)');
    db.close();
    expect(readCredentialsFromDb({ dbPath, fs })).toBeNull();
  });
});

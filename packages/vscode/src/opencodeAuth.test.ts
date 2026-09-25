import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { projectCredentialValue, readCredentialsFromDb, resolveCredentialDbPath } from './opencodeAuth';

type Sqlite = { DatabaseSync: new (p: string) => { exec: (s: string) => void; prepare: (s: string) => { run: (...a: unknown[]) => void }; close: () => void } };
const sqlite = ((): Sqlite | null => {
  try {
    // SAFETY: node:sqlite is a built-in with a fixed surface; the test only
    // uses DatabaseSync to seed a table.
    return createRequire(__filename)('node:sqlite') as Sqlite;
  } catch {
    return null;
  }
})();

describe('projectCredentialValue', () => {
  it('maps key and oauth rows to the legacy entry shape', () => {
    assert.deepEqual(projectCredentialValue(JSON.stringify({ type: 'key', key: 'k' })), { type: 'api', key: 'k' });
    assert.deepEqual(
      projectCredentialValue(JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: 5, metadata: { accountID: 'x' } })),
      { type: 'oauth', access: 'a', refresh: 'r', expires: 5, accountId: 'x' },
    );
    assert.equal(projectCredentialValue(JSON.stringify({ type: 'future' })), null);
    assert.equal(projectCredentialValue('not json'), null);
  });
});

describe('resolveCredentialDbPath', () => {
  it('uses opencode.db unless OPENCODE_DB is set', () => {
    assert.equal(resolveCredentialDbPath('/data', {}), path.join('/data', 'opencode.db'));
    assert.equal(resolveCredentialDbPath('/data', { OPENCODE_DB: 'x.db' }), path.resolve('/data', 'x.db'));
  });
});

describe('readCredentialsFromDb', () => {
  it('returns the active credential per integration and null without a database', () => {
    // Bun runs this file too and has no `node:sqlite`; the reader then answers
    // null by design, which is the only thing worth asserting there.
    if (!sqlite) {
      assert.equal(readCredentialsFromDb(path.join(os.tmpdir(), 'nowhere', 'opencode.db')), null);
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-cred-'));
    try {
      const dbPath = path.join(dir, 'opencode.db');
      assert.equal(readCredentialsFromDb(dbPath), null);

      const db = new sqlite!.DatabaseSync(dbPath);
      db.exec(
        'CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, ' +
          'active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)',
      );
      const insert = db.prepare('INSERT INTO credential VALUES (?, ?, ?, ?, ?, ?, ?)');
      insert.run('c1', 'openai', 'old', JSON.stringify({ type: 'oauth', access: 'old', refresh: 'r', expires: 1 }), 0, 9, 9);
      insert.run('c2', 'openai', 'new', JSON.stringify({ type: 'oauth', access: 'new', refresh: 'r', expires: 2 }), 1, 1, 1);
      insert.run('c3', 'opencode-go', 'k', JSON.stringify({ type: 'key', key: 'go' }), null, 1, 1);
      db.close();

      assert.deepEqual(readCredentialsFromDb(dbPath), {
        openai: { type: 'oauth', access: 'new', refresh: 'r', expires: 2 },
        'opencode-go': { type: 'api', key: 'go' },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

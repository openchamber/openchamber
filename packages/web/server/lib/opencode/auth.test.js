import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { readAuthFile } from './auth.js';

const sqlite = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite');
  } catch {
    return null;
  }
})();

let dir;
let dbPath;
let authFile;

const seedDb = (rows) => {
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, ' +
      'active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)',
  );
  const insert = db.prepare(
    'INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const [index, row] of rows.entries()) {
    insert.run(`c${index}`, row.integration, 'default', JSON.stringify(row.value), 1, 1, 1);
  }
  db.close();
};

const read = () => readAuthFile({ dbPath, authFile, fileSystem: fs });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-auth-'));
  dbPath = path.join(dir, 'opencode.db');
  authFile = path.join(dir, 'auth.json');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!sqlite)('readAuthFile', () => {
  it('answers from the database alone when it can be read, so a credential deleted in OpenCode stays deleted', () => {
    // OpenCode never clears auth.json after importing it; the stale key must not come back.
    fs.writeFileSync(authFile, JSON.stringify({ openai: { type: 'api', key: 'stale' }, deepseek: { type: 'api', key: 'removed' } }));
    seedDb([{ integration: 'openai', value: { type: 'key', key: 'fresh' } }]);
    expect(read()).toEqual({ openai: { type: 'api', key: 'fresh' } });
  });

  it('treats an empty database as authoritative', () => {
    fs.writeFileSync(authFile, JSON.stringify({ openai: { type: 'api', key: 'stale' } }));
    seedDb([]);
    expect(read()).toEqual({});
  });

  it('does not let a corrupt legacy file block a healthy database', () => {
    fs.writeFileSync(authFile, '{ not json');
    seedDb([{ integration: 'openai', value: { type: 'key', key: 'fresh' } }]);
    expect(read()).toEqual({ openai: { type: 'api', key: 'fresh' } });
  });

  it('falls back to the legacy file only when the database is unavailable', () => {
    fs.writeFileSync(authFile, JSON.stringify({ openai: { type: 'api', key: 'legacy' } }));
    expect(read()).toEqual({ openai: { type: 'api', key: 'legacy' } });
  });

  it('falls back to the legacy file when the database schema is not what it expects', () => {
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec('CREATE TABLE credential (id TEXT PRIMARY KEY)');
    db.close();
    fs.writeFileSync(authFile, JSON.stringify({ openai: { type: 'api', key: 'legacy' } }));
    expect(read()).toEqual({ openai: { type: 'api', key: 'legacy' } });
  });

  it('reports a corrupt legacy file when it is the only source left', () => {
    fs.writeFileSync(authFile, '{ not json');
    expect(() => read()).toThrow('Failed to read OpenCode auth configuration');
  });

  it('answers empty with neither source present', () => {
    expect(read()).toEqual({});
  });
});

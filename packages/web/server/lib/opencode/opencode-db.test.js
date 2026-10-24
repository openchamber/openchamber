import { afterEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import { isInMemoryOpenCodeDb, resolveOpenCodeDataDir, resolveOpenCodeDbPath } from './opencode-db.js';

const HOME = os.homedir();

describe('resolveOpenCodeDataDir', () => {
  it('follows XDG_DATA_HOME the way OpenCode does', () => {
    expect(resolveOpenCodeDataDir({ XDG_DATA_HOME: '/data/xdg' })).toBe('/data/xdg/opencode');
  });

  it('falls back to ~/.local/share/opencode', () => {
    expect(resolveOpenCodeDataDir({})).toBe(path.join(HOME, '.local', 'share', 'opencode'));
  });

  it('ignores a blank XDG_DATA_HOME', () => {
    expect(resolveOpenCodeDataDir({ XDG_DATA_HOME: '   ' })).toBe(path.join(HOME, '.local', 'share', 'opencode'));
  });
});

describe('resolveOpenCodeDbPath', () => {
  it('uses opencode.db in the data directory', () => {
    expect(resolveOpenCodeDbPath({ XDG_DATA_HOME: '/data/xdg' })).toBe('/data/xdg/opencode/opencode.db');
  });

  it('keeps an absolute OPENCODE_DB', () => {
    expect(resolveOpenCodeDbPath({ XDG_DATA_HOME: '/data/xdg', OPENCODE_DB: '/srv/other.db' })).toBe('/srv/other.db');
  });

  it('resolves a relative OPENCODE_DB against the data directory', () => {
    expect(resolveOpenCodeDbPath({ XDG_DATA_HOME: '/data/xdg', OPENCODE_DB: 'custom.db' })).toBe('/data/xdg/opencode/custom.db');
  });

  it('reports an in-memory database instead of a path', () => {
    expect(isInMemoryOpenCodeDb({ OPENCODE_DB: ':memory:' })).toBe(true);
    expect(isInMemoryOpenCodeDb({ OPENCODE_DB: 'opencode.db' })).toBe(false);
    expect(isInMemoryOpenCodeDb({})).toBe(false);
  });
});

describe('loadSqlite', () => {
  const previous = process.env.OPENCODE_DB;
  afterEach(() => {
    if (previous === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = previous;
  });

  it('opens an in-memory database when the runtime has one', async () => {
    const { loadSqlite } = await import('./opencode-db.js');
    const open = loadSqlite();
    if (!open) return;
    const db = open(':memory:');
    try {
      db.exec('CREATE TABLE probe (value INTEGER)');
      db.run('INSERT INTO probe (value) VALUES (?)', [7]);
      expect(db.all('SELECT value FROM probe')).toEqual([{ value: 7 }]);
    } finally {
      db.close();
    }
  });
});

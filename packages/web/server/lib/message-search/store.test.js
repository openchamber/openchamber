import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadSqliteOpener } from './sqlite.js';
import { openMessageSearchStore, toMatchExpression } from './store.js';

const open = loadSqliteOpener();
const temporaryDirectories = [];

const createLegacyFile = ({ partial = false } = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'message-search-migration-'));
  temporaryDirectories.push(directory);
  const file = path.join(directory, 'message-search.sqlite');
  const connection = open(file);
  connection.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0, revert_id TEXT, user_cursor TEXT, assistant_cursor TEXT, user_anchor TEXT, assistant_anchor TEXT, synced_updated_at INTEGER${partial ? ', archived_at INTEGER' : ''});
    CREATE TABLE messages (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL, text TEXT NOT NULL);
    CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='seq', tokenize='trigram');
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts (rowid, text) VALUES (new.seq, new.text); END;
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.seq, old.text); END;
    CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages BEGIN INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.seq, old.text); INSERT INTO messages_fts (rowid, text) VALUES (new.seq, new.text); END;`);
  connection.run("INSERT INTO meta (key, value) VALUES ('schema', '3')");
  connection.run("INSERT INTO sessions (id, directory, title, user_cursor) VALUES ('a', '/repo/a', 'A', 'cursor')");
  connection.run("INSERT INTO messages (id, message_id, session_id, role, created_at, text) VALUES ('m', 'm', 'a', 'user', 1, 'legacy searchable')");
  connection.close();
  return file;
};

const seedSession = (store, id, { directory = `/repo/${id}`, archivedAt = null, lifecycleKnown = true } = {}) => {
  store.upsertSession({ id, directory, title: id.toUpperCase(), archivedAt, lifecycleKnown });
};

const groupedPage = (store, before = null, options = {}) => store.searchSessions({
  match: toMatchExpression('common'),
  before,
  limit: 2,
  ...options,
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(!open)('message search store', () => {
  it('pages globally newest session representatives without duplicates, including timestamp ties', () => {
    const store = openMessageSearchStore(open(':memory:'));
    for (const id of ['a', 'b', 'c', 'd', 'e']) seedSession(store, id);
    store.putMessages([
      { id: 'a100', sessionId: 'a', role: 'user', createdAt: 100, text: 'common term' },
      { id: 'b90', sessionId: 'b', role: 'user', createdAt: 90, text: 'common term' },
      { id: 'a70', sessionId: 'a', role: 'user', createdAt: 70, text: 'common term' },
      { id: 'c60', sessionId: 'c', role: 'user', createdAt: 60, text: 'common term' },
      { id: 'd60', sessionId: 'd', role: 'user', createdAt: 60, text: 'common term' },
      { id: 'e60', sessionId: 'e', role: 'user', createdAt: 60, text: 'common term' },
    ]);

    const first = groupedPage(store);
    const second = groupedPage(store, { createdAt: first.hits.at(-1).createdAt, sessionId: first.hits.at(-1).sessionId });
    const third = groupedPage(store, { createdAt: second.hits.at(-1).createdAt, sessionId: second.hits.at(-1).sessionId });

    expect(first.hits.map((hit) => hit.sessionId)).toEqual(['a', 'b']);
    expect(second.hits.map((hit) => hit.sessionId)).toEqual(['e', 'd']);
    expect(third.hits.map((hit) => hit.sessionId)).toEqual(['c']);
    expect(new Set([...first.hits, ...second.hits, ...third.hits].map((hit) => hit.sessionId)).size).toBe(5);
    store.close();
  });

  it('applies lifecycle, directory and role filters before representative paging', () => {
    const store = openMessageSearchStore(open(':memory:'));
    seedSession(store, 'active', { directory: '/wanted' });
    seedSession(store, 'archived', { directory: '/wanted', archivedAt: 123 });
    seedSession(store, 'unknown', { directory: '/wanted', lifecycleKnown: false });
    seedSession(store, 'elsewhere', { directory: '/other' });
    store.putMessages([
      { id: 'active-new-assistant', sessionId: 'active', role: 'assistant', createdAt: 100, text: 'common term' },
      { id: 'active-user', sessionId: 'active', role: 'user', createdAt: 50, text: 'common term' },
      { id: 'archived-user', sessionId: 'archived', role: 'user', createdAt: 90, text: 'common term' },
      { id: 'unknown-user', sessionId: 'unknown', role: 'user', createdAt: 80, text: 'common term' },
      { id: 'elsewhere-user', sessionId: 'elsewhere', role: 'user', createdAt: 70, text: 'common term' },
    ]);

    expect(groupedPage(store, null, { lifecycle: 'active', directories: ['/wanted'], role: 'user' }).hits.map((hit) => hit.rowId)).toEqual(['active-user']);
    expect(groupedPage(store, null, { lifecycle: 'archived', directories: ['/wanted'], role: 'user' }).hits.map((hit) => hit.rowId)).toEqual(['archived-user']);
    expect(groupedPage(store, null, { lifecycle: 'all', directories: ['/wanted'], role: 'user', limit: 10 }).hits.map((hit) => hit.sessionId)).toEqual(['archived', 'unknown', 'active']);
    store.close();
  });

  it('keeps mixed lifecycle, directory and role filters stable across cursors', () => {
    const store = openMessageSearchStore(open(':memory:'));
    for (const id of ['a', 'b', 'c', 'd']) seedSession(store, id, { directory: '/wanted' });
    seedSession(store, 'archived', { directory: '/wanted', archivedAt: 123 });
    seedSession(store, 'elsewhere', { directory: '/other' });
    store.putMessages([
      { id: 'a-assistant', sessionId: 'a', role: 'assistant', createdAt: 110, text: 'common term' },
      { id: 'a-user', sessionId: 'a', role: 'user', createdAt: 70, text: 'common term' },
      { id: 'b-user', sessionId: 'b', role: 'user', createdAt: 100, text: 'common term' },
      { id: 'c-user', sessionId: 'c', role: 'user', createdAt: 90, text: 'common term' },
      { id: 'd-user', sessionId: 'd', role: 'user', createdAt: 80, text: 'common term' },
      { id: 'archived-user', sessionId: 'archived', role: 'user', createdAt: 120, text: 'common term' },
      { id: 'elsewhere-user', sessionId: 'elsewhere', role: 'user', createdAt: 130, text: 'common term' },
    ]);
    const options = { lifecycle: 'active', directories: ['/wanted'], role: 'user' };

    const first = groupedPage(store, null, options);
    const last = first.hits.at(-1);
    const second = groupedPage(store, { createdAt: last.createdAt, sessionId: last.sessionId }, options);

    expect([...first.hits, ...second.hits].map((hit) => hit.sessionId)).toEqual(['b', 'c', 'd', 'a']);
    store.close();
  });

  it('counts a reply and its reasoning as one distinct message match', () => {
    const store = openMessageSearchStore(open(':memory:'));
    seedSession(store, 'a');
    store.putMessages([
      { id: 'reply', messageId: 'reply', sessionId: 'a', role: 'assistant', createdAt: 2, text: 'common answer' },
      { id: 'reply:reasoning', messageId: 'reply', sessionId: 'a', role: 'reasoning', createdAt: 2, text: 'common thought' },
      { id: 'prompt', messageId: 'prompt', sessionId: 'a', role: 'user', createdAt: 1, text: 'common request' },
    ]);

    expect(groupedPage(store, null, { includeReasoning: true }).hits[0].matchCount).toBe(2);
    store.close();
  });

  it('rolls back an interrupted schema 3 migration and reopens with rows and cursors intact', () => {
    const file = createLegacyFile();
    const connection = open(file);
    const interrupted = {
      ...connection,
      exec: (sql) => {
        connection.exec(sql);
        if (sql.includes('ADD COLUMN archived_at')) throw new Error('simulated interruption');
      },
    };

    expect(() => openMessageSearchStore(interrupted)).toThrow('simulated interruption');
    connection.close();

    const afterFailure = open(file);
    expect(afterFailure.get("SELECT value FROM meta WHERE key = 'schema'").value).toBe('3');
    expect(afterFailure.all('PRAGMA table_info(sessions)').map((column) => column.name)).not.toContain('archived_at');
    expect(afterFailure.get("SELECT user_cursor FROM sessions WHERE id = 'a'").user_cursor).toBe('cursor');
    afterFailure.close();

    const migrated = openMessageSearchStore(open(file));
    expect(migrated.readSession('a')).toMatchObject({ user_cursor: 'cursor', lifecycle_known: 0 });
    expect(migrated.search({ match: toMatchExpression('searchable'), limit: 20 })).toHaveLength(1);
    migrated.close();
  });

  it('recovers an already-partial schema 3 migration without losing rows or cursors', () => {
    const file = createLegacyFile({ partial: true });
    const migrated = openMessageSearchStore(open(file));

    expect(migrated.readSession('a')).toMatchObject({ user_cursor: 'cursor', archived_at: null, lifecycle_known: 0 });
    expect(migrated.search({ match: toMatchExpression('searchable'), limit: 20 })).toHaveLength(1);
    migrated.close();
  });
});

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseMagicContextLogLine, readDiagnostics, resolveDataPaths } from './diagnostics.js';
import { isCurrentSessionRefresh, parseDiagnosticsResponse, preserveLastGoodLog } from '../shared.js';

const roots: string[] = [];
type FixtureDatabasePaths = { magicContext: string; openCode: string };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const temporaryRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-context-extension-'));
  roots.push(root);
  return root;
};

const createDatabases = (root: string): FixtureDatabasePaths => {
  const magicContext = path.join(root, 'context.db');
  const contextDb = new DatabaseSync(magicContext);
  contextDb.exec(`
    CREATE TABLE session_meta (
      session_id TEXT, harness TEXT, last_input_tokens INTEGER,
      last_context_percentage REAL, last_usage_context_limit INTEGER
    );
    CREATE TABLE compartments (id TEXT, session_id TEXT);
    CREATE TABLE memories (id TEXT, session_id TEXT, deleted_at TEXT);
    CREATE TABLE pending_ops (id TEXT, session_id TEXT);
    CREATE TABLE notes (id TEXT, session_id TEXT);
    CREATE TABLE transform_decisions (
      session_id TEXT, harness TEXT, message_id TEXT, decision TEXT,
      materialize_reason TEXT, emergency INTEGER
    );
  `);
  contextDb.prepare('INSERT INTO session_meta VALUES (?, ?, ?, ?, ?)').run('session-1', 'opencode', 210_000, 22.8, 922_000);
  contextDb.prepare('INSERT INTO compartments VALUES (?, ?)').run('compartment-1', 'session-1');
  contextDb.prepare('INSERT INTO memories VALUES (?, ?, ?)').run('memory-1', 'session-1', null);
  contextDb.prepare('INSERT INTO pending_ops VALUES (?, ?)').run('op-1', 'session-1');
  contextDb.prepare('INSERT INTO notes VALUES (?, ?)').run('note-1', 'session-1');
  const decisionInsert = contextDb.prepare('INSERT INTO transform_decisions VALUES (?, ?, ?, ?, ?, ?)');
  for (let index = 0; index < 60; index += 1) {
    decisionInsert.run('session-1', 'opencode', `unrelated-${index}`, 'cache', 'no change', 0);
  }
  decisionInsert.run('session-1', 'opencode', 'message-1', 'materialize', 'context threshold', 0);
  contextDb.close();

  const openCode = path.join(root, 'opencode.db');
  const openCodeDb = new DatabaseSync(openCode);
  openCodeDb.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
  const data = JSON.stringify({
    role: 'assistant',
    tokens: { input: 300, cache: { read: 600, write: 100 }, total: 1_000 },
  });
  openCodeDb.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('message-1', 'session-1', Date.now(), data);
  openCodeDb.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('message-other', 'session-2', Date.now(), data);
  const userMessage = JSON.stringify({ role: 'user', tokens: { input: 1, total: 1 } });
  const userInsert = openCodeDb.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
  userInsert.run('malformed', 'session-1', Date.now() + 1, '{malformed json');
  for (let index = 0; index < 55; index += 1) {
    userInsert.run(`user-${index}`, 'session-1', Date.now() + index + 1, userMessage);
  }
  openCodeDb.close();
  return { magicContext, openCode };
};

describe('Magic Context diagnostics', () => {
  test('resolves the same default storage, OpenCode, and log paths used by mcdash', () => {
    assert.deepEqual(resolveDataPaths('/home/test', '/tmp'), {
      magicContext: '/home/test/.local/share/cortexkit/magic-context/context.db',
      openCode: '/home/test/.local/share/opencode/opencode.db',
      log: '/tmp/opencode/magic-context/magic-context.log',
    });
  });

  test('parses only bounded log metadata and discards log message text', () => {
    const event = parseMagicContextLogLine(
      '2026-09-23T12:00:00.000Z WARN magic-context: session.status stream cache.read=120 cache.write=5 tokens.input=30 prompt=private',
    );
    assert.deepEqual(event, {
      at: '2026-09-23T12:00:00.000Z', level: 'warn', category: 'cache',
      inputTokens: 30, cacheRead: 120, cacheWrite: 5,
    });
    assert.equal(event && 'message' in event, false);
    assert.equal(parseMagicContextLogLine('[2026-09-23T12:00:00Z] [magic-context][session] historian completed')?.category, 'historian');
    assert.equal(parseMagicContextLogLine('unrelated application output'), null);
  });

  test('validates service responses at the panel boundary', () => {
    const valid = {
      schemaVersion: 1,
      observedAt: '2026-09-23T12:00:00.000Z',
      log: { state: 'ready', observedAt: '2026-09-23T12:00:00.000Z', events: [] },
    };
    assert.deepEqual(parseDiagnosticsResponse(JSON.stringify(valid)), valid);
    assert.equal(parseDiagnosticsResponse('{broken'), null);
    assert.equal(parseDiagnosticsResponse(JSON.stringify({ ...valid, schemaVersion: 2 })), null);
  });

  test('does not accept an old response after switching away and back to the same session', () => {
    const request = { sessionId: 'session-a', generation: 4 };
    const current = { sessionId: 'session-a', generation: 6 };
    assert.equal(isCurrentSessionRefresh(request, current), false);
    assert.equal(isCurrentSessionRefresh(current, current), true);
  });

  test('retains last-good log events on a transient read error', () => {
    const previous = {
      state: 'ready' as const,
      observedAt: '2026-09-23T12:00:00.000Z',
      events: [{ at: '2026-09-23T11:59:59.000Z', level: 'info' as const, category: 'stream' as const, inputTokens: null, cacheRead: null, cacheWrite: null }],
    };
    const failed = { state: 'error' as const, observedAt: '2026-09-23T12:00:05.000Z', events: [] };
    assert.deepEqual(preserveLastGoodLog(previous, failed), { ...previous, state: 'error' });
    assert.deepEqual(preserveLastGoodLog(previous, { ...failed, state: 'missing' }), { ...failed, state: 'missing' });
  });

  test('returns session-scoped, read-only database metrics and sanitized log events', async () => {
    const root = await temporaryRoot();
    const databases = createDatabases(root);
    const log = path.join(root, 'magic-context.log');
    await fs.writeFile(log, [
      '2026-09-23T12:00:00.000Z INFO magic-context: cache.read=600 cache.write=100 tokens.input=300 secret prompt text',
      '[2026-09-23T12:00:01Z] [magic-context][session-1] session.status stream completed private text',
    ].join('\n'));

    const snapshot = await readDiagnostics({
      sessionId: 'session-1',
      includeDatabase: true,
      paths: { ...databases, log },
    });

    assert.deepEqual(snapshot.database?.magicContext, {
      state: 'ready',
      context: { inputTokens: 210_000, contextLimit: 922_000, usagePercent: 22.8 },
      counts: { compartments: 1, memories: 1, pendingOps: 1, sessionNotes: 1 },
    });
    const cacheEvent = snapshot.database?.openCode.cacheEvents[0];
    assert.ok(cacheEvent);
    assert.ok(cacheEvent.at);
    const { at: _at, ...cacheEventValues } = cacheEvent;
    assert.deepEqual(snapshot.database?.openCode.state, 'ready');
    assert.deepEqual(snapshot.database?.openCode.lastInputTokens, 300);
    assert.deepEqual(cacheEventValues, {
      inputTokens: 300, cacheRead: 600, cacheWrite: 100, totalTokens: 1_000, hitRatio: 2 / 3, cause: 'materialized',
    });
    assert.deepEqual(snapshot.log.events.map((event) => event.category), ['cache', 'stream']);
    assert.equal(JSON.stringify(snapshot).includes('secret prompt'), false);
    assert.equal(JSON.stringify(snapshot).includes('private text'), false);

    const verifyContext = new DatabaseSync(databases.magicContext, { readOnly: true });
    assert.equal(verifyContext.prepare('SELECT COUNT(*) AS count FROM memories').get()?.count, 1);
    assert.throws(() => verifyContext.exec('DELETE FROM memories'));
    verifyContext.close();

    const verifyOpenCode = new DatabaseSync(databases.openCode, { readOnly: true });
    assert.equal(verifyOpenCode.prepare('SELECT COUNT(*) AS count FROM message WHERE session_id = ?').get('session-1')?.count, 57);
    assert.throws(() => verifyOpenCode.exec('DELETE FROM message'));
    verifyOpenCode.close();
  });

  test('reports missing files instead of treating them as empty successful data', async () => {
    const root = await temporaryRoot();
    const snapshot = await readDiagnostics({
      sessionId: null,
      includeDatabase: true,
      paths: {
        magicContext: path.join(root, 'missing-context.db'),
        openCode: path.join(root, 'missing-opencode.db'),
        log: path.join(root, 'missing.log'),
      },
    });
    assert.equal(snapshot.database?.magicContext.state, 'missing');
    assert.equal(snapshot.database?.openCode.state, 'missing');
    assert.equal(snapshot.log.state, 'missing');
    assert.deepEqual(snapshot.database?.openCode.cacheEvents, []);
  });

  test('reports unknown database layouts as partial, not successful empty diagnostics', async () => {
    const root = await temporaryRoot();
    const magicContext = path.join(root, 'context.db');
    const openCode = path.join(root, 'opencode.db');
    new DatabaseSync(magicContext).close();
    new DatabaseSync(openCode).close();
    const log = path.join(root, 'magic-context.log');
    await fs.writeFile(log, '');

    const snapshot = await readDiagnostics({
      sessionId: null,
      includeDatabase: true,
      paths: { magicContext, openCode, log },
    });
    assert.equal(snapshot.database?.magicContext.state, 'partial');
    assert.equal(snapshot.database?.openCode.state, 'partial');
    assert.equal(snapshot.log.state, 'ready');
    assert.equal(snapshot.log.events.length, 0);
  });
});

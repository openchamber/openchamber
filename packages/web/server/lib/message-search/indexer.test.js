import { describe, expect, it, beforeEach } from 'vitest';

import { createMessageSearchIndexer } from './indexer.js';
import { loadSqliteOpener } from './sqlite.js';
import { buildSnippet, MATCH_END, MATCH_START, openMessageSearchStore, toMatchExpression } from './store.js';

// A fake OpenCode that pages the way v2 does (message.ts): ascending order,
// an opaque cursor naming the last item of the page, filtered by type.
const createFakeOpenCode = () => {
  const sessions = new Map();
  const messages = new Map();
  const calls = { list: [] };
  let failSessionList = false;
  const encode = (id) => Buffer.from(JSON.stringify({ id })).toString('base64url');
  const decode = (cursor) => JSON.parse(Buffer.from(cursor, 'base64url').toString()).id;
  const tagged = (tag) => Object.assign(new Error(tag), { _tag: tag });

  const client = {
    session: {
      get: async ({ sessionID }) => {
        const session = sessions.get(sessionID);
        if (!session) throw tagged('SessionNotFoundError');
        return session;
      },
      list: async () => {
        if (failSessionList) throw new Error('boom');
        return { data: [...sessions.values()].filter((s) => !s.parentID), cursor: {} };
      },
      message: {
        get: async ({ sessionID, messageID }) => {
          const found = (messages.get(sessionID) ?? []).find((m) => m.id === messageID);
          if (!found) throw tagged('MessageNotFoundError');
          return found;
        },
      },
    },
    message: {
      list: async ({ sessionID, limit, type, cursor }) => {
        calls.list.push({ sessionID, type, cursor: cursor ?? null });
        const all = (messages.get(sessionID) ?? []).filter((m) => m.type === type);
        let start = 0;
        if (cursor) {
          const index = all.findIndex((m) => m.id === decode(cursor));
          // v2 answers a cursor whose message is gone with an empty page
          // (core session/store.ts), not an error.
          if (index < 0) return { data: [], cursor: {} };
          start = index + 1;
        }
        const data = all.slice(start, start + limit);
        return { data, cursor: { next: data.length ? encode(data[data.length - 1].id) : undefined } };
      },
    },
  };

  let clock = 1000;
  return {
    client,
    calls,
    failSessionList: (value) => { failSessionList = value; },
    session: (id, extra = {}) => {
      sessions.set(id, { id, title: `Session ${id}`, location: { directory: `/repo/${id}` }, time: { created: clock, updated: clock }, ...extra });
      if (!messages.has(id)) messages.set(id, []);
    },
    touch: (id, patch = {}) => {
      clock += 1;
      sessions.set(id, { ...sessions.get(id), ...patch, time: { ...sessions.get(id).time, updated: clock } });
    },
    removeSession: (id) => sessions.delete(id),
    user: (sessionId, id, text) => {
      clock += 1;
      messages.get(sessionId).push({ id, type: 'user', text, time: { created: clock } });
    },
    assistant: (sessionId, id, parts, { completed = true } = {}) => {
      clock += 1;
      const time = { created: clock };
      if (completed) time.completed = clock;
      messages.get(sessionId).push({ id, type: 'assistant', content: parts, time });
    },
    complete: (sessionId, id) => {
      const record = messages.get(sessionId).find((m) => m.id === id);
      record.time.completed = record.time.created;
    },
    dropMessage: (sessionId, id) => {
      messages.set(sessionId, messages.get(sessionId).filter((m) => m.id !== id));
    },
  };
};

const open = loadSqliteOpener();

describe.skipIf(!open)('message search index', () => {
  let fake;
  let store;
  let indexer;
  const search = (query, options = {}) => store.search({ match: toMatchExpression(query), limit: 50, ...options });

  beforeEach(() => {
    fake = createFakeOpenCode();
    store = openMessageSearchStore(open(':memory:'));
    indexer = createMessageSearchIndexer({ store, createClient: () => fake.client, pageSize: 2, liveDebounceMs: 0, backfillPauseMs: 0, logger: { warn: () => {} } });
  });

  const backfill = async () => {
    indexer.onConnected();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await indexer.idle();
  };

  it('indexes user messages and agent text, not tools, reasoning or subagents', async () => {
    fake.session('a');
    fake.session('child', { parentID: 'a' });
    fake.user('a', 'u1', 'How do we rebuild the packaged desktop app?');
    fake.assistant('a', 'r1', [
      { type: 'reasoning', text: 'secret reasoning about packaging' },
      { type: 'tool', name: 'shell', input: { command: 'bun run package' }, output: 'package output' },
      { type: 'text', text: 'Run the package script, then reinstall.' },
    ]);
    fake.user('child', 'c1', 'subagent packaging chatter');
    await backfill();

    expect(search('packag').map((hit) => hit.id)).toEqual(['r1', 'u1']);
    expect(search('secret reasoning')).toEqual([]);
    expect(search('package output')).toEqual([]);
    expect(search('chatter')).toEqual([]);
    const [hit] = search('reinstall');
    expect(hit).toMatchObject({ sessionId: 'a', role: 'assistant', sessionTitle: 'Session a', directory: '/repo/a' });
    expect(hit.text).toContain('reinstall');
  });

  it('indexes reasoning as its own row of the same message when asked, and can leave it out of a search', async () => {
    indexer = createMessageSearchIndexer({
      store,
      createClient: () => fake.client,
      pageSize: 2,
      liveDebounceMs: 0,
      backfillPauseMs: 0,
      includeReasoning: () => true,
      logger: { warn: () => {} },
    });
    fake.session('a');
    fake.assistant('a', 'r1', [
      { type: 'reasoning', text: 'weighing the packaging options' },
      { type: 'text', text: 'Use the packaging script.' },
    ]);
    await backfill();

    expect(search('packaging').map((hit) => [hit.id, hit.role])).toEqual([['r1', 'reasoning'], ['r1', 'assistant']]);
    expect(search('packaging', { includeReasoning: false }).map((hit) => hit.role)).toEqual(['assistant']);
    expect(search('weighing', { role: 'reasoning' })).toHaveLength(1);

    // Pages by row, so a reply and its reasoning both come through.
    const [first] = search('packaging', { limit: 1 });
    const rest = search('packaging', { before: { createdAt: first.createdAt, id: first.rowId } });
    expect(rest.map((hit) => hit.role)).toEqual(['assistant']);

    store.deleteRole('reasoning');
    expect(search('weighing')).toEqual([]);
    expect(search('packaging')).toHaveLength(1);
  });

  it('reads agent records again after rereadAssistantRecords, picking up reasoning it skipped', async () => {
    let includeReasoning = false;
    indexer = createMessageSearchIndexer({
      store,
      createClient: () => fake.client,
      pageSize: 2,
      liveDebounceMs: 0,
      backfillPauseMs: 0,
      includeReasoning: () => includeReasoning,
      logger: { warn: () => {} },
    });
    fake.session('a');
    fake.user('a', 'u1', 'plan the release');
    fake.assistant('a', 'r1', [{ type: 'reasoning', text: 'thinking about changelog order' }, { type: 'text', text: 'Done.' }]);
    await backfill();
    expect(search('changelog')).toEqual([]);

    includeReasoning = true;
    await backfill();
    expect(search('changelog')).toEqual([]);

    store.rereadAssistantRecords();
    await backfill();
    expect(search('changelog').map((hit) => hit.role)).toEqual(['reasoning']);
    expect(search('release')).toHaveLength(1);
  });

  it('matches inside words in any script and ignores case', async () => {
    fake.session('a');
    fake.user('a', 'u1', 'Привіт СВІТУ, 你好世界');
    await backfill();
    expect(search('світ')).toHaveLength(1);
    expect(search('好世界')).toHaveLength(1);
    expect(toMatchExpression('ab')).toBeNull();
    expect(toMatchExpression('ab світ')).toBe('"світ"');
  });

  it('reads only what came after the cursor on the next sync', async () => {
    fake.session('a');
    fake.user('a', 'u1', 'first question');
    fake.user('a', 'u2', 'second question');
    fake.user('a', 'u3', 'third question');
    await backfill();
    fake.calls.list.length = 0;

    fake.user('a', 'u4', 'fourth question');
    fake.touch('a');
    await indexer.syncSession('a', '');
    const userCalls = fake.calls.list.filter((call) => call.type === 'user');
    expect(userCalls[0].cursor).not.toBeNull();
    expect(search('question').map((hit) => hit.id)).toEqual(['u4', 'u3', 'u2', 'u1']);
  });

  it('leaves an unfinished reply for later without skipping it', async () => {
    fake.session('a');
    fake.assistant('a', 'r1', [{ type: 'text', text: 'streaming answer so far' }], { completed: false });
    await backfill();
    expect(search('streaming')).toEqual([]);

    fake.complete('a', 'r1');
    await indexer.syncSession('a', '');
    expect(search('streaming').map((hit) => hit.id)).toEqual(['r1']);
  });

  it('starts the session over when the message its cursor points after is gone', async () => {
    fake.session('a');
    fake.user('a', 'u1', 'kept message');
    fake.user('a', 'u2', 'dropped message');
    await backfill();
    // A revert and a new prompt: the tail is deleted between two syncs.
    fake.dropMessage('a', 'u2');
    fake.user('a', 'u3', 'newer message');
    await indexer.syncSession('a', '');
    expect(search('message').map((hit) => hit.id)).toEqual(['u3', 'u1']);

    fake.user('a', 'u4', 'latest message');
    await indexer.syncSession('a', '');
    expect(search('message').map((hit) => hit.id)).toEqual(['u4', 'u3', 'u1']);
  });

  it('keeps its cursor when there is simply nothing new', async () => {
    fake.session('a');
    fake.user('a', 'u1', 'only message');
    await backfill();
    fake.calls.list.length = 0;
    await indexer.syncSession('a', '');
    expect(fake.calls.list.filter((call) => call.type === 'user').map((call) => call.cursor !== null)).toEqual([true]);
    expect(search('only').map((hit) => hit.id)).toEqual(['u1']);
  });

  it('forgets what a revert took back', async () => {
    fake.session('a');
    fake.user('a', 'u1', 'keep this request');
    fake.assistant('a', 'r1', [{ type: 'text', text: 'keep this answer' }]);
    fake.user('a', 'u2', 'undo this request');
    fake.assistant('a', 'r2', [{ type: 'text', text: 'undo this answer' }]);
    await backfill();
    expect(search('undo')).toHaveLength(2);

    fake.touch('a', { revert: { messageID: 'u2' } });
    await indexer.syncSession('a', '');
    expect(search('undo')).toEqual([]);
    expect(search('keep')).toHaveLength(2);
  });

  it('drops sessions OpenCode no longer lists, but not on a failed list', async () => {
    fake.session('a');
    fake.session('b');
    fake.user('a', 'u1', 'alpha words');
    fake.user('b', 'u2', 'beta words');
    await backfill();
    expect(search('words')).toHaveLength(2);

    fake.removeSession('b');
    fake.failSessionList(true);
    await backfill();
    expect(search('words')).toHaveLength(2);

    fake.failSessionList(false);
    await backfill();
    expect(search('words').map((hit) => hit.sessionId)).toEqual(['a']);
  });

  it('skips sessions unchanged since they were read', async () => {
    fake.session('a');
    fake.user('a', 'u1', 'one message');
    await backfill();
    fake.calls.list.length = 0;
    await backfill();
    expect(fake.calls.list).toEqual([]);
  });

  it('follows renames, moves and deletions from events', async () => {
    fake.session('a');
    fake.user('a', 'u1', 'event driven');
    await backfill();
    indexer.processPayload({ type: 'session.updated', properties: { sessionID: 'a', info: { title: 'Renamed', directory: '/elsewhere' } } });
    expect(search('event')[0]).toMatchObject({ sessionTitle: 'Renamed', directory: '/elsewhere' });
    indexer.processPayload({ type: 'session.deleted', properties: { sessionID: 'a' } });
    expect(search('event')).toEqual([]);
  });

  it('indexes a session when its turn ends', async () => {
    fake.session('a');
    await backfill();
    fake.user('a', 'u1', 'live message');
    fake.touch('a');
    indexer.processPayload({ type: 'session.idle', properties: { sessionID: 'a' } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await indexer.idle();
    expect(search('live')).toHaveLength(1);
  });

  it('filters by session, directory and author, and pages without repeats', async () => {
    fake.session('a');
    fake.session('b');
    for (let i = 0; i < 5; i += 1) fake.user('a', `a${i}`, `shared term ${i}`);
    fake.assistant('a', 'ra', [{ type: 'text', text: 'shared term reply' }]);
    fake.user('b', 'b1', 'shared term elsewhere');
    await backfill();

    expect(search('shared', { sessionId: 'b' }).map((hit) => hit.id)).toEqual(['b1']);
    expect(search('shared', { directories: ['/repo/b'] }).map((hit) => hit.id)).toEqual(['b1']);
    expect(search('shared', { sessionId: 'a', role: 'assistant' }).map((hit) => hit.id)).toEqual(['ra']);

    const first = search('shared', { sessionId: 'a', limit: 3 });
    const last = first[first.length - 1];
    const second = search('shared', { sessionId: 'a', limit: 3, before: { createdAt: last.createdAt, id: last.id } });
    const ids = [...first, ...second].map((hit) => hit.id);
    expect(new Set(ids).size).toBe(6);
    expect(search('shared', { sessionId: 'a', order: 'asc', limit: 1 })[0].id).toBe('a0');
  });

  // A read that never settles on its own but honours its signal, the way a
  // stalled OpenCode read behaves once a deadline or stop aborts it.
  const neverSettles = (options) => new Promise((_, reject) => {
    const signal = options?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

  it('aborts the in-flight read on stop so idle() settles promptly', async () => {
    const seen = [];
    const stalled = {
      session: {
        get: (_params, options) => {
          seen.push(options);
          return neverSettles(options);
        },
        list: fake.client.session.list,
        message: fake.client.session.message,
      },
      message: fake.client.message,
    };
    const local = createMessageSearchIndexer({ store, createClient: () => stalled, pageSize: 2, liveDebounceMs: 0, backfillPauseMs: 0, logger: { warn: () => {} } });
    local.processPayload({ type: 'session.idle', properties: { sessionID: 'a' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);

    local.stop();
    const settled = await Promise.race([local.idle().then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 500))]);
    expect(settled).toBe(true);
  });

  it('times out a stalled live read, logs it, and indexes the next session', async () => {
    fake.session('a');
    fake.session('b');
    fake.user('b', 'u1', 'later session words');
    const warnings = [];
    const client = {
      session: {
        get: (params, options) => (params.sessionID === 'a' ? neverSettles(options) : fake.client.session.get(params, options)),
        list: fake.client.session.list,
        message: fake.client.session.message,
      },
      message: fake.client.message,
    };
    const local = createMessageSearchIndexer({
      store,
      createClient: () => client,
      pageSize: 2,
      liveDebounceMs: 0,
      backfillPauseMs: 0,
      readTimeoutMs: 50,
      logger: { warn: (...args) => warnings.push(args) },
    });
    local.processPayload({ type: 'session.idle', properties: { sessionID: 'a' } });
    local.processPayload({ type: 'session.idle', properties: { sessionID: 'b' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const drained = await Promise.race([local.idle().then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 2_000))]);
    expect(drained).toBe(true);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(search('later session').map((hit) => hit.id)).toEqual(['u1']);
  });

  it('fails a stalled backfill page (logged) and starts a fresh walk on the next connect', async () => {
    fake.session('a');
    fake.user('a', 'u1', 'backfill words');
    let stallList = true;
    const warnings = [];
    const client = {
      session: {
        get: fake.client.session.get,
        list: (params, options) => (stallList ? neverSettles(options) : fake.client.session.list(params, options)),
        message: fake.client.session.message,
      },
      message: fake.client.message,
    };
    const local = createMessageSearchIndexer({
      store,
      createClient: () => client,
      pageSize: 2,
      liveDebounceMs: 0,
      backfillPauseMs: 0,
      readTimeoutMs: 50,
      logger: { warn: (...args) => warnings.push(args) },
    });
    local.onConnected();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(warnings.some((args) => String(args[0]).includes('could not list sessions'))).toBe(true);
    expect(search('backfill')).toEqual([]);

    stallList = false;
    local.onConnected();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await local.idle();
    expect(search('backfill').map((hit) => hit.id)).toEqual(['u1']);
  });

  it('does not start a fresh read after stop aborts the revert-boundary lookup', async () => {
    fake.session('a', { revert: { messageID: 'u2' } });
    fake.user('a', 'u1', 'keep this request');
    fake.user('a', 'u2', 'undo this request');
    let listCalls = 0;
    const client = {
      session: {
        get: fake.client.session.get,
        list: fake.client.session.list,
        message: {
          get: (_params, options) => neverSettles(options),
        },
      },
      message: {
        list: (params, options) => {
          listCalls += 1;
          return neverSettles(options);
        },
      },
    };
    const local = createMessageSearchIndexer({ store, createClient: () => client, pageSize: 2, liveDebounceMs: 0, backfillPauseMs: 0, logger: { warn: () => {} } });
    local.processPayload({ type: 'session.idle', properties: { sessionID: 'a' } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    local.stop();
    const settled = await Promise.race([local.idle().then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 500))]);
    expect(settled).toBe(true);
    expect(listCalls).toBe(0);
  });

  it('settles a sync whose message pages repeat the same cursor', async () => {
    fake.session('a');
    const warnings = [];
    let userCalls = 0;
    const client = {
      session: fake.client.session,
      message: {
        list: async ({ type }) => {
          if (type !== 'user') return { data: [], cursor: {} };
          userCalls += 1;
          return {
            data: [
              { id: 'u1', type: 'user', text: 'looping words one', time: { created: 1001 } },
              { id: 'u2', type: 'user', text: 'looping words two', time: { created: 1002 } },
            ],
            cursor: { next: 'loop-cursor' },
          };
        },
      },
    };
    const local = createMessageSearchIndexer({ store, createClient: () => client, pageSize: 2, liveDebounceMs: 0, backfillPauseMs: 0, logger: { warn: (...args) => warnings.push(args) } });
    await local.syncSession('a', '');
    expect(userCalls).toBe(2);
    expect(warnings.some((args) => String(args[0]).includes('repeated a cursor'))).toBe(true);
    expect(search('looping').map((hit) => hit.id)).toEqual(['u2', 'u1']);
    // A guard-stopped walk is not a completed sync.
    expect(store.readSession('a')?.synced_updated_at ?? null).toBeNull();
  });

  it('caps a sync whose message pages keep returning distinct cursors', async () => {
    fake.session('a');
    const warnings = [];
    let userCalls = 0;
    const client = {
      session: fake.client.session,
      message: {
        list: async ({ type }) => {
          if (type !== 'user') return { data: [], cursor: {} };
          userCalls += 1;
          const base = userCalls * 10;
          return {
            data: [
              { id: `u${base}`, type: 'user', text: 'capped words first', time: { created: 1000 + base } },
              { id: `u${base + 1}`, type: 'user', text: 'capped words second', time: { created: 1000 + base + 1 } },
            ],
            cursor: { next: `cursor-${userCalls}` },
          };
        },
      },
    };
    const local = createMessageSearchIndexer({ store, createClient: () => client, pageSize: 2, liveDebounceMs: 0, backfillPauseMs: 0, logger: { warn: (...args) => warnings.push(args) } });
    await local.syncSession('a', '');
    expect(userCalls).toBe(20);
    expect(warnings.some((args) => String(args[0]).includes('page cap'))).toBe(true);
    expect(search('capped')).toHaveLength(40);
    // A capped walk is not a completed sync either: the session stays
    // un-marked, and the next sync resumes from the stored cursor (another
    // capped chunk of pages) instead of skipping the unread remainder.
    expect(store.readSession('a')?.synced_updated_at ?? null).toBeNull();
    await local.syncSession('a', '');
    expect(userCalls).toBe(40);
    expect(store.readSession('a')?.synced_updated_at ?? null).toBeNull();
  });

  it('finishes a backfill whose session list repeats a cursor, without deleting sessions from the partial list', async () => {
    fake.session('stale');
    fake.user('stale', 'u1', 'stale words kept');
    await backfill();
    expect(search('stale')).toHaveLength(1);

    const warnings = [];
    let listCalls = 0;
    const listedSessions = Array.from({ length: 200 }, (_, i) => ({ id: `loop${i}`, title: `Loop ${i}`, location: { directory: `/repo/loop${i}` }, time: { created: 1000, updated: 1000 } }));
    const byId = new Map(listedSessions.map((session) => [session.id, session]));
    const client = {
      session: {
        get: async ({ sessionID }) => byId.get(sessionID) ?? fake.client.session.get({ sessionID }),
        list: async () => {
          listCalls += 1;
          return { data: listedSessions, cursor: { next: 'loop-cursor' } };
        },
        message: fake.client.session.message,
      },
      message: { list: async () => ({ data: [], cursor: {} }) },
    };
    const local = createMessageSearchIndexer({ store, createClient: () => client, pageSize: 2, liveDebounceMs: 0, backfillPauseMs: 0, logger: { warn: (...args) => warnings.push(args) } });
    local.onConnected();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await local.idle();
    expect(listCalls).toBe(2);
    expect(warnings.some((args) => String(args[0]).includes('repeated a cursor'))).toBe(true);
    // The sessions the partial walk did read were queued and synced...
    expect(local.status().backfill.state).toBe('done');
    expect(store.counts().sessions).toBe(201);
    // ...and the session the partial list never mentioned was not deleted.
    expect(search('stale').map((hit) => hit.id)).toEqual(['u1']);
  });

  it('resumes a capped session-list walk on the next connect instead of restarting it', async () => {
    fake.session('stale');
    fake.user('stale', 'u1', 'stale words kept');
    await backfill();
    expect(search('stale')).toHaveLength(1);

    const PAGE = 200;
    const all = Array.from({ length: 20 * PAGE + 10 }, (_, i) => ({ id: `bulk${i}`, title: `Bulk ${i}`, location: { directory: `/repo/bulk${i}` }, time: { created: 1000, updated: 1000 } }));
    const byId = new Map(all.map((session) => [session.id, session]));
    let bulk0Refreshed = false;
    let listCalls = 0;
    const client = {
      session: {
        get: async ({ sessionID }) => byId.get(sessionID) ?? fake.client.session.get({ sessionID }),
        list: async ({ cursor }) => {
          listCalls += 1;
          const start = cursor ? Number(cursor.split('-')[1]) : 0;
          const data = all.slice(start, start + PAGE);
          const end = start + data.length;
          return { data, cursor: end < all.length ? { next: `page-${end}` } : {} };
        },
        message: fake.client.session.message,
      },
      message: {
        list: async ({ sessionID }) => {
          if (sessionID === 'newlive') return { data: [{ id: 'nl1', type: 'user', text: 'live words indexed', time: { created: 3001 } }], cursor: {} };
          if (sessionID === 'bulk0' && bulk0Refreshed) return { data: [{ id: 'b0r', type: 'user', text: 'refreshed words found', time: { created: 5001 } }], cursor: {} };
          return { data: [], cursor: {} };
        },
      },
    };
    const local = createMessageSearchIndexer({ store, createClient: () => client, pageSize: 2, liveDebounceMs: 0, backfillPauseMs: 0, logger: { warn: () => {} } });
    const connect = async () => {
      local.onConnected();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await local.idle();
    };

    // First connect: the walk stops at the page cap with 4,000 sessions
    // read; the partial list queues them but deletes nothing.
    await connect();
    expect(listCalls).toBe(20);
    expect(store.counts().sessions).toBe(4001);
    expect(search('stale')).toHaveLength(1);

    // Between chunks, a brand-new session is created and indexed live. It
    // sorts before the saved descending cursor, so the resumed walk never
    // lists it — the completion cleanup must still not delete it.
    byId.set('newlive', { id: 'newlive', title: 'New live', location: { directory: '/repo/newlive' }, time: { created: 3000, updated: 3000 } });
    // While disconnected, a session from the saved head pages changed and
    // a new session was created at the head of the list. Neither is in the
    // saved tail's reach: the resumed walk must refresh the head, or the
    // changed session is skipped on its stale timestamp and the new one
    // is never listed.
    all.find((session) => session.id === 'bulk0').time = { created: 1000, updated: 5000 };
    const newhead = { id: 'newhead', title: 'New head', location: { directory: '/repo/newhead' }, time: { created: 4000, updated: 4000 } };
    all.unshift(newhead);
    byId.set('newhead', newhead);
    bulk0Refreshed = true;
    local.processPayload({ type: 'session.idle', properties: { sessionID: 'newlive' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await local.idle();
    expect(search('live words')).toHaveLength(1);
    expect(store.counts().sessions).toBe(4002);

    // Second connect: the walk first re-reads the 20 head pages fresh up
    // to the saved boundary cursor (picking up the changed bulk0 and the
    // new head session), then resumes past the cap for one tail page and
    // reaches the end of the list. The now-complete assembled list deletes
    // the stale session — but not the one indexed live while the walk was
    // pending.
    await connect();
    expect(listCalls).toBe(41);
    expect(store.counts().sessions).toBe(4012);
    expect(search('stale')).toEqual([]);
    expect(search('live words')).toHaveLength(1);
    expect(search('refreshed words')).toHaveLength(1);
    expect(local.status().backfill.state).toBe('done');
  });

  it('removes a head session deleted while disconnected when the resumed walk completes', async () => {
    // Indexed in an earlier, completed walk, so the capped walk below
    // lists it unchanged and never syncs (or protects) it.
    fake.session('victim');
    fake.user('victim', 'v1', 'victim words vanished');
    await backfill();
    expect(search('victim')).toHaveLength(1);

    const PAGE = 200;
    const victim = { id: 'victim', title: 'Victim', location: { directory: '/repo/victim' }, time: { created: 1000, updated: 1000 } };
    const bulk = Array.from({ length: 4010 }, (_, i) => ({ id: `bulk${i}`, title: `Bulk ${i}`, location: { directory: `/repo/bulk${i}` }, time: { created: 1000, updated: 1000 } }));
    const all = [victim, ...bulk];
    const byId = new Map(all.map((session) => [session.id, session]));
    const client = {
      session: {
        get: async ({ sessionID }) => byId.get(sessionID),
        list: async ({ cursor }) => {
          const start = cursor ? Number(cursor.split('-')[1]) : 0;
          const data = all.slice(start, start + PAGE);
          const end = start + data.length;
          return { data, cursor: end < all.length ? { next: `page-${end}` } : {} };
        },
        message: fake.client.session.message,
      },
      message: {
        list: async ({ sessionID }) => (sessionID === 'victim'
          ? { data: [{ id: 'v1', type: 'user', text: 'victim words vanished', time: { created: 1001 } }], cursor: {} }
          : { data: [], cursor: {} }),
      },
    };
    const local = createMessageSearchIndexer({ store, createClient: () => client, pageSize: 2, liveDebounceMs: 0, backfillPauseMs: 0, logger: { warn: () => {} } });
    const connect = async () => {
      local.onConnected();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await local.idle();
    };

    // First connect: the walk caps with the victim in its saved head.
    await connect();
    expect(store.counts().sessions).toBe(4000);
    expect(search('victim')).toHaveLength(1);

    // The victim is deleted while disconnected.
    all.splice(0, 1);
    byId.delete('victim');

    // Second connect: the head refresh covers the saved segment and no
    // longer lists the victim, so the refresh must REPLACE the segment —
    // merging would keep the victim listed, and the completion cleanup
    // would then keep its messages searchable.
    await connect();
    expect(local.status().backfill.state).toBe('done');
    expect(search('victim')).toEqual([]);
    expect(store.counts().sessions).toBe(4010);
  });

  it('removes a head session deleted while disconnected even when the capped walk itself indexed it', async () => {
    // Unlike the test above, the victim is NOT pre-indexed: the capped
    // walk lists it, queues it, and syncs it, which puts it in the walk's
    // protection set. The resumed refresh's removal is authoritative, so
    // protection must not keep the deleted session searchable.
    const PAGE = 200;
    const victim = { id: 'victim', title: 'Victim', location: { directory: '/repo/victim' }, time: { created: 1000, updated: 1000 } };
    const bulk = Array.from({ length: 4010 }, (_, i) => ({ id: `bulk${i}`, title: `Bulk ${i}`, location: { directory: `/repo/bulk${i}` }, time: { created: 1000, updated: 1000 } }));
    const all = [victim, ...bulk];
    const byId = new Map(all.map((session) => [session.id, session]));
    const client = {
      session: {
        get: async ({ sessionID }) => byId.get(sessionID),
        list: async ({ cursor }) => {
          const start = cursor ? Number(cursor.split('-')[1]) : 0;
          const data = all.slice(start, start + PAGE);
          const end = start + data.length;
          return { data, cursor: end < all.length ? { next: `page-${end}` } : {} };
        },
        message: fake.client.session.message,
      },
      message: {
        list: async ({ sessionID }) => (sessionID === 'victim'
          ? { data: [{ id: 'v1', type: 'user', text: 'victim words vanished', time: { created: 1001 } }], cursor: {} }
          : { data: [], cursor: {} }),
      },
    };
    const local = createMessageSearchIndexer({ store, createClient: () => client, pageSize: 2, liveDebounceMs: 0, backfillPauseMs: 0, logger: { warn: () => {} } });
    const connect = async () => {
      local.onConnected();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await local.idle();
    };

    // First connect: the walk caps with the victim in its saved head, and
    // indexing the victim during that walk protects it.
    await connect();
    expect(store.counts().sessions).toBe(4000);
    expect(search('victim')).toHaveLength(1);

    // The victim is deleted while disconnected.
    all.splice(0, 1);
    byId.delete('victim');

    // Second connect: the refresh replaces the saved segment without the
    // victim, and the completion cleanup must delete it despite the
    // protection it earned during the first walk.
    await connect();
    expect(local.status().backfill.state).toBe('done');
    expect(search('victim')).toEqual([]);
    expect(store.counts().sessions).toBe(4010);
  });

  it('serializes overlapping backfill runs from repeated connects', async () => {
    fake.session('a');
    fake.user('a', 'u1', 'serialized backfill words');
    let listCalls = 0;
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const client = {
      session: {
        get: fake.client.session.get,
        list: async (...args) => {
          listCalls += 1;
          if (listCalls === 1) await firstGate;
          return fake.client.session.list(...args);
        },
        message: fake.client.session.message,
      },
      message: fake.client.message,
    };
    const local = createMessageSearchIndexer({ store, createClient: () => client, pageSize: 2, liveDebounceMs: 0, backfillPauseMs: 0, logger: { warn: () => {} } });
    local.onConnected();
    local.onConnected();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The second connect must not start a second walk while the first is
    // still listing: overlapping walks share the continuation and
    // protection state, and one run resetting it mid-walk corrupts the
    // other's completion cleanup.
    expect(listCalls).toBe(1);
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await local.idle();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await local.idle();
    expect(search('serialized').map((hit) => hit.id)).toEqual(['u1']);
  });

  it('persists head-refresh progress across connects so a long saved head cannot stall the tail', async () => {
    const PAGE = 200;
    const all = Array.from({ length: 8010 }, (_, i) => ({ id: `bulk${i}`, title: `Bulk ${i}`, location: { directory: `/repo/bulk${i}` }, time: { created: 1000, updated: 1000 } }));
    const byId = new Map(all.map((session) => [session.id, session]));
    let listCalls = 0;
    const client = {
      session: {
        get: async ({ sessionID }) => byId.get(sessionID),
        list: async ({ cursor }) => {
          listCalls += 1;
          const start = cursor ? Number(cursor.split('-')[1]) : 0;
          const data = all.slice(start, start + PAGE);
          const end = start + data.length;
          return { data, cursor: end < all.length ? { next: `page-${end}` } : {} };
        },
        message: fake.client.session.message,
      },
      message: { list: async () => ({ data: [], cursor: {} }) },
    };
    const local = createMessageSearchIndexer({ store, createClient: () => client, pageSize: 2, liveDebounceMs: 0, backfillPauseMs: 0, logger: { warn: () => {} } });
    const connect = async () => {
      local.onConnected();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await local.idle();
    };

    // Two connects advance the saved walk to 8,000 sessions: a fresh cap,
    // then a completed head refresh plus a tail cap.
    await connect();
    expect(listCalls).toBe(20);
    await connect();
    expect(listCalls).toBe(60);
    expect(store.counts().sessions).toBe(8000);

    // Third connect: refreshing the 8,000-session head needs 40 pages but
    // the refresh cap is 20. The refresh must keep its progress — if it
    // restarted from page one on every connect, the tail would never run.
    await connect();
    expect(listCalls).toBe(80);
    expect(local.status().backfill.state).toBe('running');

    // Fourth connect: the refresh resumes at page 4,000, reaches the
    // saved boundary, and the tail finally reads its last page.
    await connect();
    expect(listCalls).toBe(101);
    expect(store.counts().sessions).toBe(8010);
    expect(local.status().backfill.state).toBe('done');
  });

  it('does not mark a session synced when the revert-boundary lookup times out', async () => {
    fake.session('a', { revert: { messageID: 'u2' } });
    fake.user('a', 'u1', 'keep this request');
    fake.user('a', 'u2', 'undo this request');
    let stallBoundary = true;
    const client = {
      session: {
        get: fake.client.session.get,
        list: fake.client.session.list,
        message: {
          get: (params, options) => (stallBoundary ? neverSettles(options) : fake.client.session.message.get(params, options)),
        },
      },
      message: fake.client.message,
    };
    const local = createMessageSearchIndexer({
      store,
      createClient: () => client,
      pageSize: 2,
      liveDebounceMs: 0,
      backfillPauseMs: 0,
      readTimeoutMs: 50,
      logger: { warn: () => {} },
    });
    await expect(local.syncSession('a', '')).rejects.toBeTruthy();
    expect(store.readSession('a')?.synced_updated_at ?? null).toBeNull();

    stallBoundary = false;
    await local.syncSession('a', '');
    expect(search('keep').map((hit) => hit.id)).toEqual(['u1']);
    expect(search('undo')).toEqual([]);
  });
});

describe('snippets', () => {
  const mark = (value) => value.replaceAll(MATCH_START, '[').replaceAll(MATCH_END, ']');

  it('marks every whole occurrence, in any case', () => {
    expect(mark(buildSnippet('Portless opens portless names', ['portless']))).toBe('[Portless] opens [portless] names');
  });

  it('centres a long message on its first match and marks the edges', () => {
    const text = `${'lead '.repeat(60)}the needle sits here ${'tail '.repeat(60)}`;
    const snippet = mark(buildSnippet(text, ['needle'], 30));
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('[needle]');
    expect(snippet.length).toBeLessThan(90);
  });

  it('merges overlapping terms and flattens line breaks', () => {
    expect(mark(buildSnippet('git\nrebase onto github', ['git', 'rebase']))).toBe('[git] [rebase] onto [git]hub');
  });

  // A lone surrogate: a high half not followed by its low half, or a
  // low half not preceded by its high half (#1866).
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const EMOJI = String.fromCodePoint(0x1f600);

  it('never splits a surrogate pair at the window end (#1866)', () => {
    const snippet = buildSnippet('needle' + EMOJI.repeat(40), ['needle'], 31);
    expect(LONE_SURROGATE.test(snippet)).toBe(false);
    expect(mark(snippet)).toContain('[needle]');
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('never splits a surrogate pair at the window start (#1866)', () => {
    const snippet = buildSnippet(EMOJI.repeat(50) + 'needle', ['needle'], 89);
    expect(LONE_SURROGATE.test(snippet)).toBe(false);
    expect(mark(snippet)).toContain('[needle]');
    expect(snippet.startsWith('…')).toBe(true);
  });

  it('never splits a surrogate pair in the no-match fallback cut (#1866)', () => {
    const snippet = buildSnippet('x' + EMOJI.repeat(100), ['absent'], 90);
    expect(LONE_SURROGATE.test(snippet)).toBe(false);
    expect(snippet.length).toBe(181);
  });

  it('never splits a surrogate pair in the lowercasing-length fallback cut (#1866)', () => {
    const snippet = buildSnippet('İ' + EMOJI.repeat(100), ['absent'], 90);
    expect(LONE_SURROGATE.test(snippet)).toBe(false);
    expect(snippet.length).toBe(181);
  });

  it('centres on the longest word of the query', () => {
    const text = `see github first ${'filler '.repeat(40)} then git rebase later`;
    expect(mark(buildSnippet(text, ['git', 'rebase'], 20))).toContain('[rebase]');
  });
});

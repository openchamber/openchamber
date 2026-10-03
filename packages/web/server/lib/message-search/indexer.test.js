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
          if (index < 0) throw tagged('InvalidCursorError');
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

  it('starts the session over when OpenCode rejects the cursor', async () => {
    fake.session('a');
    fake.user('a', 'u1', 'kept message');
    fake.user('a', 'u2', 'dropped message');
    await backfill();
    fake.dropMessage('a', 'u2');
    await indexer.syncSession('a', '');
    expect(search('message').map((hit) => hit.id)).toEqual(['u1']);
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

  it('centres on the longest word of the query', () => {
    const text = `see github first ${'filler '.repeat(40)} then git rebase later`;
    expect(mark(buildSnippet(text, ['git', 'rebase'], 20))).toContain('[rebase]');
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDispatchResultMessage,
  createDispatchResultsRuntime,
  readDispatchOutcome,
} from './runtime.js';

const temporaryDirectories = [];
const runtimes = [];

afterEach(async () => {
  // Stop first and drain writes, so no timer or write outlives its directory.
  const stopping = runtimes.splice(0);
  for (const runtime of stopping) runtime.stop();
  await Promise.all(stopping.map((runtime) => runtime.flush()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
  vi.useRealTimers();
});

const makeDataDir = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-dispatch-results-'));
  temporaryDirectories.push(directory);
  return directory;
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const assistant = (text, created, extra = {}) => ({
  type: 'assistant',
  id: `msg_a${created}`,
  content: [{ type: 'text', text }],
  time: { created, completed: created + 1 },
  ...extra,
});
const idle = (outcome, created) => ({ type: 'idle', id: `msg_i${created}`, outcome, time: { created } });
const user = (created) => ({ type: 'user', id: `msg_u${created}`, text: 'go', time: { created } });

/**
 * A stand-in for the OpenCode routes the runtime reads and writes. Records
 * are kept oldest first and served newest first, as `order: desc` does.
 */
const createOpenCode = () => {
  const state = {
    active: {},
    sessions: { ses_child: { id: 'ses_child', title: 'Fix the toolbar' } },
    records: { ses_child: [] },
    synthetic: [],
    syntheticStatus: [],
    seenIds: new Set(),
  };
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const { pathname } = new URL(url);
    if (pathname === '/api/session/active') return json({ data: state.active });
    const synthetic = pathname.match(/^\/api\/session\/([^/]+)\/synthetic$/);
    if (synthetic && init.method === 'POST') {
      const status = state.syntheticStatus.shift();
      if (status) return json({ error: 'nope' }, status);
      const body = JSON.parse(init.body);
      if (state.seenIds.has(body.id)) return json({ error: 'conflict' }, 409);
      state.seenIds.add(body.id);
      state.synthetic.push({ sessionID: decodeURIComponent(synthetic[1]), ...body });
      return json({ data: { id: body.id } });
    }
    const messages = pathname.match(/^\/api\/session\/([^/]+)\/message$/);
    if (messages) {
      const id = decodeURIComponent(messages[1]);
      if (!state.sessions[id]) return json({ error: 'not found' }, 404);
      return json({ data: [...(state.records[id] ?? [])].reverse(), cursor: {} });
    }
    const session = pathname.match(/^\/api\/session\/([^/]+)$/);
    if (session) {
      const id = decodeURIComponent(session[1]);
      return state.sessions[id] ? json(state.sessions[id]) : json({ error: 'not found' }, 404);
    }
    return json({ error: `unexpected ${pathname}` }, 500);
  });
  return { state, fetchImpl };
};

const createRuntime = async ({ dataDir, openCode = createOpenCode(), ...overrides } = {}) => {
  const directory = dataDir ?? await makeDataDir();
  const listeners = { event: [], status: [] };
  const globalEventHub = {
    subscribeEvent: (listener) => { listeners.event.push(listener); return () => {}; },
    subscribeStatus: (listener) => { listeners.status.push(listener); return () => {}; },
  };
  const runtime = createDispatchResultsRuntime({
    globalEventHub,
    buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    dataDir: directory,
    fetchImpl: openCode.fetchImpl,
    quietMs: 0,
    retryDelayMs: () => 10,
    settleRecheckMs: 10,
    ...overrides,
  });
  runtimes.push(runtime);
  const emit = (payload) => runtime.processPayload(payload);

  // Runs the timers the runtime armed at its 0 ms quiet delay, then waits out
  // the requests and writes they started, until a pass starts nothing new.
  const drain = async () => {
    let calls;
    do {
      calls = openCode.fetchImpl.mock.calls.length;
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
      else await new Promise((resolve) => setTimeout(resolve, 0));
      await runtime.flush();
    } while (openCode.fetchImpl.mock.calls.length !== calls);
  };

  // Completion barrier for the exactly-once cases: once nothing is pending,
  // replay the triggers that start a delivery (an idle status and, when
  // started, a reconnect) and wait for that processing. A duplicate then
  // shows in the exact assertions that follow instead of arriving after them.
  const replayAfterDelivery = async (sessionId = 'ses_child') => {
    await vi.waitFor(() => expect(runtime.pending()).toEqual([]));
    await drain();
    emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
    for (const listener of listeners.status) listener({ type: 'connect' });
    await drain();
  };

  return { runtime, openCode, dataDir: directory, emit, listeners, replayAfterDelivery };
};

/** Every result POST, landed or refused: the fake answers a repeated id with 409, so `synthetic` alone hides a duplicate. */
const syntheticPosts = (openCode) => openCode.fetchImpl.mock.calls
  .filter(([url, init]) => url.endsWith('/synthetic') && init?.method === 'POST')
  .map(([, init]) => JSON.parse(init.body));

const settle = async () => {
  for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe('readDispatchOutcome', () => {
  it('reads the answer of the turn that ended after the dispatch', () => {
    // Newest first, as the message route serves them.
    const records = [idle('succeeded', 30), assistant('Done: toolbar fixed', 20), user(15), idle('succeeded', 5), assistant('older', 4)];
    expect(readDispatchOutcome(records, 10)).toEqual({ state: 'completed', text: 'Done: toolbar fixed', errorMessage: '' });
  });

  it('is not done while the newest run ended before the dispatch', () => {
    expect(readDispatchOutcome([idle('succeeded', 5), assistant('older', 4)], 10)).toBeNull();
    expect(readDispatchOutcome([user(12)], 10)).toBeNull();
  });

  it('matches the turn by record order when the baseline is known, whatever the clocks say', () => {
    // OpenCode's clock lags OpenChamber's: every record looks older than the
    // dispatch at 1000, yet a newer idle record than the baseline ended the turn.
    const records = [idle('succeeded', 30), assistant('Done on the remote', 20), user(15), idle('succeeded', 5), assistant('older', 4)];
    expect(readDispatchOutcome(records, 1000, 'msg_i5')).toEqual({ state: 'completed', text: 'Done on the remote', errorMessage: '' });
    // The baseline is still the newest idle record: the turn has not ended.
    expect(readDispatchOutcome([idle('succeeded', 5), assistant('older', 4)], 1000, 'msg_i5')).toBeNull();
    // A session with no run before the dispatch: its first idle record ends the turn.
    expect(readDispatchOutcome([idle('succeeded', 30), assistant('first', 20), user(15)], 1000, null))
      .toEqual({ state: 'completed', text: 'first', errorMessage: '' });
    // A reply from before the baseline is never this turn's answer.
    expect(readDispatchOutcome([idle('succeeded', 30), user(15), idle('succeeded', 5), assistant('older', 4)], 1000, 'msg_i5'))
      .toEqual({ state: 'completed', text: '', errorMessage: '' });
  });

  it('reports a failed and a stopped turn as their states', () => {
    expect(readDispatchOutcome([idle('failed', 30), assistant('', 20, { error: { type: 'APIError', message: 'rate limited' } })], 10))
      .toEqual({ state: 'error', text: '', errorMessage: 'rate limited' });
    expect(readDispatchOutcome([idle('interrupted', 30), assistant('half', 20)], 10)?.state).toBe('cancelled');
  });

  it('never hands back a reply from before the dispatch', () => {
    expect(readDispatchOutcome([idle('succeeded', 30), assistant('older', 4)], 10)).toEqual({ state: 'completed', text: '', errorMessage: '' });
  });
});

describe('buildDispatchResultMessage', () => {
  it('wraps the answer in an envelope the UI and the agent can read', () => {
    const message = buildDispatchResultMessage({
      sessionId: 'ses_child',
      title: 'Say "hi" <now>',
      outcome: { state: 'completed', text: 'Hello', errorMessage: '' },
    });
    expect(message.text).toBe('<openchamber-session sessionID="ses_child" state="completed" title="Say &quot;hi&quot; &lt;now&gt;">\nHello\n</openchamber-session>');
    expect(message.metadata).toEqual({ source: 'openchamber-session', sessionID: 'ses_child', state: 'completed', title: 'Say "hi" <now>' });
    expect(message.description).toBe('Say "hi" <now>');
  });

  it('states a failure and a stop instead of an empty answer', () => {
    expect(buildDispatchResultMessage({ sessionId: 'ses_c', title: '', outcome: { state: 'error', text: '', errorMessage: 'boom' } }).text)
      .toContain('The session failed: boom');
    expect(buildDispatchResultMessage({ sessionId: 'ses_c', title: '', outcome: { state: 'cancelled', text: 'partial', errorMessage: '' } }).text)
      .toContain('The session was stopped before it finished.\n\nIts last reply:\npartial');
    expect(buildDispatchResultMessage({ sessionId: 'ses_c', title: '', outcome: { state: 'completed', text: '', errorMessage: '' } }).text)
      .toContain('without a text reply');
  });
});

describe('dispatch results runtime', () => {
  it('delivers the answer to the parent and wakes it once the turn ends', async () => {
    const { runtime, openCode, emit, dataDir, replayAfterDelivery } = await createRuntime();
    openCode.state.active.ses_child = { type: 'running' };
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await settle();
    // Running: nothing is delivered and nothing polls it.
    expect(openCode.state.synthetic).toEqual([]);

    delete openCode.state.active.ses_child;
    openCode.state.records.ses_child.push(user(11), assistant('Toolbar fixed', 20), idle('succeeded', 30));
    emit({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'idle' } } });
    await vi.waitFor(() => {
      expect(openCode.state.synthetic).toEqual([expect.objectContaining({
        sessionID: 'ses_parent',
        id: expect.stringMatching(/^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/),
        text: expect.stringContaining('Toolbar fixed'),
        description: 'Fix the toolbar',
        metadata: { source: 'openchamber-session', sessionID: 'ses_child', state: 'completed', title: 'Fix the toolbar' },
        delivery: 'steer',
        resume: true,
      })]);
      expect(runtime.pending()).toEqual([]);
    });
    await replayAfterDelivery();
    expect(syntheticPosts(openCode)).toHaveLength(1);
    expect(openCode.state.synthetic).toHaveLength(1);
    await runtime.flush();
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'dispatch-results.json'), 'utf8'));
    expect(stored.entries).toEqual([]);
  });

  it('delivers a turn that ended before the entry existed', async () => {
    const { runtime, openCode, replayAfterDelivery } = await createRuntime();
    openCode.state.records.ses_child.push(user(11), assistant('Quick answer', 12), idle('succeeded', 13));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await vi.waitFor(() => expect(openCode.state.synthetic).toHaveLength(1));
    await replayAfterDelivery();
    expect(syntheticPosts(openCode)).toEqual([expect.objectContaining({ text: expect.stringContaining('Quick answer') })]);
  });

  it('delivers the answer of an idle session while its subagents, workflow agents and ownWork sessions still run', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.sessions.ses_sub = { id: 'ses_sub', parentID: 'ses_child' };
    openCode.state.sessions.ses_agent = { id: 'ses_agent', metadata: { openchamber: { kind: 'workflow-agent', parentID: 'ses_child' } } };
    openCode.state.sessions.ses_worker = { id: 'ses_worker', metadata: { openchamber: { kind: 'operator-child', parentID: 'ses_child' } } };
    openCode.state.active.ses_sub = { type: 'running' };
    openCode.state.active.ses_agent = { type: 'running' };
    openCode.state.active.ses_worker = { type: 'running' };
    openCode.state.records.ses_child.push(user(11), assistant('Answer while the run goes on', 12), idle('succeeded', 13));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await vi.waitFor(() => expect(openCode.state.synthetic).toEqual([expect.objectContaining({ text: expect.stringContaining('Answer while the run goes on') })]));
  });

  it('keeps sending every later answer of a session the parent runs with ownWork, whatever started its turn', async () => {
    const { runtime, openCode, emit } = await createRuntime();
    openCode.state.sessions.ses_child.metadata = { openchamber: { kind: 'operator-child', parentID: 'ses_parent' } };
    const idleEvent = () => emit({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'idle' } } });
    openCode.state.records.ses_child.push(user(11), assistant('Started two reviews, waiting on them', 12), idle('succeeded', 13));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10, afterIdleId: null });
    await vi.waitFor(() => expect(openCode.state.synthetic).toHaveLength(1));
    expect(runtime.pending()).toEqual([expect.objectContaining({ follow: true, afterIdleId: 'msg_i13' })]);

    // A subagent report woke it; nobody sent it a prompt.
    openCode.state.records.ses_child.push(assistant('Both reviews are in: ship it', 20), idle('succeeded', 21));
    idleEvent();
    await vi.waitFor(() => expect(openCode.state.synthetic.map((message) => message.text)).toEqual([
      expect.stringContaining('waiting on them'),
      expect.stringContaining('ship it'),
    ]));
    expect(new Set(openCode.state.synthetic.map((message) => message.id)).size).toBe(2);

    // A new send into it reuses the same follower instead of adding a second one.
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 30, afterIdleId: 'msg_i21' });
    expect(runtime.pending()).toHaveLength(1);
  });

  it('stops following a session the user took over or the parent archived, without sending its next answer', async () => {
    const { runtime, openCode, emit } = await createRuntime();
    openCode.state.sessions.ses_child.metadata = { openchamber: { kind: 'operator-child', parentID: 'ses_parent' } };
    openCode.state.records.ses_child.push(user(11), assistant('First answer', 12), idle('succeeded', 13));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10, afterIdleId: null });
    await vi.waitFor(() => expect(openCode.state.synthetic).toHaveLength(1));

    delete openCode.state.sessions.ses_child.metadata;
    openCode.state.records.ses_child.push(user(20), assistant('Talking to the user now', 21), idle('succeeded', 22));
    emit({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'idle' } } });
    await vi.waitFor(() => expect(runtime.pending()).toEqual([]));
    await settle();
    expect(openCode.state.synthetic).toHaveLength(1);
  });

  it('sends both answers when two turns of a followed session end before it is read', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.sessions.ses_child.metadata = { openchamber: { kind: 'operator-child', parentID: 'ses_parent' } };
    openCode.state.records.ses_child.push(idle('succeeded', 5), assistant('Report from review one', 12), idle('succeeded', 13), assistant('Report from review two', 20), idle('succeeded', 21));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10, afterIdleId: 'msg_i5' });
    await vi.waitFor(() => expect(openCode.state.synthetic).toHaveLength(1));
    expect(openCode.state.synthetic[0].text).toContain('Report from review one');
    expect(openCode.state.synthetic[0].text).toContain('Report from review two');
    expect(runtime.pending()).toEqual([expect.objectContaining({ follow: true, afterIdleId: 'msg_i21' })]);
  });

  it('keeps a failed turn in the report when a later one succeeded before the read', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.sessions.ses_child.metadata = { openchamber: { kind: 'operator-child', parentID: 'ses_parent' } };
    openCode.state.records.ses_child.push(idle('succeeded', 5), assistant('', 12, { error: { message: 'timed out' } }), idle('failed', 13), assistant('Recovered', 20), idle('succeeded', 21));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10, afterIdleId: 'msg_i5' });
    await vi.waitFor(() => expect(openCode.state.synthetic).toHaveLength(1));
    expect(openCode.state.synthetic[0].text).toContain('The session failed: timed out');
    expect(openCode.state.synthetic[0].text).toContain('Recovered');
  });

  it('at the limit refuses a new one-answer entry instead of dropping a session that reports back', async () => {
    const dataDir = await makeDataDir();
    const followers = Array.from({ length: 200 }, (_, index) => ({ id: `dispatch-${index}`, parentSessionId: 'ses_parent', sessionId: `ses_worker${index}`, dispatchedAt: index, afterIdleId: null, follow: true }));
    await fs.writeFile(path.join(dataDir, 'dispatch-results.json'), JSON.stringify({ version: 1, entries: followers }));
    const { runtime } = await createRuntime({ dataDir });
    await expect(runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 500 })).rejects.toThrow('too many');
    expect(runtime.pending()).toHaveLength(200);
  });

  it('keeps following after settling an entry stored before targets existed', async () => {
    const dataDir = await makeDataDir();
    await fs.writeFile(path.join(dataDir, 'dispatch-results.json'), JSON.stringify({ version: 1, entries: [{
      id: 'dispatch-1', parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10, afterIdleId: 'msg_i5', messageId: 'msg_000000000001AAAAAAAAAAAAAA',
    }] }));
    const openCode = createOpenCode();
    openCode.state.sessions.ses_child.metadata = { openchamber: { kind: 'operator-child', parentID: 'ses_parent' } };
    openCode.state.records.ses_child.push(idle('succeeded', 5), assistant('Answer', 12), idle('succeeded', 13));
    const { runtime } = await createRuntime({ dataDir, openCode });
    runtime.start();
    await vi.waitFor(() => expect(openCode.state.synthetic).toHaveLength(1));
    await vi.waitFor(() => expect(runtime.pending()).toEqual([expect.objectContaining({ follow: true, afterIdleId: 'msg_i13' })]));
  });

  it('after a restart resends only the turn it had minted an id for, then the newer turn under its own id', async () => {
    const dataDir = await makeDataDir();
    // The parent got turn A, then the server stopped before it saved the cursor; turn B ended meanwhile.
    await fs.writeFile(path.join(dataDir, 'dispatch-results.json'), JSON.stringify({ version: 1, entries: [{
      id: 'dispatch-1', parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10, afterIdleId: 'msg_i5',
      follow: true, messageId: 'msg_000000000001AAAAAAAAAAAAAA', targetIdleId: 'msg_i13',
    }] }));
    const openCode = createOpenCode();
    openCode.state.seenIds.add('msg_000000000001AAAAAAAAAAAAAA');
    openCode.state.sessions.ses_child.metadata = { openchamber: { kind: 'operator-child', parentID: 'ses_parent' } };
    openCode.state.records.ses_child.push(idle('succeeded', 5), assistant('Turn A', 12), idle('succeeded', 13), assistant('Turn B', 20), idle('succeeded', 21));
    const { runtime } = await createRuntime({ dataDir, openCode });
    runtime.start();
    await vi.waitFor(() => expect(openCode.state.synthetic).toEqual([expect.objectContaining({ text: expect.stringContaining('Turn B') })]));
    expect(syntheticPosts(openCode).map((post) => post.text.includes('Turn B') ? 'B' : 'A')).toEqual(['A', 'B']);
    expect(openCode.state.synthetic[0].text).not.toContain('Turn A');
  });

  it('never sends a followed session\'s answer to a parent that lost it before its first turn ended', async () => {
    const { runtime, openCode, emit } = await createRuntime();
    openCode.state.sessions.ses_child.metadata = { openchamber: { kind: 'operator-child', parentID: 'ses_parent' } };
    openCode.state.active.ses_child = { type: 'running' };
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10, afterIdleId: null });
    await vi.waitFor(() => expect(runtime.pending()).toEqual([expect.objectContaining({ follow: true })]));
    delete openCode.state.sessions.ses_child.metadata;
    delete openCode.state.active.ses_child;
    openCode.state.records.ses_child.push(user(11), assistant('For the user now', 12), idle('succeeded', 13));
    emit({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'idle' } } });
    await vi.waitFor(() => expect(runtime.pending()).toEqual([]));
    await settle();
    expect(openCode.state.synthetic).toEqual([]);
  });

  it('keeps following when the session record does not parse, and sends one answer for two entries of one pair', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.sessions.ses_child = { id: 'ses_child', title: 42 };
    openCode.state.records.ses_child.push(idle('succeeded', 5), assistant('One answer', 12), idle('succeeded', 13));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10, afterIdleId: 'msg_i5' });
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 11, afterIdleId: 'msg_i5' });
    await settle();
    expect(openCode.state.synthetic).toEqual([]);
    expect(runtime.pending()).toHaveLength(2);
    openCode.state.sessions.ses_child = { id: 'ses_child', title: 'Fix', metadata: { openchamber: { kind: 'operator-child', parentID: 'ses_parent' } } };
    await vi.waitFor(() => expect(openCode.state.synthetic).toHaveLength(1));
    await settle();
    expect(syntheticPosts(openCode)).toHaveLength(1);
    expect(runtime.pending()).toEqual([expect.objectContaining({ follow: true, afterIdleId: 'msg_i13' })]);
  });

  it('records the answer in an archived parent without waking it', async () => {
    // Async like the real archive store.
    const { runtime, openCode } = await createRuntime({ isSessionArchived: async (id) => id === 'ses_parent' });
    openCode.state.records.ses_child.push(user(11), assistant('Done', 12), idle('succeeded', 13));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await vi.waitFor(() => expect(openCode.state.synthetic).toEqual([expect.objectContaining({ resume: false })]));
  });

  it('wakes a parent the async archive store reports as not archived', async () => {
    // Seen live: the store's Promise was read as "archived", and no parent woke.
    const { runtime, openCode } = await createRuntime({ isSessionArchived: async () => false });
    openCode.state.records.ses_child.push(user(11), assistant('Done', 12), idle('succeeded', 13));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await vi.waitFor(() => expect(openCode.state.synthetic).toEqual([expect.objectContaining({ resume: true })]));
  });

  it('wakes the parent when the archive lookup fails', async () => {
    const { runtime, openCode } = await createRuntime({ isSessionArchived: async () => { throw new Error('store down'); } });
    openCode.state.records.ses_child.push(user(11), assistant('Done', 12), idle('succeeded', 13));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await vi.waitFor(() => expect(openCode.state.synthetic).toEqual([expect.objectContaining({ resume: true })]));
  });

  it('retries a failed delivery with the same message id, so it lands once', async () => {
    const { runtime, openCode, replayAfterDelivery } = await createRuntime();
    openCode.state.records.ses_child.push(user(11), assistant('Done', 12), idle('succeeded', 13));
    openCode.state.syntheticStatus.push(500);
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await vi.waitFor(() => expect(openCode.state.synthetic).toHaveLength(1));
    await replayAfterDelivery();

    const posts = syntheticPosts(openCode).map(({ id }) => id);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toBe(posts[1]);
    expect(openCode.state.synthetic).toHaveLength(1);
    expect(runtime.pending()).toEqual([]);
  });

  it('forgets results owed to a parent that was deleted', async () => {
    const { runtime, openCode, emit, dataDir } = await createRuntime();
    openCode.state.active.ses_child = { type: 'running' };
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    emit({ type: 'session.deleted', properties: { sessionID: 'ses_parent', info: { id: 'ses_parent' } } });
    expect(runtime.pending()).toEqual([]);
    await runtime.flush();
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'dispatch-results.json'), 'utf8'));
    expect(stored.entries).toEqual([]);
  });

  it('reports a dispatched session deleted before it finished as stopped', async () => {
    const { runtime, openCode, emit } = await createRuntime();
    openCode.state.active.ses_child = { type: 'running' };
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    delete openCode.state.active.ses_child;
    delete openCode.state.sessions.ses_child;
    emit({ type: 'session.deleted', properties: { sessionID: 'ses_child', info: { id: 'ses_child' } } });
    await vi.waitFor(() => expect(openCode.state.synthetic).toEqual([expect.objectContaining({
      metadata: { source: 'openchamber-session', sessionID: 'ses_child', state: 'cancelled' },
      text: expect.stringContaining('stopped before it finished'),
    })]));
  });

  it('retries when OpenCode cannot be asked, never guessing the turn is over', async () => {
    const openCode = createOpenCode();
    const original = openCode.fetchImpl.getMockImplementation();
    let failing = true;
    openCode.fetchImpl.mockImplementation(async (url, init) => {
      if (failing && url.includes('/api/session/active')) return json({ error: 'down' }, 503);
      return original(url, init);
    });
    const { runtime, replayAfterDelivery } = await createRuntime({ openCode });
    openCode.state.records.ses_child.push(user(11), assistant('Done', 12), idle('succeeded', 13));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await settle();
    expect(openCode.state.synthetic).toEqual([]);

    failing = false;
    await vi.waitFor(() => expect(openCode.state.synthetic).toHaveLength(1));
    await replayAfterDelivery();
    expect(syntheticPosts(openCode)).toHaveLength(1);
  });

  it('reports one result to a parent that sent several prompts into one run', async () => {
    const { runtime, openCode, emit, replayAfterDelivery } = await createRuntime();
    openCode.state.active.ses_child = { type: 'running' };
    openCode.state.records.ses_child.push(user(1), assistant('Earlier run', 2), idle('succeeded', 3));
    // Seen live: eight sends steered into the running turn, eight identical results.
    for (let index = 0; index < 8; index += 1) {
      await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 + index, afterIdleId: 'msg_i3' });
    }
    await runtime.register({ parentSessionId: 'ses_other', sessionId: 'ses_child', dispatchedAt: 20, afterIdleId: 'msg_i3' });
    // The first delivery fails, so the retry must reuse the one shared id.
    openCode.state.syntheticStatus.push(500);

    delete openCode.state.active.ses_child;
    openCode.state.records.ses_child.push(user(11), assistant('Toolbar fixed', 20), idle('succeeded', 30));
    emit({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'idle' } } });
    emit({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'idle' } } });
    await vi.waitFor(() => {
      expect(openCode.state.synthetic.map(({ sessionID }) => sessionID).sort()).toEqual(['ses_other', 'ses_parent']);
      expect(openCode.state.synthetic.every(({ text }) => text.includes('Toolbar fixed'))).toBe(true);
      expect(runtime.pending()).toEqual([]);
    });
    await replayAfterDelivery();
    expect(openCode.state.synthetic.map(({ sessionID }) => sessionID).sort()).toEqual(['ses_other', 'ses_parent']);
    // The failed first attempt is retried under the same id; nothing else is posted.
    const posts = syntheticPosts(openCode);
    expect(posts).toHaveLength(3);
    expect(new Set(posts.map(({ id }) => id)).size).toBe(2);
    expect(runtime.pending()).toEqual([]);
  });

  it('keeps the answer when one of the shared entries has no baseline', async () => {
    const { runtime, openCode, emit, replayAfterDelivery } = await createRuntime();
    openCode.state.active.ses_child = { type: 'running' };
    openCode.state.records.ses_child.push(user(1), assistant('Earlier run', 2), idle('succeeded', 3));
    // Its baseline read failed: it compares clocks and misses the reply that began before it.
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 25 });
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 26, afterIdleId: 'msg_i3' });

    delete openCode.state.active.ses_child;
    openCode.state.records.ses_child.push(user(11), assistant('Toolbar fixed', 20), idle('succeeded', 30));
    emit({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'idle' } } });
    await vi.waitFor(() => {
      expect(openCode.state.synthetic).toEqual([expect.objectContaining({ text: expect.stringContaining('Toolbar fixed') })]);
      expect(runtime.pending()).toEqual([]);
    });
    await replayAfterDelivery();
    expect(syntheticPosts(openCode)).toEqual([expect.objectContaining({ text: expect.stringContaining('Toolbar fixed') })]);
  });

  it('still reports a newer run next to an entry whose earlier attempt landed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dataDir = await makeDataDir();
    const landed = 'msg_000000000001aaaaaaaaaaaaaa';
    await fs.writeFile(path.join(dataDir, 'dispatch-results.json'), JSON.stringify({
      version: 1,
      entries: [
        { id: 'dispatch-a', parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10, afterIdleId: null, messageId: landed },
        { id: 'dispatch-b', parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 20, afterIdleId: 'msg_i13' },
      ],
    }));
    const openCode = createOpenCode();
    // The first run's result landed, but its response was lost before the entry was dropped.
    openCode.state.seenIds.add(landed);
    openCode.state.records.ses_child.push(user(11), assistant('First', 12), idle('succeeded', 13), user(21), assistant('Second', 22), idle('succeeded', 23));
    const { runtime, replayAfterDelivery } = await createRuntime({ dataDir, openCode });
    runtime.start();
    await vi.waitFor(() => {
      expect(openCode.state.synthetic).toEqual([expect.objectContaining({ text: expect.stringContaining('Second') })]);
      expect(runtime.pending()).toEqual([]);
    });
    await replayAfterDelivery();
    // The landed id is retried once and answered as already admitted; the newer run posts once.
    expect(syntheticPosts(openCode).map(({ id }) => id).filter((id) => id !== landed)).toHaveLength(1);
    expect(openCode.state.synthetic).toHaveLength(1);
  });

  it('delivers after a restart from what was persisted', async () => {
    const dataDir = await makeDataDir();
    const first = await createRuntime({ dataDir });
    first.openCode.state.active.ses_child = { type: 'running' };
    await first.runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    first.runtime.stop();

    const openCode = createOpenCode();
    openCode.state.records.ses_child.push(user(11), assistant('After restart', 12), idle('succeeded', 13));
    const second = await createRuntime({ dataDir, openCode });
    second.runtime.start();
    await vi.waitFor(() => expect(openCode.state.synthetic).toEqual([expect.objectContaining({ sessionID: 'ses_parent', text: expect.stringContaining('After restart') })]));
    await second.replayAfterDelivery();
    expect(syntheticPosts(openCode)).toEqual([expect.objectContaining({ text: expect.stringContaining('After restart') })]);
    expect(second.runtime.pending()).toEqual([]);
  });

  it.each([['not JSON', '{ not json'], ['JSON of another shape', '{"version":1}']])('keeps a file that is %s aside instead of overwriting it', async (_label, content) => {
    const dataDir = await makeDataDir();
    await fs.writeFile(path.join(dataDir, 'dispatch-results.json'), content);
    const { runtime } = await createRuntime({ dataDir });
    await runtime.load();
    const files = await fs.readdir(dataDir);
    expect(files.some((name) => name.startsWith('dispatch-results.json.corrupt-'))).toBe(true);
    expect(runtime.pending()).toEqual([]);
  });

  it('fails a registration that did not reach the disk and forgets the entry', async () => {
    const dataDir = await makeDataDir();
    const { runtime, openCode } = await createRuntime({ dataDir });
    openCode.state.active.ses_child = { type: 'running' };
    await runtime.load();
    // A directory where the file goes makes the atomic rename fail.
    await fs.mkdir(path.join(dataDir, 'dispatch-results.json'));
    await expect(runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 })).rejects.toThrow();
    expect(runtime.pending()).toEqual([]);
  });

  it('refuses an entry that would report a session to itself', async () => {
    const { runtime } = await createRuntime();
    await expect(runtime.register({ parentSessionId: 'ses_same', sessionId: 'ses_same', dispatchedAt: 1 })).rejects.toThrow('itself');
  });
});

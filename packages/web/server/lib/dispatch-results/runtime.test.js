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
    jobs: [],
    sessions: { ses_child: { id: 'ses_child', title: 'Fix the toolbar' } },
    records: { ses_child: [] },
    synthetic: [],
    syntheticStatus: [],
    seenIds: new Set(),
  };
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const { pathname } = new URL(url);
    if (pathname === '/api/experimental/job') {
      return state.jobs === null ? json({ error: 'down' }, 503) : json({ data: state.jobs });
    }
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

  describe('a child whose own background work still runs', () => {
    const job = { kind: 'shell', sessionID: 'ses_child', status: 'running', command: 'bun run verify', time: { started: 1 } };
    const start = async (overrides = {}) => {
      let clock = 1_000;
      const openCode = createOpenCode();
      openCode.state.sessions.ses_child.metadata = { openchamber: { kind: 'operator-child', parentID: 'ses_parent' } };
      openCode.state.jobs = [job];
      const run = await createRuntime({ openCode, now: () => clock, waitCheckMs: 10, waitGraceMs: 0, ...overrides });
      openCode.state.records.ses_child.push(user(11), assistant('The verify run is on', 12), idle('succeeded', 13));
      await run.runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10, afterIdleId: null });
      const held = () => vi.waitFor(() => expect(run.runtime.pending()[0].held?.since).toBe(1_000));
      const end = (...records) => {
        openCode.state.records.ses_child.push(...records);
        run.emit({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'busy' } } });
        run.emit({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'idle' } } });
      };
      const sent = (count) => vi.waitFor(() => expect(openCode.state.synthetic).toHaveLength(count));
      return { ...run, openCode, end, sent, held, pass: (ms) => { clock += ms; } };
    };
    const sourcesOf = (state) => () => ({
      extensionWaits: { load: async () => {}, snapshot: () => ({ waits: state.waits ?? [] }) },
      prWatch: { listWaits: async () => state.pulls ?? [] },
      workflows: { list: async () => state.runs ?? [] },
      waitsOnAnswer: (id) => id === state.asking,
    });

    it('does not wake the parent while it waits, and delivers the held answers with the later one', async () => {
      const { openCode, end, sent, held, runtime } = await start();
      await held();
      end(assistant('A second run is on', 20), idle('succeeded', 21));
      await vi.waitFor(() => expect(runtime.pending()[0].afterIdleId).toBe('msg_i21'));
      expect(openCode.state.synthetic).toEqual([]);
      openCode.state.jobs = [];
      end(assistant('Net green, 3 commits', 30), idle('succeeded', 31));
      await sent(1);
      const [{ text }] = openCode.state.synthetic;
      expect(text).toContain('The verify run is on\n\nA second run is on\n\nNet green, 3 commits');
      expect(text).not.toContain('without waking');
      await vi.waitFor(() => expect(runtime.pending()).toEqual([expect.not.objectContaining({ held: expect.anything() })]));
    });

    it('delivers a failure at once, with the answer it held', async () => {
      const { openCode, end, sent, held } = await start();
      await held();
      end(assistant('', 20, { error: { message: 'SIGKILL' } }), idle('failed', 21));
      await sent(1);
      expect(openCode.state.synthetic[0]).toMatchObject({ metadata: { state: 'error' }, text: expect.stringContaining('The verify run is on\n\nThe session failed: SIGKILL') });
    });

    it('delivers at once when the child, its subagent or its workflow waits on an answer', async () => {
      const subagent = { ...job, kind: 'subagent', childSessionID: 'ses_sub' };
      for (const [jobs, state] of [[[job], { asking: 'ses_child' }], [[subagent], { asking: 'ses_sub' }], [[job], { runs: [{ name: 'audit', state: 'awaiting-approval' }] }]]) {
        const { openCode, sent } = await start({ ownWorkSources: sourcesOf(state) });
        openCode.state.jobs = jobs;
        await sent(1);
      }
    });

    it('tells the parent when the work ended and nothing woke the child, after a moment for the wake to start a turn', async () => {
      const { openCode, sent, held, pass } = await start({ waitGraceMs: 30 });
      await held();
      openCode.state.jobs = [];
      await settle();
      expect(openCode.state.synthetic).toEqual([]);
      pass(30);
      await sent(1);
      expect(openCode.state.synthetic[0].text).toContain('The verify run is on\n\nIts background work ended without waking it');
    });

    it('tells the parent once what the child waits on after 30 minutes, also after a restart', async () => {
      const { openCode, runtime, dataDir, held } = await start();
      await held();
      runtime.stop();
      await runtime.flush();
      const restarted = await createRuntime({ openCode, dataDir, now: () => 1_000 + 30 * 60_000, waitCheckMs: 10 });
      restarted.runtime.start();
      await vi.waitFor(() => expect(openCode.state.synthetic).toHaveLength(1));
      expect(openCode.state.synthetic[0].text).toContain('still runs:\n- shell: bun run verify');
      await settle();
      expect(openCode.state.synthetic).toHaveLength(1);
    });

    it('keeps a held answer whose records are gone from the newest page, and when the child is deleted', async () => {
      const paged = await start();
      await paged.held();
      paged.openCode.state.jobs = [];
      paged.openCode.state.records.ses_child.length = 0;
      paged.end(assistant('Done', 20), idle('succeeded', 21));
      await paged.sent(1);
      expect(paged.openCode.state.synthetic[0].text).toContain('The verify run is on\n\nDone');

      const deleted = await start();
      await deleted.held();
      delete deleted.openCode.state.sessions.ses_child;
      deleted.emit({ type: 'session.deleted', properties: { sessionID: 'ses_child' } });
      await deleted.sent(1);
      expect(deleted.openCode.state.synthetic[0]).toMatchObject({ metadata: { state: 'cancelled' }, text: expect.stringContaining('The verify run is on\n\nThe session was stopped') });
    });

    it('sends what it held to the parent when the user takes the child over', async () => {
      const { openCode, end, sent, held, runtime } = await start();
      await held();
      delete openCode.state.sessions.ses_child.metadata;
      end(assistant('For the user now', 20), idle('succeeded', 21));
      await sent(1);
      expect(openCode.state.synthetic[0].text).toContain('The verify run is on');
      expect(openCode.state.synthetic[0].text).not.toContain('For the user now');
      await vi.waitFor(() => expect(runtime.pending()).toEqual([]));
    });

    it('sends what it held after 30 minutes, or once it waits on an answer, while a later turn still runs', async () => {
      const late = await start();
      await late.held();
      late.openCode.state.active.ses_child = { type: 'running' };
      late.emit({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'busy' } } });
      await settle();
      expect(late.openCode.state.synthetic).toEqual([]);
      late.pass(30 * 60_000);
      await late.sent(1);
      expect(late.openCode.state.synthetic[0].text).toContain('working on its next turn');
      delete late.openCode.state.active.ses_child;
      late.openCode.state.jobs = [];
      late.end(assistant('Done', 20), idle('succeeded', 21));
      await late.sent(2);
      expect(late.openCode.state.synthetic[1].text).not.toContain('The verify run is on');

      const state = {};
      const asking = await start({ ownWorkSources: sourcesOf(state) });
      await asking.held();
      asking.openCode.state.active.ses_child = { type: 'running' };
      state.asking = 'ses_child';
      await asking.sent(1);
    });

    it('keeps watching after the 30-minute note, also after a restart, and says once when the work ended without waking the child', async () => {
      const { openCode, runtime, dataDir, held, pass, sent } = await start();
      await held();
      pass(30 * 60_000);
      await sent(1);
      await vi.waitFor(() => expect(runtime.pending()[0]).toMatchObject({ watching: true, afterIdleId: 'msg_i13' }));
      runtime.stop();
      await runtime.flush();
      const restarted = await createRuntime({ openCode, dataDir, now: () => 9_000_000, waitCheckMs: 10, waitGraceMs: 0 });
      restarted.runtime.start();
      await settle();
      openCode.state.jobs = null;
      await settle();
      expect(openCode.state.synthetic).toHaveLength(1);
      openCode.state.jobs = [];
      await sent(2);
      const { text } = openCode.state.synthetic[1];
      expect(text).toContain('ended without waking it');
      expect(text).not.toContain('The verify run is on');
      await settle();
      expect(openCode.state.synthetic).toHaveLength(2);
    });

    it('sends no such note when the watched work wakes the child', async () => {
      const { openCode, end, held, pass, sent } = await start();
      await held();
      pass(30 * 60_000);
      await sent(1);
      openCode.state.active.ses_child = { type: 'running' };
      openCode.state.jobs = [];
      end();
      await settle();
      delete openCode.state.active.ses_child;
      end(assistant('Done', 20), idle('succeeded', 21));
      await sent(2);
      expect(openCode.state.synthetic[1].text).toContain('\nDone\n');
      await settle();
      expect(openCode.state.synthetic).toHaveLength(2);
    });

    it('retries a refused delivery with the same text, the list of running work included', async () => {
      const { openCode, pass, sent, held } = await start();
      await held();
      openCode.state.syntheticStatus.push(503);
      pass(30 * 60_000);
      await sent(1);
      const posts = syntheticPosts(openCode);
      expect(posts).toHaveLength(2);
      expect(posts[1]).toEqual(posts[0]);
      expect(posts[0].text).toContain('- shell: bun run verify');
    });

    it('replays a refused batch unchanged when the child is taken over or deleted, or its records move on', async () => {
      const refuse = async () => {
        const run = await start({ retryDelayMs: () => 200 });
        await run.held();
        run.openCode.state.syntheticStatus.push(503);
        run.openCode.state.jobs = [];
        run.end(assistant('Net green', 20), idle('succeeded', 21));
        await vi.waitFor(() => expect(syntheticPosts(run.openCode)).toHaveLength(1));
        return run;
      };
      const taken = await refuse();
      delete taken.openCode.state.sessions.ses_child.metadata;
      await taken.sent(1);
      const moved = await refuse();
      moved.openCode.state.records.ses_child.length = 0;
      moved.openCode.state.records.ses_child.push(assistant('Newer', 30), idle('succeeded', 31));
      await moved.sent(2);
      const deleted = await refuse();
      delete deleted.openCode.state.sessions.ses_child;
      await deleted.sent(2);
      for (const { openCode } of [taken, moved, deleted]) {
        const [first, replay] = syntheticPosts(openCode);
        expect(replay).toEqual(first);
        expect(replay.text).toContain('The verify run is on\n\nNet green');
      }
      expect(moved.openCode.state.synthetic[1].text).toContain('Newer');
      expect(moved.openCode.state.synthetic[1].text).not.toContain('Net green');
      expect(deleted.openCode.state.synthetic[1].text).not.toContain('Net green');
    });

    it('sends a saved message even when the child can no longer be read', async () => {
      const { openCode, held, pass, sent } = await start();
      await held();
      openCode.state.syntheticStatus.push(503);
      const served = openCode.fetchImpl.getMockImplementation();
      openCode.fetchImpl.mockImplementation(async (url, init) => {
        const { pathname } = new URL(url);
        if (pathname === '/api/session/ses_child/message' && syntheticPosts(openCode).length > 0) return json({ error: 'down' }, 500);
        return served(url, init);
      });
      pass(30 * 60_000);
      await sent(1);
    });

    it('stays within the limit and shows the last failure however many answers are sent together', async () => {
      const dataDir = await makeDataDir();
      const openCode = createOpenCode();
      openCode.state.sessions.ses_child.metadata = { openchamber: { kind: 'operator-child', parentID: 'ses_parent' } };
      openCode.state.records.ses_child.push(idle('succeeded', 5), assistant('', 12, { error: { message: 'SIGKILL' } }), idle('failed', 13));
      await fs.writeFile(path.join(dataDir, 'dispatch-results.json'), JSON.stringify({ version: 1, entries: [{
        id: 'dispatch-1', parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 1, afterIdleId: 'msg_i5', follow: true,
        held: { since: 1_000, bodies: Array.from({ length: 260 }, () => 'x'.repeat(400)) },
      }] }));
      const { runtime } = await createRuntime({ dataDir, openCode });
      runtime.start();
      await vi.waitFor(() => expect(openCode.state.synthetic).toHaveLength(1));
      expect(openCode.state.synthetic[0].text.length).toBeLessThan(50_300);
      expect(openCode.state.synthetic[0].text).toContain('The session failed: SIGKILL');
      expect(openCode.state.synthetic[0].text).toContain('earlier answers are left out');
    });

    it('keeps the 30 minutes when the child gets busy right before they end', async () => {
      const { openCode, emit, sent, held, pass } = await start({ waitCheckMs: 60_000 });
      await held();
      pass(30 * 60_000 - 20);
      openCode.state.active.ses_child = { type: 'running' };
      emit({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'busy' } } });
      pass(20);
      await sent(1);
    });

    it('keeps a later failure visible when the answers sent together are too long for one message', async () => {
      const { openCode, end, sent, held } = await start();
      await held();
      end(assistant('x'.repeat(49_000), 20), idle('succeeded', 21));
      await settle();
      end(assistant('', 30, { error: { message: 'SIGKILL' } }), idle('failed', 31));
      await sent(1);
      end(assistant('y'.repeat(60_000), 40), idle('succeeded', 41));
      await settle();
      end(assistant('', 50, { error: { message: 'SECOND' } }), idle('failed', 51));
      await sent(2);
      expect(openCode.state.synthetic[1].text.length).toBeLessThan(50_300);
      expect(openCode.state.synthetic[1].text).toContain('The session failed: SECOND');
    });

    it('counts waits, running workflows and the sessions the child runs as its own work', async () => {
      for (const state of [{ waits: [{ sessionID: 'ses_child', source: 'timer' }] }, { pulls: [{ title: 'PR' }] }, { runs: [{ name: 'audit', state: 'running' }] }]) {
        const { openCode, held } = await start({ ownWorkSources: sourcesOf(state) });
        openCode.state.jobs = [];
        await held();
        await settle();
        expect(openCode.state.synthetic).toEqual([]);
      }
      const other = await start({ ownWorkSources: sourcesOf({ waits: [{ sessionID: 'ses_other', source: 'timer' }] }) });
      other.openCode.state.jobs = [];
      await other.sent(1);

      const nestedState = {};
      const nested = await createRuntime({ waitCheckMs: 10, ownWorkSources: sourcesOf(nestedState) });
      nested.openCode.state.sessions.ses_child.metadata = { openchamber: { kind: 'operator-child', parentID: 'ses_parent' } };
      nested.openCode.state.sessions.ses_grand = { id: 'ses_grand', metadata: { openchamber: { kind: 'operator-child', parentID: 'ses_child' } } };
      nested.openCode.state.active.ses_grand = { type: 'running' };
      nested.openCode.state.records.ses_child.push(assistant('Delegated', 12), idle('succeeded', 13));
      await nested.runtime.register({ parentSessionId: 'ses_child', sessionId: 'ses_grand', dispatchedAt: 10, afterIdleId: null });
      await nested.runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10, afterIdleId: null });
      await vi.waitFor(() => expect(nested.runtime.pending().find((entry) => entry.sessionId === 'ses_child').held).toBeDefined());
      expect(nested.openCode.state.synthetic).toEqual([]);
      nestedState.asking = 'ses_grand';
      await vi.waitFor(() => expect(nested.openCode.state.synthetic.map(({ sessionID }) => sessionID)).toEqual(['ses_parent']));
    });

    it('wakes the parent when what still runs cannot be read', async () => {
      const openCode = createOpenCode();
      openCode.state.jobs = null;
      openCode.state.sessions.ses_child.metadata = { openchamber: { kind: 'operator-child', parentID: 'ses_parent' } };
      openCode.state.records.ses_child.push(assistant('On it', 12), idle('succeeded', 13));
      const { runtime } = await createRuntime({ openCode });
      await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10, afterIdleId: null });
      await vi.waitFor(() => expect(openCode.state.synthetic).toHaveLength(1));
    });

    it('answers at once to a parent that only sent a prompt to a session the user talks to', async () => {
      const openCode = createOpenCode();
      openCode.state.jobs = [job];
      openCode.state.records.ses_child.push(assistant('On it', 12), idle('succeeded', 13));
      const { runtime } = await createRuntime({ openCode });
      await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10, afterIdleId: null });
      await vi.waitFor(() => expect(openCode.state.synthetic).toHaveLength(1));
    });
  });

  it('says a failed turn failed, also when a later turn it is sent with succeeded', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.sessions.ses_child.metadata = { openchamber: { kind: 'operator-child', parentID: 'ses_parent' } };
    openCode.state.records.ses_child.push(assistant('', 12, { error: { message: 'SIGKILL' } }), idle('failed', 13), assistant('The net runs alone', 20), idle('succeeded', 21));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10, afterIdleId: null });
    await vi.waitFor(() => expect(openCode.state.synthetic).toHaveLength(1));
    const [note] = openCode.state.synthetic;
    expect(note.metadata.state).toBe('error');
    expect(note.text).toContain('state="error"');
    expect(note.text).toContain('The session failed: SIGKILL\n\nThe net runs alone');
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

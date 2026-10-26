import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionGoalRuntime, normalizeMaxAutoTurns } from './runtime.js';

/**
 * The goal record — status, turns, token accounting — lives in
 * OpenChamber's own session metadata store, because OpenCode 2.x accepts
 * session metadata only when a session is created. `readSessionMetadata` and
 * `persistSessionGoal` are the seams.
 *
 * What is pinned here is the wiring: the runtime stays inert and costs nothing
 * when no store is given, it reads the goal from the store rather than from the
 * OpenCode record, and a goal that starts or resumes arms the loop through
 * `notifyGoalChanged` instead of through an OpenCode `session.updated` event
 * (which no longer carries our metadata).
 *
 * The previous suite drove the whole audit loop against a fake v1 OpenCode; it
 * is gone rather than rewritten because every route and shape it asserted on
 * belongs to v1. Subagents come from `GET /api/session?parentID=` now.
 */

const SESSION_ID = 'ses_parent';
const runtimes = [];

const activeGoal = (extra = {}) => ({
  id: 'goal_1',
  objective: 'Finish the task',
  status: 'active',
  turnsUsed: 0,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

const makeRuntime = (overrides = {}) => {
  const buildOpenCodeUrl = vi.fn((fetchPath) => `http://opencode.test${fetchPath}`);
  const getSmallModelService = vi.fn(async () => {
    throw new Error('the small model must not be consulted in this test');
  });
  const emitGoalNotification = vi.fn();
  const runtime = createSessionGoalRuntime({
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders: () => ({}),
    getSmallModelService,
    emitGoalNotification,
    isEnabled: () => true,
    // Never the user's settings file: the classifier stays chosen, and with
    // no endpoint injected the small model checks, as on a fresh install.
    getChecker: () => 'classifier',
    idleQuietMs: 1,
    kickoffQuietMs: 1,
    ...overrides,
  });
  runtimes.push(runtime);
  return { runtime, buildOpenCodeUrl, getSmallModelService, emitGoalNotification };
};

const wired = (metadata = {}) => ({
  readSessionMetadata: vi.fn(async () => metadata),
  persistSessionGoal: vi.fn(async () => undefined),
});

const idle = (sessionID = SESSION_ID) => ({
  type: 'session.status',
  properties: { sessionID, status: { type: 'idle' } },
});

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop().stop?.();
  vi.restoreAllMocks();
});

/**
 * A fake v2 OpenCode over the global fetch: flat message records (`type`,
 * `content[]`, `model`, `finish`, `tokens`), `{ location, data }` envelopes,
 * `/api/session/active` for busy state, and the three continuation calls.
 */
const v2OpenCode = ({ messages, active = {}, childPages = [[]], childrenStatus = 200, sessionRead = async () => {} }) => {
  const calls = [];
  const json = (data, status = 200) => new Response(JSON.stringify({ location: { directory: '/repo' }, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  const fetchMock = vi.fn(async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    // Real shape: `{ data }` without a `location`, unlike directory-scoped routes.
    if (url.pathname === '/api/session/active') return Response.json({ data: active });
    if (url.pathname === '/api/session') {
      // Children of the parent, cursor paged: the first page is selected by
      // `parentID`, later ones by the cursor alone.
      const index = url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor').replace('page-', '')) : 0;
      if (index === 0 && url.searchParams.get('parentID') !== SESSION_ID) return json({ data: [], cursor: {} });
      const data = childPages[index] ?? [];
      const next = index + 1 < childPages.length ? { next: `page-${index + 1}` } : {};
      return json({ data, cursor: next }, childrenStatus);
    }
    if (url.pathname.endsWith('/message')) return json({ data: [...messages].reverse(), cursor: null });
    if (url.pathname === `/api/session/${SESSION_ID}`) {
      await sessionRead();
      return json({ id: SESSION_ID, location: { directory: '/repo' } });
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
};

const assistantRecord = (overrides = {}) => ({
  id: 'msg_a1',
  sessionID: SESSION_ID,
  type: 'assistant',
  agent: 'build',
  model: { providerID: 'anthropic', id: 'claude-sonnet-5' },
  content: [{ type: 'text', text: 'Done with step one.' }],
  finish: 'stop',
  tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 20, write: 0 } },
  time: { created: 10, completed: 20 },
  ...overrides,
});

const smallModelSays = (answers) => JSON.stringify({ all_done: false, remaining: false, needs_user: false, ...answers });
const jevSays = (scores) => ({
  answers: Object.fromEntries(Object.entries({ all_done: 0.05, remaining: 0.05, needs_user: 0.05, ...scores }).map(([id, noul]) => [id, { noul }])),
  ms: 5,
});
const JEV_ENDPOINT = { url: 'https://jev.test', model: 'jev-1.13-free', headers: {} };

const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
};

const runTick = async (runtime) => {
  await runtime.notifyGoalChanged(SESSION_ID, '/repo', { openchamber: { goal: activeGoal() } });
  // idleQuietMs / kickoffQuietMs are 1 ms; the tick itself is async.
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe('session goal session-read recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    quiet();
  });

  afterEach(() => vi.useRealTimers());

  const setup = (sessionRead = vi.fn(async () => { throw new Error('fetch failed'); }), serverOptions = {}) => {
    const server = v2OpenCode({ messages: [assistantRecord()], sessionRead, ...serverOptions });
    const metadata = { openchamber: { goal: activeGoal() } };
    const seam = wired(metadata);
    seam.persistSessionGoal.mockImplementation(async (_sessionId, _directory, goal) => {
      metadata.openchamber.goal = goal;
    });
    const generate = vi.fn(async () => ({ text: smallModelSays({ remaining: true }) }));
    const runtime = makeRuntime({
      ...seam,
      idleQuietMs: 15_000,
      getSmallModelService: async () => ({ generateSmallModelText: generate }),
    });
    const start = async () => {
      await runtime.runtime.notifyGoalChanged(SESSION_ID, '/repo', metadata);
      await vi.advanceTimersByTimeAsync(1);
    };
    return { ...runtime, ...seam, ...server, metadata, sessionRead, generate, start };
  };

  it('retries a rejected initial read after the quiet window, then audits and continues', async () => {
    const sessionRead = vi.fn().mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValue(undefined);
    const test = setup(sessionRead);
    await test.start();
    expect(sessionRead).toHaveBeenCalledTimes(1);
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.persistSessionGoal).not.toHaveBeenCalled();
    expect(test.calls.some((call) => call.method === 'POST')).toBe(false);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(sessionRead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(sessionRead).toHaveBeenCalledTimes(2);
    expect(test.generate).toHaveBeenCalledTimes(1);
    expect(test.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(test.metadata.openchamber.goal).toMatchObject({ status: 'active', turnsUsed: 1 });
    expect(test.emitGoalNotification).not.toHaveBeenCalled();
  });

  it('backs off for 3 retries, then blocks once with a reason and a settlement notification', async () => {
    const test = setup();
    await test.start();
    for (const [index, delay] of [15_000, 30_000, 60_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(test.sessionRead).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(test.sessionRead).toHaveBeenCalledTimes(index + 2);
    }

    expect(test.persistSessionGoal).toHaveBeenCalledTimes(1);
    expect(test.metadata.openchamber.goal).toMatchObject({
      status: 'blocked',
      statusReason: 'Session could not be read after repeated attempts. Resume to try again.',
      turnsUsed: 0,
    });
    expect(test.emitGoalNotification).toHaveBeenCalledTimes(1);
    expect(test.emitGoalNotification.mock.calls[0][0]).toMatchObject({ status: 'blocked' });
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.calls.some((call) => call.method === 'POST')).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(test.sessionRead).toHaveBeenCalledTimes(4);
    expect(test.persistSessionGoal).toHaveBeenCalledTimes(1);
    expect(test.emitGoalNotification).toHaveBeenCalledTimes(1);
    test.runtime.processPayload(idle());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(test.persistSessionGoal).toHaveBeenCalledTimes(1);
    expect(test.emitGoalNotification).toHaveBeenCalledTimes(1);
  });

  it('resets the failure count after a successful read', async () => {
    const sessionRead = vi.fn().mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValue(undefined);
    const test = setup(sessionRead, { childrenStatus: 500 });
    await test.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sessionRead).toHaveBeenCalledTimes(2);
    // The children read arms another quiet window without a new session event.
    sessionRead.mockRejectedValue(new Error('fetch failed'));
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(sessionRead).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(sessionRead).toHaveBeenCalledTimes(4);
    expect(test.emitGoalNotification).not.toHaveBeenCalled();
  });

  for (const status of ['paused', 'complete', null]) {
    it(`preserves a ${status ?? 'cleared'} goal while the final read fails`, async () => {
      const gate = Promise.withResolvers();
      const sessionRead = vi.fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockImplementationOnce(() => gate.promise);
      const test = setup(sessionRead);
      await test.start();
      await vi.advanceTimersByTimeAsync(105_000);
      expect(sessionRead).toHaveBeenCalledTimes(4);
      test.metadata.openchamber.goal = status ? activeGoal({ status }) : null;
      gate.reject(new Error('fetch failed'));
      await vi.advanceTimersByTimeAsync(0);

      expect(test.persistSessionGoal).not.toHaveBeenCalled();
      expect(test.emitGoalNotification).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sessionRead).toHaveBeenCalledTimes(4);
    });
  }

  it('lets a tick reading the session survive a mid-goal edit', async () => {
    const gate = Promise.withResolvers();
    const sessionRead = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined);
    const test = setup(sessionRead);
    await test.start();
    expect(sessionRead).toHaveBeenCalledTimes(1);
    // The user edits the objective while the tick waits on the session read.
    await test.runtime.notifyGoalChanged(SESSION_ID, '/repo', { openchamber: { goal: activeGoal({ turnsUsed: 1 }) } });
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(test.generate).toHaveBeenCalledTimes(1);
    expect(test.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('pauses a goal whose user aborts while the tick reads the session', async () => {
    const gate = Promise.withResolvers();
    const sessionRead = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined);
    const test = setup(sessionRead, {
      messages: [assistantRecord({ finish: undefined, error: { name: 'MessageAbortedError', data: {} } })],
    });
    await test.start();
    test.runtime.processPayload({
      type: 'session.idle',
      properties: { sessionID: SESSION_ID, aborted: true, reason: 'user' },
    });
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(test.metadata.openchamber.goal).toMatchObject({ status: 'paused' });
    expect(test.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('rechecks active status at the settlement write', async () => {
    const test = setup();
    await test.start();
    await vi.advanceTimersByTimeAsync(45_000);
    // The goal changes between the exhaustion check and settlement write read.
    test.readSessionMetadata
      .mockResolvedValueOnce(test.metadata)
      .mockResolvedValueOnce({ openchamber: { goal: activeGoal({ status: 'complete' }) } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.sessionRead).toHaveBeenCalledTimes(4);
    expect(test.persistSessionGoal).not.toHaveBeenCalled();
    expect(test.emitGoalNotification).not.toHaveBeenCalled();
  });

  for (const failure of ['readSessionMetadata', 'persistSessionGoal']) {
    it(`logs and stops if ${failure} fails at exhaustion`, async () => {
      const test = setup();
      test[failure].mockRejectedValue(new Error('metadata unavailable'));
      await test.start();
      await vi.advanceTimersByTimeAsync(225_000);
      expect(test.sessionRead).toHaveBeenCalledTimes(4);
      expect(test.metadata.openchamber.goal.status).toBe('active');
      expect(test.emitGoalNotification).not.toHaveBeenCalled();
      expect(test.calls.some((call) => call.method === 'POST')).toBe(false);
      expect(console.warn).toHaveBeenCalledWith('[session-goal] tick failed:', 'metadata unavailable');
    });
  }

  for (const goal of [activeGoal({ status: 'paused' }), activeGoal({ status: 'complete' }), null, activeGoal({ id: 'goal_2' })]) {
    it(`rejects settlement if the metadata write queue sees ${goal?.status ?? 'no goal'} ${goal?.id ?? ''}`, async () => {
      const test = setup();
      test.persistSessionGoal.mockImplementationOnce(async (_sessionId, _directory, _next, canWrite) => {
        test.metadata.openchamber.goal = goal;
        return canWrite(test.metadata);
      });
      await test.start();
      await vi.advanceTimersByTimeAsync(105_000);
      expect(test.persistSessionGoal).toHaveBeenCalledTimes(1);
      expect(test.metadata.openchamber.goal).toEqual(goal);
      expect(test.emitGoalNotification).not.toHaveBeenCalled();
    });
  }

  it('keeps a later idle wakeup without running a second tick during the read', async () => {
    const gate = Promise.withResolvers();
    const sessionRead = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined);
    const test = setup(sessionRead);
    await test.start();
    test.runtime.processPayload(idle());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sessionRead).toHaveBeenCalledTimes(1);
    gate.reject(new Error('fetch failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionRead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sessionRead).toHaveBeenCalledTimes(2);
    expect(test.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('honors pause and resume while a read is in flight with a fresh retry window', async () => {
    const gate = Promise.withResolvers();
    const sessionRead = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const test = setup(sessionRead);
    await test.start();
    await vi.advanceTimersByTimeAsync(45_000);
    sessionRead.mockImplementationOnce(() => gate.promise);
    await vi.advanceTimersByTimeAsync(60_000);

    test.metadata.openchamber.goal = activeGoal({ status: 'paused' });
    await test.runtime.notifyGoalChanged(SESSION_ID, '/repo', test.metadata);
    test.metadata.openchamber.goal = activeGoal({ statusReason: 'resumed' });
    await test.runtime.notifyGoalChanged(SESSION_ID, '/repo', test.metadata);
    await vi.advanceTimersByTimeAsync(250);
    expect(sessionRead).toHaveBeenCalledTimes(4);
    gate.reject(new Error('fetch failed'));
    await vi.advanceTimersByTimeAsync(250);
    expect(sessionRead).toHaveBeenCalledTimes(5);
    expect(test.persistSessionGoal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sessionRead).toHaveBeenCalledTimes(6);
    expect(test.persistSessionGoal).not.toHaveBeenCalled();
  });

  // An abort is not here: the in-flight tick keeps its read so it can reach
  // its own abort check and pause the goal (see the abort test above).
  for (const event of ['busy', 'pause', 'stop']) {
    it(`cancels recovery on ${event} during an in-flight read`, async () => {
      const gate = Promise.withResolvers();
      const test = setup(vi.fn(() => gate.promise));
      await test.start();
      if (event === 'stop') test.runtime.stop();
      if (event === 'pause') {
        test.metadata.openchamber.goal = activeGoal({ status: 'paused' });
        await test.runtime.notifyGoalChanged(SESSION_ID, '/repo', test.metadata);
      }
      if (event === 'busy') {
        test.runtime.processPayload({ type: 'session.status', properties: { sessionID: SESSION_ID, status: { type: 'busy' } } });
      }
      gate.reject(new Error('fetch failed'));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(test.sessionRead).toHaveBeenCalledTimes(1);
      expect(test.persistSessionGoal).not.toHaveBeenCalled();
      expect(test.emitGoalNotification).not.toHaveBeenCalled();
      expect(test.calls.some((call) => call.method === 'POST')).toBe(false);
    });
  }
});

describe('session goal tick on v2 messages', () => {
  it('reads the flat v2 assistant record, audits it, and continues on the same model and agent', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { calls } = v2OpenCode({
      messages: [
        { id: 'msg_u1', sessionID: SESSION_ID, type: 'user', text: 'Finish the task', time: { created: 1 } },
        assistantRecord(),
      ],
    });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const generate = vi.fn(async () => ({ text: smallModelSays({ remaining: true }), providerID: 'anthropic', modelID: 'claude-haiku-5' }));
    const { runtime } = makeRuntime({
      ...seam,
      getSmallModelService: async () => ({ generateSmallModelText: generate }),
    });

    await runTick(runtime);

    // The check saw the assistant's text and ran within the session's provider.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).toMatchObject({ preferredProviderID: 'anthropic', preferredModelID: 'claude-sonnet-5' });
    expect(generate.mock.calls[0][0].prompt).toContain('Done with step one.');
    // Tokens were accounted from the v2 record: input + cache.read + output.
    const written = seam.persistSessionGoal.mock.calls.at(-1)[2];
    expect(written).toMatchObject({ turnsUsed: 1, tokensUsed: 170, evaluationProviderID: 'anthropic', evaluationModelID: 'claude-haiku-5' });
    // The continuation is one plain prompt: the session keeps its own model
    // and agent, nothing is re-selected.
    const continuation = calls.filter((call) => call.method === 'POST').map((call) => [call.path, call.body]);
    expect(continuation).toEqual([
      [`/api/session/${SESSION_ID}/prompt`, { text: expect.stringContaining('Finish the task') }],
    ]);
    runtime.stop();
  });

  it('takes the turn cap from Settings for both the prompt and the stop', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { calls } = v2OpenCode({
      messages: [
        { id: 'msg_u1', sessionID: SESSION_ID, type: 'user', text: 'Finish the task', time: { created: 1 } },
        assistantRecord(),
      ],
    });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const generate = vi.fn(async () => ({ text: smallModelSays({ remaining: true }) }));
    const { runtime } = makeRuntime({
      ...seam,
      getSmallModelService: async () => ({ generateSmallModelText: generate }),
      getMaxAutoTurns: () => 7,
    });

    await runTick(runtime);

    const prompt = calls.find((call) => call.method === 'POST')?.body.text;
    expect(prompt).toContain('Auto-continuations used: 1 of 7.');
    runtime.stop();
  });

  it('blocks the goal once it has used the turns Settings allows', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { calls } = v2OpenCode({ messages: [assistantRecord()] });
    const seam = wired({ openchamber: { goal: activeGoal({ turnsUsed: 3 }) } });
    const generate = vi.fn(async () => ({ text: smallModelSays({ remaining: true }) }));
    const { runtime } = makeRuntime({
      ...seam,
      getSmallModelService: async () => ({ generateSmallModelText: generate }),
      getMaxAutoTurns: () => 3,
    });

    await runTick(runtime);

    expect(seam.persistSessionGoal.mock.calls.at(-1)[2]).toMatchObject({ status: 'blocked', statusReason: 'auto-continuation limit reached' });
    expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
    runtime.stop();
  });

  it('falls back to 20 turns for a missing or out-of-range setting', () => {
    expect([undefined, 0, -5, 2.5, '50', 201].map(normalizeMaxAutoTurns)).toEqual([20, 20, 20, 20, 20, 20]);
    expect([1, 50, 200].map(normalizeMaxAutoTurns)).toEqual([1, 50, 200]);
  });

  it('settles the goal as complete when the report says all is done, without a continuation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { calls } = v2OpenCode({ messages: [assistantRecord()] });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const { runtime, emitGoalNotification } = makeRuntime({
      ...seam,
      getSmallModelService: async () => ({
        generateSmallModelText: async () => ({ text: smallModelSays({ all_done: true }) }),
      }),
    });

    await runTick(runtime);

    expect(seam.persistSessionGoal.mock.calls.at(-1)[2]).toMatchObject({ status: 'complete' });
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    expect(emitGoalNotification).toHaveBeenCalledTimes(1);
    runtime.stop();
  });

  it('treats a finished compaction as a summary turn: no audit, continuation sent', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { calls } = v2OpenCode({
      messages: [
        assistantRecord(),
        { id: 'msg_c1', sessionID: SESSION_ID, type: 'compaction', status: 'completed', summary: 'Summary so far', time: { created: 30 } },
      ],
    });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const generate = vi.fn();
    const { runtime } = makeRuntime({ ...seam, getSmallModelService: async () => ({ generateSmallModelText: generate }) });

    await runTick(runtime);

    expect(generate).not.toHaveBeenCalled();
    expect(calls.some((call) => call.path.endsWith('/prompt') && call.method === 'POST')).toBe(true);
    runtime.stop();
  });

  it('a compaction closes the token segment, so the goal keeps counting what came before it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    v2OpenCode({
      messages: [
        assistantRecord(),
        { id: 'msg_c1', sessionID: SESSION_ID, type: 'compaction', status: 'completed', summary: 'Summary so far', time: { created: 30 } },
        assistantRecord({ id: 'msg_d1', tokens: { input: 30, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 40, completed: 50 } }),
      ],
    });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const { runtime } = makeRuntime(seam);

    await runTick(runtime);

    // 170 from the turn before the compaction, 50 from the one after it.
    expect(seam.persistSessionGoal.mock.calls.at(-1)[2]).toMatchObject({ tokensUsed: 220 });
    runtime.stop();
  });

  it('waits when the session is still running or the user just sent a message', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const generate = vi.fn();
    const busy = v2OpenCode({ messages: [assistantRecord()], active: { [SESSION_ID]: { status: 'running' } } });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const { runtime } = makeRuntime({ ...seam, getSmallModelService: async () => ({ generateSmallModelText: generate }) });
    await runTick(runtime);
    expect(busy.calls.some((call) => call.method === 'POST')).toBe(false);
    runtime.stop();

    const trailing = v2OpenCode({
      messages: [assistantRecord(), { id: 'msg_u2', sessionID: SESSION_ID, type: 'user', text: 'wait', time: { created: 50 } }],
    });
    const { runtime: second } = makeRuntime({ ...wired({ openchamber: { goal: activeGoal() } }), getSmallModelService: async () => ({ generateSmallModelText: generate }) });
    await runTick(second);
    expect(trailing.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    second.stop();
  });
});

describe('session goal tick and subagents', () => {
  const child = (id) => ({ id, parentID: SESSION_ID, time: { updated: 1 } });

  it('waits while a subagent listed on a later page is still working', async () => {
    quiet();
    const generate = vi.fn();
    const server = v2OpenCode({
      messages: [assistantRecord()],
      active: { ses_child_2: { status: 'running' } },
      childPages: [[child('ses_child_1')], [child('ses_child_2')]],
    });
    const { runtime } = makeRuntime({
      ...wired({ openchamber: { goal: activeGoal() } }),
      getSmallModelService: async () => ({ generateSmallModelText: generate }),
      idleQuietMs: 1_000,
    });
    await runTick(runtime);
    const listCalls = server.calls.filter((call) => call.path === '/api/session');
    expect(listCalls.map((call) => call.query.parentID ?? call.query.cursor)).toEqual([SESSION_ID, 'page-1']);
    expect(server.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it('rechecks a working subagent and audits after it finishes without another parent event', async () => {
    quiet();
    const active = { ses_child_1: { status: 'running' } };
    const server = v2OpenCode({
      messages: [assistantRecord()],
      active,
      childPages: [[child('ses_child_1')]],
    });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const generate = vi.fn(async () => ({ text: smallModelSays({ all_done: true }) }));
    const { runtime } = makeRuntime({
      ...seam,
      getSmallModelService: async () => ({ generateSmallModelText: generate }),
      idleQuietMs: 5,
    });

    await runtime.notifyGoalChanged(SESSION_ID, '/repo', { openchamber: { goal: activeGoal() } });
    await vi.waitFor(() => {
      expect(server.calls.some((call) => call.path === '/api/session' && call.query.parentID === SESSION_ID)).toBe(true);
    });
    expect(generate).not.toHaveBeenCalled();

    delete active.ses_child_1;
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    // The verdict is persisted after the audit resolves, a tick later.
    await vi.waitFor(() => {
      expect(seam.persistSessionGoal.mock.calls.at(-1)?.[2]).toMatchObject({ status: 'complete' });
    });
  });

  it('audits once every subagent is idle', async () => {
    quiet();
    const server = v2OpenCode({
      messages: [assistantRecord()],
      childPages: [[child('ses_child_1')]],
    });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const { runtime } = makeRuntime({
      ...seam,
      getSmallModelService: async () => ({
        describeSmallModel: async () => ({ inputCharBudget: 20_000 }),
        generateSmallModelText: async () => ({ text: smallModelSays({ all_done: true }) }),
      }),
    });
    await runTick(runtime);
    expect(server.calls.some((call) => call.path === '/api/session' && call.query.parentID === SESSION_ID)).toBe(true);
    expect(seam.persistSessionGoal).toHaveBeenCalled();
  });

  it('does not treat an unreadable children list as "no subagents"', async () => {
    quiet();
    const generate = vi.fn();
    const server = v2OpenCode({ messages: [assistantRecord()], childrenStatus: 500 });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const { runtime } = makeRuntime({
      ...seam,
      getSmallModelService: async () => ({ generateSmallModelText: generate }),
      idleQuietMs: 1_000,
    });
    await runTick(runtime);
    expect(server.calls.some((call) => call.path === '/api/session')).toBe(true);
    expect(server.calls.some((call) => call.path.endsWith('/message'))).toBe(false);
    expect(server.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(seam.persistSessionGoal).not.toHaveBeenCalled();
  });
});

describe('session goal progress check', () => {
  it('asks Jev when it is the checker and a provider answers, and settles on its word', async () => {
    quiet();
    const { calls } = v2OpenCode({ messages: [assistantRecord()] });
    const seam = wired({ openchamber: { goal: activeGoal({ evaluationProviderID: 'anthropic', evaluationModelID: 'claude-haiku-5' }) } });
    const jev = { ask: vi.fn(async () => jevSays({ all_done: 0.9 })) };
    const { runtime, getSmallModelService } = makeRuntime({ ...seam, jev, classifierEndpoint: async () => JEV_ENDPOINT });

    await runTick(runtime);

    const [request, endpoint] = jev.ask.mock.calls[0];
    expect(endpoint).toBe(JEV_ENDPOINT);
    expect(request.state).toEqual({ objective: 'Finish the task', answer: 'Done with step one.' });
    expect(Object.keys(request.questions)).toEqual(['all_done', 'remaining', 'needs_user']);
    expect(getSmallModelService).not.toHaveBeenCalled();
    // Jev has no provider: a leftover small-model provider must not be paired with Jev's model.
    expect(seam.persistSessionGoal.mock.calls.at(-1)[2]).toMatchObject({ status: 'complete', evaluationProviderID: '', evaluationModelID: 'jev-1.13-free' });
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('keeps going while the report names work the agent still has to do', async () => {
    quiet();
    const { calls } = v2OpenCode({ messages: [assistantRecord()] });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const jev = { ask: vi.fn(async () => jevSays({ all_done: 0.9, remaining: 0.8 })) };
    const { runtime } = makeRuntime({ ...seam, jev, classifierEndpoint: async () => JEV_ENDPOINT });

    await runTick(runtime);

    expect(seam.persistSessionGoal.mock.calls.at(-1)[2]).toMatchObject({ status: 'active', turnsUsed: 1 });
    expect(calls.some((call) => call.path.endsWith('/prompt') && call.method === 'POST')).toBe(true);
  });

  it('settles as blocked on the first turn that waits for the user, without a continuation', async () => {
    quiet();
    const { calls } = v2OpenCode({ messages: [assistantRecord()] });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const jev = { ask: vi.fn(async () => jevSays({ all_done: 0.9, needs_user: 0.9 })) };
    const { runtime, emitGoalNotification } = makeRuntime({ ...seam, jev, classifierEndpoint: async () => JEV_ENDPOINT });

    await runTick(runtime);

    expect(seam.persistSessionGoal.mock.calls.at(-1)[2]).toMatchObject({ status: 'blocked', statusReason: 'waiting for user input' });
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    expect(emitGoalNotification).toHaveBeenCalledTimes(1);
  });

  it('checks with the small model when Jev fails this time', async () => {
    quiet();
    v2OpenCode({ messages: [assistantRecord()] });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const jev = { ask: vi.fn(async () => { throw new Error('Jev responded 503'); }) };
    const generate = vi.fn(async () => ({ text: smallModelSays({ all_done: true }), providerID: 'anthropic', modelID: 'claude-haiku-5' }));
    const { runtime } = makeRuntime({
      ...seam,
      jev,
      classifierEndpoint: async () => JEV_ENDPOINT,
      getSmallModelService: async () => ({ generateSmallModelText: generate }),
    });

    await runTick(runtime);

    expect(jev.ask).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(seam.persistSessionGoal.mock.calls.at(-1)[2]).toMatchObject({ status: 'complete', evaluationModelID: 'claude-haiku-5' });
  });

  it('never asks Jev when the user picked the small model', async () => {
    quiet();
    v2OpenCode({ messages: [assistantRecord()] });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const jev = { ask: vi.fn() };
    const generate = vi.fn(async () => ({ text: smallModelSays({ remaining: true }), providerID: 'anthropic', modelID: 'claude-haiku-5' }));
    const { runtime } = makeRuntime({
      ...seam,
      jev,
      classifierEndpoint: async () => JEV_ENDPOINT,
      getChecker: () => 'small-model',
      getSmallModelService: async () => ({ generateSmallModelText: generate }),
    });

    await runTick(runtime);

    expect(jev.ask).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('counts a small-model reply that is not the asked-for JSON as no check', async () => {
    quiet();
    const { calls } = v2OpenCode({ messages: [assistantRecord()] });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const generate = vi.fn(async () => ({ text: '{"verdict":"complete"}' }));
    const { runtime } = makeRuntime({ ...seam, getSmallModelService: async () => ({ generateSmallModelText: generate }) });

    await runTick(runtime);

    // One unchecked continuation is tolerated; the goal is not settled on a guess.
    expect(seam.persistSessionGoal.mock.calls.at(-1)[2]).toMatchObject({ status: 'active', auditFailStreak: 1 });
    expect(calls.some((call) => call.path.endsWith('/prompt') && call.method === 'POST')).toBe(true);
  });
});

describe('session goal runtime', () => {
  it('arms the loop when a goal starts, without waiting for an OpenCode event', async () => {
    const seam = wired();
    const { runtime, buildOpenCodeUrl } = makeRuntime(seam);

    await runtime.notifyGoalChanged('ses_1', '/repo', { openchamber: { goal: activeGoal() } });
    // The kickoff timer is armed; the directory came with the notification, so
    // nothing had to be looked up.
    expect(buildOpenCodeUrl).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('looks the directory up when a UI patch does not name one', async () => {
    const seam = wired();
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ location: { directory: '/resolved' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { runtime } = makeRuntime(seam);

    await runtime.notifyGoalChanged('ses_1', '', { openchamber: { goal: activeGoal() } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/session/ses_1');
    runtime.stop();
  });

  it('does not arm for a goal that is not active or already under way', async () => {
    const seam = wired();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { runtime } = makeRuntime(seam);

    await runtime.notifyGoalChanged('ses_1', '', { openchamber: { goal: activeGoal({ status: 'paused' }) } });
    await runtime.notifyGoalChanged('ses_1', '', { openchamber: { goal: activeGoal({ turnsUsed: 3 }) } });
    await runtime.notifyGoalChanged('ses_1', '', {});

    expect(fetchMock).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('does no work and reaches no service while no goal store is injected', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime, buildOpenCodeUrl, getSmallModelService, emitGoalNotification } = makeRuntime();

    runtime.processPayload(idle());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(buildOpenCodeUrl).not.toHaveBeenCalled();
    expect(getSmallModelService).not.toHaveBeenCalled();
    expect(emitGoalNotification).not.toHaveBeenCalled();
  });

  it('explains itself once, not on every event', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime } = makeRuntime();

    runtime.processPayload(idle('ses_1'));
    runtime.processPayload(idle('ses_2'));
    runtime.processPayload({ type: 'session.updated', properties: { info: { id: 'ses_3' } } });

    const notices = log.mock.calls.filter(([line]) => String(line).includes('[session-goal] parked'));
    expect(notices).toHaveLength(1);
  });

  it('ignores everything after stop', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime } = makeRuntime();

    runtime.stop();
    runtime.processPayload(idle());

    expect(log).not.toHaveBeenCalled();
  });

  it('reads a user abort off the aborted idle event v2 produces', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime } = makeRuntime(wired());

    // The old signal was an assistant message carrying MessageAbortedError;
    // accepting the new one must not throw or be mistaken for a normal idle.
    expect(() => runtime.processPayload({
      type: 'session.idle',
      properties: { sessionID: SESSION_ID, aborted: true, reason: 'user' },
    })).not.toThrow();
  });

  it('rejects an HTML continuation response on the v2 prompt route', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    v2OpenCode({ messages: [assistantRecord({ finish: 'length' })] });
    const upstream = globalThis.fetch;
    const fetchMock = vi.fn(async (input, init) => {
      if (new URL(input).pathname.endsWith('/prompt')) {
        return new Response('<!doctype html><title>OpenChamber</title>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return upstream(input, init);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { runtime } = makeRuntime(wired({ openchamber: { goal: activeGoal() } }));
    await runTick(runtime);
    expect(fetchMock.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/prompt'))).toBe(true);
    expect(warning).toHaveBeenCalledWith(
      '[session-goal] tick failed:',
      expect.stringContaining('runtime returned HTML instead of an API response'),
    );
    runtime.stop();
    warning.mockRestore();
  });
});

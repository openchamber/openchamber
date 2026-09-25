import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionGoalRuntime } from './runtime.js';

/**
 * The goal record — status, turns, token accounting, audit notes — lives in
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
const v2OpenCode = ({ messages, active = {}, childPages = [[]], childrenStatus = 200 }) => {
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
    if (url.pathname === `/api/session/${SESSION_ID}`) return json({ id: SESSION_ID, location: { directory: '/repo' } });
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

const runTick = async (runtime) => {
  await runtime.notifyGoalChanged(SESSION_ID, '/repo', { openchamber: { goal: activeGoal() } });
  // idleQuietMs / kickoffQuietMs are 1 ms; the tick itself is async.
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

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
    const generate = vi.fn(async () => ({ text: JSON.stringify({ verdict: 'continue', note: 'more to do' }), providerID: 'anthropic', modelID: 'claude-haiku-5' }));
    const { runtime } = makeRuntime({
      ...seam,
      getSmallModelService: async () => ({ generateSmallModelText: generate }),
    });

    await runTick(runtime);

    // The audit saw the assistant's text and ran within the session's provider.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).toMatchObject({ preferredProviderID: 'anthropic', preferredModelID: 'claude-sonnet-5', restrictToPreferredProvider: true });
    expect(generate.mock.calls[0][0].prompt).toContain('Done with step one.');
    // Tokens were accounted from the v2 record: input + cache.read + output.
    const written = seam.persistSessionGoal.mock.calls.at(-1)[2];
    expect(written).toMatchObject({ turnsUsed: 1, tokensUsed: 170 });
    // The continuation is one plain prompt: the session keeps its own model
    // and agent, nothing is re-selected.
    const continuation = calls.filter((call) => call.method === 'POST').map((call) => [call.path, call.body]);
    expect(continuation).toEqual([
      [`/api/session/${SESSION_ID}/prompt`, { text: expect.stringContaining('Finish the task') }],
    ]);
    runtime.stop();
  });

  it('settles the goal as complete when the audit says so, without a continuation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { calls } = v2OpenCode({ messages: [assistantRecord()] });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const { runtime, emitGoalNotification } = makeRuntime({
      ...seam,
      getSmallModelService: async () => ({
        generateSmallModelText: async () => ({ text: JSON.stringify({ verdict: 'complete', note: 'all done' }) }),
      }),
    });

    await runTick(runtime);

    expect(seam.persistSessionGoal.mock.calls.at(-1)[2]).toMatchObject({ status: 'complete', note: 'all done' });
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    expect(emitGoalNotification).toHaveBeenCalledTimes(1);
    runtime.stop();
  });

  it('treats a finished compaction as a summary turn: no audit, continuation sent', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { calls } = v2OpenCode({
      messages: [
        assistantRecord(),
        { id: 'msg_c1', sessionID: SESSION_ID, type: 'compaction', status: 'completed', summary: 'Summary so far', time: { created: 30, completed: 40 } },
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
  const quiet = () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  };
  const child = (id) => ({ id, parentID: SESSION_ID, time: { updated: 1 } });

  it('waits while a subagent listed on a later page is still working', async () => {
    quiet();
    const generate = vi.fn();
    const server = v2OpenCode({
      messages: [assistantRecord()],
      active: { ses_child_2: { status: 'running' } },
      childPages: [[child('ses_child_1')], [child('ses_child_2')]],
    });
    const { runtime } = makeRuntime({ ...wired({ openchamber: { goal: activeGoal() } }), getSmallModelService: async () => ({ generateSmallModelText: generate }) });
    await runTick(runtime);
    const listCalls = server.calls.filter((call) => call.path === '/api/session');
    expect(listCalls.map((call) => call.query.parentID ?? call.query.cursor)).toEqual([SESSION_ID, 'page-1']);
    expect(server.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(generate).not.toHaveBeenCalled();
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
        generateSmallModelText: async () => ({ text: '{"verdict":"complete","reason":"done"}' }),
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
    const { runtime } = makeRuntime({ ...seam, getSmallModelService: async () => ({ generateSmallModelText: generate }) });
    await runTick(runtime);
    expect(server.calls.some((call) => call.path === '/api/session')).toBe(true);
    expect(server.calls.some((call) => call.path.endsWith('/message'))).toBe(false);
    expect(server.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(seam.persistSessionGoal).not.toHaveBeenCalled();
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
});

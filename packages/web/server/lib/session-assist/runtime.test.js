import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionAssistRuntime } from './runtime.js';

/**
 * The recap and the suggestion live in OpenChamber's own session metadata
 * store, because OpenCode 2.x accepts session metadata only at create time.
 * `persistSessionAssist` is the seam. What is pinned here is the wiring: no
 * store means no work and no cost, and injecting one turns generation back on.
 *
 * The previous suite drove the whole generation through a fake v1 OpenCode
 * server. It is gone rather than rewritten: every shape it asserted on
 * (`message.parts`, `info.parentID`, `info.summary`, `PATCH /session/{id}`)
 * belongs to v1, so keeping it green would prove nothing about v2. The reader
 * itself is covered by `context.test.js`.
 */

const runtimes = [];

const makeRuntime = (overrides = {}) => {
  const buildOpenCodeUrl = vi.fn(() => 'http://127.0.0.1:1/');
  const getOpenCodeAuthHeaders = vi.fn(() => ({}));
  const getSmallModelService = vi.fn(async () => {
    throw new Error('the small model must not be consulted while assist is parked');
  });
  const runtime = createSessionAssistRuntime({
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    getSmallModelService,
    getTargets: () => ({ recap: true, suggestion: true }),
    quietMs: 1,
    ...overrides,
  });
  runtimes.push(runtime);
  return { runtime, buildOpenCodeUrl, getOpenCodeAuthHeaders, getSmallModelService };
};

const idle = (sessionId = 'ses_1') => ({
  type: 'session.status',
  properties: { sessionID: sessionId, status: { type: 'idle' } },
});

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop().stop();
  vi.restoreAllMocks();
});

describe('session assist runtime', () => {
  it('does no work and reaches no service while no assist store is injected', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime, buildOpenCodeUrl, getSmallModelService } = makeRuntime();

    runtime.processPayload(idle());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(buildOpenCodeUrl).not.toHaveBeenCalled();
    expect(getSmallModelService).not.toHaveBeenCalled();
  });

  it('explains itself once, not on every idle session', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime } = makeRuntime();

    runtime.processPayload(idle('ses_1'));
    runtime.processPayload(idle('ses_2'));
    runtime.processPayload(idle('ses_3'));

    const notices = log.mock.calls.filter(([line]) => String(line).includes('[session-assist] parked'));
    expect(notices).toHaveLength(1);
  });

  it('ignores everything after stop', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime } = makeRuntime();

    runtime.stop();
    runtime.processPayload(idle());

    expect(log).not.toHaveBeenCalled();
  });

  it('leaves an archived session alone: no context is loaded and no model is called', async () => {
    const persistSessionAssist = vi.fn(async () => undefined);
    const getSmallModelService = vi.fn(async () => {
      throw new Error('the small model must not be consulted for an archived session');
    });
    const fetchMock = vi.fn(async (input) => {
      const url = new URL(String(input));
      const body = url.pathname === '/api/session/ses_1'
        ? { location: { directory: '/repo' }, data: { id: 'ses_1', location: { directory: '/repo' } } }
        : { location: { directory: '/repo' }, data: { data: [], cursor: null } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { runtime } = makeRuntime({
      persistSessionAssist,
      getSmallModelService,
      buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
      isSessionArchived: async (sessionId) => sessionId === 'ses_1',
    });

    runtime.processPayload(idle());
    await new Promise((resolve) => setTimeout(resolve, 40));

    // The session record was read (that is where the parent/revert checks
    // live), then the archive check stopped everything else.
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(['/api/session/ses_1']);
    expect(getSmallModelService).not.toHaveBeenCalled();
    expect(persistSessionAssist).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('generates and saves an assist for a turn that v2 closed with an idle marker', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const persistSessionAssist = vi.fn(async () => undefined);
    const listLimits = [];
    // Newest first, the way OpenCode serves it: the idle marker sits above
    // the answer, and a model switch the user made afterwards above that.
    const records = [
      { id: 'msg_switch', type: 'model-switched', model: { providerID: 'p', id: 'm' } },
      { id: 'msg_idle', type: 'idle', outcome: 'succeeded' },
      { id: 'msg_a', type: 'assistant', content: [{ type: 'text', text: 'All done.' }], finish: 'stop', time: { completed: 2 }, model: { providerID: 'p', id: 'm' } },
      { id: 'msg_u', type: 'user', text: 'Do the thing' },
    ];
    const fetchMock = vi.fn(async (input) => {
      const url = new URL(String(input));
      let body;
      // `session.get` answers `{ data }`, which the client unwraps; the message
      // page is `{ data, cursor }` and reaches the reader as is.
      if (url.pathname === '/api/session/ses_1') body = { data: { id: 'ses_1', location: { directory: '/repo' } } };
      else if (url.pathname === '/api/session/ses_1/message') {
        listLimits.push(Number(url.searchParams.get('limit')));
        body = { data: records.slice(0, Number(url.searchParams.get('limit'))), cursor: {} };
      } else throw new Error(`unexpected ${url.pathname}`);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { runtime } = makeRuntime({
      persistSessionAssist,
      buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
      isSessionArchived: async () => false,
      getSmallModelService: async () => ({
        describeSmallModel: async () => ({ inputCharBudget: 20_000 }),
        generateSmallModelText: async () => ({ text: '{"recap":"Did the thing.","suggestion":"Verify it."}' }),
      }),
    });

    runtime.processPayload(idle());
    for (let i = 0; i < 20 && persistSessionAssist.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(persistSessionAssist).toHaveBeenCalledTimes(1);
    expect(persistSessionAssist.mock.calls[0][2]).toMatchObject({ recap: 'Did the thing.', suggestion: 'Verify it.', forMessageID: 'msg_a' });
    // The pre-write re-check must see past the idle marker as well.
    expect(listLimits.at(-1)).toBeGreaterThan(2);

    // A new turn deletes the stored assist, once.
    const busy = { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } };
    runtime.processPayload(busy);
    runtime.processPayload(busy);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persistSessionAssist).toHaveBeenCalledTimes(2);
    expect(persistSessionAssist.mock.calls[1][2]).toBeNull();
    vi.unstubAllGlobals();
  });

  it('arms generation again as soon as a store is injected', async () => {
    const persistSessionAssist = vi.fn(async () => undefined);
    const getSmallModelService = vi.fn(async () => {
      throw new Error('stop here: the transport is what this test observes');
    });
    const buildOpenCodeUrl = vi.fn(() => 'http://127.0.0.1:1/');
    const { runtime } = makeRuntime({ persistSessionAssist, getSmallModelService, buildOpenCodeUrl });

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    runtime.processPayload(idle());
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The idle timer fired and the generation path ran, which is what the gate
    // above suppresses.
    expect(buildOpenCodeUrl).toHaveBeenCalled();
  });
});

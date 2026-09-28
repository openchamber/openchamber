import { afterEach, describe, expect, it, vi } from 'vitest';

import { createContextObligatoryRuntime } from './runtime.js';

/**
 * Pinned messages and the compaction cursor live in OpenChamber's own session
 * metadata store, because OpenCode 2.x accepts session metadata only at create
 * time. `readSessionMetadata` and `persistContextCursor` are the seams, and a
 * compaction is now recognised by the `compaction` message role rather than by
 * `info.summary`.
 *
 * What is pinned here is the wiring: without both seams the runtime stays inert
 * and costs nothing, and it says so once. The previous suite drove the whole
 * injection against a fake v1 OpenCode and is gone rather than rewritten,
 * because every shape it asserted on belongs to v1.
 */

const runtimes = [];

const makeRuntime = (overrides = {}) => {
  const buildOpenCodeUrl = vi.fn((fetchPath) => `http://opencode.test${fetchPath}`);
  const runtime = createContextObligatoryRuntime({
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders: () => ({}),
    ...overrides,
  });
  runtimes.push(runtime);
  return { runtime, buildOpenCodeUrl };
};

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop().stop();
  vi.restoreAllMocks();
});

describe('context obligatory runtime', () => {
  it('needs both seams: a read alone leaves it inert', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime, buildOpenCodeUrl } = makeRuntime({ readSessionMetadata: async () => ({}) });

    await runtime.processPayload({ type: 'session.compacted', properties: { sessionID: 'ses_1' } });

    expect(buildOpenCodeUrl).not.toHaveBeenCalled();
  });

  it('starts working once both seams are wired', async () => {
    const readSessionMetadata = vi.fn(async () => ({}));
    const { runtime, buildOpenCodeUrl } = makeRuntime({
      readSessionMetadata,
      persistContextCursor: vi.fn(async () => undefined),
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'ses_1' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));

    await runtime.processPayload({ type: 'session.compacted', properties: { sessionID: 'ses_1' } });

    expect(buildOpenCodeUrl).toHaveBeenCalled();
    expect(readSessionMetadata).toHaveBeenCalledWith('ses_1');
  });

  it('reaches no service while no cursor store is injected', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime, buildOpenCodeUrl } = makeRuntime();

    await runtime.processPayload({ type: 'session.compacted', properties: { sessionID: 'ses_1' } });

    expect(buildOpenCodeUrl).not.toHaveBeenCalled();
  });

  it('explains itself once, not on every event', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime } = makeRuntime();

    runtime.processPayload({ type: 'session.compacted', properties: { sessionID: 'ses_1' } });
    runtime.processPayload({ type: 'session.idle', properties: { sessionID: 'ses_2' } });

    const notices = log.mock.calls.filter(([line]) => String(line).includes('[context-obligatory] parked'));
    expect(notices).toHaveLength(1);
  });

  it('ignores everything after stop', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime } = makeRuntime();

    runtime.stop();
    runtime.processPayload({ type: 'session.compacted', properties: { sessionID: 'ses_1' } });

    expect(log).not.toHaveBeenCalled();
  });
});

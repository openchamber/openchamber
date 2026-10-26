import { afterEach, describe, expect, it, vi } from 'vitest';

import { createContextObligatoryRuntime } from './runtime.js';

/**
 * Pinned messages and the compaction cursor live in OpenChamber's own session
 * metadata store. `readSessionMetadata` and `persistContextCursor` are the
 * seams; without both the runtime stays inert and says so once.
 *
 * `session.compacted` is the hub's translation of OpenCode 2's
 * `session.compaction.ended`. The v2 compaction message carries only
 * `time.created`, so the fake below has no `time.completed` on purpose.
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

const compactionEvent = () => ({ type: 'session.compacted', properties: { sessionID: 'ses_1' } });

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** A v2 OpenCode holding one finished compaction and two pinned messages. */
const fakeOpenCode = () => {
  const synthetic = [];
  const fetchMock = vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/api/session/ses_1') return json({ data: { id: 'ses_1' } });
    if (path === '/api/session/ses_1/message') {
      return json({
        data: [
          { id: 'msg_compact', type: 'compaction', status: 'completed', reason: 'auto', summary: 'S', recent: '', time: { created: 5 } },
          { id: 'msg_a', type: 'assistant', content: [{ type: 'text', text: 'Old answer' }], time: { created: 2 } },
        ],
        cursor: {},
      });
    }
    if (path === '/api/session/ses_1/message/msg_u') return json({ data: { id: 'msg_u', type: 'user', text: 'Keep this rule', time: { created: 1 } } });
    if (path === '/api/session/ses_1/message/msg_a') {
      return json({ data: { id: 'msg_a', type: 'assistant', content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'Old answer' }], time: { created: 2 } } });
    }
    if (path === '/api/session/ses_1/synthetic') {
      synthetic.push(JSON.parse(init.body));
      return json({ data: {} });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { synthetic, fetchMock };
};

const pinnedMetadata = (extra = {}) => ({
  openchamber: {
    context_obligatory_messages: [
      { id: 'msg_a', createdAt: 2, role: 'assistant' },
      { id: 'msg_u', createdAt: 1, role: 'user' },
    ],
    ...extra,
  },
});

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop().stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('context obligatory runtime', () => {
  it('re-sends pinned messages after a finished compaction and records the cursor', async () => {
    const { synthetic } = fakeOpenCode();
    const persistContextCursor = vi.fn(async () => undefined);
    const { runtime } = makeRuntime({ readSessionMetadata: async () => pinnedMetadata(), persistContextCursor });

    await runtime.processPayload(compactionEvent(), '/repo');

    expect(synthetic).toHaveLength(1);
    expect(synthetic[0].resume).toBe(false);
    const text = synthetic[0].text;
    expect(text.indexOf('Keep this rule')).toBeGreaterThan(-1);
    expect(text.indexOf('Keep this rule')).toBeLessThan(text.indexOf('Old answer'));
    expect(text).not.toContain('\nx\n');
    expect(persistContextCursor).toHaveBeenCalledWith('ses_1', '/repo', {
      openchamber: { context_obligatory_last_compaction_message_id: 'msg_compact' },
    });
  });

  it('does not re-send for a compaction it already handled', async () => {
    const { synthetic } = fakeOpenCode();
    const { runtime } = makeRuntime({
      readSessionMetadata: async () => pinnedMetadata({ context_obligatory_last_compaction_message_id: 'msg_compact' }),
      persistContextCursor: vi.fn(async () => undefined),
    });

    await runtime.processPayload(compactionEvent(), '/repo');

    expect(synthetic).toHaveLength(0);
  });

  it('needs both seams: a read alone leaves it inert', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime, buildOpenCodeUrl } = makeRuntime({ readSessionMetadata: async () => ({}) });

    await runtime.processPayload(compactionEvent());

    expect(buildOpenCodeUrl).not.toHaveBeenCalled();
  });

  it('explains itself once, not on every event', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime } = makeRuntime();

    runtime.processPayload(compactionEvent());
    runtime.processPayload({ type: 'session.idle', properties: { sessionID: 'ses_2' } });

    const notices = log.mock.calls.filter(([line]) => String(line).includes('[context-obligatory] parked'));
    expect(notices).toHaveLength(1);
  });

  it('ignores everything after stop', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime } = makeRuntime();

    runtime.stop();
    runtime.processPayload(compactionEvent());

    expect(log).not.toHaveBeenCalled();
  });

  it('does not record the compaction cursor when synthetic context returns HTML', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchMock } = fakeOpenCode();
    const upstream = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input).pathname.endsWith('/synthetic')) {
        return new Response('<!doctype html><title>OpenChamber</title>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return upstream(input, init);
    });
    const persistContextCursor = vi.fn(async () => undefined);
    const { runtime } = makeRuntime({ readSessionMetadata: async () => pinnedMetadata(), persistContextCursor });
    await runtime.processPayload(compactionEvent(), '/repo');
    expect(fetchMock.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/synthetic'))).toBe(true);
    expect(persistContextCursor).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionRuntime, RESTART_RESUME_GRACE_MS } from './session-runtime.js';

const RETRY_MS = 15 * 1000;
const ATTEMPTS = 3;

const markBusy = (runtime, sessionID) => runtime.processOpenCodeSsePayload({
  type: 'session.status',
  properties: { sessionID, status: { type: 'busy' } },
});

// Plain objects, not undici Responses: body reading through the real
// ReadableStream does not settle under faked timers and would leak the
// continuation across timer advances.
const jsonResponse = (status) => ({
  ok: status >= 200 && status < 300,
  status,
  body: undefined,
  text: async () => '',
});

// Clears the 15 s AbortSignal.timeout so no live timer survives the test.
// Guarded: on some runtimes (Bun) the timeout signal exposes no callable
// abort, and the signal then simply outlives the test.
const clearSignal = (init) => {
  if (init?.signal && typeof init.signal.abort === 'function') init.signal.abort();
};

const createRuntime = (fetchImpl, deps = {}) => {
  const runtime = createSessionRuntime({
    writeSseEvent() {},
    getNotificationClients: () => new Set(),
    broadcastEvent() {},
    buildOpenCodeUrl: (fetchPath) => `http://127.0.0.1:49722${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({ authorization: 'Basic test' }),
    fetchImpl,
    ...deps,
  });
  runtimes.push(runtime);
  return runtime;
};

const runtimes = [];

describe('restart auto-resume fallback', () => {
  afterEach(() => {
    for (const runtime of runtimes) runtime.dispose();
    runtimes.length = 0;
    vi.useRealTimers();
  });

  it('sends a continuation to a session that is still idle after the grace period', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      clearSignal(init);
      calls.push({ url, init });
      return jsonResponse(200);
    });
    const runtime = createRuntime(fetchImpl);

    markBusy(runtime, 'session-1');
    runtime.interruptBusySessionsAfterRestart();
    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS - 1);
    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const { url, init } = calls[0];
    expect(url).toBe('http://127.0.0.1:49722/api/session/session-1/synthetic');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Basic test');
    const body = JSON.parse(init.body);
    expect(body.resume).toBe(true);
    expect(body.metadata).toEqual({ notice: 'opencode-restart' });
    expect(body.text).toContain('Continue from where you left off without repeating completed work');
    expect(body.id).toMatch(/^opencode-restart-resume-/);
  });

  it('skips the fallback when the session resumed on its own before the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchImpl = vi.fn(async (url, init) => {
      clearSignal(init);
      return jsonResponse(200);
    });
    const runtime = createRuntime(fetchImpl);

    markBusy(runtime, 'session-1');
    runtime.interruptBusySessionsAfterRestart();
    // OpenCode's own boot sweep (or the user) picked the turn back up.
    markBusy(runtime, 'session-1');

    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries a failed continuation and gives up after the final attempt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url, init) => {
      clearSignal(init);
      return jsonResponse(500);
    });
    const runtime = createRuntime(fetchImpl);

    markBusy(runtime, 'session-1');
    runtime.interruptBusySessionsAfterRestart();

    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(ATTEMPTS);
    expect(warn).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(ATTEMPTS);
    warn.mockRestore();
  });

  it('reuses the same message id across the attempts of one restart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const bodies = [];
    const fetchImpl = vi.fn(async (url, init) => {
      clearSignal(init);
      bodies.push(JSON.parse(init.body));
      return jsonResponse(502);
    });
    const runtime = createRuntime(fetchImpl);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    markBusy(runtime, 'session-1');
    runtime.interruptBusySessionsAfterRestart();

    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await vi.advanceTimersByTimeAsync(RETRY_MS);

    expect(bodies).toHaveLength(ATTEMPTS);
    expect(new Set(bodies.map((body) => body.id)).size).toBe(1);
    warn.mockRestore();
  });

  it('does not retry a session that was deleted in the meantime', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url, init) => {
      clearSignal(init);
      return jsonResponse(404);
    });
    const runtime = createRuntime(fetchImpl);

    markBusy(runtime, 'session-1');
    runtime.interruptBusySessionsAfterRestart();

    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS + RETRY_MS);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('starts a fresh schedule when a second restart interrupts the session again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchImpl = vi.fn(async (url, init) => {
      clearSignal(init);
      return jsonResponse(200);
    });
    const runtime = createRuntime(fetchImpl);

    markBusy(runtime, 'session-1');
    runtime.interruptBusySessionsAfterRestart();
    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS / 2);
    // The turn ran again and was interrupted by another restart.
    markBusy(runtime, 'session-1');
    runtime.interruptBusySessionsAfterRestart();

    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS / 2);
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS / 2);
    expect(fetchImpl).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS + RETRY_MS * 3);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not resume when OpenCode access was not injected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchImpl = vi.fn(async (url, init) => {
      clearSignal(init);
      return jsonResponse(200);
    });
    const runtime = createRuntime(fetchImpl, { buildOpenCodeUrl: undefined, getOpenCodeAuthHeaders: undefined });

    markBusy(runtime, 'session-1');
    runtime.interruptBusySessionsAfterRestart();

    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

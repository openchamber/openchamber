import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionMessage } from '@opencode/schema';

import { createSessionRuntime, RESTART_RESUME_GRACE_MS } from './session-runtime.js';
import { translateWireEvent } from '../event-stream/translate-v2.js';

const RETRY_MS = 15 * 1000;
const ATTEMPTS = 3;

const markBusy = (runtime, sessionID) => runtime.processOpenCodeSsePayload({
  type: 'session.status',
  properties: { sessionID, status: { type: 'busy' } },
});

const jsonResponse = (status) => ({
  ok: status >= 200 && status < 300,
  status,
});

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
    expect(body.delivery).toBe('steer');
    expect(body.metadata).toEqual({ notice: 'opencode-restart' });
    expect(body.text).toContain('Continue from where you left off without repeating completed work');
    expect(body.id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(SessionMessage.ID.make(body.id)).toBe(body.id);
  });

  it('skips the fallback when the session resumed on its own before the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchImpl = vi.fn(async () => {
      return jsonResponse(200);
    });
    const runtime = createRuntime(fetchImpl);

    markBusy(runtime, 'session-1');
    runtime.interruptBusySessionsAfterRestart();
    // The user continued before the automatic attempt.
    markBusy(runtime, 'session-1');

    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries a failed continuation and gives up after the final attempt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
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

  it.each([404, 409])('stops transport retries after status %s', async (status) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      return jsonResponse(status);
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
    const fetchImpl = vi.fn(async () => {
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
    const fetchImpl = vi.fn(async () => {
      return jsonResponse(200);
    });
    const runtime = createRuntime(fetchImpl, { buildOpenCodeUrl: undefined, getOpenCodeAuthHeaders: undefined });

    markBusy(runtime, 'session-1');
    runtime.interruptBusySessionsAfterRestart();

    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not resume the same turn after another two restarts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchImpl = vi.fn(async () => jsonResponse(200));
    const runtime = createRuntime(fetchImpl);
    markBusy(runtime, 'session-1');
    runtime.interruptBusySessionsAfterRestart();
    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);
    for (let restart = 0; restart < 2; restart += 1) {
      markBusy(runtime, 'session-1');
      runtime.interruptBusySessionsAfterRestart();
      await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('never sends an isolated space continuation to the host OpenCode', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchImpl = vi.fn(async () => jsonResponse(200));
    const runtime = createRuntime(fetchImpl);
    runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: { sessionID: 'space-session', status: { type: 'busy' } },
    }, { spaceId: 'space-1' });
    markBusy(runtime, 'host-session');
    runtime.interruptBusySessionsAfterRestart();
    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toContain('/host-session/');
  });

  it('keeps the budget spent when another restart lands during the POST', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let complete;
    const fetchImpl = vi.fn(() => new Promise((resolve) => { complete = resolve; }));
    const runtime = createRuntime(fetchImpl);
    markBusy(runtime, 'session-1');
    runtime.interruptBusySessionsAfterRestart();
    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);
    markBusy(runtime, 'session-1');
    expect(runtime.interruptBusySessionsAfterRestart().autoResumeSessionIds).toEqual([]);
    complete(jsonResponse(500));
    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS + RETRY_MS * 3);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('renews the budget only for a new user inbox message, not a synthetic or replay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchImpl = vi.fn(async () => jsonResponse(200));
    const runtime = createRuntime(fetchImpl);
    const enqueue = (inboxID, type) => {
      for (const payload of translateWireEvent({
        type: 'session.inbox.enqueued',
        data: { sessionID: 'session-1', inboxID, item: { type, payload: { text: 'Continue' } } },
      })) runtime.processOpenCodeSsePayload(payload);
    };
    enqueue('msg_user1', 'user');
    markBusy(runtime, 'session-1');
    runtime.interruptBusySessionsAfterRestart();
    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);
    enqueue('msg_synthetic', 'synthetic');
    enqueue('msg_user1', 'user');
    markBusy(runtime, 'session-1');
    expect(runtime.interruptBusySessionsAfterRestart().autoResumeSessionIds).toEqual([]);
    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);
    expect(fetchImpl).toHaveBeenCalledOnce();
    enqueue('msg_user2', 'user');
    markBusy(runtime, 'session-1');
    expect(runtime.interruptBusySessionsAfterRestart().autoResumeSessionIds).toEqual(['session-1']);
    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([200, 404, 409, 500])('keeps a new user turn schedule when an older POST returns %s', async (status) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let complete;
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }))
      .mockImplementation(async () => jsonResponse(200));
    const runtime = createRuntime(fetchImpl);
    markBusy(runtime, 'session-1');
    runtime.interruptBusySessionsAfterRestart();
    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);
    runtime.processOpenCodeSsePayload({
      type: 'message.updated',
      properties: { info: { id: 'msg_new', sessionID: 'session-1', role: 'user' } },
    });
    markBusy(runtime, 'session-1');
    runtime.interruptBusySessionsAfterRestart();
    complete(jsonResponse(status));
    await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const ids = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body).id);
    expect(ids[1]).not.toBe(ids[0]);
  });
});

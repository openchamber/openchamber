import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJevClient } from './jev.js';

const ENDPOINT = { url: 'http://localhost:11434/v1/systemone', model: 'd3:9b', headers: {} };
const ANSWER = { answers: { category: { choice: 'trivial', confidence: 0.9 } } };

// A fetch whose responses the test releases by hand; an abort rejects it the way fetch does.
const pendingFetch = () => {
  const calls = [];
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    const call = {
      signal: init.signal,
      respond: () => resolve({ ok: true, status: 200, text: async () => JSON.stringify(ANSWER) }),
    };
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    calls.push(call);
  });
  return { calls, fetchImpl };
};

const client = (fetchImpl) => createJevClient({ fetchImpl, timeoutMs: 4000, lingerMs: 60_000, lingering: new Set() });

afterEach(() => {
  vi.useRealTimers();
});

describe('jev client timeout', () => {
  it('answers the turn as a timeout but lets the first timed-out request finish loading the model', async () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = pendingFetch();
    const jev = client(fetchImpl);

    const first = jev.ask({}, ENDPOINT);
    const firstFailed = expect(first).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(4000);
    await firstFailed;
    expect(calls[0].signal.aborted).toBe(false);

    // A second turn while the first still loads is aborted at its own timeout.
    const second = jev.ask({}, ENDPOINT);
    const secondFailed = expect(second).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(4000);
    await secondFailed;
    expect(calls[1].signal.aborted).toBe(true);
    expect(calls[0].signal.aborted).toBe(false);

    // Once the load finishes the slot is free, and a warm model answers in time.
    calls[0].respond();
    await vi.advanceTimersByTimeAsync(0);
    const third = jev.ask({}, ENDPOINT);
    calls[2].respond();
    await expect(third).resolves.toMatchObject({ answers: ANSWER.answers });
  });

  it('aborts a lingering request at the cap and frees the endpoint', async () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = pendingFetch();
    const jev = client(fetchImpl);

    const first = expect(jev.ask({}, ENDPOINT)).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(4000);
    await first;
    await vi.advanceTimersByTimeAsync(56_000);
    expect(calls[0].signal.aborted).toBe(true);

    // The next timed-out request may linger again.
    const next = expect(jev.ask({}, ENDPOINT)).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(4000);
    await next;
    expect(calls[1].signal.aborted).toBe(false);
  });

  it('keeps one lingering request per endpoint, so another endpoint gets its own', async () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = pendingFetch();
    const jev = client(fetchImpl);

    const a = expect(jev.ask({}, ENDPOINT)).rejects.toMatchObject({ code: 'timeout' });
    const b = expect(jev.ask({}, { ...ENDPOINT, model: 'other' })).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(4000);
    await Promise.all([a, b]);
    expect(calls.map((call) => call.signal.aborted)).toEqual([false, false]);
  });

  it('reports an HTTP error before the timeout as it is', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => '' });
    await expect(client(fetchImpl).ask({}, ENDPOINT)).rejects.toMatchObject({ status: 401 });
  });
});

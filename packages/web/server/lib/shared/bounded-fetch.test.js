import { describe, expect, it, vi } from 'vitest';

import { combineAbortSignals, fetchWithDeadline } from './bounded-fetch.js';

// A fetch whose response never arrives; like a real fetch it rejects when
// the request signal aborts.
const stalledFetch = () =>
  vi.fn(
    async (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      }),
  );

describe('fetchWithDeadline', () => {
  it('rejects with a TimeoutError at the deadline', async () => {
    await expect(fetchWithDeadline(stalledFetch(), 'https://example.test', {}, { timeoutMs: 30 })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('rejects with the caller signal reason when the caller aborts first', async () => {
    const caller = new AbortController();
    const pending = fetchWithDeadline(stalledFetch(), 'https://example.test', {}, { timeoutMs: 60_000, signal: caller.signal });
    caller.abort(new Error('caller gave up'));
    await expect(pending).rejects.toThrow('caller gave up');
  });

  it('keeps the caller signal out of init: the composed signal replaces nothing', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'));
    const caller = new AbortController();
    await fetchWithDeadline(fetchImpl, 'https://example.test', { signal: undefined }, { timeoutMs: 1000, signal: caller.signal });
    const passed = fetchImpl.mock.calls[0][1].signal;
    expect(passed).toBeInstanceOf(AbortSignal);
    expect(passed).not.toBe(caller.signal);
  });

  it('headersOnly clears the deadline once headers arrive: the body stays readable', async () => {
    const fetchImpl = vi.fn(async () => new Response('body-text'));
    const response = await fetchWithDeadline(fetchImpl, 'https://example.test', {}, { timeoutMs: 30, headersOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(response.text()).resolves.toBe('body-text');
  });

  it('by default the deadline bounds the body read: a silent body settles at the deadline', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              // Headers arrived; the body never produces a byte.
            },
          }),
        ),
    );
    const response = await fetchWithDeadline(fetchImpl, 'https://example.test', {}, { timeoutMs: 30 });
    await expect(response.text()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('the body deadline still fires when the underlying cancellation never settles', async () => {
    // Regression (Codex P2 on PR #806): if reader.cancel() stays pending —
    // as it does for a cloned response whose other branch is still unread —
    // awaiting it before erroring the wrapped stream leaves response.text()
    // pending past the deadline.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              // Headers arrived; the body never produces a byte.
            },
            cancel() {
              return new Promise(() => {});
            },
          }),
        ),
    );
    const response = await fetchWithDeadline(fetchImpl, 'https://example.test', {}, { timeoutMs: 30 });
    await expect(response.text()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('returns an under-deadline body unchanged', async () => {
    const fetchImpl = vi.fn(async () => new Response('complete'));
    const response = await fetchWithDeadline(fetchImpl, 'https://example.test', {}, { timeoutMs: 1000 });
    await expect(response.text()).resolves.toBe('complete');
  });

  it('requires a positive timeoutMs', async () => {
    await expect(fetchWithDeadline(stalledFetch(), 'https://example.test', {}, {})).rejects.toThrow(TypeError);
  });
});

describe('combineAbortSignals', () => {
  // The helper mirrors AbortSignal.any where the runtime has it and
  // composes manually where it does not; the manual path is exercised by
  // hiding AbortSignal.any for the duration of one composition.
  const composeManually = (signals) => {
    const originalAny = AbortSignal.any;
    AbortSignal.any = undefined;
    try {
      return combineAbortSignals(signals);
    } finally {
      AbortSignal.any = originalAny;
    }
  };

  it('aborts the composed signal when any source aborts, with that source reason', () => {
    const first = new AbortController();
    const second = new AbortController();
    const { signal } = composeManually([first.signal, second.signal]);
    expect(signal.aborted).toBe(false);
    second.abort(new Error('second gave up'));
    expect(signal.aborted).toBe(true);
    expect(signal.reason?.message).toBe('second gave up');
  });

  it('is already aborted when a source was already aborted', () => {
    const source = new AbortController();
    source.abort(new Error('already over'));
    const { signal } = composeManually([new AbortController().signal, source.signal]);
    expect(signal.aborted).toBe(true);
    expect(signal.reason?.message).toBe('already over');
  });

  it('detach removes the forwarding listeners: a later source abort does not reach the composed signal', () => {
    const source = new AbortController();
    const { signal, detach } = composeManually([source.signal, new AbortController().signal]);
    detach();
    source.abort(new Error('too late'));
    expect(signal.aborted).toBe(false);
  });

  it('also composes through AbortSignal.any when the runtime provides it', () => {
    const source = new AbortController();
    const { signal } = combineAbortSignals([source.signal, new AbortController().signal]);
    source.abort(new Error('native path'));
    expect(signal.aborted).toBe(true);
    expect(signal.reason?.message).toBe('native path');
  });
});

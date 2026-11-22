import { describe, expect, it, vi } from 'vitest';

import { classifyGitLabFailure, fetchWithTimeout } from './network.js';

// fetchWithTimeout delegates to the shared fetchWithDeadline (design #802
// phase 2, #804). These tests pin the two contract changes that delegation
// brings: the caller's signal composes with the deadline, and the deadline
// stays armed until the body has been read.
describe('fetchWithTimeout', () => {
  it('keeps the redirect refusal and returns a readable body on success', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));

    const response = await fetchWithTimeout(fetchImpl, 'https://gitlab.example.com/api/v4/version', { headers: { Accept: 'application/json' } }, 1_000);

    expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('rejects at the deadline when the fetch never answers, classified unreachable', async () => {
    const fetchImpl = vi.fn((url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));

    const error = await fetchWithTimeout(fetchImpl, 'https://gitlab.example.com', {}, 50).catch((caught) => caught);

    expect(error).toMatchObject({ name: 'TimeoutError' });
    expect(classifyGitLabFailure(error)).toBe('unreachable');
  });

  it('takes effect when the caller signal aborts, instead of overwriting it', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));

    const pending = fetchWithTimeout(fetchImpl, 'https://gitlab.example.com', { signal: controller.signal }, 60_000);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejection;
  });

  it('keeps the deadline armed during the body read', async () => {
    const hangingBody = new ReadableStream({ pull: () => new Promise(() => {}) });
    const fetchImpl = vi.fn(async () => new Response(hangingBody, { status: 200 }));

    const response = await fetchWithTimeout(fetchImpl, 'https://gitlab.example.com', {}, 50);

    const startedAt = Date.now();
    await expect(response.text()).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

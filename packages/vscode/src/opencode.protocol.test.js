import { afterEach, describe, mock, test } from 'bun:test';
import assert from 'node:assert/strict';

mock.module('vscode', () => ({
  l10n: { t: (value) => value },
  window: { createOutputChannel: () => ({ appendLine: () => {} }) },
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('OpenCode protocol detection', () => {
  test('tries V2 with auth after a stalled legacy probe times out', async () => {
    const requested = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requested.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      if (url.endsWith('/global/health')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      return new Response(JSON.stringify({ healthy: true, version: '2.0.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const { waitForReady } = await import('./opencode');
    const result = await waitForReady('http://127.0.0.1:4096', 500, { Authorization: 'Basic external' }, { attemptTimeoutMs: 20 });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.protocol, 'opencode2');
    assert.deepEqual(requested, [
      { url: 'http://127.0.0.1:4096/global/health', authorization: 'Basic external' },
      { url: 'http://127.0.0.1:4096/api/health', authorization: 'Basic external' },
    ]);
  });

  test('tries V2 after the legacy probe fails', async () => {
    const requested = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/global/health')) throw new Error('legacy unavailable');
      return Response.json({ healthy: true });
    };

    const { waitForReady } = await import('./opencode');
    const result = await waitForReady('http://127.0.0.1:4096', 500);

    assert.equal(result.ok && result.protocol, 'opencode2');
    assert.deepEqual(requested, [
      'http://127.0.0.1:4096/global/health',
      'http://127.0.0.1:4096/api/health',
    ]);
  });

  test('outer abort stops protocol detection during a probe', async () => {
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });

    const { waitForReady } = await import('./opencode');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const startedAt = Date.now();
    const result = await waitForReady('http://127.0.0.1:4096', 1000, {}, { signal: controller.signal, attemptTimeoutMs: 500 });

    assert.equal(result.ok, false);
    assert.ok(Date.now() - startedAt < 250);
  });
});

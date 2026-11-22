import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { OPENCODE_DIAGNOSTICS_RESPONSE_MAX_BYTES } from './bounded-response-body';
import { fetchOpenCodeDiagnosticsProbe } from './opencode-diagnostics-runtime';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const streamBody = (totalBytes: number, state: { pulledBytes: number; cancelled: boolean }) => new ReadableStream<Uint8Array>({
  pull(controller) {
    if (state.pulledBytes >= totalBytes) { controller.close(); return; }
    const size = Math.min(64 * 1024, totalBytes - state.pulledBytes);
    controller.enqueue(new Uint8Array(size).fill(0x20));
    state.pulledBytes += size;
  },
  cancel() { state.cancelled = true; },
});

describe('OpenCode diagnostics probe response cap', () => {
  test('reports a failed probe and cancels a streamed response over 1 MiB', async () => {
    const state = { pulledBytes: 0, cancelled: false };
    globalThis.fetch = async () => new Response(streamBody(2 * OPENCODE_DIAGNOSTICS_RESPONSE_MAX_BYTES, state), {
      headers: { 'content-type': 'application/json' },
    });

    const result = await fetchOpenCodeDiagnosticsProbe('http://localhost/api/info', 1000, { Authorization: 'Bearer test' });

    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.match(result.summary, /exceeded the 1 MiB limit/);
    assert.equal(state.cancelled, true);
    assert.ok(state.pulledBytes < 2 * OPENCODE_DIAGNOSTICS_RESPONSE_MAX_BYTES);
  });

  test('accepts JSON at exactly 1 MiB and sends the OpenCode auth header', async () => {
    const prefix = JSON.stringify({ version: '2.0.32' });
    const body = prefix + ' '.repeat(OPENCODE_DIAGNOSTICS_RESPONSE_MAX_BYTES - Buffer.byteLength(prefix));
    let authorization: string | null = null;
    globalThis.fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization');
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    };

    const result = await fetchOpenCodeDiagnosticsProbe('http://localhost/api/info', 1000, { Authorization: 'Bearer test' });

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.summary, 'json[object] keys=version');
    assert.equal(authorization, 'Bearer test');
  });
});

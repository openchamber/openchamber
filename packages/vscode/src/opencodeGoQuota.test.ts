import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOpenCodeGoUsage } from './opencodeGoQuota';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const streamedResponse = (body: string, chunkCount: number) => {
  const bytes = new TextEncoder().encode(body);
  const chunkSize = Math.ceil(bytes.length / chunkCount);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/json' } });
};

describe('OpenCode Go quota', () => {
  it('parses an in-cap usage response', async () => {
    globalThis.fetch = async () =>
      Response.json({ usage: { rolling: { percent: 25, resetsAt: 1_893_456_000_000 } } });
    const usage = await fetchOpenCodeGoUsage({ apiKey: 'test-key', consoleKey: false });
    assert.equal(usage.windows['5h']?.usedPercent, 25);
  });

  it('fails an over-cap streamed usage response instead of parsing it whole', async () => {
    // A valid usage document padded past the cap with leading whitespace
    // (which JSON permits), streamed in 20 chunks with no content-length.
    // The document parses successfully if it is read whole, so this test
    // fails if the 1 MiB quota cap is removed — an invalid-JSON fixture
    // could not distinguish the cap failure from a parse failure.
    const padding = ' '.repeat(1_280 * 1024);
    const usage = JSON.stringify({ usage: { rolling: { percent: 25, resetsAt: 1_893_456_000_000 } } });
    globalThis.fetch = async () => streamedResponse(`${padding}${usage}`, 20);
    await assert.rejects(
      fetchOpenCodeGoUsage({ apiKey: 'test-key', consoleKey: false }),
      /could not be parsed/,
    );
  });
});

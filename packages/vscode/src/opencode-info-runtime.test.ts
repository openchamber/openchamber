import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { OPENCODE_INFO_RESPONSE_MAX_BYTES, ResponseBodyTooLargeError } from './bounded-response-body';
import { readOpenCodeInfoResponse } from './opencode-info-runtime';

const streamBody = (totalBytes: number, state: { pulledBytes: number; cancelled: boolean }) => new ReadableStream<Uint8Array>({
  pull(controller) {
    if (state.pulledBytes >= totalBytes) { controller.close(); return; }
    const size = Math.min(64 * 1024, totalBytes - state.pulledBytes);
    controller.enqueue(new Uint8Array(size).fill(0x20));
    state.pulledBytes += size;
  },
  cancel() { state.cancelled = true; },
});

describe('OpenCode /api/info response cap', () => {
  test('rejects and cancels a streamed response over 1 MiB', async () => {
    const state = { pulledBytes: 0, cancelled: false };
    const response = new Response(streamBody(2 * OPENCODE_INFO_RESPONSE_MAX_BYTES, state));

    await assert.rejects(readOpenCodeInfoResponse(response), ResponseBodyTooLargeError);
    assert.equal(state.cancelled, true);
    assert.ok(state.pulledBytes < 2 * OPENCODE_INFO_RESPONSE_MAX_BYTES);
  });

  test('parses a body at exactly 1 MiB', async () => {
    const prefix = JSON.stringify({ version: '2.0.32' });
    const body = prefix + ' '.repeat(OPENCODE_INFO_RESPONSE_MAX_BYTES - Buffer.byteLength(prefix));

    assert.deepEqual(await readOpenCodeInfoResponse(new Response(body)), { version: '2.0.32' });
  });
});

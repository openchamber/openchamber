import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { OPENCODE_SKILLS_RESPONSE_MAX_BYTES } from './bounded-response-body';
import { readOpenCodeSkillsPayload } from './opencode-skills-response';

const streamBody = (totalBytes: number, state: { pulledBytes: number; cancelled: boolean }) => new ReadableStream<Uint8Array>({
  pull(controller) {
    if (state.pulledBytes >= totalBytes) { controller.close(); return; }
    const size = Math.min(64 * 1024, totalBytes - state.pulledBytes);
    controller.enqueue(new Uint8Array(size).fill(0x20));
    state.pulledBytes += size;
  },
  cancel() { state.cancelled = true; },
});

describe('OpenCode skills response cap', () => {
  test('returns null and cancels a streamed response over 16 MiB', async () => {
    const state = { pulledBytes: 0, cancelled: false };
    const response = new Response(streamBody(OPENCODE_SKILLS_RESPONSE_MAX_BYTES + 1024 * 1024, state));

    assert.equal(await readOpenCodeSkillsPayload(response), null);
    assert.equal(state.cancelled, true);
    assert.ok(state.pulledBytes < OPENCODE_SKILLS_RESPONSE_MAX_BYTES + 1024 * 1024);
  });

  test('parses an exactly 16 MiB body and keeps the data envelope', async () => {
    const prefix = JSON.stringify({ data: [{ name: 'skill', content: 'text' }] });
    const body = prefix + ' '.repeat(OPENCODE_SKILLS_RESPONSE_MAX_BYTES - Buffer.byteLength(prefix));
    const payload = await readOpenCodeSkillsPayload(new Response(body));

    assert.equal(Buffer.byteLength(body), OPENCODE_SKILLS_RESPONSE_MAX_BYTES);
    assert.deepEqual(payload?.data, [{ name: 'skill', content: 'text' }]);
  });
});

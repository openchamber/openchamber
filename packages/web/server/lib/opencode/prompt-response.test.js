import { describe, expect, it } from 'vitest';

import { assertPromptResponse } from './prompt-response.js';

describe('assertPromptResponse', () => {
  it('includes a short error body in the thrown error', async () => {
    const response = new Response('upstream exploded', { status: 500 });

    await expect(assertPromptResponse(response, 'prompt')).rejects.toThrow(
      'prompt failed (500): upstream exploded',
    );
  });

  it('cuts an oversize streamed error body at the cap instead of buffering it whole', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024).fill(120);
    const stream = new ReadableStream({
      pull(controller) {
        pulled += 1;
        if (pulled > 32) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const response = new Response(stream, { status: 500 });

    let error;
    try {
      await assertPromptResponse(response, 'prompt');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('prompt failed (500)');
    expect(error.message.length).toBeLessThanOrEqual(200 + 'prompt failed (500): '.length);
    expect(pulled).toBeLessThan(32);
  });

  it('truncates a long error body to the excerpt instead of embedding it whole', async () => {
    const response = new Response('x'.repeat(500), { status: 502 });

    let error;
    try {
      await assertPromptResponse(response, 'prompt');
    } catch (caught) {
      error = caught;
    }

    expect(error.message.length).toBe('prompt failed (502): '.length + 200);
  });
});

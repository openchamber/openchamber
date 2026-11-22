import { describe, expect, test } from 'bun:test';
import { readBoundedResponseText } from './boundedResponse';

const encoder = new TextEncoder();

const streamedResponse = (chunks: string[], onPull?: () => void): Response => {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
};

describe('readBoundedResponseText', () => {
  test('a streamed over-cap body is rejected as soon as it crosses the cap, without being consumed whole', async () => {
    let pulls = 0;
    // Four 4-byte chunks, cap 8: the third chunk crosses the cap, so the
    // fourth chunk must never be pulled from the stream.
    const response = streamedResponse(['aaaa', 'bbbb', 'cccc', 'dddd'], () => {
      pulls += 1;
    });

    await expect(readBoundedResponseText(response, 8)).rejects.toThrow('exceeded size limit');
    expect(pulls).toBe(3);
  });

  test('a body exactly at the cap is returned whole', async () => {
    const response = streamedResponse(['aaaa', 'bbbb']);
    expect(await readBoundedResponseText(response, 8)).toBe('aaaabbbb');
  });

  test('a declared content-length over the cap is rejected without reading the body', async () => {
    let pulls = 0;
    const body = streamedResponse(['aaaa'], () => {
      pulls += 1;
    });
    const response = new Response(body.body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Content-Length': '100' },
    });

    await expect(readBoundedResponseText(response, 8)).rejects.toThrow('exceeded size limit');
    expect(pulls).toBe(0);
  });

  test('a representative JSON body parses the same after the bounded read', async () => {
    const payload = JSON.stringify({ gitmojis: [{ emoji: 'x', code: ':x:', description: 'X.' }] });
    const response = streamedResponse([payload.slice(0, 10), payload.slice(10)]);
    const text = await readBoundedResponseText(response, 1024);
    expect(JSON.parse(text)).toEqual(JSON.parse(payload));
  });
});

import { Readable } from 'node:stream';
import { TransformStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

describe('relay native stream contracts', () => {
  it('passes a native response body through Readable.fromWeb', async () => {
    const response = new Response('relay response');
    if (!response.body) throw new Error('Expected a response body');
    const stream: NodeReadableStream<Uint8Array<ArrayBuffer>> = response.body;
    const chunks: Buffer[] = [];
    for await (const chunk of Readable.fromWeb(stream)) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('relay response');
  });

  it('uses Node readers and transforms on server-native streams', async () => {
    const stream = new ReadableStream<Uint8Array>({
      type: 'bytes',
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const reader = stream.getReader({ mode: 'byob' });
    expect((await reader.read(new Uint8Array(3))).value).toEqual(new Uint8Array([1, 2, 3]));
    reader.releaseLock();
    const transformed: NodeReadableStream<Uint8Array> = stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>());
    expect((await transformed.getReader().read()).done).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import { readBoundedResponseBytes, readBoundedResponseJson, readBoundedResponseText } from './response-body.js';

const streamOf = (chunks, { declaredLength } = {}) => {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const headers = new Headers();
  if (declaredLength !== undefined) headers.set('content-length', String(declaredLength));
  return new Response(stream, { headers });
};

describe('shared bounded response readers', () => {
  it('returns a complete body under the cap unchanged', async () => {
    await expect(readBoundedResponseText(streamOf(['hello ', 'world']), 100)).resolves.toEqual({
      tooLarge: false,
      text: 'hello world',
    });
    const bytes = await readBoundedResponseBytes(streamOf(['abc']), 100);
    expect(bytes.tooLarge).toBe(false);
    expect(bytes.bytes.toString('utf8')).toBe('abc');
  });

  it('refuses on the declared length before reading', async () => {
    let pulls = 0;
    const stream = new ReadableStream({
      pull() {
        pulls += 1;
      },
    });
    const response = new Response(stream, { headers: { 'content-length': '101' } });
    await expect(readBoundedResponseText(response, 100)).resolves.toEqual({ tooLarge: true });
    expect(pulls).toBe(0);
  });

  it('cancels mid-stream the moment the cap is crossed', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('123456'));
        controller.enqueue(new TextEncoder().encode('78901'));
        // Never closed: only the reader cancelling can end this body.
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readBoundedResponseText(new Response(stream), 10)).resolves.toEqual({ tooLarge: true });
    expect(cancelled).toBe(true);
  });

  it('parses a JSON envelope at the exact byte cap and strips a UTF-8 BOM like response.json()', async () => {
    const text = '{"data":[{"id":"msg_1"}],"cursor":{"next":"page_2"}}';
    await expect(readBoundedResponseJson(streamOf([text]), Buffer.byteLength(text))).resolves.toEqual(JSON.parse(text));
    await expect(readBoundedResponseJson(streamOf(['\uFEFF{"data":[]}']), 100)).resolves.toEqual({ data: [] });
  });

  it('returns null and cancels a streamed JSON body as soon as it crosses the cap', async () => {
    let cancelled = false;
    let ended = false;
    let chunks = 0;
    const stream = new ReadableStream({
      pull(controller) {
        chunks += 1;
        if (chunks === 1) controller.enqueue(new TextEncoder().encode('{"data":"12345'));
        else if (chunks === 2) controller.enqueue(new TextEncoder().encode('67890'));
        else {
          ended = true;
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readBoundedResponseJson(new Response(stream), 12)).resolves.toBeNull();
    expect(cancelled).toBe(true);
    expect(ended).toBe(false);
  });
});

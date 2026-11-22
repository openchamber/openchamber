import { describe, expect, it } from 'vitest';

import { QUOTA_RESPONSE_MAX_BYTES, readQuotaBytes, readQuotaJson } from './response-body.js';

const jsonResponse = (value) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

// A chunked body with no Content-Length: only a streaming cap can stop it
// before it is buffered whole.
const streamedResponse = (text, onPull) => {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const chunk = bytes.subarray(offset, offset + 8192);
      offset += chunk.byteLength;
      if (onPull) onPull(offset);
      controller.enqueue(chunk);
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
};

describe('readQuotaJson (#1282)', () => {
  it('parses an in-cap JSON body', async () => {
    await expect(readQuotaJson(jsonResponse({ ok: true }))).resolves.toEqual({ ok: true });
  });

  it('parses an at-cap JSON body', async () => {
    const skeleton = JSON.stringify({ pad: '' });
    const body = { pad: 'x'.repeat(QUOTA_RESPONSE_MAX_BYTES - skeleton.length) };
    await expect(readQuotaJson(jsonResponse(body))).resolves.toEqual(body);
  });

  it('throws a SyntaxError for a malformed body, as response.json() did', async () => {
    await expect(readQuotaJson(new Response('not json'))).rejects.toBeInstanceOf(SyntaxError);
  });

  it('refuses a declared over-cap body', async () => {
    const body = JSON.stringify({ pad: 'x'.repeat(QUOTA_RESPONSE_MAX_BYTES) });
    await expect(readQuotaJson(jsonResponse(body))).rejects.toThrow(/Quota response exceeded/);
  });

  it('refuses a streamed over-cap body without buffering it whole', async () => {
    const body = JSON.stringify({ pad: 'x'.repeat(QUOTA_RESPONSE_MAX_BYTES * 2) });
    let pulled = 0;
    await expect(readQuotaJson(streamedResponse(body, (offset) => { pulled = offset; })))
      .rejects.toThrow(/Quota response exceeded/);
    expect(pulled).toBeLessThan(body.length);
  });

  it('keeps the plain test-double fallback (no body) working', async () => {
    await expect(readQuotaJson({ json: async () => ({ via: 'double' }) })).resolves.toEqual({ via: 'double' });
  });
});

describe('readQuotaBytes (#1282)', () => {
  it('returns an in-cap binary body', async () => {
    const bytes = await readQuotaBytes(new Response(new Uint8Array([1, 2, 3])));
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it('refuses an over-cap binary body', async () => {
    const body = new Uint8Array(QUOTA_RESPONSE_MAX_BYTES + 1);
    await expect(readQuotaBytes(new Response(body))).rejects.toThrow(/Quota response exceeded/);
  });
});

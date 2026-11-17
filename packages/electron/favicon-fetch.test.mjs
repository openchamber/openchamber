import assert from 'node:assert/strict';
import test from 'node:test';

import { FAVICON_FETCH_TIMEOUT_MS, fetchFaviconDataUrl } from './favicon-fetch.mjs';

const MIME_TYPES = new Set(['image/png', 'image/x-icon']);
const MAX_BYTES = 16;

const fetchArgs = (fetchImpl, overrides = {}) => ({
  fetchImpl,
  url: 'https://example.com/favicon.png',
  session: undefined,
  maxBytes: MAX_BYTES,
  mimeTypes: MIME_TYPES,
  timeoutMs: 50,
  ...overrides,
});

const pngResponse = (body, headers = {}) => new Response(body, {
  status: 200,
  headers: { 'content-type': 'image/png', ...headers },
});

test('exports a default deadline consistent with sibling Electron fetches', () => {
  assert.equal(FAVICON_FETCH_TIMEOUT_MS, 10_000);
});

test('returns a data URL for a conforming icon', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const result = await fetchFaviconDataUrl(fetchArgs(async () => pngResponse(bytes)));
  assert.equal(result.dataUrl, `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
});

test('a host that never answers settles with a timeout instead of hanging', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  await assert.rejects(fetchFaviconDataUrl(fetchArgs(fetchImpl)), /Favicon request timed out/);
});

test('a body that stalls mid-stream settles with a timeout instead of hanging', async () => {
  const stalledBody = new ReadableStream({
    pull() {
      // Never enqueue and never close: the read stays pending until the
      // deadline aborts it.
      return new Promise(() => {});
    },
  });
  const fetchImpl = async () => new Response(stalledBody, {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
  await assert.rejects(fetchFaviconDataUrl(fetchArgs(fetchImpl)), /Favicon request timed out/);
});

test('a declared content-length above the cap is rejected before the body is read', async () => {
  let pulls = 0;
  let cancelled = false;
  let requestSignal;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(8));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetchImpl = async (_url, { signal }) => {
    requestSignal = signal;
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(MAX_BYTES + 1) },
    });
  };
  await assert.rejects(fetchFaviconDataUrl(fetchArgs(fetchImpl)), /Favicon is not a usable size/);
  // The Response constructor itself performs one stream pull to prime its
  // internal queue; the handler must add none of its own before rejecting.
  assert.ok(pulls <= 1, "expected no body read before rejection");
  // The rejection must release the network resources: abort the request and
  // cancel the body, so a host stalling after its headers cannot hold the
  // connection open once the deadline timer is cleared.
  assert.equal(requestSignal.aborted, true);
  assert.equal(cancelled, true);
});

test('status and MIME rejections abort the request and cancel the body', async () => {
  const cases = [
    { responseInit: { status: 404, headers: { 'content-type': 'image/png' } }, error: /Favicon request failed \(404\)/ },
    { responseInit: { status: 200, headers: { 'content-type': 'text/html' } }, error: /Favicon is not an image/ },
  ];
  for (const { responseInit, error } of cases) {
    let cancelled = false;
    let requestSignal;
    const body = new ReadableStream({
      pull() {
        // Stall after the headers: only the rejection's abort/cancel can
        // release this connection.
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = async (_url, { signal }) => {
      requestSignal = signal;
      return new Response(body, responseInit);
    };
    await assert.rejects(fetchFaviconDataUrl(fetchArgs(fetchImpl)), error);
    assert.equal(requestSignal.aborted, true);
    assert.equal(cancelled, true);
  }
});

test('an oversized streamed body is rejected after the cap, not buffered whole', async () => {
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls <= 10) controller.enqueue(new Uint8Array(8));
      else controller.close();
    },
  });
  const fetchImpl = async () => new Response(body, {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
  await assert.rejects(fetchFaviconDataUrl(fetchArgs(fetchImpl)), /Favicon is not a usable size/);
  // 16-byte cap with 8-byte chunks: the third chunk crosses the cap and the
  // stream is cancelled, so most of the ten offered chunks are never pulled.
  assert.ok(pulls <= 4, `expected the read to stop at the cap, pulled ${pulls} chunks`);
});

test('empty bodies and non-image responses keep the existing errors', async () => {
  await assert.rejects(
    fetchFaviconDataUrl(fetchArgs(async () => pngResponse(new Uint8Array(0)))),
    /Favicon is not a usable size/,
  );
  await assert.rejects(
    fetchFaviconDataUrl(fetchArgs(async () => new Response('<html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }))),
    /Favicon is not an image/,
  );
  await assert.rejects(
    fetchFaviconDataUrl(fetchArgs(async () => new Response('nope', { status: 404 }))),
    /Favicon request failed \(404\)/,
  );
});

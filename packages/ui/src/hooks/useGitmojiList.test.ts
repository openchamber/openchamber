import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { fetchGitmojiList, GITMOJI_CATALOG_MAX_BYTES, GITMOJI_FETCH_TIMEOUT_MS } from './useGitmojiList';

const ENTRY = { emoji: '✨', code: ':sparkles:', description: 'Introduce new features.' };

let originalFetch: typeof globalThis.fetch;
let originalWarn: typeof console.warn;

beforeEach(() => {
  jest.useFakeTimers();
  originalFetch = globalThis.fetch;
  originalWarn = console.warn;
  console.warn = () => {};
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});

const successFetch = async (): Promise<Response> => new Response(JSON.stringify({ gitmojis: [ENTRY] }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

test('a stalled catalog fetch settles via the failure path at the deadline and a later call re-fetches', async () => {
  let fetchCalls = 0;
  const signals: Array<AbortSignal | null | undefined> = [];
  const stalledFetch = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    fetchCalls += 1;
    signals.push(init?.signal);
    // A request that never answers, but like a real fetch it rejects when
    // its signal aborts.
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason));
    });
  };
  globalThis.fetch = Object.assign(stalledFetch, originalFetch);

  const first = fetchGitmojiList();
  const second = fetchGitmojiList();
  expect(fetchCalls).toBe(1);
  expect(signals[0]).toBeInstanceOf(AbortSignal);

  jest.advanceTimersByTime(GITMOJI_FETCH_TIMEOUT_MS);
  expect(await first).toEqual([]);
  expect(await second).toEqual([]);

  globalThis.fetch = Object.assign(successFetch, originalFetch);
  expect(await fetchGitmojiList()).toEqual([ENTRY]);
  expect(fetchCalls).toBe(1);
});

test('a stalled body read also settles via the failure path at the deadline', async () => {
  let fetchCalls = 0;
  const stalledBodyFetch = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    fetchCalls += 1;
    // Headers arrive at once; the body stream never produces a byte and
    // errors when the fetch signal aborts, as a real response body does.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) {
          controller.error(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => controller.error(signal.reason));
      },
    });
    return Promise.resolve(new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  };
  globalThis.fetch = Object.assign(stalledBodyFetch, originalFetch);

  const pending = fetchGitmojiList();
  // Let the loader reach the body read (and attach to the signal) first.
  await Promise.resolve();
  await Promise.resolve();
  jest.advanceTimersByTime(GITMOJI_FETCH_TIMEOUT_MS);
  expect(await pending).toEqual([]);
  expect(fetchCalls).toBe(1);

  globalThis.fetch = Object.assign(successFetch, originalFetch);
  expect(await fetchGitmojiList()).toEqual([ENTRY]);
});

test('a streamed over-cap catalog body falls back to the empty list without being consumed whole', async () => {
  let pulls = 0;
  const chunk = 'x'.repeat(512 * 1024);
  // Five chunks of 512 KiB against a 1 MiB cap: the third chunk crosses
  // the cap, so chunks four and five must never be pulled.
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls > 5) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(chunk));
    },
  });
  expect(GITMOJI_CATALOG_MAX_BYTES).toBe(1024 * 1024);
  globalThis.fetch = Object.assign(async () => new Response(stream, { status: 200 }), originalFetch);

  expect(await fetchGitmojiList()).toEqual([]);
  // The Response wrapper may prefetch one chunk ahead of the reader, but
  // the fifth chunk is never pulled: the body is not consumed whole.
  expect(pulls).toBeLessThan(5);
});

test('a representative streamed catalog body parses and returns its entries', async () => {
  const payload = JSON.stringify({ gitmojis: [ENTRY] });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload.slice(0, 8)));
      controller.enqueue(new TextEncoder().encode(payload.slice(8)));
      controller.close();
    },
  });
  globalThis.fetch = Object.assign(async () => new Response(stream, { status: 200 }), originalFetch);

  expect(await fetchGitmojiList()).toEqual([ENTRY]);
});

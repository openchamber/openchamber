import { beforeEach, describe, expect, test } from 'bun:test';
import { directoryEnvironment } from './test-support/directoryEnvironment';
import { getRuntimeKey } from '@/lib/runtime-switch';

const environment = directoryEnvironment();

let responses: Array<{ status: number; body: unknown } | Promise<Response>> = [];
let calls: string[] = [];

environment.respond(async (url) => {
  if (url.pathname !== '/api/small-model') throw new Error(`Unexpected request: ${url}`);
  calls.push(`${url.pathname}${url.search}`);
  const next = responses.shift() ?? { status: 200, body: { available: true } };
  if (next instanceof Promise) return next;
  return Response.json(next.body, { status: next.status });
});

const { useSmallModelStore, selectSmallModelAvailability } = await import('./useSmallModelStore');

const deferredResponse = (body: unknown, status = 200) => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return {
    promise,
    resolve: () =>
      resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
  };
};

describe('useSmallModelStore', () => {
  beforeEach(() => {
    responses = [];
    calls = [];
    useSmallModelStore.getState().invalidate();
  });

  test('is unknown until fetched, then reports the server answer per directory', async () => {
    expect(selectSmallModelAvailability(useSmallModelStore.getState(), '/p')).toBe('unknown');
    responses = [{ status: 200, body: { available: false } }];
    await useSmallModelStore.getState().ensureFresh('/p');
    expect(selectSmallModelAvailability(useSmallModelStore.getState(), '/p')).toBe('unavailable');
    expect(selectSmallModelAvailability(useSmallModelStore.getState(), '/q')).toBe('unknown');
    expect(calls).toEqual(['/api/small-model?directory=%2Fp']);
  });

  test('a fresh answer is not fetched again, and concurrent callers share one request', async () => {
    responses = [{ status: 200, body: { available: true } }];
    await Promise.all([
      useSmallModelStore.getState().ensureFresh('/p'),
      useSmallModelStore.getState().ensureFresh('/p'),
    ]);
    await useSmallModelStore.getState().ensureFresh('/p');
    expect(calls).toHaveLength(1);
  });

  test('a failed or malformed answer keeps what was known', async () => {
    responses = [{ status: 200, body: { available: true } }];
    await useSmallModelStore.getState().ensureFresh('/p');
    useSmallModelStore.setState((state) => ({
      byKey: { ...state.byKey, [`${getRuntimeKey()}::/p`]: { availability: 'available', fetchedAt: 0 } },
    }));
    responses = [{ status: 500, body: { error: 'down' } }];
    await useSmallModelStore.getState().ensureFresh('/p');
    expect(selectSmallModelAvailability(useSmallModelStore.getState(), '/p')).toBe('available');
    responses = [{ status: 200, body: { available: 'yes' } }];
    await useSmallModelStore.getState().ensureFresh('/p');
    expect(selectSmallModelAvailability(useSmallModelStore.getState(), '/p')).toBe('available');
  });

  test('invalidate forgets every answer so the next reader fetches again', async () => {
    responses = [{ status: 200, body: { available: false } }];
    await useSmallModelStore.getState().ensureFresh('/p');
    useSmallModelStore.getState().invalidate();
    expect(selectSmallModelAvailability(useSmallModelStore.getState(), '/p')).toBe('unknown');
    responses = [{ status: 200, body: { available: true } }];
    await useSmallModelStore.getState().ensureFresh('/p');
    expect(selectSmallModelAvailability(useSmallModelStore.getState(), '/p')).toBe('available');
    expect(calls).toHaveLength(2);
  });

  test('a response that lands after invalidation cannot overwrite the fresh answer', async () => {
    const stale = deferredResponse({ available: false });
    responses = [stale.promise];
    const requestA = useSmallModelStore.getState().ensureFresh('/p');
    useSmallModelStore.getState().invalidate();
    const fresh = deferredResponse({ available: true });
    responses = [fresh.promise];
    const requestB = useSmallModelStore.getState().ensureFresh('/p');
    fresh.resolve();
    await requestB;
    expect(selectSmallModelAvailability(useSmallModelStore.getState(), '/p')).toBe('available');
    stale.resolve();
    await requestA;
    expect(selectSmallModelAvailability(useSmallModelStore.getState(), '/p')).toBe('available');
    expect(calls).toHaveLength(2);
  });

  test('a stale request finishing cannot evict a newer in-flight request', async () => {
    const stale = deferredResponse({ error: 'down' }, 500);
    responses = [stale.promise];
    const requestA = useSmallModelStore.getState().ensureFresh('/p');
    useSmallModelStore.getState().invalidate();
    const fresh = deferredResponse({ available: true });
    responses = [fresh.promise];
    const requestB = useSmallModelStore.getState().ensureFresh('/p');
    stale.resolve();
    await requestA;
    // B is still in flight; another reader must coalesce onto it, not fetch.
    void useSmallModelStore.getState().ensureFresh('/p');
    expect(calls).toHaveLength(2);
    fresh.resolve();
    await requestB;
    expect(selectSmallModelAvailability(useSmallModelStore.getState(), '/p')).toBe('available');
  });
});

import { beforeEach, describe, expect, mock, test } from 'bun:test';

let responses: Array<{ status: number; body: unknown }> = [];
let calls: string[] = [];

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (url: string) => {
    calls.push(url);
    const next = responses.shift() ?? { status: 200, body: { available: true } };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  },
}));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => 'runtime-a',
  subscribeRuntimeEndpointChanged: () => () => {},
}));
mock.module('@/lib/configSync', () => ({
  subscribeToConfigChanges: () => () => {},
}));

const { useSmallModelStore, selectSmallModelAvailability } = await import('./useSmallModelStore');

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
      byKey: { ...state.byKey, 'runtime-a::/p': { availability: 'available', fetchedAt: 0 } },
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
});

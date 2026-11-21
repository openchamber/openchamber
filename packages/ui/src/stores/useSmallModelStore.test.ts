import { beforeEach, describe, expect, test } from 'bun:test';
import { directoryEnvironment } from './test-support/directoryEnvironment';
import { getRuntimeKey } from '@/lib/runtime-switch';

const environment = directoryEnvironment();

let responses: Array<{ status: number; body: unknown }> = [];
let calls: string[] = [];

environment.respond(async (url) => {
  if (url.pathname !== '/api/small-model') throw new Error(`Unexpected request: ${url}`);
  calls.push(`${url.pathname}${url.search}`);
  const next = responses.shift() ?? { status: 200, body: { available: true } };
  return Response.json(next.body, { status: next.status });
});

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
});

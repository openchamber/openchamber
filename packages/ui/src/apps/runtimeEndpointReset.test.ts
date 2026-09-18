import { afterEach, describe, expect, test } from 'bun:test';
import {
  getSessionFailureKey,
  recordSessionFailure,
  resetSessionFailureStore,
  useSessionFailureStore,
} from '@/sync/session-failure-store';
import { resetAppForRuntimeEndpointChange } from './runtimeEndpointReset';

describe('runtime endpoint reset', () => {
  afterEach(() => {
    resetSessionFailureStore();
  });

  test('clears failures from the previous runtime', () => {
    recordSessionFailure({
      directory: '/repo',
      sessionId: 'ses_child',
      name: 'ProviderError',
      message: 'provider unavailable',
    });

    resetAppForRuntimeEndpointChange({
      apiBaseUrl: 'https://runtime-b.example',
      previousApiBaseUrl: 'https://runtime-a.example',
      runtimeKey: 'runtime-b',
      previousRuntimeKey: 'runtime-a',
    });

    expect(useSessionFailureStore.getState().failures.has(getSessionFailureKey('/repo', 'ses_child'))).toBe(false);
  });
});

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  clearSessionFailure,
  getSessionFailureKey,
  recordSessionFailure,
  resetSessionFailureStore,
  useSessionFailureStore,
} from './session-failure-store';

describe('session failure store', () => {
  beforeEach(() => {
    resetSessionFailureStore();
  });

  test('keeps a terminal failure scoped to its directory and clears it for a new attempt', () => {
    recordSessionFailure({
      directory: '/repo',
      sessionId: 'ses_child',
      name: 'ProviderError',
      message: 'provider unavailable',
    });

    const failures = useSessionFailureStore.getState().failures;
    expect(failures.get(getSessionFailureKey('/repo', 'ses_child'))?.message).toBe('provider unavailable');
    expect(failures.has(getSessionFailureKey('/other-repo', 'ses_child'))).toBe(false);

    clearSessionFailure('/repo', 'ses_child');
    expect(useSessionFailureStore.getState().failures.has(getSessionFailureKey('/repo', 'ses_child'))).toBe(false);
  });

  test('clears failures from every directory when the runtime changes', () => {
    recordSessionFailure({
      directory: '/repo',
      sessionId: 'ses_child',
      name: 'ProviderError',
      message: 'provider unavailable',
    });
    recordSessionFailure({
      directory: '/other-repo',
      sessionId: 'ses_other',
      name: 'ProviderError',
      message: 'other provider unavailable',
    });

    resetSessionFailureStore();

    expect(useSessionFailureStore.getState().failures.size).toBe(0);
  });
});

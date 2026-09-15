import { beforeEach, describe, expect, test } from 'bun:test';
import {
  clearSessionFailure,
  getSessionFailureKey,
  recordSessionFailure,
  useSessionFailureStore,
} from './session-failure-store';

describe('session failure store', () => {
  beforeEach(() => {
    useSessionFailureStore.setState({ failures: new Map() });
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
});

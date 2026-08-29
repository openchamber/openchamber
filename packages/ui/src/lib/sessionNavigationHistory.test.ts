import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { navigateSessionHistory } from './sessionNavigationHistory';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

// SAFETY: the history module only reads a session's id and directory metadata.
const session = (id: string): Session => ({
  id,
  title: id,
  directory: '/repo',
  projectID: 'p1',
  version: '1',
  time: { created: 1, updated: 1 },
} as Session);

describe('sessionNavigationHistory', () => {
  test('steps back and forward through the visit order', () => {
    useGlobalSessionsStore.setState({ activeSessions: [session('s1'), session('s2'), session('s3')] });

    useSessionUIStore.setState({ currentSessionId: 's1' });
    useSessionUIStore.setState({ currentSessionId: 's2' });
    useSessionUIStore.setState({ currentSessionId: 's3' });

    expect(navigateSessionHistory(-1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('s2');
    expect(navigateSessionHistory(-1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('s1');
    expect(navigateSessionHistory(-1)).toBe(false);

    expect(navigateSessionHistory(1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('s2');
  });

  test('a fresh visit truncates the forward branch', () => {
    // Continues from the previous test's state: at s2 with s3 forward.
    useSessionUIStore.setState({ currentSessionId: 's1' });
    expect(navigateSessionHistory(1)).toBe(false);
    expect(navigateSessionHistory(-1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('s2');
  });

  test('skips and drops entries whose session no longer exists', () => {
    useSessionUIStore.setState({ currentSessionId: 's3' });
    useGlobalSessionsStore.setState({ activeSessions: [session('s1'), session('s3')] });
    // History behind s3 contains s2 (dead) then s1 (alive).
    expect(navigateSessionHistory(-1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('s1');
  });
});

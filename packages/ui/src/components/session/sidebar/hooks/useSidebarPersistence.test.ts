import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { prunePinnedSessionIds } from './pinnedSessionCleanup';
import { getPinnedSessionKey } from '@/stores/useSessionPinnedStore';

const makeSession = (id: string): Session => ({ id, directory: '/repo' }) as Session;
const pin = (id: string, runtimeKey = 'runtime-a') => getPinnedSessionKey(runtimeKey, '/repo', id)!;

describe('prunePinnedSessionIds', () => {
  test('keeps pinned ids that still exist in the authoritative session list', () => {
    const sessions = [makeSession('visible-session'), makeSession('hidden-session')];
    const pinnedSessionIds = new Set([pin('hidden-session'), pin('missing-session'), pin('other-runtime', 'runtime-b')]);

    const next = prunePinnedSessionIds('runtime-a', sessions, pinnedSessionIds);

    expect([...next]).toEqual([pin('hidden-session'), pin('other-runtime', 'runtime-b')]);
    expect(next).not.toBe(pinnedSessionIds);
  });

  test('returns the original set when nothing needs pruning', () => {
    const sessions = [makeSession('visible-session'), makeSession('hidden-session')];
    const pinnedSessionIds = new Set([pin('visible-session'), pin('hidden-session')]);

    const next = prunePinnedSessionIds('runtime-a', sessions, pinnedSessionIds);

    expect(next).toBe(pinnedSessionIds);
  });

  test('discards malformed pinned keys', () => {
    const validPin = pin('visible-session');
    const pinnedSessionIds = new Set([validPin, 'legacy-session-id', JSON.stringify(['', '/repo', 'session-1'])]);

    const next = prunePinnedSessionIds('runtime-a', [makeSession('visible-session')], pinnedSessionIds);

    expect([...next]).toEqual([validPin]);
  });
});

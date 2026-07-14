import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { prunePinnedSessionIds } from './pinnedSessionCleanup';

const makeSession = (id: string): Pick<Session, 'id'> => ({ id });

describe('prunePinnedSessionIds', () => {
  test('keeps pinned ids that still exist in the authoritative session list', () => {
    const sessions = [makeSession('visible-session'), makeSession('hidden-session')];
    const pinnedSessionIds = new Set(['hidden-session', 'missing-session']);

    const next = prunePinnedSessionIds(sessions, pinnedSessionIds);

    expect([...next]).toEqual(['hidden-session']);
    expect(next).not.toBe(pinnedSessionIds);
  });

  test('returns the original set when nothing needs pruning', () => {
    const sessions = [makeSession('visible-session'), makeSession('hidden-session')];
    const pinnedSessionIds = new Set(['visible-session', 'hidden-session']);

    const next = prunePinnedSessionIds(sessions, pinnedSessionIds);

    expect(next).toBe(pinnedSessionIds);
  });
});

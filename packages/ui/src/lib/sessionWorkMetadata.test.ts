import { describe, expect, test } from 'bun:test';
import type { Metadata, Session } from '@/lib/opencode/model';
import { getSessionWork, isDoneSuggested, isSessionInWork, withSessionWorkState } from './sessionWorkMetadata';

// SAFETY: fixture carries the identity fields and what the work helpers read.
const session = (metadata: Metadata, idle = 100): Session => ({
  id: 'ses_1',
  projectID: 'prj',
  directory: '/repo',
  title: 't',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 200, idle },
  metadata,
} as Session);

describe('session work metadata', () => {
  test('reads membership from the stored state, and anything else as not in work', () => {
    expect(isSessionInWork(session({ openchamber: { work: { state: 'open' } } }))).toBe(true);
    expect(isSessionInWork(session({ openchamber: { work: { state: 'done' } } }))).toBe(false);
    expect(isSessionInWork(session({ openchamber: { goal: { id: 'g' } } }))).toBe(false);
    expect(isSessionInWork(session({}))).toBe(false);
    expect(isSessionInWork(null)).toBe(false);
  });

  test('shows the done hint only while it was written after the last turn ended', () => {
    expect(isDoneSuggested(session({ openchamber: { work: { state: 'open', suggestDoneAt: 150 } } }, 100))).toBe(true);
    expect(isDoneSuggested(session({ openchamber: { work: { state: 'open', suggestDoneAt: 150 } } }, 300))).toBe(false);
    expect(isDoneSuggested(session({ openchamber: { work: { state: 'done', suggestDoneAt: 150 } } }, 100))).toBe(false);
    expect(isDoneSuggested(session({ openchamber: { work: { state: 'open' } } }))).toBe(false);
  });

  test('the user tracks and closes; closing keeps when and by whom it opened and drops the hint', () => {
    const base: Metadata = { openchamber: { goal: { id: 'g' } } };
    const tracked = withSessionWorkState(base, 'open', 10);
    expect(tracked).toEqual({ openchamber: { goal: { id: 'g' }, work: { state: 'open', openedAt: 10, openedBy: 'user' } } });

    const hinted: Metadata = { openchamber: { work: { state: 'open', openedAt: 5, openedBy: 'jev', suggestDoneAt: 8 } } };
    const closed = withSessionWorkState(hinted, 'done', 20);
    expect(getSessionWork(session(closed))).toEqual({ state: 'done', doneAt: 20, openedAt: 5, openedBy: 'jev' });

    // Asking for the state it already has changes nothing.
    expect(withSessionWorkState(closed, 'done', 30)).toBe(closed);
  });
});

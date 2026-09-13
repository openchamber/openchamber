import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { selectRecentMobileSessions } from './mobileRecentSessions';

const NOW = 200_000_000;
const RECENT = NOW - (48 * 60 * 60 * 1000);
const OLD = NOW - (72 * 60 * 60 * 1000);

const session = (id: string, options: { parentID?: string; archived?: number; updated?: number } = {}): Session => ({
  id,
  parentID: options.parentID,
  time: { created: OLD, updated: options.updated ?? OLD, archived: options.archived },
} as Session);

const ids = (sessions: Session[]) => sessions.map((entry) => entry.id).sort();

describe('selectRecentMobileSessions', () => {
  test('keeps sessions inside the window and drops expired, archived, and subtask entries', () => {
    const inside = session('inside', { updated: RECENT });
    const expired = session('expired');
    const archived = session('archived', { archived: NOW - 1, updated: RECENT });
    const child = session('child', { parentID: 'parent', updated: RECENT });

    expect(ids(selectRecentMobileSessions(
      [inside, expired, archived, child],
      new Set(),
      new Set(),
      new Map(),
      NOW,
    ))).toEqual(['inside']);
  });

  test('promotes a live session regardless of its timestamp', () => {
    const live = session('live');

    expect(ids(selectRecentMobileSessions([live], new Set([live.id]), new Set(), new Map(), NOW))).toEqual(['live']);
  });

  test('returns an empty list for an empty collection', () => {
    expect(selectRecentMobileSessions([], new Set(), new Set(), new Map(), NOW)).toEqual([]);
  });
});
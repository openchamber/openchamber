import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { sessionHasSidebarRow } from './sidebarSessionRows';

const session: Session = {
  id: 'row', title: 'Row', directory: '/repo', projectID: 'project', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  metadata: { openchamber: { work: { state: 'open' } } },
};

describe('sidebar row admission and section visibility', () => {
  test('placement, pins and work never admit an untrusted destination', () => {
    expect(sessionHasSidebarRow(session, {
      isAdmitted: false, isPlaced: true, isPinned: true, zones: { pinned: true, work: true },
    })).toBe(false);
  });

  test('an admitted placed session remains visible with both zones hidden', () => {
    expect(sessionHasSidebarRow(session, {
      isAdmitted: true, isPlaced: true, isPinned: false, zones: { pinned: false, work: false },
    })).toBe(true);
  });

  test('admitted unplaced sessions follow their pin and work zones', () => {
    const base = { isAdmitted: true, isPlaced: false, isPinned: true };
    expect(sessionHasSidebarRow(session, { ...base, zones: { pinned: false, work: false } })).toBe(false);
    expect(sessionHasSidebarRow(session, { ...base, zones: { pinned: true, work: false } })).toBe(true);
    expect(sessionHasSidebarRow(session, { ...base, zones: { pinned: false, work: true } })).toBe(true);
  });
});

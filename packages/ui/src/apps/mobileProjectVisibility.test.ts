import { describe, expect, test } from 'bun:test';

import type { Session } from '@/lib/opencode/model';

import {
  filterSessionsForAllSessions,
  filterSessionsForWorkZone,
  isSessionHiddenFromAllSessions,
  isSessionHiddenFromWork,
  projectVisibilitySets,
} from './mobileProjectVisibility';

const session = (id: string): Session => ({
  id,
  projectID: 'project',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  title: id,
  directory: '/workspace',
  time: { created: 1, updated: 1 },
});

const projects = [
  { id: 'visible' },
  { id: 'no-work', hiddenFromWork: true },
  { id: 'no-all', hiddenFromAllSessions: true },
  { id: 'no-both', hiddenFromWork: true, hiddenFromAllSessions: true },
];
const visibility = projectVisibilitySets(projects);
const ownerById = new Map([
  ['s-visible', 'visible'],
  ['s-no-work', 'no-work'],
  ['s-no-all', 'no-all'],
  ['s-no-both', 'no-both'],
]);
const ownerOf = (entry: Session): string | null => ownerById.get(entry.id) ?? null;
const sessions = [...ownerById.keys()].map(session);
const ids = (list: Session[]): string[] => list.map((entry) => entry.id);

describe('projectVisibilitySets', () => {
  test('collects each flag into its own set', () => {
    expect([...visibility.hiddenFromWorkProjectIds].sort()).toEqual(['no-both', 'no-work']);
    expect([...visibility.hiddenFromAllProjectIds].sort()).toEqual(['no-all', 'no-both']);
  });
});

describe('phone sessions sheet visibility (#217)', () => {
  test('a hiddenFromWork project is absent from the work zone but stays in All sessions', () => {
    expect(ids(filterSessionsForWorkZone(sessions, ownerOf, visibility))).toEqual(['s-visible', 's-no-all']);
    expect(ids(filterSessionsForAllSessions(sessions, ownerOf, visibility))).toContain('s-no-work');
  });

  test('a hiddenFromAllSessions project is absent from All sessions but stays in the work zone', () => {
    expect(ids(filterSessionsForAllSessions(sessions, ownerOf, visibility))).toEqual(['s-visible', 's-no-work']);
    expect(ids(filterSessionsForWorkZone(sessions, ownerOf, visibility))).toContain('s-no-all');
  });

  test('a project hidden from both leaves both lists; a visible project stays in both', () => {
    expect(isSessionHiddenFromWork(session('s-no-both'), ownerOf, visibility)).toBe(true);
    expect(isSessionHiddenFromAllSessions(session('s-no-both'), ownerOf, visibility)).toBe(true);
    expect(ids(filterSessionsForWorkZone(sessions, ownerOf, visibility))).not.toContain('s-no-both');
    expect(ids(filterSessionsForAllSessions(sessions, ownerOf, visibility))).not.toContain('s-no-both');
    expect(ids(filterSessionsForWorkZone(sessions, ownerOf, visibility))).toContain('s-visible');
    expect(ids(filterSessionsForAllSessions(sessions, ownerOf, visibility))).toContain('s-visible');
  });

  test('an ownerless session is never hidden', () => {
    const orphan = session('s-orphan');
    expect(isSessionHiddenFromWork(orphan, ownerOf, visibility)).toBe(false);
    expect(isSessionHiddenFromAllSessions(orphan, ownerOf, visibility)).toBe(false);
    expect(ids(filterSessionsForAllSessions([...sessions, orphan], ownerOf, visibility))).toContain('s-orphan');
  });
});

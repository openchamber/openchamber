import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { deriveRecentSessions } from './activitySections';

const makeSession = (overrides: Partial<Session> = {}): Session =>
  ({
    id: 'session-id',
    slug: 'session-slug',
    projectID: 'project-id',
    directory: '/workspace',
    title: 'Test session',
    version: '1',
    time: { created: 0, updated: 0 },
    ...overrides,
  }) as Session;

const NOW = 1_700_000_000_000;
const RECENT_AGE_MS = 48 * 60 * 60 * 1000;
const FRESH = NOW - 60_000;
const STALE = NOW - RECENT_AGE_MS - 60_000;

describe('deriveRecentSessions — subagent exclusion', () => {
  test('excludes subagent sessions even when fresh and not archived', () => {
    const parent = makeSession({ id: 'parent', title: 'Parent', time: { created: NOW, updated: FRESH } });
    const subagent = makeSession({
      id: 'sub',
      title: 'Sub',
      time: { created: NOW, updated: FRESH },
      parentID: 'parent',
    } as unknown as Partial<Session>);

    const result = deriveRecentSessions([parent, subagent], NOW);
    expect(result.map((s) => s.id)).toEqual(['parent']);
  });

  test('keeps fresh top-level sessions in updated-desc order', () => {
    const a = makeSession({ id: 'a', title: 'A', time: { created: NOW, updated: FRESH - 30_000 } });
    const b = makeSession({ id: 'b', title: 'B', time: { created: NOW, updated: FRESH } });

    const result = deriveRecentSessions([a, b], NOW);
    expect(result.map((s) => s.id)).toEqual(['b', 'a']);
  });

  test('excludes archived subagent sessions', () => {
    const archivedSub = makeSession({
      id: 'arch-sub',
      title: 'Archived Sub',
      time: { created: NOW, updated: FRESH, archived: 1 },
      parentID: 'parent',
    } as unknown as Partial<Session>);

    const result = deriveRecentSessions([archivedSub], NOW);
    expect(result).toEqual([]);
  });

  test('excludes stale top-level sessions (older than 48h)', () => {
    const stale = makeSession({ id: 'old', title: 'Old', time: { created: STALE - 1000, updated: STALE - 1000 } });

    const result = deriveRecentSessions([stale], NOW);
    expect(result).toEqual([]);
  });
});

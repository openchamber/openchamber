import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { filterArchivedFolderSessions } from './useArchivedAutoFolders';

const makeSession = (id: string, options: { parentID?: string } = {}): Session =>
  ({
    id,
    parentID: options.parentID,
    time: { created: 1, updated: 1, archived: 2 },
  } as unknown as Session);

const ids = (sessions: Session[]): string[] => sessions.map((session) => session.id);

describe('filterArchivedFolderSessions', () => {
  test('keeps parent-less sessions', () => {
    const sessions = [makeSession('a'), makeSession('b')];

    expect(ids(filterArchivedFolderSessions(sessions))).toEqual(['a', 'b']);
  });

  test('drops subagents whose parent is archived too, so folders do not render them twice (#2266 issue 1)', () => {
    const sessions = [
      makeSession('parent'),
      makeSession('child-1', { parentID: 'parent' }),
      makeSession('child-2', { parentID: 'parent' }),
    ];

    expect(ids(filterArchivedFolderSessions(sessions))).toEqual(['parent']);
  });

  test('drops nested descendants of an archived tree', () => {
    const sessions = [
      makeSession('parent'),
      makeSession('child', { parentID: 'parent' }),
      makeSession('grandchild', { parentID: 'child' }),
    ];

    expect(ids(filterArchivedFolderSessions(sessions))).toEqual(['parent']);
  });

  test('keeps subagents whose parent is not archived: they root in the archived bucket themselves', () => {
    const sessions = [makeSession('detached-child', { parentID: 'active-or-deleted-parent' })];

    expect(ids(filterArchivedFolderSessions(sessions))).toEqual(['detached-child']);
  });
});

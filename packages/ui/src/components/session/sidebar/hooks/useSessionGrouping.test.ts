import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { buildGroupedSessions, type BuildGroupedSessionsArgs } from './useSessionGrouping';

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

const baseArgs: BuildGroupedSessionsArgs = {
  homeDirectory: '/home',
  worktreeMetadata: new Map(),
  pinnedSessionIds: new Set(),
  gitBranches: new Map(),
  isVSCode: false,
  showSubagentSessionsInSidebar: false,
  t: (key: string) => key,
};

describe('buildGroupedSessions — subagent visibility toggle', () => {
  test('toggle OFF: subtask session does not appear in any group', () => {
    const parent = makeSession({ id: 'parent-1', title: 'Parent' });
    const subagent = makeSession({
      id: 'sub-1',
      title: 'Sub',
      parentID: 'parent-1',
    } as unknown as Partial<Session>);
    const otherParent = makeSession({ id: 'parent-2', title: 'Other' });

    const groups = buildGroupedSessions([parent, subagent, otherParent], '/workspace', [], null, false, baseArgs);

    const allNodes = groups.flatMap((g) => g.sessions);
    expect(allNodes).toHaveLength(2);
    expect(allNodes.map((n) => n.session.id).sort()).toEqual(['parent-1', 'parent-2']);
  });

  test('toggle OFF: parent node has empty children array', () => {
    const parent = makeSession({ id: 'parent-1', title: 'Parent' });
    const subagent = makeSession({
      id: 'sub-1',
      title: 'Sub',
      parentID: 'parent-1',
    } as unknown as Partial<Session>);

    const groups = buildGroupedSessions([parent, subagent], '/workspace', [], null, false, baseArgs);

    const allNodes = groups.flatMap((g) => g.sessions);
    const parentNode = allNodes.find((n) => n.session.id === 'parent-1');
    expect(parentNode).toBeTruthy();
    expect(parentNode?.children).toEqual([]);
  });

  test('toggle ON: subtask appears as a child of its parent', () => {
    const parent = makeSession({ id: 'parent-1', title: 'Parent' });
    const subagent = makeSession({
      id: 'sub-1',
      title: 'Sub',
      parentID: 'parent-1',
    } as unknown as Partial<Session>);

    const args: BuildGroupedSessionsArgs = { ...baseArgs, showSubagentSessionsInSidebar: true };
    const groups = buildGroupedSessions([parent, subagent], '/workspace', [], null, false, args);

    const allNodes = groups.flatMap((g) => g.sessions);
    expect(allNodes).toHaveLength(1);
    expect(allNodes[0]?.session.id).toBe('parent-1');
    expect(allNodes[0]?.children).toHaveLength(1);
    expect(allNodes[0]?.children[0]?.session.id).toBe('sub-1');
  });

  test('toggle ON: subtask with non-matching archived state is filtered out of children but still appears in archived bucket', () => {
    const parent = makeSession({ id: 'parent-1', title: 'Parent' });
    const subagent = makeSession({
      id: 'sub-1',
      title: 'Sub',
      parentID: 'parent-1',
      time: { created: 0, updated: 0, archived: 1 },
    });
    const args: BuildGroupedSessionsArgs = { ...baseArgs, showSubagentSessionsInSidebar: true };
    const groups = buildGroupedSessions([parent, subagent], '/workspace', [], null, false, args);

    const rootGroup = groups.find((g) => g.id === 'root');
    const archivedGroup = groups.find((g) => g.isArchivedBucket);
    expect(rootGroup?.sessions).toHaveLength(1);
    expect(rootGroup?.sessions[0]?.session.id).toBe('parent-1');
    expect(rootGroup?.sessions[0]?.children).toEqual([]);
    expect(archivedGroup?.sessions).toHaveLength(1);
    expect(archivedGroup?.sessions[0]?.session.id).toBe('sub-1');
  });

  test('toggle OFF: subtask pinned does not reorder parent above other top-level', () => {
    const parentA = makeSession({ id: 'A', title: 'A', time: { created: 1, updated: 1 } });
    const parentB = makeSession({ id: 'B', title: 'B', time: { created: 2, updated: 2 } });
    const subB = makeSession({
      id: 'subB',
      title: 'Sub B',
      parentID: 'B',
      time: { created: 99, updated: 99 },
    } as unknown as Partial<Session>);
    const args: BuildGroupedSessionsArgs = { ...baseArgs, pinnedSessionIds: new Set(['subB']) };

    const groups = buildGroupedSessions([parentA, parentB, subB], '/workspace', [], null, false, args);

    const allNodes = groups.flatMap((g) => g.sessions);
    expect(allNodes).toHaveLength(2);
    // Pinned subB should not promote B above A. Sort is by pinned+time of top-level only.
    expect(allNodes.map((n) => n.session.id)).toEqual(['B', 'A']);
  });
});

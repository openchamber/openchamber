import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { getSessionNodesActivityState } from './collapsedActivityState';
import type { SessionNode } from './types';

const node = (id: string, parentID?: string, children: SessionNode[] = []): SessionNode => ({
  session: { id, parentID } as Session,
  children,
  worktree: null,
});

describe('getSessionNodesActivityState', () => {
  test('prioritizes active descendants over unread descendants', () => {
    const nodes = [node('unread'), node('root', undefined, [node('active-child', 'root')])];

    expect(getSessionNodesActivityState(
      nodes,
      new Set(['active-child']),
      new Set(['unread']),
      false,
    )).toBe('active');
  });

  test('includes unread subtasks only when subtask notifications are enabled', () => {
    const nodes = [node('root', undefined, [node('unread-child', 'root')])];
    const unread = new Set(['unread-child']);

    expect(getSessionNodesActivityState(nodes, new Set(), unread, false)).toBeNull();
    expect(getSessionNodesActivityState(nodes, new Set(), unread, true)).toBe('unread');
  });

  test('returns null when no descendant has activity', () => {
    expect(getSessionNodesActivityState([node('idle')], new Set(), new Set(), true)).toBeNull();
  });
});

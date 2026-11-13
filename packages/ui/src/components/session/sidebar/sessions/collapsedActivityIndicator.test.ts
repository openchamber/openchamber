import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { getSessionNodesActivityState } from './collapsedActivityState';
import type { SessionNode } from '../types';

// SAFETY: the fixture supplies the minimal SDK identity fields used by the activity projection.
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
    )).toBe('active');
  });

  test('never shows a subtask as unread; its parent carries the mark', () => {
    const nodes = [node('root', undefined, [node('unread-child', 'root')])];

    expect(getSessionNodesActivityState(nodes, new Set(), new Set(['unread-child']))).toBeNull();
    expect(getSessionNodesActivityState(nodes, new Set(), new Set(['root']))).toBe('unread');
  });

  test('returns null when no descendant has activity', () => {
    expect(getSessionNodesActivityState([node('idle')], new Set(), new Set())).toBeNull();
  });
});

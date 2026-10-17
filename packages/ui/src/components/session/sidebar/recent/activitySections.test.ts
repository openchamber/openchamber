import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { pruneSessionTreeForSidebarQuery, sessionTreeMatchesSidebarQuery } from './activitySections';
import type { SessionNode } from '../types';

// SAFETY: the query match reads only the id, title, and parent.
const session = (id: string, options: { parentID?: string } = {}): Session => ({
  id,
  parentID: options.parentID,
  time: { created: 1, updated: 1 },
} as Session);

describe('sessionTreeMatchesSidebarQuery', () => {
  const tree = (): SessionNode => ({
    session: { ...session('ses_parent'), title: 'Parent work' } as Session,
    children: [{
      session: { ...session('ses_child', { parentID: 'ses_parent' }), title: 'Fix the header' } as Session,
      children: [],
      worktree: null,
    }],
    worktree: null,
  });

  test('keeps a tree whose subsession is the match, by id and by title', () => {
    expect(sessionTreeMatchesSidebarQuery(tree(), 'ses_child')).toBe(true);
    expect(sessionTreeMatchesSidebarQuery(tree(), 'header')).toBe(true);
    expect(sessionTreeMatchesSidebarQuery(tree(), 'parent')).toBe(true);
  });

  test('drops a tree where nothing matches', () => {
    expect(sessionTreeMatchesSidebarQuery(tree(), 'unrelated')).toBe(false);
    expect(sessionTreeMatchesSidebarQuery(tree(), 'ses_other')).toBe(false);
  });
});

describe('pruneSessionTreeForSidebarQuery', () => {
  const titled = (id: string, title: string, children: SessionNode[] = []): SessionNode => ({
    session: { ...session(id), title },
    children,
    worktree: null,
  });
  const tree = () => titled('ses_parent', 'Parent work', [
    titled('ses_tests', 'Write tests', [titled('ses_deep', 'Header snapshot')]),
    titled('ses_docs', 'Docs'),
  ]);
  type Outline = [string, Outline[]];
  const outline = (node: SessionNode): Outline => [node.session.id, node.children.map(outline)];
  const ids = (node: SessionNode | null): Outline | null => (node ? outline(node) : null);

  test('keeps only the branches that lead to a match', () => {
    expect(ids(pruneSessionTreeForSidebarQuery(tree(), 'header'))).toEqual(['ses_parent', [['ses_tests', [['ses_deep', []]]]]]);
  });

  test('keeps everything under a matching session', () => {
    expect(ids(pruneSessionTreeForSidebarQuery(tree(), 'tests'))).toEqual(['ses_parent', [['ses_tests', [['ses_deep', []]]]]]);
    expect(pruneSessionTreeForSidebarQuery(tree(), 'parent')).toEqual(tree());
  });

  test('is null when nothing in the tree matches', () => {
    expect(pruneSessionTreeForSidebarQuery(tree(), 'unrelated')).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { matchZoneSessionsForSidebarQuery, pruneSessionTreeForSidebarQuery } from './activitySections';
import type { SessionNode } from '../types';

// SAFETY: the query match reads only the id, title, and parent.
const session = (id: string, options: { parentID?: string } = {}): Session => ({
  id,
  parentID: options.parentID,
  time: { created: 1, updated: 1 },
} as Session);

describe('matchZoneSessionsForSidebarQuery', () => {
  const parent = { ...session('ses_parent'), title: 'Parent work' };
  const other = { ...session('ses_other'), title: 'Other header work' };
  const child = { ...session('ses_child', { parentID: 'ses_parent' }), title: 'Fix the header' };
  const grandchild = { ...session('ses_grandchild', { parentID: 'ses_child' }), title: 'Header snapshot' };
  const trees = new Map<string, SessionNode>([
    ['ses_parent', {
      session: parent,
      children: [{ session: child, children: [{ session: grandchild, children: [], worktree: null }], worktree: null }],
      worktree: null,
    }],
    ['ses_other', { session: other, children: [], worktree: null }],
  ]);
  const match = (query: string, scope: 'tree' | 'session') => {
    const result = matchZoneSessionsForSidebarQuery([parent, other], (zoneSession) => trees.get(zoneSession.id) ?? { session: zoneSession, children: [], worktree: null }, query, scope);
    return { ids: result.sessions.map((zoneSession) => zoneSession.id), counts: Object.fromEntries(result.matchCountById) };
  };

  test('Tree keeps a session whose subsession is the match and counts only real matches', () => {
    expect(match('header', 'tree')).toEqual({ ids: ['ses_parent', 'ses_other'], counts: { ses_parent: 2, ses_other: 1 } });
    expect(match('ses_child', 'tree')).toEqual({ ids: ['ses_parent'], counts: { ses_parent: 1 } });
  });

  test('List lists a session only when it matches itself', () => {
    expect(match('header', 'session')).toEqual({ ids: ['ses_other'], counts: { ses_other: 1 } });
    expect(match('ses_child', 'session')).toEqual({ ids: [], counts: {} });
    expect(match('parent', 'session')).toEqual({ ids: ['ses_parent'], counts: { ses_parent: 1 } });
  });

  test('lists every session with no counts when there is no query', () => {
    expect(match('', 'session')).toEqual({ ids: ['ses_parent', 'ses_other'], counts: {} });
    expect(match('', 'tree')).toEqual({ ids: ['ses_parent', 'ses_other'], counts: {} });
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

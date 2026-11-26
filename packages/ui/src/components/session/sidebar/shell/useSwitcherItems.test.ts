import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';

import {
  buildSwitcherNode,
  collectSwitcherChildren,
  findSwitcherItemAncestorIds,
  selectSwitcherParents,
  type SwitcherItem,
} from './useSwitcherItems';
import { listedChildren } from '../listedChildren';
import { selectBlockingBadgeSessionScopes } from '../sessions/sessionNodeItemUtils';

const session = (id: string, options: { parentID?: string; archived?: boolean; projectId?: string } = {}): Session => ({
  id,
  parentID: options.parentID,
  time: options.archived ? { archived: Date.now() } : undefined,
  projectId: options.projectId ?? 'project-a',
} as unknown as Session);

const selectParents = (sessions: Session[], currentSessionId: string | null, scopeProjectId: string | null = null): Session[] => (
  selectSwitcherParents(sessions, new Set(), new Map(), scopeProjectId, currentSessionId, (item) => (item as Session & { projectId: string }).projectId)
);

describe('session switcher initial selection', () => {
  test('finds all local ancestors for a current child session', () => {
    const items: SwitcherItem[] = [{
      node: { session: session('root'), worktree: null, children: [{ session: session('parent', { parentID: 'root' }), worktree: null, children: [{ session: session('child', { parentID: 'parent' }), worktree: null, children: [] }] }] },
      projectId: 'project-a', groupDirectory: null, secondaryMeta: null,
    }];

    expect(findSwitcherItemAncestorIds(items, 'child')).toEqual(['root', 'parent']);
    expect(findSwitcherItemAncestorIds(items, 'missing')).toBeNull();
  });

  test('replaces the final recent slot with the current root and excludes invalid current sessions', () => {
    const roots = Array.from({ length: 8 }, (_, index) => session(`root-${index}`));
    const child = session('child', { parentID: 'root-7' });

    expect(selectParents([...roots, child], 'child').map((item) => item.id)).toEqual([
      'root-0', 'root-1', 'root-2', 'root-3', 'root-4', 'root-5', 'root-7',
    ]);
    expect(selectParents([...roots, child], 'missing').map((item) => item.id)).toEqual(roots.slice(0, 7).map((item) => item.id));
    expect(selectParents([...roots, child], 'child', 'project-b').map((item) => item.id)).toEqual([]);
    expect(selectParents([...roots.slice(0, 7), session('archived', { archived: true })], 'archived').map((item) => item.id)).toEqual(roots.slice(0, 7).map((item) => item.id));
    expect(selectParents([...roots, session('archived-child', { archived: true, parentID: 'root-7' })], 'archived-child').map((item) => item.id)).toEqual(roots.slice(0, 7).map((item) => item.id));
  });
});

describe('switcher trees', () => {
  const byId = (a: Session, b: Session) => a.id.localeCompare(b.id);
  // SAFETY: the fixture carries the fields the switcher tree reads: id, parent and the workflow-agent kind.
  const workflowAgent = (id: string, parentID: string): Session => ({
    ...session(id, { parentID }),
    metadata: { openchamber: { kind: 'workflow-agent' } },
  } as Session);

  test('a run blocked by a workflow agent keeps the child for its badge, with no row and no chevron of its own', () => {
    const root = session('root');
    const children = collectSwitcherChildren([root, workflowAgent('agent', 'root'), session('child', { parentID: 'root' })], () => true, byId);
    const node = buildSwitcherNode(root, children);

    // The node keeps both children, so the waiting request of an agent the
    // switcher cannot open still counts for the row above it.
    expect(node.children.map((child) => child.session.id)).toEqual(['agent', 'child']);
    expect(listedChildren(node).map((child) => child.session.id)).toEqual(['child']);
    expect(selectBlockingBadgeSessionScopes(node, false, '/project-a')).toEqual([
      { directory: '/project-a', sessionIDs: ['root', 'agent', 'child'] },
    ]);
  });

  test('an agent-only run keeps no child row, so the row has no chevron', () => {
    const root = session('root');
    const node = buildSwitcherNode(root, collectSwitcherChildren([root, workflowAgent('agent', 'root')], () => true, byId));

    expect(node.children.map((child) => child.session.id)).toEqual(['agent']);
    expect(listedChildren(node)).toEqual([]);
  });

  test('leaves out archived and unadmitted children', () => {
    const root = session('root');
    const children = collectSwitcherChildren(
      [root, session('archived', { parentID: 'root', archived: true }), session('elsewhere', { parentID: 'root' })],
      (item) => item.id !== 'elsewhere',
      byId,
    );

    expect(buildSwitcherNode(root, children).children).toEqual([]);
  });
});

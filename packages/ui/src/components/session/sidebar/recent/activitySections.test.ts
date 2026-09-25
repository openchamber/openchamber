import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';
import { getGitHubPrStatusKey } from '@/stores/useGitHubPrStatusStore';
import { resolveSessionPrLookupKey } from '../sessions/sessionNodeItemUtils';
import { deriveRecentActivitySections, deriveRecentSessions } from './activitySections';
import { resolveSidebarSessionLocations } from './sessionLocation';
import type { SessionNode } from '../types';
import type { DirectoryOwner } from '../sessions/sessionOwnership';

const NOW = 200_000_000;
const RECENT = NOW - (48 * 60 * 60 * 1000);
const OLD = NOW - (72 * 60 * 60 * 1000);

const session = (id: string, options: { parentID?: string; archived?: number; updated?: number } = {}): Session => ({
  id,
  parentID: options.parentID,
  time: { created: OLD, updated: options.updated ?? OLD, archived: options.archived },
} as Session);

describe('deriveRecentSessions', () => {
  test('includes an old root session while it is active', () => {
    const oldActive = session('old-active');

    expect(deriveRecentSessions([oldActive], new Set([oldActive.id]), NOW)).toEqual([oldActive]);
  });

  test('does not promote active children or archived sessions into Recent', () => {
    const child = session('child', { parentID: 'parent' });
    const archived = session('archived', { archived: NOW - 1 });

    expect(deriveRecentSessions(
      [child, archived],
      new Set([child.id, archived.id]),
      NOW,
    )).toEqual([]);
  });

  test('keeps inactive membership timestamp-based', () => {
    const oldSession = session('old');
    const recentSession = session('recent', { updated: RECENT });

    expect(deriveRecentSessions([oldSession, recentSession], new Set(), NOW)).toEqual([recentSession]);
  });
});

describe('deriveRecentActivitySections', () => {
  test('matches full IDs only, without falling back to titles or changing the matched subtree', () => {
    const target = { ...session('ses_f88b1a2b3c4d'), title: 'Release' };
    const other = { ...session('ses_f88b1a2b3c4e'), title: target.id };
    const node = { session: target, worktree: null, children: [{ session: other, worktree: null, children: [] }] };
    for (const query of [target.id, ` ${target.id.toUpperCase()} `, 'ses_f88b', 'ses_f88b1a2b3c4f']) {
      const sections = deriveRecentActivitySections({
        sessions: [target, other],
        getSessionLocation: () => null,
        getSessionNode: () => node,
        query,
      });
      const expected = query.trim().toLowerCase() === target.id ? [target.id] : [];
      expect(sections[0].items.map((item) => item.node.session.id)).toEqual(expected);
      for (const item of sections[0].items) expect(item.node).toBe(node);
    }
    expect(node.children).toHaveLength(1);
  });

  test('filters recent roots by search text and falls back to topology metadata', () => {
    const matching = {
      ...session('matching', { updated: RECENT }),
      title: 'Deploy release',
      directory: '/workspace/app/worktrees/release',
    };
    const excluded = {
      ...session('excluded', { updated: RECENT }),
      title: 'Investigate failure',
      directory: '/workspace/app',
    };

    const sections = deriveRecentActivitySections({
      sessions: [matching, excluded],
      getSessionLocation: (sessionId) => sessionId === matching.id ? {
        projectId: 'app',
        groupDirectory: '/workspace/app/worktrees/release',
        projectLabel: 'App',
        branchLabel: 'release',
        worktree: null,
      } : null,
      query: 'deploy',
    });

    expect(sections).toMatchObject([{
      key: 'active-now',
      items: [{
        node: { session: matching, children: [], worktree: null },
        projectId: 'app',
        groupDirectory: '/workspace/app/worktrees/release',
        secondaryMeta: { projectLabel: 'App', branchLabel: 'release' },
      }],
    }]);
  });

  test('attaches the location worktree to the node so the row derives its PR key', () => {
    const record = { ...session('worktree', { updated: RECENT }), directory: '/worktrees/feature' };
    const worktree: WorktreeMetadata = {
      path: '/worktrees/feature', projectDirectory: '/workspace/app', branch: 'feature-1', label: 'feature',
    };

    const sections = deriveRecentActivitySections({
      sessions: [record],
      getSessionLocation: (sessionId) => sessionId === record.id ? {
        projectId: 'app',
        groupDirectory: '/worktrees/feature',
        projectLabel: 'App',
        branchLabel: 'feature-1',
        worktree,
      } : null,
      // `buildActiveSessionNode` hands Recent rows a null worktree; the Recent
      // projection must carry the resolved one onto the node.
      getSessionNode: (target) => ({ session: target, children: [], worktree: null }),
      query: '',
    });

    const node = sections[0].items[0]?.node;
    expect(node?.worktree).toBe(worktree);
    expect(resolveSessionPrLookupKey(node?.worktree, false))
      .toBe(getGitHubPrStatusKey('/worktrees/feature', 'feature-1'));
  });

  test('keeps the node unchanged when no location resolved a worktree', () => {
    const record = session('plain', { updated: RECENT });
    const node = { session: record, children: [], worktree: null };

    const sections = deriveRecentActivitySections({
      sessions: [record],
      getSessionLocation: () => null,
      getSessionNode: () => node,
      query: '',
    });

    expect(sections[0].items[0]?.node).toBe(node);
  });

  test('resolves child and grandchild PR keys from their own worktrees without losing the subtree', () => {
    const root = { ...session('root'), directory: '/workspace/app' };
    const child = { ...session('child', { parentID: root.id }), directory: '/worktrees/feature' };
    const grandchild = { ...session('grandchild', { parentID: child.id }), directory: '/worktrees/other/sub' };
    const missing = { ...session('missing', { parentID: root.id }), directory: '/worktrees/deleted' };
    const worktree: WorktreeMetadata = {
      path: '/worktrees/feature', projectDirectory: '/workspace/app', branch: 'feature', label: 'feature',
    };
    const otherWorktree: WorktreeMetadata = { ...worktree, path: '/worktrees/other', branch: 'other' };
    const owner: DirectoryOwner = {
      projectId: 'app', projectRoot: '/workspace/app', scopeDirectory: '/workspace/app', kind: 'project',
    };
    const locations = resolveSidebarSessionLocations({
      sessions: [root, child, grandchild, missing],
      projects: [{ id: 'app', normalizedPath: '/workspace/app' }],
      ownerBySessionId: new Map([root, child, grandchild, missing].map((record) => [
        record.id, owner,
      ])),
      availableWorktreesByProject: new Map([['/workspace/app', [worktree, otherWorktree]]]),
      gitBranches: new Map(),
      homeDirectory: null,
      hideBranchMatchingProjectLabel: true,
    });
    const missingNode: SessionNode = { session: missing, worktree: null, children: [] };
    const original: SessionNode = {
      session: root, worktree: null,
      children: [{ session: child, worktree: null, children: [{ session: grandchild, worktree: null, children: [] }] }, missingNode],
    };
    const sections = deriveRecentActivitySections({
      sessions: [root], getSessionLocation: (id) => locations.get(id) ?? null,
      getSessionNode: () => original, query: '',
    });
    const projected = sections[0].items[0].node;
    expect(projected.worktree).toBeNull();
    expect(resolveSessionPrLookupKey(projected.children[0].worktree, false))
      .toBe(getGitHubPrStatusKey('/worktrees/feature', 'feature'));
    expect(resolveSessionPrLookupKey(projected.children[0].children[0].worktree, false))
      .toBe(getGitHubPrStatusKey('/worktrees/other', 'other'));
    expect(projected.children[1]).toBe(missingNode);
    expect(projected.children.map((node) => node.session.id)).toEqual(['child', 'missing']);
    expect(projected.children[0].children[0].session).toBe(grandchild);
    expect(original.children[0].worktree).toBeNull();
  });
});

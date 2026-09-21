import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';
import { createSessionOwnershipIndex } from '../sessions/sessionOwnership';
import { deriveTimelineActivityItems } from './activitySections';
import { resolveSidebarSessionLocations } from './sessionLocation';

const projects = [{ id: 'repo', normalizedPath: '/repo', label: 'Repo' }];
const session = (id: string, directory: string): Session => ({
  id, directory, slug: id, title: id, projectID: 'opencode-repo', version: '1',
  time: { created: 1, updated: 1, archived: 0 },
});

describe('resolveSidebarSessionLocations', () => {
  test('keeps a restored missing-worktree session in Timeline with its actual request directory', () => {
    const restored = session('restored', '/worktrees/deleted');
    const ownership = createSessionOwnershipIndex(
      [restored], projects, new Map(), false, [], [{ id: 'opencode-repo', worktree: '/repo' }],
    );
    for (const hideBranchMatchingProjectLabel of [true, false]) {
      const locations = resolveSidebarSessionLocations({
        sessions: [restored], projects, ownerBySessionId: ownership.bySessionId,
        availableWorktreesByProject: new Map(), gitBranches: new Map(),
        homeDirectory: null, hideBranchMatchingProjectLabel,
      });
      expect(locations.get(restored.id)).toEqual({
        projectId: 'repo', groupDirectory: restored.directory, projectLabel: 'Repo',
        branchLabel: null, worktree: null,
      });
      const items = deriveTimelineActivityItems({
        sessions: [restored], getSessionLocation: (id) => locations.get(id) ?? null,
        getSessionNode: (record) => ({ session: record, children: [], worktree: null }), query: '',
      });
      expect(items[0]?.node.session).toBe(restored);
      expect(items[0]?.projectId).toBe('repo');
      expect(items[0]?.groupDirectory).toBe('/worktrees/deleted');
    }
  });

  test('keeps worktree metadata and the distinct Recent/Timeline branch-label policies', () => {
    const record = session('worktree', '/worktrees/feature');
    const worktree: WorktreeMetadata = {
      path: record.directory, projectDirectory: '/repo', branch: 'Repo', label: 'feature',
    };
    const availableWorktreesByProject = new Map([['/repo', [worktree]]]);
    const ownership = createSessionOwnershipIndex([record], projects, availableWorktreesByProject, false);
    for (const hideBranchMatchingProjectLabel of [true, false]) {
      const locations = resolveSidebarSessionLocations({
        sessions: [record], projects, ownerBySessionId: ownership.bySessionId,
        availableWorktreesByProject, gitBranches: new Map(), homeDirectory: null,
        hideBranchMatchingProjectLabel,
      });
      expect(locations.get(record.id)?.worktree).toBe(worktree);
      expect(locations.get(record.id)?.branchLabel).toBe(hideBranchMatchingProjectLabel ? null : 'Repo');
    }
  });

  test('leaves unrelated sessions unassigned and hides detached HEAD', () => {
    const records = [session('unowned', '/elsewhere'), session('detached', '/repo')];
    const ownership = createSessionOwnershipIndex(records, projects, new Map(), false);
    const locations = resolveSidebarSessionLocations({
      sessions: records, projects, ownerBySessionId: ownership.bySessionId,
      availableWorktreesByProject: new Map(), gitBranches: new Map([['/repo', 'HEAD']]),
      homeDirectory: null, hideBranchMatchingProjectLabel: false,
    });
    expect(locations.has('unowned')).toBe(false);
    expect(locations.get('detached')?.branchLabel).toBeNull();
  });
});

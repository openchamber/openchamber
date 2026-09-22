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

const worktreeMeta = (path: string, branch: string): WorktreeMetadata => ({
  path,
  projectDirectory: '/repo',
  branch,
  label: branch,
});

const resolveLocations = (
  records: Session[],
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  gitBranches: ReadonlyMap<string, string | null> = new Map(),
  hideBranchMatchingProjectLabel = true,
) => {
  const ownership = createSessionOwnershipIndex(records, projects, availableWorktreesByProject, false);
  return resolveSidebarSessionLocations({
    sessions: records, projects, ownerBySessionId: ownership.bySessionId,
    availableWorktreesByProject, gitBranches, homeDirectory: null,
    hideBranchMatchingProjectLabel,
  });
};

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

  test('resolves worktree metadata for sessions inside <worktree>/sub through the longest prefix', () => {
    const exact = session('exact', '/worktrees/feature');
    const sub = session('sub', '/worktrees/feature/sub');
    const deeper = session('deeper', '/worktrees/feature/sub/deeper');
    const worktree = worktreeMeta('/worktrees/feature', 'feature-1');
    const availableWorktreesByProject = new Map([['/repo', [worktree]]]);
    const locations = resolveLocations([exact, sub, deeper], availableWorktreesByProject);

    for (const record of [exact, sub, deeper]) {
      expect(locations.get(record.id)?.projectId).toBe('repo');
      expect(locations.get(record.id)?.worktree).toBe(worktree);
      expect(locations.get(record.id)?.branchLabel).toBe('feature-1');
      expect(locations.get(record.id)?.groupDirectory).toBe(record.directory);
    }
  });

  test('prefers the innermost containing worktree for nested worktrees', () => {
    const nested = session('nested', '/tmp/wt/outer/inner/sub');
    const outer = worktreeMeta('/tmp/wt/outer', 'outer');
    const inner = worktreeMeta('/tmp/wt/outer/inner', 'inner');
    const locations = resolveLocations([nested], new Map([['/repo', [outer, inner]]]));

    expect(locations.get('nested')?.worktree).toBe(inner);
    expect(locations.get('nested')?.branchLabel).toBe('inner');
  });

  test('keeps the project root and unregistered worktree buckets out of the index', () => {
    const rootRecord = session('root-record', '/repo/');
    const featureSub = session('feature-sub', '/worktrees/feature/sub');
    const rootWorktree = worktreeMeta('/repo', 'main');
    const feature = worktreeMeta('/worktrees/feature/', 'feature-1');
    const foreign = worktreeMeta('/elsewhere/wt', 'other');
    const availableWorktreesByProject = new Map([
      ['/repo/', [rootWorktree, feature]],
      ['/elsewhere', [foreign]],
    ]);
    const locations = resolveLocations([rootRecord, featureSub], availableWorktreesByProject);

    // `/repo/` normalizes to the configured project root, so the root entry
    // never becomes a worktree; the normalized worktree key still resolves.
    expect(locations.get('root-record')?.worktree).toBeNull();
    expect(locations.get('feature-sub')?.worktree).toBe(feature);
  });

  test('live git status wins over stored worktree metadata, including <worktree>/sub', () => {
    const exact = session('exact', '/worktrees/feature');
    const sub = session('sub', '/worktrees/feature/sub');
    const worktree = worktreeMeta('/worktrees/feature', 'stored-1');
    const locations = resolveLocations(
      [exact, sub],
      new Map([['/repo', [worktree]]]),
      new Map([['/worktrees/feature', 'live-1'], ['/worktrees/feature/sub', 'live-sub']]),
      false,
    );

    expect(locations.get('exact')?.branchLabel).toBe('live-1');
    expect(locations.get('sub')?.branchLabel).toBe('live-sub');
    // The stored branch stays reachable through the node's worktree for the
    // project-row fallback, never as the displayed Recent/Timeline label.
    expect(locations.get('exact')?.worktree?.branch).toBe('stored-1');
    expect(locations.get('sub')?.worktree?.branch).toBe('stored-1');
  });

  test('falls back to the worktree-root live branch and only then to stored metadata', () => {
    const sub = session('sub', '/worktrees/feature/sub');
    const worktree = worktreeMeta('/worktrees/feature', 'stored-1');
    const availableWorktreesByProject = new Map([['/repo', [worktree]]]);

    const rootLive = resolveLocations(
      [sub], availableWorktreesByProject, new Map([['/worktrees/feature', 'live-1']]), false,
    );
    expect(rootLive.get('sub')?.branchLabel).toBe('live-1');

    const storedOnly = resolveLocations([sub], availableWorktreesByProject, new Map(), false);
    expect(storedOnly.get('sub')?.branchLabel).toBe('stored-1');
  });
});

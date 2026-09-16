import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';
import { buildRecentSessionLocations } from './recentSessionLocations';

const makeSession = (id: string, directory: string): Session => ({
  id,
  slug: id,
  projectID: 'app',
  title: id,
  version: '1',
  directory,
  time: { created: 1, updated: 1 },
});

describe('buildRecentSessionLocations', () => {
  test('uses the most specific project and exact worktree metadata', () => {
    const session = makeSession('ses_release', '/workspace/app/worktrees/release');
    const worktree: WorktreeMetadata = {
      path: '/workspace/app/worktrees/release',
      projectDirectory: '/workspace/app',
      branch: 'release',
      label: 'release',
    };

    const locations = buildRecentSessionLocations({
      sessions: [session],
      projects: [
        { id: 'workspace', label: 'Workspace', normalizedPath: '/workspace' },
        { id: 'app', label: 'App', normalizedPath: '/workspace/app' },
      ],
      availableWorktreesByProject: new Map([['/workspace/app', [worktree]]]),
      gitBranches: new Map(),
      homeDirectory: '/home/user',
    });

    expect(locations.get(session.id)).toEqual({
      projectId: 'app',
      groupDirectory: '/workspace/app/worktrees/release',
      projectLabel: 'App',
      branchLabel: 'release',
    });
  });

  test('does not assign sessions outside every project root', () => {
    const session = makeSession('ses_external', '/other/location');
    const locations = buildRecentSessionLocations({
      sessions: [session],
      projects: [{ id: 'app', normalizedPath: '/workspace/app' }],
      availableWorktreesByProject: new Map(),
      gitBranches: new Map(),
      homeDirectory: null,
    });

    expect(locations.has(session.id)).toBe(false);
  });
});

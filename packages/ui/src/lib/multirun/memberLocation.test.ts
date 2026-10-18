import { describe, expect, test } from 'bun:test';
import type { WorktreeMetadata } from '@/types/worktree';
import { locateRunMember, type RunMemberLocationSources } from './memberLocation';

const worktree = (path: string, projectDirectory = '/repo/ai'): WorktreeMetadata => ({ path, projectDirectory, branch: 'lane', label: 'lane' });

const sources = (overrides: Partial<RunMemberLocationSources> = {}): RunMemberLocationSources => ({
  projectPaths: ['/repo/ai'],
  known: undefined,
  legacyScope: null,
  projectRefFor: (path) => ({ id: `id:${path}`, path }),
  listWorktrees: async () => [],
  ...overrides,
});

describe('locateRunMember', () => {
  test('a lane in the project folder of its recorded worktree belongs to that worktree', async () => {
    const lane = worktree('/worktrees/lane');
    expect(await locateRunMember('/worktrees/lane/ai', sources({ known: lane }))).toEqual({
      project: { id: 'id:/repo/ai', path: '/repo/ai' },
      worktree: lane,
    });
  });

  test('finds the listed worktree that holds a lane in its project folder', async () => {
    const lane = worktree('/worktrees/lane');
    const location = await locateRunMember('/worktrees/lane/ai', sources({ listWorktrees: async () => [lane] }));
    expect(location?.worktree).toBe(lane);
  });

  test('never takes the primary checkout that holds the project for a lane worktree', async () => {
    // Git lists the primary checkout `/repo` among the worktrees of the project at `/repo/ai`.
    const primary = worktree('/repo');
    expect(await locateRunMember('/repo/ai/src', sources({ listWorktrees: async () => [primary] }))).toBeNull();
    expect(await locateRunMember('/repo/ai/src', sources({ known: primary })))
      .toEqual({ project: { id: 'id:/repo/ai', path: '/repo/ai' }, worktree: null });
  });

  test('a lane in the project root has no worktree', async () => {
    expect(await locateRunMember('/repo/ai', sources())).toEqual({ project: { id: 'id:/repo/ai', path: '/repo/ai' }, worktree: null });
  });

  test('does not match a sibling checkout that only shares the name prefix', async () => {
    const location = await locateRunMember('/worktrees/lane-two/ai', sources({ listWorktrees: async () => [worktree('/worktrees/lane')] }));
    expect(location).toBeNull();
  });
});

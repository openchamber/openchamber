import { describe, expect, test } from 'bun:test';
import { selectSourceControlDiscoveryCandidates, SOURCE_CONTROL_DISCOVERY_LIMIT } from './sourceControlDiscovery';

const group = (directory: string, branch: string) => ({
  branch,
  directory,
  isArchivedBucket: false,
  isMain: false,
});

describe('source-control sidebar discovery', () => {
  test('selects at most 50 unique directories in stable project order', () => {
    const sections = Array.from({ length: 55 }, (_, index) => ({
      project: { id: `project-${index}` },
      groups: [group(`/repo/worktree-${index}`, `branch-${index}`)],
    }));
    sections[0].groups.push(group('/repo/worktree-0', 'duplicate-branch'));

    const candidates = selectSourceControlDiscoveryCandidates(sections, new Set(), new Map());

    expect(candidates).toHaveLength(SOURCE_CONTROL_DISCOVERY_LIMIT);
    expect(new Set(candidates.map((candidate) => candidate.directory)).size).toBe(SOURCE_CONTROL_DISCOVERY_LIMIT);
    expect(candidates[0]).toEqual({ directory: '/repo/worktree-0', branch: 'branch-0' });
    expect(candidates.at(-1)).toEqual({ directory: '/repo/worktree-49', branch: 'branch-49' });
  });

  test('skips collapsed projects and resolves a missing group branch from Git state', () => {
    const sections = [{
      project: { id: 'visible' },
      groups: [group('/repo/visible', '')],
    }, {
      project: { id: 'collapsed' },
      groups: [group('/repo/collapsed', 'hidden')],
    }];

    expect(selectSourceControlDiscoveryCandidates(
      sections,
      new Set(['collapsed']),
      new Map([['/repo/visible', 'resolved-branch']]),
    )).toEqual([{ directory: '/repo/visible', branch: 'resolved-branch' }]);
  });
});

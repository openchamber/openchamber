import { describe, expect, test } from 'bun:test';
import { buildSessionBootstrapDemands } from './sessionBootstrapDemands';

describe('SessionProjectCollection', () => {
  test('preserves authoritative background demand when its visible rows are absent', () => {
    const demands = buildSessionBootstrapDemands({
      knownDirectories: ['/project', '/project/worktree'],
      activeProjectDirectory: '/project',
      activeProjectId: 'project',
      collapsedProjects: new Set(),
      collapsedGroups: new Set(),
      currentDirectory: null,
      currentSessionDirectory: null,
    });

    expect(demands.map((demand) => demand.directory)).toEqual(['/project', '/project/worktree']);
    expect(demands[0]?.priority).toBe('active-project');
    expect(demands[1]?.priority).toBe('background');
  });

});

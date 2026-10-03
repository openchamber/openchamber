import { describe, expect, test } from 'bun:test';
import { buildKnownSessionDirectories } from './sessionListDirectories';
import { buildSessionBootstrapDemands } from './sessionBootstrapDemands';

describe('buildKnownSessionDirectories', () => {
  test('normalizes project roots and optionally includes worktrees', () => {
    const worktrees = new Map([
      ['/repo', [{ path: '/repo/worktree', projectDirectory: '/repo', branch: 'worktree', label: 'worktree' }]],
    ]);

    expect([...buildKnownSessionDirectories([{ path: '/Repo' }], worktrees)]).toEqual([
      '/Repo',
      '/repo/worktree',
    ]);
    expect([...buildKnownSessionDirectories([{ path: '/Repo' }], worktrees, { includeWorktrees: false })]).toEqual([
      '/Repo',
    ]);
  });

  test('known topology is never bootstrap demand, however large it is', () => {
    const projects = Array.from({ length: 4 }, (_, index) => ({
      id: `project-${index}`,
      path: `/Users/Developer/Project-${index}`,
    }));
    const worktrees = new Map(projects.map((project) => [project.path,
      Array.from({ length: 5 }, (_, index) => ({
        path: `${project.path}/Worktree-${index}`,
        projectDirectory: project.path,
        branch: `branch-${index}`,
        label: `worktree-${index}`,
      })),
    ]));

    // The known set still feeds global-list refreshes for topology additions.
    expect(buildKnownSessionDirectories(projects, worktrees).size).toBe(24);
    // Bootstrap demand ignores it: only the directory being worked in is initialized.
    const demands = buildSessionBootstrapDemands({
      currentDirectory: projects[0].path,
      currentSessionDirectory: null,
    });
    expect(demands.map((demand) => demand.directory)).toEqual([projects[0].path]);
  });

  test('preserves case-sensitive directories and normalizes Windows separators without lowercasing names', () => {
    expect([...buildKnownSessionDirectories([
      { path: '/srv/Project' }, { path: '/srv/project' },
      { path: 'c:\\Users\\Developer\\Project\\' }, { path: 'C:/Users/Developer/Project' },
    ], new Map())]).toEqual(['/srv/Project', '/srv/project', 'C:/Users/Developer/Project']);
  });
});

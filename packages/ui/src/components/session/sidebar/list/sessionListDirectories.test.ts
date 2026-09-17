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

  test('layout and expanded sidebar demand share one directory identity at startup', () => {
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
    const common = {
      activeProjectId: projects[0].id,
      collapsedProjects: new Set<string>(),
      collapsedGroups: new Set<string>(),
      currentDirectory: projects[0].path,
      currentSessionDirectory: null,
    };
    const layout = buildSessionBootstrapDemands({
      ...common,
      knownDirectories: buildKnownSessionDirectories(projects, worktrees),
    });
    const sidebar = buildSessionBootstrapDemands({
      ...common,
      projectSections: projects.map((project) => ({
        project: { id: project.id, normalizedPath: project.path },
        groups: (worktrees.get(project.path) ?? []).map((worktree) => ({
          id: worktree.path, directory: worktree.path, isMain: false,
        })),
      })),
    });
    expect(layout).toHaveLength(24);
    expect(new Set([...layout, ...sidebar].map((demand) => demand.directory)).size).toBe(24);
  });

  test('preserves case-sensitive directories and normalizes Windows separators without lowercasing names', () => {
    expect([...buildKnownSessionDirectories([
      { path: '/srv/Project' }, { path: '/srv/project' },
      { path: 'c:\\Users\\Developer\\Project\\' }, { path: 'C:/Users/Developer/Project' },
    ], new Map())]).toEqual(['/srv/Project', '/srv/project', 'C:/Users/Developer/Project']);
  });
});

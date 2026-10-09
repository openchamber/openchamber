import { describe, expect, it, vi } from 'vitest';
import { resolveProjectForSessionDirectory } from '../../../../ui/src/lib/projectResolution';
import { partitionWorktreesByRegisteredProject } from '../../../../ui/src/lib/worktrees/worktreeManager';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { unsupportedRepositoryRootReason } from '../git/repository-root.js';
import { createKnowledgeOwnerResolver } from './knowledge-owner.js';

const setup = (paths, topology = [], overrides = {}) => {
  const getWorktrees = vi.fn(async (project) => topology.find((entry) => entry.project === project)?.worktrees || []);
  const resolvePrimaryWorktreeRoot = vi.fn(async (project) => ({ root: topology.find((entry) => entry.project === project)?.primary || project }));
  const resolver = createKnowledgeOwnerResolver({
    listProjectPaths: async () => paths, getWorktrees, resolvePrimaryWorktreeRoot,
    isGitRepository: async (project) => !unsupportedRepositoryRootReason(project, overrides.homeDirectory),
    realpath: async (root) => root, ...overrides,
  });
  const panelOwner = (directory) => {
    const projects = paths.map((path, index) => ({ id: `configured-${index}`, path }));
    const worktrees = new Map(topology.filter((entry) => paths.includes(entry.project)
      && !unsupportedRepositoryRootReason(entry.project, overrides.homeDirectory)).map(({ project, primary, worktrees }) => [project,
      worktrees.filter((entry) => entry.path !== project).map((entry) => ({ ...entry, projectDirectory: primary || project })),
    ]));
    const owner = resolveProjectForSessionDirectory(projects, partitionWorktreesByRegisteredProject(projects, worktrees), directory);
    return owner ? createProjectIdFromPath(owner.path) : '';
  };
  return { resolver, panelOwner, getWorktrees, resolvePrimaryWorktreeRoot };
};

describe('knowledge panel owner parity', () => {
  it.each([
    ['/home/user/workspaces/independent', '/home/user'],
    ['/home/user/workspaces/independent/src', '/home/user'],
    ['/home/user-other/repo', ''],
    ['/home/user/', '/home/user'],
    ['/home/user', '/home/user'],
  ])('uses registered ancestor boundaries for %s', async (directory, expected) => {
    const fixture = setup(['/home/user']);
    expect(await fixture.resolver(directory)).toBe(expected ? createProjectIdFromPath(expected) : '');
    expect(await fixture.resolver(directory)).toBe(fixture.panelOwner(directory));
  });

  it('selects a registered nested project and reads current registration on each call', async () => {
    const paths = ['/home/user'];
    const fixture = setup(paths);
    expect(await fixture.resolver('/home/user/repo/src')).toBe(fixture.panelOwner('/home/user/repo/src'));
    paths.push('/home/user/repo');
    expect(await fixture.resolver('/home/user/repo/src')).toBe(createProjectIdFromPath('/home/user/repo'));
    expect(await fixture.resolver('/home/user/repo/src')).toBe(fixture.panelOwner('/home/user/repo/src'));
  });

  it.each([
    ['/home/user', '/repo'],
    ['/home/user', '/repo', '/home/user/worktree'],
    ['/home/user', '/repo', '/home/user/worktree/nested'],
    ['/home/user', '/repo/subproject'],
    ['/registered-tree'],
  ].map((paths) => [paths]))('matches the actual UI worktree resolver for %j', async (paths) => {
    const fixture = setup(paths, [
      { project: '/repo', primary: '/repo', worktrees: [{ path: '/repo' }, { path: '/home/user/worktree' }] },
      { project: '/repo/subproject', primary: '/repo', worktrees: [{ path: '/repo' }, { path: '/home/user/worktree' }] },
      { project: '/registered-tree', primary: '/unregistered-primary', worktrees: [{ path: '/registered-tree' }, { path: '/outside/tree' }] },
    ]);
    for (const directory of ['/home/user/worktree', '/home/user/worktree/src', '/home/user/worktree/nested/src', '/home/user/worktree-other', '/outside/tree/src']) {
      expect(await fixture.resolver(directory)).toBe(fixture.panelOwner(directory));
    }
  });

  it('selects the longest worktree match and preserves the direct owner on a tie', async () => {
    const fixture = setup(['/repo-a', '/repo-b', '/trees/nested'], [
      { project: '/repo-a', worktrees: [{ path: '/trees' }] },
      { project: '/repo-b', worktrees: [{ path: '/trees/nested' }] },
    ]);
    expect(await fixture.resolver('/trees/src')).toBe(createProjectIdFromPath('/repo-a'));
    expect(await fixture.resolver('/trees/nested/src')).toBe(createProjectIdFromPath('/trees/nested'));
    expect(await fixture.resolver('/trees/nested/src')).toBe(fixture.panelOwner('/trees/nested/src'));
  });

  it('excludes the listing project path and other registered checkouts from discovery', async () => {
    const fixture = setup(['/repo', '/tree'], [
      { project: '/repo', worktrees: [{ path: '/repo' }, { path: '/tree' }] },
      { project: '/tree', primary: '/repo', worktrees: [{ path: '/repo' }, { path: '/tree' }] },
    ]);
    expect(await fixture.resolver('/tree/src')).toBe(createProjectIdFromPath('/tree'));
    expect(await fixture.resolver('/repo/src')).toBe(createProjectIdFromPath('/repo'));
    expect(fixture.resolvePrimaryWorktreeRoot).not.toHaveBeenCalled();
  });

  it.each([
    [['/listing', '/primary'], '/primary', '/primary'],
    [['/listing', '/primary'], '/primary/subdir', '/primary'],
    [['/listing'], '/unregistered-primary', '/listing'],
    [['/home', '/home/listing'], '/home/primary', '/home'],
  ])('tries primary candidate before listing fallback for %j', async (paths, primary, expected) => {
    const listing = paths.find((entry) => entry.endsWith('/listing'));
    const fixture = setup(paths, [{ project: listing, primary, worktrees: [{ path: '/outside/tree' }] }]);
    expect(await fixture.resolver('/outside/tree/src')).toBe(createProjectIdFromPath(expected));
    expect(await fixture.resolver('/outside/tree/src')).toBe(fixture.panelOwner('/outside/tree/src'));
  });

  it('overrides a shorter registered ancestor and retains an equally specific direct owner', async () => {
    const paths = ['/home', '/repo'];
    const fixture = setup(paths, [{ project: '/repo', worktrees: [{ path: '/home/tree' }] }]);
    expect(await fixture.resolver('/home/tree/src')).toBe(createProjectIdFromPath('/repo'));
    paths.push('/home/tree');
    expect(await fixture.resolver('/home/tree/src')).toBe(createProjectIdFromPath('/home/tree'));
    expect(await fixture.resolver('/home/tree/src')).toBe(fixture.panelOwner('/home/tree/src'));
  });

  it.each([
    ['/repo/b', '/repo/a'],
    ['/repo/a', '/repo/b'],
    ['/repo/b', '/repo/a', '/repo'],
  ].map((paths) => [paths]))('matches published repository partition order for %j', async (paths) => {
    // Discovery completion order differs from configured order.
    const fixture = setup(paths, ['/repo/a', '/repo/b', '/repo'].map((project) => ({
      project, primary: '/repo', worktrees: [{ path: '/repo' }, { path: '/repo/a' }, { path: '/repo/b' }, { path: '/outside/tree' }],
    })));
    const expected = paths.includes('/repo') ? '/repo' : paths[0];
    expect(await fixture.resolver('/outside/tree/src')).toBe(createProjectIdFromPath(expected));
    expect(await fixture.resolver('/outside/tree/src')).toBe(fixture.panelOwner('/outside/tree/src'));
  });

  it.each([
    [['/'], '/repo/src'],
    [['c:\\Users\\user\\repo\\'], 'C:/Users/user/repo/src'],
    [['C:/'], 'c:\\repo\\src'],
  ])('keeps original storage identity while normalizing %j', async (paths, directory) => {
    const fixture = setup(paths);
    expect(await fixture.resolver(directory)).toBe(fixture.panelOwner(directory));
    expect(await fixture.resolver(directory)).toBe(createProjectIdFromPath(paths[0]));
  });

  it('gives configured and legacy Chats priority with canonical aliases and boundaries', async () => {
    const fixture = setup(['/home/user', '/relocated/chats/day'], [], {
      managedProjectRoots: ['/relocated/chats', '/home/user/.config/openchamber/chats'],
      realpath: async (root) => root === '/relocated/chats' ? '/canonical/chats' : root,
    });
    for (const directory of ['/relocated/chats', '/relocated/chats/day/session', '/canonical/chats/day/session']) {
      expect(await fixture.resolver(directory)).toBe(createProjectIdFromPath('/relocated/chats'));
    }
    expect(await fixture.resolver('/home/user/.config/openchamber/chats/day/session')).toBe(createProjectIdFromPath('/home/user/.config/openchamber/chats'));
    expect(fixture.getWorktrees).not.toHaveBeenCalledWith('/relocated/chats/day');
    expect(await fixture.resolver('/relocated/chats-other')).toBe('');
  });

  it('uses no Git lookup for exact registered paths and no settings/Git lookup for Chats', async () => {
    const listProjectPaths = vi.fn(async () => ['/repo']);
    const fixture = setup([], [], { listProjectPaths, managedProjectRoots: ['/chats'] });
    expect(await fixture.resolver('/chats/day')).toBe(createProjectIdFromPath('/chats'));
    expect(listProjectPaths).not.toHaveBeenCalled();
    expect(await fixture.resolver('/repo')).toBe(createProjectIdFromPath('/repo'));
    expect(fixture.getWorktrees).not.toHaveBeenCalled();
    expect(fixture.resolvePrimaryWorktreeRoot).not.toHaveBeenCalled();
  });

  it('reads each configured topology once and resolves only the selected listing primary', async () => {
    const fixture = setup(['/home/user', '/repo-a', '/repo-b'], [
      { project: '/repo-a', worktrees: [{ path: '/home/user/tree' }] },
      { project: '/repo-b', worktrees: [{ path: '/home/user/tree/nested' }] },
    ]);
    expect(await fixture.resolver('/home/user/tree/nested/src')).toBe(createProjectIdFromPath('/repo-b'));
    expect(fixture.getWorktrees).toHaveBeenCalledTimes(3);
    expect(fixture.resolvePrimaryWorktreeRoot).toHaveBeenCalledTimes(1);
    expect(fixture.resolvePrimaryWorktreeRoot).toHaveBeenCalledWith('/repo-b');
  });

  it('propagates settings and topology failures without inventing an owner', async () => {
    await expect(setup([], [], { listProjectPaths: async () => { throw new Error('settings unavailable'); } }).resolver('/repo')).rejects.toThrow('settings unavailable');
    await expect(setup(['/repo'], [], { getWorktrees: async () => { throw new Error('topology unavailable'); } }).resolver('/repo/src')).rejects.toThrow('topology unavailable');
    const fixture = setup(['/repo'], [{ project: '/repo', worktrees: [{ path: '/tree' }] }], {
      resolvePrimaryWorktreeRoot: async () => { throw new Error('primary unavailable'); },
    });
    await expect(fixture.resolver('/tree/src')).rejects.toThrow('primary unavailable');
    await expect(setup(['/repo'], [{ project: '/repo', worktrees: [{ path: '/tree' }] }], {
      isGitRepository: async () => { throw new Error('eligibility unavailable'); },
    }).resolver('/tree/src')).rejects.toThrow('eligibility unavailable');
    expect(await fixture.resolver(null)).toBe('');
  });

  it('excludes HOME-rooted topology but keeps a supported linked listing of that repository', async () => {
    const fixture = setup(['/home/user', '/linked'], [
      { project: '/home/user', worktrees: [{ path: '/outside/tree' }] },
      { project: '/linked', primary: '/home/user', worktrees: [{ path: '/outside/tree' }] },
    ], { homeDirectory: '/home/user' });
    expect(await fixture.resolver('/outside/tree/src')).toBe(createProjectIdFromPath('/home/user'));
    expect(await fixture.resolver('/outside/tree/src')).toBe(fixture.panelOwner('/outside/tree/src'));
    expect(fixture.resolvePrimaryWorktreeRoot).toHaveBeenCalledWith('/linked');
    expect(fixture.resolvePrimaryWorktreeRoot).not.toHaveBeenCalledWith('/home/user');
    const unsupported = setup(['/home/user'], [
      { project: '/home/user', worktrees: [{ path: '/outside/tree' }] },
    ], { homeDirectory: '/home/user' });
    expect(await unsupported.resolver('/outside/tree/src')).toBe('');
    expect(await unsupported.resolver('/outside/tree/src')).toBe(unsupported.panelOwner('/outside/tree/src'));
  });

  it.each(['/home/user', '/'])('tries the next supported topology when %s is excluded', async (excluded) => {
    const fixture = setup([excluded, '/repo'], [
      { project: excluded, worktrees: [{ path: '/outside/tree/nested' }] },
      { project: '/repo', worktrees: [{ path: '/outside/tree' }] },
    ], { homeDirectory: '/home/user' });
    expect(await fixture.resolver('/outside/tree/nested/src')).toBe(createProjectIdFromPath('/repo'));
    expect(await fixture.resolver('/outside/tree/nested/src')).toBe(fixture.panelOwner('/outside/tree/nested/src'));
  });
});

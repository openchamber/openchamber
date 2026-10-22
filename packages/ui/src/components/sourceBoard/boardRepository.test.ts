import { describe, expect, test } from 'bun:test';

import { choiceForFocus, folderOfRepository, repositoryLabel, resolveBoardRepository, resolveBoardTab, resolvePullLinkTarget, shouldRememberAll } from './boardRepository';
import { repositoryUrlOfItemLink } from './openTrackerItem';
import { githubLikeDescriptor, gitlabLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { createRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';

const descriptors = [githubLikeDescriptor(), gitlabLikeDescriptor()];
const urls = createRepositoryUrlMatcher(descriptors, []);

const ROOT = '/work';
const REPOS = ['/work/app', '/work/api'];

const none = { path: null, all: undefined } as const;
const at = (status: 'pending' | 'failed' | 'ready') => ({ status, directory: ROOT, repositories: [], all: false });

describe('resolveBoardRepository', () => {
  test('reads a root that is a repository where it is, whatever lies below it', () => {
    expect(resolveBoardRepository(ROOT, true, REPOS, { path: '/work/api', all: true }, true)).toEqual(at('ready'));
    expect(resolveBoardRepository(ROOT, true, undefined, none, true)).toEqual(at('ready'));
  });

  test('has no directory without a project', () => {
    expect(resolveBoardRepository(null, null, undefined, none, true)).toEqual({ status: 'ready', directory: null, repositories: [], all: false });
  });

  test('waits on the probe and the discovery, keeping the root meanwhile', () => {
    expect(resolveBoardRepository(ROOT, null, undefined, none, true)).toEqual(at('pending'));
    expect(resolveBoardRepository(ROOT, false, undefined, none, true)).toEqual(at('pending'));
  });

  test('does not take a failed discovery for a folder without repositories', () => {
    expect(resolveBoardRepository(ROOT, false, null, none, true)).toEqual(at('failed'));
  });

  test('stays at the root when there is nothing to look in', () => {
    expect(resolveBoardRepository(ROOT, false, [], none, true)).toEqual(at('ready'));
    expect(resolveBoardRepository(ROOT, false, 'unsupported', none, true)).toEqual(at('ready'));
  });

  test('lists all repositories together by default, where the runtime can', () => {
    expect(resolveBoardRepository(ROOT, false, REPOS, none, true)).toEqual({ status: 'ready', directory: ROOT, repositories: REPOS, all: true });
    expect(resolveBoardRepository(ROOT, false, REPOS, { path: null, all: true }, true).all).toBe(true);
  });

  test('keeps a single repository remembered before "all" existed, or chosen after it', () => {
    expect(resolveBoardRepository(ROOT, false, REPOS, { path: '/work/api', all: undefined }, true))
      .toEqual({ status: 'ready', directory: '/work/api', repositories: REPOS, all: false });
    expect(resolveBoardRepository(ROOT, false, REPOS, { path: '/work/api', all: false }, true).directory).toBe('/work/api');
    expect(resolveBoardRepository(ROOT, false, REPOS, { path: '/work/api', all: true }, true).all).toBe(true);
  });

  test('falls back to a single repository where the runtime cannot list across them', () => {
    expect(resolveBoardRepository(ROOT, false, REPOS, none, false)).toEqual({ status: 'ready', directory: '/work/app', repositories: REPOS, all: false });
    expect(resolveBoardRepository(ROOT, false, REPOS, { path: '/work/api', all: true }, false).directory).toBe('/work/api');
  });

  test('picks the remembered repository, else the first', () => {
    expect(resolveBoardRepository(ROOT, false, REPOS, { path: '/work/api', all: false }, true).directory).toBe('/work/api');
    expect(resolveBoardRepository(ROOT, false, REPOS, { path: null, all: false }, true).directory).toBe('/work/app');
    expect(resolveBoardRepository(ROOT, false, REPOS, { path: '/work/gone', all: false }, true).directory).toBe('/work/app');
  });
});

describe('repositoryLabel', () => {
  test('names a repository by its path below the root', () => {
    expect(repositoryLabel('/work/team/app', ROOT)).toBe('team/app');
    expect(repositoryLabel('/elsewhere/app', ROOT)).toBe('/elsewhere/app');
  });
});

describe('resolvePullLinkTarget', () => {
  const target = (repository: string | null, currentDirectory: string | null, owned: boolean, projectPath = ROOT) => (
    resolvePullLinkTarget({ projectPath, repository, currentDirectory, owned })
  );

  test('reads a project that is a repository through the folder on screen when it is the project\'s', () => {
    expect(target(ROOT, '/work-tree', true)).toEqual({
      panelDirectory: '/work-tree', targetDirectory: null, requestDirectory: '/work-tree',
      mobileDirectory: '/work-tree', mobileRequestDirectory: '/work-tree', mobileRepository: null,
    });
  });

  test('reads another project\'s PR through its root, beside the chat on screen', () => {
    expect(target(null, '/elsewhere', false)).toEqual({
      panelDirectory: '/elsewhere', targetDirectory: ROOT, requestDirectory: ROOT,
      mobileDirectory: ROOT, mobileRequestDirectory: ROOT, mobileRepository: null,
    });
    // No chat on screen: a draft of the project opens, and the tab is its own.
    expect(target(null, null, false)).toMatchObject({ panelDirectory: ROOT, targetDirectory: null, requestDirectory: ROOT });
  });

  test('reads a repository under a root that is not one through that repository, leaving the Git selection alone', () => {
    expect(target('/work/api', ROOT, true)).toEqual({
      panelDirectory: ROOT, targetDirectory: '/work/api', requestDirectory: '/work/api',
      mobileDirectory: ROOT, mobileRequestDirectory: ROOT, mobileRepository: '/work/api',
    });
    // From another project.
    // From another repository of the project; the phone opens the project's root, which can show the PR's repository.
    expect(target('/work/api', '/work/app', true)).toMatchObject({
      panelDirectory: '/work/app', targetDirectory: '/work/api', mobileDirectory: ROOT, mobileRequestDirectory: ROOT, mobileRepository: '/work/api',
    });
    expect(target('/work/api', '/elsewhere', false)).toMatchObject({ panelDirectory: '/elsewhere', targetDirectory: '/work/api', requestDirectory: '/work/api' });
  });

  test('reads a session already in the repository as its own', () => {
    expect(target('/work/api', '/work/api', true)).toEqual({
      panelDirectory: '/work/api', targetDirectory: null, requestDirectory: '/work/api',
      mobileDirectory: '/work/api', mobileRequestDirectory: '/work/api', mobileRepository: null,
    });
  });

  test('keys the phone\'s request by the normalized folder the app shows', () => {
    expect(target('/work/api', null, false, '/work/')).toMatchObject({ mobileRequestDirectory: ROOT, mobileRepository: '/work/api', targetDirectory: '/work/api' });
  });
});

describe('folderOfRepository', () => {
  const remote = (name: string, url: string) => ({ name, fetchUrl: url, pushUrl: url });
  const github = [{ provider: 'github' as const, instance: 'github.com' }];
  const API = 'https://github.com/acme/api';

  test('finds the folder whose origin is the repository, over one that only has it as another remote', () => {
    const folders = [
      { directory: '/work/fork', remotes: [remote('origin', 'git@github.com:me/api.git'), remote('upstream', 'https://github.com/acme/api.git')] },
      { directory: '/work/api', remotes: [remote('origin', 'https://github.com/Acme/API')] },
    ];
    expect(folderOfRepository(API, folders, github, descriptors)).toBe('/work/api');
    expect(folderOfRepository(API, folders.slice(0, 1), github, descriptors)).toBe('/work/fork');
  });

  test('waits on a folder still being read unless an origin already answers', () => {
    const reading = { directory: '/work/app', remotes: null };
    expect(folderOfRepository(API, [reading, { directory: '/work/fork', remotes: [remote('upstream', 'https://github.com/acme/api.git')] }], github, descriptors)).toBeNull();
    expect(folderOfRepository(API, [reading, { directory: '/work/api', remotes: [remote('origin', 'https://github.com/acme/api.git')] }], github, descriptors)).toBe('/work/api');
  });

  test('answers none when no remote is the repository', () => {
    expect(folderOfRepository(API, [{ directory: '/work/app', remotes: [remote('origin', 'https://github.com/acme/app.git')] }, { directory: '/work/x', remotes: [] }], github, descriptors)).toBe('none');
  });
});

describe('a link focus on a project', () => {
  const single = { path: '/work/api', all: false };
  const resolve = (rootIsGitRepo: boolean | null, repos: string[] | undefined, across: boolean, focusPending: boolean) => (
    resolveBoardRepository(ROOT, rootIsGitRepo, repos, choiceForFocus(single, focusPending), across)
  );

  test('lists the folder\'s repositories together, whatever single one was chosen', () => {
    expect(resolve(false, REPOS, true, true)).toMatchObject({ status: 'ready', directory: ROOT, all: true });
    expect(resolve(false, REPOS, true, false)).toMatchObject({ directory: '/work/api', all: false });
  });

  test('leaves a root that is a repository, and a runtime that cannot list across them, as they are', () => {
    expect(resolve(true, REPOS, true, true)).toEqual({ status: 'ready', directory: ROOT, repositories: [], all: false });
    expect(resolve(false, REPOS, false, true)).toMatchObject({ directory: '/work/api', all: false });
  });

  test('is decided once the folder is known, not before', () => {
    expect(resolve(null, undefined, true, true)).toMatchObject({ status: 'pending', all: false });
    expect(resolve(false, undefined, true, true)).toMatchObject({ status: 'pending', all: false });
    expect(resolve(false, REPOS, true, true)).toMatchObject({ status: 'ready', all: true });
  });

  test('is remembered for the project only when the focus made it list all of them', () => {
    const all = resolve(false, REPOS, true, true);
    expect(shouldRememberAll(all, false, true)).toBe(true);
    expect(shouldRememberAll(all, undefined, true)).toBe(true);
    expect(shouldRememberAll(all, true, true)).toBe(false);
    expect(shouldRememberAll(all, false, false)).toBe(false);
    expect(shouldRememberAll(resolve(true, REPOS, true, true), false, true)).toBe(false);
    expect(shouldRememberAll(resolve(false, REPOS, false, true), false, true)).toBe(false);
    expect(shouldRememberAll(resolve(false, undefined, true, true), false, true)).toBe(false);
  });
});

describe('repositoryUrlOfItemLink', () => {
  test('names the repository a GitHub or GitLab link points into', () => {
    expect(repositoryUrlOfItemLink('https://github.com/Acme/API/pull/12/files', urls)).toBe('https://github.com/acme/api');
    expect(repositoryUrlOfItemLink('https://gitlab.example.com/group/sub/repo/-/merge_requests/7', urls)).toBe('https://gitlab.example.com/group/sub/repo');
    expect(repositoryUrlOfItemLink('#12', urls)).toBeNull();
  });
});

describe('resolveBoardTab', () => {
  const tab = (overrides: Partial<Parameters<typeof resolveBoardTab>[0]>) => resolveBoardTab({
    chosen: 'repository', hasRepository: false, repositoryStatus: 'ready', linear: 'disconnected', ...overrides,
  });

  test('shows the repository tab when the project has one', () => {
    expect(tab({ hasRepository: true })).toBe('repository');
    expect(tab({ hasRepository: true, linear: 'connected' })).toBe('repository');
    expect(tab({ hasRepository: true, linear: 'pending' })).toBe('repository');
  });

  test('keeps Linear when the user chose it, connected or not', () => {
    expect(tab({ chosen: 'linear', hasRepository: true })).toBe('linear');
    expect(tab({ chosen: 'linear' })).toBe('linear');
    expect(tab({ chosen: 'linear', linear: 'absent', hasRepository: true })).toBe('repository');
  });

  test('turns to Linear without a repository unless Linear is known to be disconnected', () => {
    expect(tab({ linear: 'connected' })).toBe('linear');
    expect(tab({ linear: 'unknown' })).toBe('linear');
    expect(tab({})).toBeNull();
    expect(tab({ linear: 'absent' })).toBeNull();
    expect(tab({ repositoryStatus: 'failed' })).toBeNull();
  });

  test('waits for the folder search and for Linear status before choosing', () => {
    expect(tab({ repositoryStatus: 'pending', linear: 'connected' })).toBeNull();
    expect(tab({ linear: 'pending' })).toBeNull();
  });
});

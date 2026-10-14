import { describe, expect, test } from 'bun:test';

import { repositoryLabel, resolveBoardRepository, resolvePullLinkTarget } from './boardRepository';

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
  test('keeps a project that is a repository where the app is, else at its root', () => {
    expect(resolvePullLinkTarget({ projectPath: ROOT, repository: ROOT, ownedCurrentDirectory: '/work-tree' }))
      .toEqual({ appDirectory: '/work-tree', requestDirectory: '/work-tree', mobileRequestDirectory: '/work-tree', selectNestedIn: null });
    expect(resolvePullLinkTarget({ projectPath: ROOT, repository: null, ownedCurrentDirectory: null }))
      .toEqual({ appDirectory: ROOT, requestDirectory: ROOT, mobileRequestDirectory: ROOT, selectNestedIn: null });
  });

  test('moves the root\'s Git selection to a repository under a root that is not one', () => {
    expect(resolvePullLinkTarget({ projectPath: ROOT, repository: '/work/api', ownedCurrentDirectory: ROOT }))
      .toEqual({ appDirectory: ROOT, requestDirectory: '/work/api', mobileRequestDirectory: ROOT, selectNestedIn: ROOT });
    expect(resolvePullLinkTarget({ projectPath: ROOT, repository: '/work/api', ownedCurrentDirectory: null }))
      .toEqual({ appDirectory: ROOT, requestDirectory: '/work/api', mobileRequestDirectory: ROOT, selectNestedIn: ROOT });
    // A session in another repository of the project is not where this one's views resolve.
    expect(resolvePullLinkTarget({ projectPath: ROOT, repository: '/work/api', ownedCurrentDirectory: '/work/app' }))
      .toEqual({ appDirectory: ROOT, requestDirectory: '/work/api', mobileRequestDirectory: ROOT, selectNestedIn: ROOT });
  });

  test('shows a session already in the repository as it is', () => {
    expect(resolvePullLinkTarget({ projectPath: ROOT, repository: '/work/api', ownedCurrentDirectory: '/work/api' }))
      .toEqual({ appDirectory: '/work/api', requestDirectory: '/work/api', mobileRequestDirectory: '/work/api', selectNestedIn: null });
  });

  test('keys the phone\'s request by the folder the app shows, normalized, never the repository', () => {
    const nested = resolvePullLinkTarget({ projectPath: '/work/', repository: '/work/api', ownedCurrentDirectory: null });
    expect(nested.requestDirectory).toBe('/work/api');
    expect(nested.mobileRequestDirectory).toBe('/work');
    expect(resolvePullLinkTarget({ projectPath: ROOT, repository: '/work/api', ownedCurrentDirectory: '/work/app' }).mobileRequestDirectory).toBe(ROOT);
  });
});

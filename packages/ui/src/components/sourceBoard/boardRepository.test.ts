import { describe, expect, test } from 'bun:test';

import { repositoryLabel, resolveBoardRepository, resolvePullLinkTarget } from './boardRepository';

const ROOT = '/work';
const REPOS = ['/work/app', '/work/api'];

describe('resolveBoardRepository', () => {
  test('reads a root that is a repository where it is, whatever lies below it', () => {
    expect(resolveBoardRepository(ROOT, true, REPOS, '/work/api')).toEqual({ status: 'ready', directory: ROOT, repositories: [] });
    expect(resolveBoardRepository(ROOT, true, undefined, null)).toEqual({ status: 'ready', directory: ROOT, repositories: [] });
  });

  test('has no directory without a project', () => {
    expect(resolveBoardRepository(null, null, undefined, null)).toEqual({ status: 'ready', directory: null, repositories: [] });
  });

  test('waits on the probe and the discovery, keeping the root meanwhile', () => {
    expect(resolveBoardRepository(ROOT, null, undefined, null)).toEqual({ status: 'pending', directory: ROOT, repositories: [] });
    expect(resolveBoardRepository(ROOT, false, undefined, null)).toEqual({ status: 'pending', directory: ROOT, repositories: [] });
  });

  test('does not take a failed discovery for a folder without repositories', () => {
    expect(resolveBoardRepository(ROOT, false, null, null)).toEqual({ status: 'failed', directory: ROOT, repositories: [] });
  });

  test('stays at the root when there is nothing to look in', () => {
    expect(resolveBoardRepository(ROOT, false, [], null)).toEqual({ status: 'ready', directory: ROOT, repositories: [] });
    expect(resolveBoardRepository(ROOT, false, 'unsupported', null)).toEqual({ status: 'ready', directory: ROOT, repositories: [] });
  });

  test('picks the remembered repository, else the first', () => {
    expect(resolveBoardRepository(ROOT, false, REPOS, '/work/api')).toEqual({ status: 'ready', directory: '/work/api', repositories: REPOS });
    expect(resolveBoardRepository(ROOT, false, REPOS, null).directory).toBe('/work/app');
    expect(resolveBoardRepository(ROOT, false, REPOS, '/work/gone').directory).toBe('/work/app');
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
      .toEqual({ appDirectory: '/work-tree', requestDirectory: '/work-tree', selectNestedIn: null });
    expect(resolvePullLinkTarget({ projectPath: ROOT, repository: null, ownedCurrentDirectory: null }))
      .toEqual({ appDirectory: ROOT, requestDirectory: ROOT, selectNestedIn: null });
  });

  test('moves the root\'s Git selection to a repository under a root that is not one', () => {
    expect(resolvePullLinkTarget({ projectPath: ROOT, repository: '/work/api', ownedCurrentDirectory: ROOT }))
      .toEqual({ appDirectory: ROOT, requestDirectory: '/work/api', selectNestedIn: ROOT });
    expect(resolvePullLinkTarget({ projectPath: ROOT, repository: '/work/api', ownedCurrentDirectory: null }))
      .toEqual({ appDirectory: ROOT, requestDirectory: '/work/api', selectNestedIn: ROOT });
    // A session in another repository of the project is not where this one's views resolve.
    expect(resolvePullLinkTarget({ projectPath: ROOT, repository: '/work/api', ownedCurrentDirectory: '/work/app' }))
      .toEqual({ appDirectory: ROOT, requestDirectory: '/work/api', selectNestedIn: ROOT });
  });

  test('shows a session already in the repository as it is', () => {
    expect(resolvePullLinkTarget({ projectPath: ROOT, repository: '/work/api', ownedCurrentDirectory: '/work/api' }))
      .toEqual({ appDirectory: '/work/api', requestDirectory: '/work/api', selectNestedIn: null });
  });
});

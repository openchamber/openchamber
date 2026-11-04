import { describe, expect, test } from 'bun:test';
import type { GitPublishContext } from '@/lib/boundGitNetworkOperation';
import { obviousPublishTargets } from './useGitPublishChooser';

const ENDPOINT = { displayUrl: 'https://example.com/team/repo.git', fingerprint: 'f'.repeat(64) };
const contextOf = (tracking: string | null): GitPublishContext => ({
  action: 'push',
  directory: '/repo',
  runtime: 'runtime-one',
  status: { current: 'feature', tracking, ahead: 1, behind: 0, files: [], isClean: true },
  branches: { all: [], current: 'feature', branches: {} },
  bindingRead: {
    status: 'missing',
    revision: 0,
    binding: null,
    repository: {
      repositoryId: 'repository-one',
      configRevision: 'config-one',
      bare: false,
      remotes: [{ name: 'origin', fetch: ENDPOINT, push: ENDPOINT }],
    },
  },
});

describe('obviousPublishTargets', () => {
  test('pushes a tracked branch to its upstream', () => {
    expect(obviousPublishTargets(contextOf('origin/topic')))
      .toEqual({ push: { remoteName: 'origin', ref: 'refs/heads/topic' } });
  });

  test('publishes a new branch on the only remote', () => {
    expect(obviousPublishTargets(contextOf(null)))
      .toEqual({ push: { remoteName: 'origin', ref: 'refs/heads/feature' } });
  });

  test('asks when the upstream is on a remote the list leaves out', () => {
    expect(obviousPublishTargets(contextOf('backup/feature'))).toBeNull();
  });
});

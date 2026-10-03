import { describe, expect, test } from 'bun:test';
import {
  createRemoteBranchIntegrationTargets,
  resolveBranchIntegrationRef,
  type BranchIntegrationTarget,
} from './branchIntegration';

const remoteTarget: Extract<BranchIntegrationTarget, { kind: 'remote' }> = {
  kind: 'remote',
  branch: 'release/next',
  destinationRef: 'refs/remotes/upstream/release/next',
  label: 'upstream/release/next',
  remote: 'upstream',
  sourceRef: 'refs/heads/release/next',
};

describe('branch integration authority', () => {
  test('keeps remote and branch identity explicit, including slash names', () => {
    expect(createRemoteBranchIntegrationTargets(
      ['team', 'team/upstream'],
      ['team/upstream/release/next', 'team/main', 'unknown/main'],
    )).toEqual([
      {
        kind: 'remote',
        branch: 'release/next',
        destinationRef: 'refs/remotes/team/upstream/release/next',
        label: 'team/upstream/release/next',
        remote: 'team/upstream',
        sourceRef: 'refs/heads/release/next',
      },
      {
        kind: 'remote',
        branch: 'main',
        destinationRef: 'refs/remotes/team/main',
        label: 'team/main',
        remote: 'team',
        sourceRef: 'refs/heads/main',
      },
    ]);
  });

  test('fetches the exact selected remote target and pins its fetched commit', async () => {
    const fetched: BranchIntegrationTarget[] = [];
    const sha = 'a'.repeat(40);

    const resolved = await resolveBranchIntegrationRef({
      directory: '/repo',
      target: remoteTarget,
      runPlannedFetch: async (target) => { fetched.push(target); },
      git: {
        getGitLog: async (_directory, options) => {
          expect(options).toEqual({ to: remoteTarget.destinationRef, maxCount: 1 });
          return {
            all: [],
            latest: {
              hash: sha,
              date: '',
              message: '',
              refs: '',
              body: '',
              author_name: '',
              author_email: '',
              filesChanged: 0,
              insertions: 0,
              deletions: 0,
              parents: [],
            },
            total: 1,
          };
        },
      },
    });

    expect(fetched).toEqual([remoteTarget]);
    expect(resolved).toBe(sha);
  });

  test('keeps an explicitly selected local branch local', async () => {
    let fetches = 0;
    let logReads = 0;
    const target: BranchIntegrationTarget = { kind: 'local', branch: 'main', label: 'main' };

    const resolved = await resolveBranchIntegrationRef({
      directory: '/repo',
      target,
      runPlannedFetch: async () => { fetches += 1; },
      git: {
        getGitLog: async () => {
          logReads += 1;
          return { all: [], latest: null, total: 0 };
        },
      },
    });

    expect(resolved).toBe('main');
    expect(fetches).toBe(0);
    expect(logReads).toBe(0);
  });

  test('does not integrate a remote-tracking name when its fetched SHA is unavailable', async () => {
    await expect(resolveBranchIntegrationRef({
      directory: '/repo',
      target: remoteTarget,
      runPlannedFetch: async () => undefined,
      git: { getGitLog: async () => ({ all: [], latest: null, total: 0 }) },
    })).rejects.toThrow('invalid-terminal-state');
  });
});

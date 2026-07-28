import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkPullRequestSourceAvailability,
} from '../src/availability.js';
import { checkRemoteBranchExists, fetchRemoteBranchRef } from '../src/remote.js';
import type { PullRequestSourceInput } from '../src/types.js';

import {
  commitEmptyOnBranch,
  createTempGitRepo,
  type TempGitRepo,
} from './_fixtures.js';

const buildSource = (overrides: Partial<PullRequestSourceInput> = {}): PullRequestSourceInput => ({
  pullRequest: { number: 42, sourceRef: 'refs/pull/42/head' },
  headBranch: 'feature/cool',
  baseRemote: 'origin',
  fork: null,
  ...overrides,
});

describe('checkRemoteBranchExists', () => {
  let repo: TempGitRepo;

  beforeEach(async () => {
    repo = await createTempGitRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns found:true against a configured remote with the branch', async () => {
    // Use the local repo as its own "remote" by pointing the remote at
    // a file:// URL of itself.
    const fileUrl = `file://${repo.path}`;
    const add = await repo.runner.run(repo.path, ['remote', 'add', 'origin', fileUrl]);
    expect(add.success).toBe(true);
    const fetch = await repo.runner.run(repo.path, ['fetch', 'origin']);
    expect(fetch.success).toBe(true);

    const result = await checkRemoteBranchExists(repo.runner, repo.path, 'origin', 'main');
    expect(result).toEqual({ success: true, found: true });
  });

  it('returns found:false for a missing branch', async () => {
    const result = await checkRemoteBranchExists(repo.runner, repo.path, 'origin', 'no-such-branch');
    // success:false because the remote isn't configured locally.
    expect(result.found).toBe(false);
  });

  it('returns found:false for an empty branch name without throwing', async () => {
    const result = await checkRemoteBranchExists(repo.runner, repo.path, 'origin', '   ');
    expect(result).toEqual({ success: false, found: false });
  });
});

describe('fetchRemoteBranchRef', () => {
  let repo: TempGitRepo;
  let other: TempGitRepo;

  beforeEach(async () => {
    repo = await createTempGitRepo();
    other = await createTempGitRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
    await other.cleanup();
  });

  it('fetches a branch from a remote', async () => {
    await commitEmptyOnBranch(other, 'feature', 'remote branch');
    const add = await repo.runner.run(repo.path, ['remote', 'add', 'upstream', `file://${other.path}`]);
    expect(add.success).toBe(true);

    await fetchRemoteBranchRef(repo.runner, repo.path, 'upstream', 'feature');

    const showRef = await repo.runner.run(repo.path, ['show-ref', '--verify', '--quiet', 'refs/remotes/upstream/feature']);
    expect(showRef.success).toBe(true);
  });

  it('is a no-op when remote or branch is blank', async () => {
    await expect(fetchRemoteBranchRef(repo.runner, repo.path, '', 'feature')).resolves.toBeUndefined();
    await expect(fetchRemoteBranchRef(repo.runner, repo.path, 'upstream', '')).resolves.toBeUndefined();
  });

  it('throws when the fetch fails', async () => {
    await expect(
      fetchRemoteBranchRef(repo.runner, repo.path, 'nonexistent-remote', 'main'),
    ).rejects.toThrow();
  });
});

describe('checkPullRequestSourceAvailability', () => {
  let repo: TempGitRepo;

  beforeEach(async () => {
    repo = await createTempGitRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns null when source is missing', async () => {
    const result = await checkPullRequestSourceAvailability(
      repo.runner,
      repo.path,
      null as unknown as PullRequestSourceInput,
    );
    expect(result).toBeNull();
  });

  it('returns the fork upstream when the fork has the head branch', async () => {
    const other = await createTempGitRepo();
    try {
      await commitEmptyOnBranch(other, 'feature/cool', 'fork branch');
      const add = await repo.runner.run(repo.path, [
        'remote',
        'add',
        'fork',
        `file://${other.path}`,
      ]);
      expect(add.success).toBe(true);
      const fetch = await repo.runner.run(repo.path, ['fetch', 'fork']);
      expect(fetch.success).toBe(true);

      const result = await checkPullRequestSourceAvailability(
        repo.runner,
        repo.path,
        buildSource({
          fork: { remote: 'fork', url: `file://${other.path}`, branch: 'feature/cool' },
        }),
      );
      expect(result).toEqual({
        headBranch: 'feature/cool',
        upstream: { remote: 'fork', branch: 'feature/cool' },
      });
    } finally {
      await other.cleanup();
    }
  });

  it('falls back to baseRemote when fork is missing or lacks the branch', async () => {
    // Make the base remote reachable via file:// pointing at ourselves,
    // and synthesize refs/pull/42/head by pushing a SHA from HEAD to
    // that ref on the remote side.
    const fileUrl = `file://${repo.path}`;
    const add = await repo.runner.run(repo.path, ['remote', 'add', 'origin', fileUrl]);
    expect(add.success).toBe(true);

    const headSha = (await repo.runner.run(repo.path, ['rev-parse', 'HEAD'])).stdout.trim();
    const push = await repo.runner.run(repo.path, [
      'push',
      'origin',
      `${headSha}:refs/pull/42/head`,
    ]);
    expect(push.success).toBe(true);

    const result = await checkPullRequestSourceAvailability(repo.runner, repo.path, buildSource());
    expect(result).toEqual({
      headBranch: 'feature/cool',
      upstream: null,
    });
  });

  it('returns null when neither path is reachable', async () => {
    const result = await checkPullRequestSourceAvailability(
      repo.runner,
      repo.path,
      buildSource({ baseRemote: 'no-such-remote' }),
    );
    expect(result).toBeNull();
  });
});

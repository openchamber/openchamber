import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PullRequestSourceUnavailableError } from '../src/errors.js';
import { resolvePullRequestSource } from '../src/resolvePullRequestSource.js';
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

describe('resolvePullRequestSource', () => {
  let repo: TempGitRepo;

  beforeEach(async () => {
    repo = await createTempGitRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns fork source with upstream when fork has the branch', async () => {
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

      const result = await resolvePullRequestSource(
        repo.runner,
        repo.path,
        buildSource({
          fork: { remote: 'fork', url: `file://${other.path}`, branch: 'feature/cool' },
        }),
      );
      expect(result).toEqual({
        checkoutRef: 'refs/remotes/fork/feature/cool',
        headBranch: 'feature/cool',
        upstream: { remote: 'fork', branch: 'feature/cool' },
      });
    } finally {
      await other.cleanup();
    }
  });

  it('falls back to base remote when fork is missing', async () => {
    // Configure origin as a self-loop and synthesise refs/pull/<n>/head.
    const add = await repo.runner.run(repo.path, ['remote', 'add', 'origin', `file://${repo.path}`]);
    expect(add.success).toBe(true);

    // Create a refs/pull/42/head on origin via fetch (using a known SHA).
    const headSha = (await repo.runner.run(repo.path, ['rev-parse', 'HEAD'])).stdout.trim();
    // Push the ref so origin exposes it.
    const push = await repo.runner.run(repo.path, [
      'push',
      'origin',
      `${headSha}:refs/pull/42/head`,
    ]);
    expect(push.success).toBe(true);

    const result = await resolvePullRequestSource(repo.runner, repo.path, buildSource());
    expect(result).toEqual({
      checkoutRef: 'refs/remotes/origin/pull/42/head',
      headBranch: 'feature/cool',
      upstream: null,
    });
  });

  it('throws PullRequestSourceUnavailableError when neither path is reachable', async () => {
    await expect(
      resolvePullRequestSource(
        repo.runner,
        repo.path,
        buildSource({ baseRemote: 'no-such-remote' }),
      ),
    ).rejects.toBeInstanceOf(PullRequestSourceUnavailableError);
  });

  it('throws PullRequestSourceUnavailableError when fork has no matching branch and base is unreachable', async () => {
    // Empty repo with no remotes configured.
    await expect(
      resolvePullRequestSource(
        repo.runner,
        repo.path,
        buildSource({
          fork: { remote: 'fork', url: `file://${repo.path}`, branch: 'no-such-branch' },
          baseRemote: '',
        }),
      ),
    ).rejects.toBeInstanceOf(PullRequestSourceUnavailableError);
  });
});

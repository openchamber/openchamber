import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createChildProcessGitRunner } from '../src/gitRunner.js';
import { resolvePullRequestForkRemote } from '../src/resolvePullRequestForkRemote.js';
import type { PullRequestSourceInput } from '../src/types.js';

import { createTempGitRepo, type TempGitRepo } from './_fixtures.js';

const buildSource = (overrides: Partial<PullRequestSourceInput> = {}): PullRequestSourceInput => ({
  pullRequest: { number: 42, sourceRef: 'refs/pull/42/head' },
  headBranch: 'feature/cool',
  baseRemote: 'origin',
  fork: {
    remote: 'fork',
    url: 'git@github.com:fork/repo.git',
    branch: 'feature/cool',
  },
  ...overrides,
});

describe('resolvePullRequestForkRemote', () => {
  let repo: TempGitRepo;

  beforeEach(async () => {
    repo = await createTempGitRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns null when source has no fork', async () => {
    const result = await resolvePullRequestForkRemote(
      repo.runner,
      repo.path,
      buildSource({ fork: null }),
    );
    expect(result).toBeNull();
  });

  it('reuses the preferred remote when its URL already matches', async () => {
    const existing = await repo.runner.run(repo.path, [
      'remote',
      'add',
      'fork',
      'git@github.com:fork/repo.git',
    ]);
    expect(existing.success).toBe(true);

    const result = await resolvePullRequestForkRemote(repo.runner, repo.path, buildSource());
    expect(result).toEqual({
      remote: 'fork',
      url: 'git@github.com:fork/repo.git',
      branch: 'feature/cool',
    });
  });

  it('skips the preferred remote when its URL differs and uses a suffixed name', async () => {
    const existing = await repo.runner.run(repo.path, [
      'remote',
      'add',
      'fork',
      'git@github.com:other/repo.git',
    ]);
    expect(existing.success).toBe(true);

    const result = await resolvePullRequestForkRemote(repo.runner, repo.path, buildSource());
    expect(result?.remote).toBe('fork-pr-42');
    expect(result?.url).toBe('git@github.com:fork/repo.git');

    const verify = await repo.runner.run(repo.path, ['remote', 'get-url', 'fork-pr-42']);
    expect(verify.success).toBe(true);
    expect(verify.stdout.trim()).toBe('git@github.com:fork/repo.git');
  });

  it('avoids the baseRemote name and allocates a suffixed remote instead', async () => {
    const base = await repo.runner.run(repo.path, [
      'remote',
      'add',
      'origin',
      'git@github.com:base/repo.git',
    ]);
    expect(base.success).toBe(true);

    const result = await resolvePullRequestForkRemote(
      repo.runner,
      repo.path,
      buildSource({ fork: { remote: 'origin', url: 'git@github.com:fork/repo.git', branch: 'feature/cool' } }),
    );
    expect(result?.remote).toBe('origin-pr-42');
    // The base remote's URL must NOT have been overwritten.
    const verifyBase = await repo.runner.run(repo.path, ['remote', 'get-url', 'origin']);
    expect(verifyBase.stdout.trim()).toBe('git@github.com:base/repo.git');
  });

  it('avoids remotes that already exist with the desired name', async () => {
    // Pre-create the preferred name `fork` AND the first suffixed name
    // `fork-pr-42` with conflicting URLs so the allocator must walk past
    // both and pick `fork-pr-42-2`.
    for (const name of ['fork', 'fork-pr-42']) {
      const taken = await repo.runner.run(repo.path, [
        'remote',
        'add',
        name,
        'git@github.com:other/repo.git',
      ]);
      expect(taken.success).toBe(true);
    }

    const result = await resolvePullRequestForkRemote(repo.runner, repo.path, buildSource());
    expect(result?.remote).toBe('fork-pr-42-2');

    // The pre-existing remote URLs must NOT have been overwritten.
    for (const name of ['fork', 'fork-pr-42']) {
      const verify = await repo.runner.run(repo.path, ['remote', 'get-url', name]);
      expect(verify.stdout.trim()).toBe('git@github.com:other/repo.git');
    }
  });

  it('returns null when all candidate names are exhausted by non-matching remotes', async () => {
    // Block all 100 candidates by pre-creating them with different URLs.
    const names = ['fork', ...Array.from({ length: 100 }, (_, index) => {
      const suffix = index === 0 ? '' : `-${index + 1}`;
      return `fork-pr-42${suffix}`;
    })];

    for (const name of names) {
      const add = await repo.runner.run(repo.path, [
        'remote',
        'add',
        name,
        `git@github.com:other/${name}.git`,
      ]);
      expect(add.success).toBe(true);
    }

    const result = await resolvePullRequestForkRemote(repo.runner, repo.path, buildSource());
    expect(result).toBeNull();
  });
});

describe('createChildProcessGitRunner smoke', () => {
  let repo: TempGitRepo;

  beforeEach(async () => {
    repo = await createTempGitRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns success for a passing command', async () => {
    const runner = createChildProcessGitRunner();
    const result = await runner.run(repo.path, ['rev-parse', '--is-inside-work-tree']);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('true');
  });

  it('returns failure for a failing command without throwing', async () => {
    const runner = createChildProcessGitRunner();
    const result = await runner.run(repo.path, ['cat-file', '-e', 'nonexistent']);
    expect(result.success).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });
});

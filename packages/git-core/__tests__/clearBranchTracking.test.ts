import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearBranchTracking } from '../src/clearBranchTracking.js';

import { createTempGitRepo, type TempGitRepo } from './_fixtures.js';

describe('clearBranchTracking', () => {
  let repo: TempGitRepo;

  beforeEach(async () => {
    repo = await createTempGitRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('clears branch.<name>.remote and branch.<name>.merge when set', async () => {
    const setRemote = await repo.runner.run(repo.path, [
      'config',
      'branch.main.remote',
      'origin',
    ]);
    expect(setRemote.success).toBe(true);
    const setMerge = await repo.runner.run(repo.path, [
      'config',
      'branch.main.merge',
      'refs/heads/main',
    ]);
    expect(setMerge.success).toBe(true);

    await clearBranchTracking(repo.runner, repo.path, 'main');

    const readRemote = await repo.runner.run(repo.path, [
      'config',
      '--get',
      'branch.main.remote',
    ]);
    expect(readRemote.success).toBe(false);
    const readMerge = await repo.runner.run(repo.path, [
      'config',
      '--get',
      'branch.main.merge',
    ]);
    expect(readMerge.success).toBe(false);
  });

  it('is a no-op when keys are not configured', async () => {
    await expect(
      clearBranchTracking(repo.runner, repo.path, 'main'),
    ).resolves.toBeUndefined();
  });

  it('is a no-op for an empty branch name', async () => {
    await expect(
      clearBranchTracking(repo.runner, repo.path, ''),
    ).resolves.toBeUndefined();
  });

  it('clears only the keys that exist when one is missing', async () => {
    const setRemote = await repo.runner.run(repo.path, [
      'config',
      'branch.main.remote',
      'origin',
    ]);
    expect(setRemote.success).toBe(true);

    await clearBranchTracking(repo.runner, repo.path, 'main');

    const readRemote = await repo.runner.run(repo.path, [
      'config',
      '--get',
      'branch.main.remote',
    ]);
    expect(readRemote.success).toBe(false);
  });
});

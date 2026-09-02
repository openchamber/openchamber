import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createChildProcessGitRunner } from '../src/gitRunner.js';
import type { GitRunner } from '../src/types.js';

const execFileAsync = promisify(execFile);

export interface TempGitRepo {
  path: string;
  runner: GitRunner;
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated temp git repository with a single initial commit.
 * Uses `git init`, configures a local user identity, and commits a
 * throwaway file so subsequent `git show-ref`/`fetch` calls have
 * something to operate on.
 */
export const createTempGitRepo = async (): Promise<TempGitRepo> => {
  const path = await mkdtemp(join(tmpdir(), 'openchamber-git-core-'));

  const baseEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    // Disable any global hooks the host machine may have installed.
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };

  await execFileAsync('git', ['init', '--initial-branch=main', path], { env: baseEnv });

  const runner = createChildProcessGitRunner({ env: baseEnv });

  await writeFile(join(path, 'README.md'), '# test\n');
  await runner.run(path, ['add', 'README.md']);
  const commit = await runner.run(path, ['commit', '-m', 'init']);
  if (!commit.success) {
    await rm(path, { recursive: true, force: true });
    throw new Error(`failed to seed temp repo: ${commit.message ?? 'unknown error'}`);
  }

  const cleanup = async () => {
    await rm(path, { recursive: true, force: true });
  };

  return { path, runner, cleanup };
};

/**
 * Seed a branch with one commit pointing at `parentSha^` (or HEAD when
 * `parentSha` is null). Returns the new commit SHA.
 */
export const seedBranch = async (
  repo: TempGitRepo,
  branchName: string,
  parentSha: string | null = null,
): Promise<string> => {
  const base = parentSha ?? 'HEAD';
  const write = await repo.runner.run(repo.path, ['commit', '--allow-empty', '-m', `seed ${branchName}`]);
  if (!write.success) {
    throw new Error(`failed to seed commit: ${write.message ?? 'unknown'}`);
  }
  const branch = await repo.runner.run(repo.path, ['branch', branchName, base]);
  if (!branch.success) {
    throw new Error(`failed to create branch ${branchName}: ${branch.message ?? 'unknown'}`);
  }
  const head = await repo.runner.run(repo.path, ['rev-parse', 'HEAD']);
  if (!head.success) {
    throw new Error(`failed to read HEAD: ${head.message ?? 'unknown'}`);
  }
  return head.stdout.trim();
};

export const commitEmptyOnBranch = async (
  repo: TempGitRepo,
  branchName: string,
  message: string,
): Promise<string> => {
  // Create the branch first (cheap/fast-forward create); only commit when
  // it already exists or when the caller wants a fresh commit.
  const createBranch = await repo.runner.run(repo.path, [
    'branch',
    branchName,
    'HEAD',
  ]);
  if (!createBranch.success) {
    throw new Error(`branch ${branchName} failed: ${createBranch.message ?? 'unknown'}`);
  }
  const checkout = await repo.runner.run(repo.path, ['checkout', branchName]);
  if (!checkout.success) {
    throw new Error(`checkout ${branchName} failed: ${checkout.message ?? 'unknown'}`);
  }
  const commit = await repo.runner.run(repo.path, ['commit', '--allow-empty', '-m', message]);
  if (!commit.success) {
    throw new Error(`commit failed: ${commit.message ?? 'unknown'}`);
  }
  const head = await repo.runner.run(repo.path, ['rev-parse', 'HEAD']);
  if (!head.success) {
    throw new Error(`rev-parse failed: ${head.message ?? 'unknown'}`);
  }
  return head.stdout.trim();
};

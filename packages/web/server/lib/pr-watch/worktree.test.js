import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupProjectsOf, isPullRequestWorktree } from './worktree.js';

const GIT_IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...args) => execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, stdio: 'ignore' });

let root;

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('cleanupProjectsOf', () => {
  it('lists the projects while merged-worktree cleanup is on, and nothing while it is off', () => {
    const projects = [{ id: 'a', path: '/repo' }];
    expect(cleanupProjectsOf({ mergedWorktreeCleanupEnabled: true, projects })).toEqual(['/repo']);
    expect(cleanupProjectsOf({ mergedWorktreeCleanupEnabled: false, projects })).toBeNull();
    expect(cleanupProjectsOf(null)).toBeNull();
  });
});

describe('isPullRequestWorktree', () => {
  it.each([
    ['git@github.com:acme/app.git', 'Acme/App', true],
    ['git@github-alias:Acme/App', 'acme/app', true],
    ['ssh://git@github.com:2222/acme/app.git', 'acme/app', true],
    ['https://github.com/acme/app.git/', 'acme/app', true],
    ['https://gitlab.example.com/group/sub/app.git', 'group/sub/app', true],
    ['git@github.com:acme/app-docs.git', 'acme/app', false],
  ])('reads the repository of remote %s', async (remote, repository, expected) => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-pr-worktree-'));
    const project = path.join(root, 'app');
    const worktree = path.join(root, 'app-fix');
    git(root, 'init', '-q', '-b', 'main', project);
    git(project, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(project, 'remote', 'add', 'origin', remote);
    git(project, 'worktree', 'add', '-q', '-b', 'fix', worktree);

    await expect(isPullRequestWorktree({
      directory: worktree, branch: 'fix', repository, projects: [project], provider: 'github', instance: 'github.com', readBinding: undefined,
    })).resolves.toBe(expected);
  });
});

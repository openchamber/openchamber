import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLocalRevision, readUpstreamBranch } from './local-revision.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const CHANGE_ID = 'I8473b95934b5732ac55d26311a706c9c2bde9940';

async function repository() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-gerrit-local-'));
  directories.push(directory);
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'master');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Base');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', `Add login form\n\nChange-Id: ${CHANGE_ID}`);
  return { directory, git };
}

describe('Gerrit local revision', () => {
  it('reads the branch tip and its Change-Id trailer', async () => {
    const { directory, git } = await repository();
    await expect(readLocalRevision(directory, 'master')).resolves.toEqual({ sha: git('rev-parse', 'HEAD').trim(), changeId: CHANGE_ID });
  });

  it('answers no Change-Id for a tip without the trailer, and rejects a missing branch', async () => {
    const { directory, git } = await repository();
    git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'No trailer');
    await expect(readLocalRevision(directory, 'master')).resolves.toMatchObject({ changeId: null });
    await expect(readLocalRevision(directory, 'missing')).rejects.toBeTruthy();
  });

  it('reads the branch a branch tracks on the primary remote only, whatever the remote is named', async () => {
    const { directory, git } = await repository();
    const base = git('rev-parse', 'HEAD').trim();
    for (const remote of ['team/gerrit', 'mirror']) {
      git('remote', 'add', remote, 'https://review.example.com/a/app');
      git('update-ref', `refs/remotes/${remote}/release/1.0`, base);
    }
    git('branch', '-q', 'login');
    git('branch', '-q', '--set-upstream-to=team/gerrit/release/1.0', 'login');
    git('branch', '-q', 'other');
    git('branch', '-q', '--set-upstream-to=mirror/release/1.0', 'other');

    // Not checked out, and a remote with a slash in its name.
    await expect(readUpstreamBranch(directory, 'login', 'team/gerrit')).resolves.toBe('release/1.0');
    // Tracks a remote that is not the primary one.
    await expect(readUpstreamBranch(directory, 'other', 'team/gerrit')).resolves.toBeNull();
    // No upstream, no such branch, an argument Git would read as something else.
    await expect(readUpstreamBranch(directory, 'master', 'team/gerrit')).resolves.toBeNull();
    await expect(readUpstreamBranch(directory, 'missing', 'team/gerrit')).resolves.toBeNull();
    await expect(readUpstreamBranch(directory, '--all', 'team/gerrit')).resolves.toBeNull();
    await expect(readUpstreamBranch(directory, 'login', null)).resolves.toBeNull();
  });
});

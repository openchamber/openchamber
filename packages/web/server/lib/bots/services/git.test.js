import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { configureBotWorktreeIdentity, readBotGitSnapshot, publishBotGit } from './git.js';
import { resolveRepositoryIdentity } from '../../source-control/repository-identity.js';
import { disconnectedPolicy, enterprisePolicy } from './http.test-support.js';

const run = promisify(execFile);
const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
const git = async (directory, ...args) => (await run('git', args, { cwd: directory,
  env: { PATH: process.env.PATH, GIT_MASTER: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
})).stdout.trim();
const checkout = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-git-test-'));
  directories.push(directory);
  await git(directory, 'init', '-q', '-b', 'main');
  await git(directory, 'config', 'user.name', 'Original User');
  await git(directory, 'config', 'user.email', 'original@example.test');
  await git(directory, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'Base');
  const baseSha = await git(directory, 'rev-parse', 'HEAD');
  const worktree = path.join(directory, 'item');
  await git(directory, 'worktree', 'add', '-q', '-b', 'bot/item-one', worktree, baseSha);
  return { directory, worktree, baseSha };
};

it('keeps commit authors local to the linked worktree and exports an exact linear snapshot', async () => {
  const { directory, worktree, baseSha } = await checkout();
  await configureBotWorktreeIdentity({ directory: worktree, name: 'Developer Bot', email: 'bot@example.test' });
  expect(await git(directory, 'config', 'user.name')).toBe('Original User');
  expect(await git(directory, 'config', 'user.email')).toBe('original@example.test');
  expect(await git(worktree, 'config', 'user.name')).toBe('Developer Bot');
  await fs.writeFile(path.join(worktree, 'fix.js'), 'fixed\n');
  await git(worktree, 'add', 'fix.js');
  await git(worktree, 'commit', '-qm', 'Fix');
  const headSha = await git(worktree, 'rev-parse', 'HEAD');
  const snapshot = await readBotGitSnapshot({ directory: worktree, branch: 'bot/item-one', baseSha, headSha });
  expect(snapshot.commits).toHaveLength(1);
  expect(snapshot.commits[0]).toMatchObject({ sourceSha: headSha, files: [{ path: 'fix.js', mode: '100644' }] });
  expect(Buffer.from(snapshot.commits[0].files[0].content, 'base64').toString()).toBe('fixed\n');
  await expect(configureBotWorktreeIdentity({ directory, name: 'Bad', email: 'bad@example.test' })).rejects.toMatchObject({ code: 'BOT_GIT_WORKTREE_REQUIRED' });
});

it('uses one-operation credentials without a token in process argv or environment and cleans temporary state', async () => {
  const { directory, worktree, baseSha } = await checkout();
  await git(worktree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Change', '--allow-empty');
  const headSha = await git(worktree, 'rev-parse', 'HEAD');
  const repository = await resolveRepositoryIdentity(directory);
  let spawned;
  const input = { directory: worktree, branch: 'bot/item-one', baseSha, headSha, base: 'main', expectedRemoteSha: null };
  const args = { credential: { definition: { kind: 'github-account' }, gitToken: 'must-stay-private', assertCurrent: async () => {} },
    target: { repositoryId: repository.repositoryId, owner: 'acme', repo: 'example' }, input,
    readBranch: async () => null, readRules: async () => ({ headSha: baseSha, requiredSignatures: false }),
    policyOptions: disconnectedPolicy, pushProcess: async (...values) => { spawned = values; return { stdout: '', stderr: '' }; },
  };
  await expect(publishBotGit(args)).resolves.toMatchObject({ headSha });
  expect(spawned[0]).toBe('git');
  expect(JSON.stringify(spawned)).not.toContain('must-stay-private');
  expect(spawned[1]).toContain('http.followRedirects=false');
  expect(spawned[1]).toContain('--force-with-lease=refs/heads/bot/item-one:');
  expect(spawned[2]).toMatchObject({ shell: false, windowsHide: true });
  await expect(fs.stat(spawned[2].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  spawned = null;
  await expect(publishBotGit({ ...args, policyOptions: enterprisePolicy([]) })).rejects.toMatchObject({ code: 'enterprise_mode' });
  expect(spawned).toBeNull();
});

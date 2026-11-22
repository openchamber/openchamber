import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseRawBranchListing,
  parseRemoteDefaultBranches,
  RAW_BRANCH_LISTING_ARGS,
  REMOTE_DEFAULT_BRANCHES_ARGS,
} from './gitBranchListing';

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const createForkClone = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-branch-listing-'));
  tempDirs.push(dir);
  git(dir, ['init', '-b', 'feature']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  for (const ref of ['origin/main', 'upstream/dev', 'upstream/main', 'mirror/main']) {
    git(dir, ['update-ref', `refs/remotes/${ref}`, 'HEAD']);
  }
  git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  git(dir, ['symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/dev']);
  git(dir, ['symbolic-ref', 'refs/remotes/origin/stable', 'refs/remotes/origin/main']);
  return dir;
};

test('reports the default branch of each remote with a known HEAD and none for a remote without one', () => {
  const dir = createForkClone();

  assert.deepEqual(parseRemoteDefaultBranches(git(dir, REMOTE_DEFAULT_BRANCHES_ARGS)), { origin: 'main', upstream: 'dev' });
});

test('reports no defaults when no remote HEAD is known', () => {
  const dir = createForkClone();
  git(dir, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
  git(dir, ['symbolic-ref', '--delete', 'refs/remotes/upstream/HEAD']);

  assert.deepEqual(parseRemoteDefaultBranches(git(dir, REMOTE_DEFAULT_BRANCHES_ARGS)), {});
});

test('lists remote branches with the remotes/ prefix, keeps other symbolic remote refs and leaves out remote HEAD aliases', () => {
  const dir = createForkClone();

  const listing = parseRawBranchListing(git(dir, RAW_BRANCH_LISTING_ARGS));

  assert.equal(listing.current, 'feature');
  assert.deepEqual([...listing.all].sort(), [
    'feature',
    'remotes/mirror/main',
    'remotes/origin/main',
    'remotes/origin/stable',
    'remotes/upstream/dev',
    'remotes/upstream/main',
  ]);
  assert.equal(listing.branches['remotes/upstream/dev']?.label, 'upstream/dev');
  assert.equal(listing.branches.feature?.current, true);
});

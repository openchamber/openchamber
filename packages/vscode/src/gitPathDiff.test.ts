import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execGit } from './bridge-git-process-runtime';
import { readSubmoduleState, resolveGitPathTarget } from './gitPathDiff';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// The submodule cases spawn about twenty git commands. Each takes a few hundred
// milliseconds on Windows, which alone passes Bun's 5 s default.
const SUBMODULE_TIMEOUT = { timeout: 60_000 };

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const createRepository = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-path-diff-'));
  tempDirs.push(dir);
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'tracked\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
};

test('a status path that no longer exists is unavailable, while a deleted tracked file still diffs', async () => {
  const repository = createRepository();
  assert.deepEqual(await resolveGitPathTarget(execGit, repository, 'removed.txt'), {
    kind: 'unavailable',
    reason: 'path_not_found',
    message: 'Path not found in working tree, index, or HEAD: removed.txt',
  });
  fs.rmSync(path.join(repository, 'tracked.txt'));
  assert.deepEqual(await resolveGitPathTarget(execGit, repository, 'tracked.txt'), {
    kind: 'file',
    repoPath: 'tracked.txt',
    absolutePath: path.join(repository, 'tracked.txt'),
  });
});

test('a nested repository listed as a directory is unavailable', async () => {
  const repository = createRepository();
  const nested = path.join(repository, 'nested');
  fs.mkdirSync(nested);
  git(nested, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(nested, 'inner.txt'), 'inner\n');
  assert.match(git(repository, ['status', '--porcelain', '-uall']), /\?\? nested\//);
  const target = await resolveGitPathTarget(execGit, repository, 'nested/');
  assert.equal(target.kind === 'unavailable' ? target.reason : target.kind, 'nested_repository');
});

test('a submodule with only untracked files reports them although its patch is empty', SUBMODULE_TIMEOUT, async () => {
  const repository = createRepository();
  const library = createRepository();
  git(repository, ['-c', 'protocol.file.allow=always', 'submodule', 'add', library, 'sub']);
  git(repository, ['commit', '-m', 'add submodule']);
  const recorded = git(repository, ['rev-parse', 'HEAD:sub']).trim();
  fs.writeFileSync(path.join(repository, 'sub', 'scratch.txt'), 'scratch\n');

  const target = await resolveGitPathTarget(execGit, repository, 'sub');
  if (target.kind !== 'submodule') assert.fail(`expected a submodule, got ${target.kind}`);
  assert.equal(git(repository, ['diff', '--', 'sub']), '');
  assert.deepEqual(await readSubmoduleState(execGit, repository, target), {
    headCommit: recorded,
    indexCommit: recorded,
    worktreeCommit: recorded,
    hasTrackedChanges: false,
    hasUntrackedFiles: true,
    hasConflict: false,
  });

  // From a subfolder, paths are relative to it; HEAD lookups must not resolve from the root.
  const subfolder = path.join(repository, 'vendor');
  fs.mkdirSync(subfolder);
  git(repository, ['mv', 'sub', 'vendor/sub']);
  git(repository, ['commit', '-m', 'move submodule']);
  fs.rmSync(path.join(subfolder, 'sub', 'scratch.txt'));
  const nestedTarget = await resolveGitPathTarget(execGit, subfolder, 'sub');
  if (nestedTarget.kind !== 'submodule') assert.fail(`expected a submodule, got ${nestedTarget.kind}`);
  assert.equal((await readSubmoduleState(execGit, subfolder, nestedTarget)).headCommit, recorded);
});

test('a submodule in a merge conflict reports the conflict instead of an unchanged commit', SUBMODULE_TIMEOUT, async () => {
  const repository = createRepository();
  const library = createRepository();
  const libraryHead = git(library, ['rev-parse', 'HEAD']).trim();
  git(library, ['checkout', '-q', '-b', 'left']);
  git(library, ['commit', '-q', '--allow-empty', '-m', 'left']);
  git(library, ['checkout', '-q', '-b', 'right', libraryHead]);
  git(library, ['commit', '-q', '--allow-empty', '-m', 'right']);
  git(library, ['checkout', '-q', 'main']);
  git(repository, ['-c', 'protocol.file.allow=always', 'submodule', 'add', library, 'sub']);
  git(repository, ['commit', '-m', 'add submodule']);
  const submodule = path.join(repository, 'sub');
  git(repository, ['checkout', '-q', '-b', 'other']);
  git(submodule, ['checkout', '-q', 'right']);
  git(repository, ['add', 'sub']);
  git(repository, ['commit', '-qm', 'other']);
  git(repository, ['checkout', '-q', 'main']);
  git(submodule, ['checkout', '-q', 'left']);
  git(repository, ['add', 'sub']);
  git(repository, ['commit', '-qm', 'main']);
  assert.throws(() => git(repository, ['merge', 'other']));

  const target = await resolveGitPathTarget(execGit, repository, 'sub');
  if (target.kind !== 'submodule') assert.fail(`expected a submodule, got ${target.kind}`);
  const state = await readSubmoduleState(execGit, repository, target);
  assert.equal(state.hasConflict, true);
  assert.equal(state.indexCommit, null);
  assert.equal(state.headCommit, git(repository, ['rev-parse', 'HEAD:sub']).trim());
});

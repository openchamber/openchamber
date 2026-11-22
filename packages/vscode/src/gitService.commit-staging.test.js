import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { createGitCommit } = await import('./gitService.ts?commit-staging-test');

const tempDirs = [];
const originalPath = process.env.PATH || '';
const realGitPath = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

const runGit = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const canRunGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const makeTempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const makeRepo = () => {
  const dir = makeTempDir('openchamber-vscode-commit-staging-');
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    fs.writeFileSync(path.join(dir, name), 'base\n');
  }
  runGit(dir, ['add', 'a.txt', 'b.txt', 'c.txt']);
  runGit(dir, ['commit', '-m', 'root']);
  const root = runGit(dir, ['rev-parse', 'HEAD']).trim();
  return { dir, root };
};

const modify = (dir, name, content) => {
  fs.writeFileSync(path.join(dir, name), content);
};

const headSubject = (dir) => runGit(dir, ['log', '-1', '--format=%s']).trim();
const headHash = (dir) => runGit(dir, ['rev-parse', 'HEAD']).trim();
const stagedPaths = (dir) => runGit(dir, ['diff', '--cached', '--name-only']).trim().split('\n').filter(Boolean).sort();
const commitPaths = (dir) => runGit(dir, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').filter(Boolean).sort();

/**
 * Put a `git` wrapper first on PATH that fails the named subcommand.
 * When `matchArg` is set, only invocations carrying that argument fail.
 */
const installFailingGit = (subcommand, matchArg) => {
  const binDir = makeTempDir('openchamber-vscode-git-shim-');
  const lines = [
    '#!/bin/sh',
    `if [ "$1" = "${subcommand}" ]; then`,
  ];
  if (matchArg) {
    lines.push(
      '  matched=0',
      '  for arg in "$@"; do',
      `    if [ "$arg" = "${matchArg}" ]; then matched=1; fi`,
      '  done',
      '  if [ "$matched" = "1" ]; then',
      '    echo "fatal: simulated git failure" >&2',
      '    exit 1',
      '  fi',
    );
  } else {
    lines.push('  echo "fatal: simulated git failure" >&2', '  exit 1');
  }
  lines.push('fi', `exec "${realGitPath}" "$@"`, '');
  const gitPath = path.join(binDir, 'git');
  fs.writeFileSync(gitPath, lines.join('\n'));
  fs.chmodSync(gitPath, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
};

afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code git service createGitCommit selective staging (#669)', () => {
  it('commits exactly the selection and restores the rest of the index', async () => {
    if (!canRunGit()) return;

    const { dir } = makeRepo();
    modify(dir, 'a.txt', 'a changed\n');
    modify(dir, 'b.txt', 'b changed\n');
    modify(dir, 'c.txt', 'c changed\n');
    runGit(dir, ['add', 'a.txt', 'b.txt']);

    const result = await createGitCommit(dir, 'selective', { files: ['a.txt'], stageFiles: ['a.txt'] });

    expect(result.success).toBe(true);
    expect(result.commit).toBe(headHash(dir));
    expect(result.branch).toBe('main');
    expect(headSubject(dir)).toBe('selective');
    expect(commitPaths(dir)).toEqual(['a.txt']);
    expect(stagedPaths(dir)).toEqual(['b.txt']);
  });

  it('aborts with the git error when the staged index cannot be read', async () => {
    if (!canRunGit()) return;

    const { dir, root } = makeRepo();
    modify(dir, 'a.txt', 'a changed\n');
    runGit(dir, ['add', 'a.txt']);
    installFailingGit('diff');

    await expect(createGitCommit(dir, 'blocked', { files: ['a.txt'], stageFiles: ['a.txt'] }))
      .rejects.toThrow(/Failed to read staged files: fatal: simulated git failure/);

    expect(headHash(dir)).toBe(root);
    expect(headSubject(dir)).toBe('root');
  });

  it('aborts with the git error when a non-selected staged file cannot be unstaged', async () => {
    if (!canRunGit()) return;

    const { dir, root } = makeRepo();
    modify(dir, 'a.txt', 'a changed\n');
    modify(dir, 'b.txt', 'b changed\n');
    runGit(dir, ['add', 'a.txt', 'b.txt']);
    const lockPath = path.join(dir, '.git', 'index.lock');
    fs.writeFileSync(lockPath, '');

    try {
      await expect(createGitCommit(dir, 'blocked', { files: ['a.txt'], stageFiles: ['a.txt'] }))
        .rejects.toThrow(/Failed to unstage files outside the selection: .*index\.lock/);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }

    expect(headHash(dir)).toBe(root);
    expect(headSubject(dir)).toBe('root');
  });

  it('aborts with the git error when a selected file cannot be staged, instead of committing the rest of the index', async () => {
    if (!canRunGit()) return;

    const { dir, root } = makeRepo();
    modify(dir, 'a.txt', 'a changed\n');
    modify(dir, 'b.txt', 'b changed\n');
    runGit(dir, ['add', 'b.txt']);
    installFailingGit('add');

    await expect(createGitCommit(dir, 'blocked', { files: ['a.txt', 'b.txt'], stageFiles: ['a.txt'] }))
      .rejects.toThrow(/Failed to stage selected files: fatal: simulated git failure/);

    expect(headHash(dir)).toBe(root);
    expect(headSubject(dir)).toBe('root');
    expect(stagedPaths(dir)).toEqual(['b.txt']);
  });

  it('fallback (no VS Code repository) stages a dash-named selected file as a path, not an option (#786)', async () => {
    if (!canRunGit()) return;

    const { dir } = makeRepo();
    fs.writeFileSync(path.join(dir, '-A'), 'dash selected\n');
    fs.writeFileSync(path.join(dir, 'other.txt'), 'unselected sibling\n');

    const result = await createGitCommit(dir, 'dash fallback', { files: ['-A'] });

    expect(result.success).toBe(true);
    expect(result.commit).toBe(headHash(dir));
    expect(headSubject(dir)).toBe('dash fallback');
    expect(commitPaths(dir)).toEqual(['-A']);
    expect(stagedPaths(dir)).toEqual([]);
  });

  it('logs a failure to restore temporarily unstaged files after a successful commit', async () => {
    if (!canRunGit()) return;

    const { dir } = makeRepo();
    modify(dir, 'a.txt', 'a changed\n');
    modify(dir, 'b.txt', 'b changed\n');
    runGit(dir, ['add', 'a.txt', 'b.txt']);
    installFailingGit('add', 'b.txt');
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await createGitCommit(dir, 'partial restore', { files: ['a.txt'], stageFiles: ['a.txt'] });

      expect(result.success).toBe(true);
      expect(headSubject(dir)).toBe('partial restore');
      expect(commitPaths(dir)).toEqual(['a.txt']);
      expect(stagedPaths(dir)).toEqual([]);
      const logged = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toContain('Failed to restore temporarily unstaged files');
      expect(logged).toContain('fatal: simulated git failure');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

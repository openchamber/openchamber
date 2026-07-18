import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, mock } from 'bun:test';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { getGitBranches } = await import('./gitService.ts');
const tempDirs = [];

const createTempDir = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-git-'));
  tempDirs.push(directory);
  return directory;
};

const runGit = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('getGitBranches', () => {
  it('returns live remote branches that do not have local tracking refs', async () => {
    const remote = createTempDir();
    const repo = createTempDir();
    runGit(remote, ['init', '--bare']);
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    runGit(repo, ['remote', 'add', 'origin', remote]);
    runGit(repo, ['push', '-u', 'origin', 'main']);

    const head = runGit(repo, ['rev-parse', 'HEAD']).trim();
    runGit(remote, ['update-ref', 'refs/heads/remote-only', head]);
    runGit(repo, ['update-ref', 'refs/remotes/origin/stale', head]);

    const result = await getGitBranches(repo);

    expect(result.all).toContain('remotes/origin/remote-only');
    expect(result.all).not.toContain('remotes/origin/stale');
    expect(result.branches['remotes/origin/remote-only']).toEqual({
      current: false,
      name: 'remotes/origin/remote-only',
      commit: '',
      label: 'origin/remote-only',
    });
  });

  it('returns reachable remote branches when another remote cannot be reached', async () => {
    const remote = createTempDir();
    const repo = createTempDir();
    runGit(remote, ['init', '--bare']);
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    runGit(repo, ['remote', 'add', 'origin', remote]);
    runGit(repo, ['push', '-u', 'origin', 'main']);
    runGit(repo, ['remote', 'add', 'broken', path.join(repo, 'missing.git')]);

    const result = await getGitBranches(repo);

    expect(result.all).toContain('remotes/origin/main');
  });

  it('rejects when a remote cannot be reached', async () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    runGit(repo, ['remote', 'add', 'broken', path.join(repo, 'missing.git')]);

    await expect(getGitBranches(repo)).rejects.toThrow('Failed to fetch remote branches');
  });
});

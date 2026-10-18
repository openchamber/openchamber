import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { resolveRepositoryPrefix } = await import('./gitService.ts?repository-prefix-test');

const tempDirs = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-prefix-'));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const canRunGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code git service repository prefix', () => {
  it('reports where a directory sits inside its checkout, and nothing at the root', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    fs.mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true });

    expect(await resolveRepositoryPrefix(path.join(repo, 'packages', 'app'))).toBe('packages/app');
    expect(await resolveRepositoryPrefix(repo)).toBe('');
  });

  it('rejects instead of answering "at the root" outside a repository', async () => {
    if (!canRunGit()) return;

    await expect(resolveRepositoryPrefix(createTempDir())).rejects.toThrow();
  });
});

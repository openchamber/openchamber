import { describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cleanupResult = {
  stdout: '',
  stderr: 'Git process tree cleanup was not confirmed',
  exitCode: 1,
  code: 'ERR_PROCESS_TREE_TERMINATION',
  cleanupBlocked: true,
  descendantsTerminated: false,
  rootClosed: false,
  pid: 5151,
};

let result = cleanupResult;
const execGit = mock(async () => result);

mock.module('vscode', () => ({
  extensions: {
    getExtension: () => undefined,
  },
}));
mock.module('./bridge-git-process-runtime', () => ({ execGit }));

const {
  getGitStatus,
  getGitBranches,
  getGitDiff,
  getGitFileDiff,
  getGitRangeDiff,
  listGitWorktrees,
} = await import('./gitService.ts?cleanup-propagation');
const { createGitExecutionRuntime } = await import('./git-execution-runtime.ts?cleanup-propagation');

const context = {
  isRepository: true,
  requestedDirectory: '/repo',
  topLevel: '/repo',
  gitDir: '/repo/.git',
  commonDir: '/repo/.git',
  commonId: '/repo/.git',
  worktreeId: '/repo',
};

describe('VS Code Git cleanup propagation', () => {
  it('does not return clean fallback status or release its lease after blocked cleanup', async () => {
    const runtime = createGitExecutionRuntime({ resolver: { resolve: async () => context } });
    const pending = runtime.runServiceOperation('getGitStatus', '/repo', () => getGitStatus('/repo'));

    await expect(pending).rejects.toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      descendantsTerminated: false,
      rootClosed: false,
      pid: 5151,
    });
    expect(runtime.coordinator.getStats()).toMatchObject({ active: 1 });
  });

  it('keeps the ordinary raw status fallback for a confirmed non-repository', async () => {
    result = {
      stdout: '',
      stderr: 'fatal: not a git repository',
      exitCode: 128,
      code: '128',
    };

    await expect(getGitStatus('/repo')).resolves.toMatchObject({
      current: '',
      files: [],
      isClean: true,
    });
  });

  it('does not report unavailable Git as a clean status', async () => {
    result = {
      stdout: '',
      stderr: 'spawn git ENOENT',
      exitCode: 1,
      code: 'ENOENT',
    };

    await expect(getGitStatus('/repo')).rejects.toMatchObject({
      code: 'ENOENT',
      stderr: 'spawn git ENOENT',
    });
  });

  it('does not report unavailable Git as an empty branch list', async () => {
    result = {
      stdout: '',
      stderr: 'permission denied while executing Git',
      exitCode: 1,
      code: 'EACCES',
    };

    await expect(getGitBranches('/repo')).rejects.toMatchObject({
      code: 'EACCES',
      stderr: 'permission denied while executing Git',
    });
  });

  it('does not turn a blocked legacy worktree command into an empty list', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-cleanup-'));
    fs.mkdirSync(path.join(directory, '.git'));
    try {
      result = cleanupResult;
      await expect(listGitWorktrees(directory)).rejects.toMatchObject({
        code: 'ERR_PROCESS_TREE_TERMINATION',
        cleanupBlocked: true,
        descendantsTerminated: false,
        pid: 5151,
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['path diff', () => getGitDiff('/repo', 'file.txt')],
    ['file diff', () => getGitFileDiff('/repo', 'file.txt')],
    ['range diff', () => getGitRangeDiff('/repo', 'main', 'feature', 'file.txt')],
  ])('keeps cleanup metadata on the %s error adapter', async (_name, operation) => {
    result = cleanupResult;
    await expect(operation()).rejects.toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      descendantsTerminated: false,
      pid: 5151,
    });
  });
});

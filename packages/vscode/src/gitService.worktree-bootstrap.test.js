import { EventEmitter } from 'node:events';
import { afterAll, describe, expect, it, mock } from 'bun:test';

let gitExtension;
const originalSshAuthSock = process.env.SSH_AUTH_SOCK;
process.env.SSH_AUTH_SOCK = '/tmp/openchamber-test-agent.sock';
const spawnCalls = [];
const spawn = mock((command, args, options) => {
  const childProcess = new EventEmitter();
  childProcess.stdout = new EventEmitter();
  childProcess.stderr = new EventEmitter();
  spawnCalls.push({ command, args, options });
  queueMicrotask(() => {
    childProcess.stdout.emit('data', 'true\n');
    childProcess.emit('close', 0);
  });
  return childProcess;
});

mock.module('vscode', () => ({
  extensions: { getExtension: () => gitExtension },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));
mock.module('child_process', () => ({
  execFile: mock(),
  spawn,
}));

afterAll(() => {
  if (originalSshAuthSock === undefined) {
    delete process.env.SSH_AUTH_SOCK;
  } else {
    process.env.SSH_AUTH_SOCK = originalSshAuthSock;
  }
});

const {
  checkIsGitRepository,
  getGitExecutablePath,
  getWorktreeBootstrapStatus,
} = await import('./gitService.ts?worktree-bootstrap-test');

describe('VS Code worktree bootstrap phases', () => {
  it('treats missing bootstrap state as fully ready', async () => {
    await expect(getWorktreeBootstrapStatus('/untracked-worktree')).resolves.toMatchObject({
      status: 'ready',
      phase: 'setup-ready',
      error: null,
    });
  });

  it('exposes the Git executable selected by VS Code', async () => {
    gitExtension = undefined;
    await expect(getGitExecutablePath()).resolves.toBeUndefined();

    const gitApi = { git: { path: '/custom/bin/git' } };
    gitExtension = {
      isActive: true,
      exports: {
        enabled: true,
        getAPI: () => gitApi,
        onDidChangeEnablement: () => ({ dispose: () => undefined }),
      },
    };

    spawn.mockClear();
    spawnCalls.length = 0;
    await expect(checkIsGitRepository('/repo')).resolves.toBe(true);
    expect(spawnCalls[0]).toMatchObject({
      command: '/custom/bin/git',
      args: ['rev-parse', '--is-inside-work-tree'],
      options: { cwd: '/repo' },
    });
    await expect(getGitExecutablePath()).resolves.toBe('/custom/bin/git');
  });
});

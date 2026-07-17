import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { promisify } from 'node:util';

const execCalls = [];
const execMock = mock(() => {
  throw new Error('exec should be called through promisify');
});
const unusedChildProcessMock = mock(() => {
  throw new Error('unexpected child process invocation');
});

execMock[promisify.custom] = (command, options) => {
  execCalls.push({ command, options });
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ stdout: '/repo/.git\n/repo/.git\n', stderr: '' });
    }, 10);
  });
};

mock.module('child_process', () => ({
  exec: execMock,
  execFile: unusedChildProcessMock,
  spawn: unusedChildProcessMock,
}));

mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    fs: {},
  },
  Uri: {
    file: (fsPath) => ({ fsPath }),
  },
  FileType: {
    Directory: 2,
  },
  window: {},
}));

const { clearGitReadCacheForTests, handleFsBridgeMessage } = await import('./bridge-fs-runtime');

const deps = {
  resolveUserPath: (value) => value,
  listDirectoryEntries: mock(),
  normalizeFsPath: (value) => value,
  execGit: mock(),
  searchDirectory: mock(),
  resolveFileReadPath: mock(),
  parseDroppedFileReference: mock(),
  readUriAsAttachment: mock(),
};

describe('bridge fs exec git read cache', () => {
  beforeEach(() => {
    execCalls.length = 0;
    clearGitReadCacheForTests();
    deps.listDirectoryEntries.mockReset();
    deps.execGit.mockReset();
  });

  it('dedupes in-flight cacheable git reads and reuses fresh results', async () => {
    const command = 'git rev-parse --absolute-git-dir --git-common-dir';
    const cwd = '/repo';

    const [first, second] = await Promise.all([
      handleFsBridgeMessage({ id: '1', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps),
      handleFsBridgeMessage({ id: '2', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps),
    ]);

    expect(first?.success).toBe(true);
    expect(second?.success).toBe(true);
    expect(execCalls).toHaveLength(1);

    const spacedCommand = 'git   rev-parse   --absolute-git-dir   --git-common-dir';
    const cached = await handleFsBridgeMessage({ id: '3', type: 'api:fs:exec', payload: { commands: [spacedCommand], cwd } }, deps);

    expect(execCalls).toHaveLength(1);
    expect(cached?.data?.results?.[0]).toMatchObject({
      command: spacedCommand,
      success: true,
      stdout: '/repo/.git\n/repo/.git',
    });
  });

  it('does not cache arbitrary exec commands', async () => {
    const command = 'git status --porcelain';
    const cwd = '/repo';

    await handleFsBridgeMessage({ id: '1', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps);
    await handleFsBridgeMessage({ id: '2', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps);

    expect(execCalls).toHaveLength(2);
  });

  it('delegates list ignore probes to the injected scheduled Git owner', async () => {
    deps.listDirectoryEntries.mockImplementation(async () => [
      { name: 'visible.ts', path: '/repo/visible.ts', isDirectory: false },
      { name: 'ignored.log', path: '/repo/ignored.log', isDirectory: false },
    ]);
    deps.execGit.mockImplementation(async () => ({
      stdout: 'ignored.log\n',
      stderr: '',
      exitCode: 0,
    }));

    const response = await handleFsBridgeMessage({
      id: '4',
      type: 'api:fs:list',
      payload: { path: '/repo', respectGitignore: true },
    }, deps);

    expect(deps.execGit).toHaveBeenCalledTimes(1);
    expect(deps.execGit).toHaveBeenCalledWith(
      ['check-ignore', '--', 'visible.ts', 'ignored.log'],
      '/repo',
    );
    expect(response?.data?.entries).toEqual([
      { name: 'visible.ts', path: '/repo/visible.ts', isDirectory: false },
    ]);
  });
});

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { promisify } from 'node:util';

const execCalls = [];
const execMock = mock(() => {
  throw new Error('exec should be called through promisify');
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
  execFile: mock(),
  spawn: mock(),
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

process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS = '10';
const { clearGitReadCacheForTests, handleFsBridgeMessage } = await import('./bridge-fs-runtime');
delete process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS;

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

  it('uses the execution adapter for gitignore checks', async () => {
    const readCalls = [];
    const readOptions = [];
    const execOptions = [];
    const execArgs = [];
    const result = await handleFsBridgeMessage(
      { id: '1', type: 'api:fs:list', payload: { path: '/repo', respectGitignore: true } },
      {
        ...deps,
        listDirectoryEntries: async () => [
          { name: 'ignored.ts', path: '/repo/ignored.ts', isDirectory: false },
          { name: 'visible.ts', path: '/repo/visible.ts', isDirectory: false },
        ],
        execGit: async (args, _cwd, options) => {
          execArgs.push(args);
          execOptions.push(options);
          return { stdout: 'ignored.ts\0', stderr: '', exitCode: 0 };
        },
        runGitRead: async (cwd, task, options) => {
          readCalls.push(cwd);
          readOptions.push(options);
          return task();
        },
      },
    );

    expect(readCalls).toEqual(['/repo']);
    expect(readOptions[0]).toEqual({
      signal: expect.any(AbortSignal),
      queueTimeoutMs: 10,
    });
    expect(execOptions[0]).toEqual({
      signal: readOptions[0].signal,
    });
    expect(execArgs[0]).toEqual(['check-ignore', '-z', '--', 'ignored.ts', 'visible.ts']);
    expect(result?.data?.entries).toEqual([
      { name: 'visible.ts', path: '/repo/visible.ts', isDirectory: false },
    ]);
  });

  it('returns existing entries when Gitignore admission fails', async () => {
    const result = await handleFsBridgeMessage(
      { id: 'gitignore-failure', type: 'api:fs:list', payload: { path: '/repo', respectGitignore: true } },
      {
        ...deps,
        listDirectoryEntries: async () => [
          { name: 'visible.ts', path: '/repo/visible.ts', isDirectory: false },
        ],
        runGitRead: async () => {
          throw Object.assign(new Error('Git execution queue wait timed out'), {
            code: 'GIT_EXECUTION_QUEUE_TIMEOUT',
          });
        },
      },
    );

    expect(result?.success).toBe(true);
    expect(result?.data?.entries).toEqual([
      { name: 'visible.ts', path: '/repo/visible.ts', isDirectory: false },
    ]);
  });

  it('returns existing entries when Gitignore execution fails', async () => {
    const result = await handleFsBridgeMessage(
      { id: 'gitignore-execution-failure', type: 'api:fs:list', payload: { path: '/repo', respectGitignore: true } },
      {
        ...deps,
        listDirectoryEntries: async () => [
          { name: 'visible.ts', path: '/repo/visible.ts', isDirectory: false },
        ],
        execGit: async () => ({
          stdout: '',
          stderr: 'EACCES: permission denied while checking Gitignore',
          exitCode: 1,
          code: 'EACCES',
        }),
      },
    );

    expect(result?.success).toBe(true);
    expect(result?.data?.entries).toEqual([
      { name: 'visible.ts', path: '/repo/visible.ts', isDirectory: false },
    ]);
  });

  it('returns existing entries when Gitignore execution times out and aborts its waiter', async () => {
    let aborted = false;
    const result = await handleFsBridgeMessage(
      { id: 'gitignore-timeout', type: 'api:fs:list', payload: { path: '/repo', respectGitignore: true } },
      {
        ...deps,
        listDirectoryEntries: async () => [
          { name: 'visible.ts', path: '/repo/visible.ts', isDirectory: false },
        ],
        runGitRead: async (_cwd, _task, options) => {
          options?.signal?.addEventListener('abort', () => {
            aborted = true;
          });
          return new Promise(() => {});
        },
      },
    );

    expect(result?.success).toBe(true);
    expect(result?.data?.entries).toEqual([
      { name: 'visible.ts', path: '/repo/visible.ts', isDirectory: false },
    ]);
    expect(aborted).toBe(true);
  });
});

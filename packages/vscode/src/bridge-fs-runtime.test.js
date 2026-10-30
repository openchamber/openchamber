import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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
}));

mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    fs: { createDirectory: ({ fsPath }) => fs.mkdir(fsPath, { recursive: true }) },
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

describe('managed Chats home', () => {
  it('returns an existing Chats root and its filesystem identity', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-chats-'));
    const homedir = spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const root = path.join(home, '.config', 'openchamber', 'chats');
      await fs.mkdir(root, { recursive: true });
      const result = await handleFsBridgeMessage({ id: 'home', type: 'api:fs/home' }, deps);
      expect(result).toMatchObject({ success: true, data: { home, chatsRoot: root, canonicalChatsRoot: await fs.realpath(root) } });
      expect((await fs.stat(root)).isDirectory()).toBe(true);
      expect(await handleFsBridgeMessage({ id: 'home', type: 'api:fs/home' }, deps)).toEqual(result);
    } finally {
      homedir.mockRestore();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('reads home without creating a missing Chats root', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-chats-'));
    const homedir = spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const root = path.join(home, '.config', 'openchamber', 'chats');
      expect(await handleFsBridgeMessage({ id: 'home', type: 'api:fs/home' }, deps))
        .toMatchObject({ success: true, data: { home, chatsRoot: root } });
      await expect(fs.stat(root)).rejects.toThrow();
      expect(await handleFsBridgeMessage({ id: 'mkdir', type: 'api:fs:mkdir', payload: { path: path.join(root, 'day', 'session-a') } }, deps))
        .toMatchObject({ success: true });
      expect((await fs.stat(path.join(root, 'day', 'session-a'))).isDirectory()).toBe(true);
    } finally {
      homedir.mockRestore();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('keeps home readable when only Chat allocation is blocked', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-chats-'));
    const homedir = spyOn(os, 'homedir').mockReturnValue(home);
    try {
      await fs.writeFile(path.join(home, '.config'), 'not a directory');
      const root = path.join(home, '.config', 'openchamber', 'chats');
      expect(await handleFsBridgeMessage({ id: 'home', type: 'api:fs/home' }, deps))
        .toMatchObject({ success: true, data: { home, chatsRoot: root } });
      await expect(handleFsBridgeMessage({ id: 'mkdir', type: 'api:fs:mkdir', payload: { path: path.join(root, 'day', 'session-a') } }, deps)).rejects.toThrow();
    } finally {
      homedir.mockRestore();
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

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
});

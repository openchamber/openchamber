import { describe, expect, it, mock, spyOn } from 'bun:test';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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

const { handleFsBridgeMessage } = await import('./bridge-fs-runtime');

const deps = {
  resolveUserPath: (value) => value,
  listDirectoryEntries: mock(),
  normalizeFsPath: (value) => value,
  execGit: mock(),
  searchDirectory: mock(),
  resolveFileReadPath: mock(),
  resolveDirectoryListPath: async (target) => ({ ok: true, resolvedPath: target }),
  resolveDirectoryCreatePath: async (target) => ({ ok: true, resolvedPath: target }),
  resolveRevealPath: async (target) => ({ ok: true, resolvedPath: target }),
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

describe('bridge fs read size cap', () => {
  const CAP = 16 * 1024 * 1024;
  const readDeps = { ...deps, resolveFileReadPath: mock(async (target) => ({ ok: true, resolvedPath: target })) };
  const withFile = async (content, run) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-bridge-fs-read-'));
    try {
      const file = path.join(dir, 'file.txt');
      await fs.writeFile(file, content);
      return await run(file);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };

  it('returns a small file exactly as before', async () => {
    await withFile('hello', async (file) => {
      const response = await handleFsBridgeMessage({ id: '1', type: 'api:fs:read', payload: { path: file } }, readDeps);
      expect(response.success).toBe(true);
      expect(response.data.content).toBe('hello');
      expect(response.data.path).toBe(file);
    });
  });

  it('returns a file at the cap', async () => {
    await withFile('a'.repeat(CAP), async (file) => {
      const response = await handleFsBridgeMessage({ id: '2', type: 'api:fs:read', payload: { path: file } }, readDeps);
      expect(response.success).toBe(true);
      expect(response.data.content.length).toBe(CAP);
    });
  });

  it('refuses a file over the cap with an error naming the limit', async () => {
    await withFile('a'.repeat(CAP + 1), async (file) => {
      const response = await handleFsBridgeMessage({ id: '3', type: 'api:fs:read', payload: { path: file } }, readDeps);
      expect(response.success).toBe(false);
      expect(response.error).toBe(`File exceeds maximum size of ${CAP} bytes`);
    });
  });
});

describe('check-ignore deadline from OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS', () => {
  const name = 'OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS';
  let loads = 0;
  // The value is read when the module loads, so each case loads a fresh copy
  // and lists a directory with ignore checks; the deadline is the timer the
  // check races, and an explicit 0 runs the check with none.
  const deadlineFor = async (value) => {
    const saved = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    const delays = [];
    const timer = spyOn(globalThis, 'setTimeout');
    try {
      loads += 1;
      const fresh = await import(`./bridge-fs-runtime.ts?check-ignore-${loads}`);
      timer.mockImplementation((callback, delay) => { delays.push(delay); return 0; });
      await fresh.handleFsBridgeMessage({ id: 'list', type: 'api:fs:list', payload: { path: '/workspace', respectGitignore: true } }, {
        ...deps,
        listDirectoryEntries: async () => [{ name: 'a.ts' }],
        execGit: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
      });
      return delays.length === 0 ? 0 : delays[0];
    } finally {
      timer.mockRestore();
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  };

  it('falls back to 2500 ms when unset or not a plain decimal', async () => {
    for (const value of [undefined, '', ' ', '1e3', '0x10', '5.9', '-5']) {
      expect(await deadlineFor(value)).toBe(2500);
    }
  });

  it('honours a plain decimal value, including an explicit 0', async () => {
    expect(await deadlineFor('4000')).toBe(4000);
    expect(await deadlineFor('0')).toBe(0);
  });

  it('falls back to the default above the timer maximum', async () => {
    expect(await deadlineFor('2147483647')).toBe(2_147_483_647);
    expect(await deadlineFor('3000000000')).toBe(2500);
  });
});

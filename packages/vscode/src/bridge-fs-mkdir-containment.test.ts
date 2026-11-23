import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// The workspace root is created per test on the real filesystem, so the
// vscode mock reads it through this mutable holder instead of a fixed path.
const state = { workspaceRoot: '' };

mock.module('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return state.workspaceRoot ? [{ uri: { fsPath: state.workspaceRoot } }] : undefined;
    },
    fs: {
      createDirectory: async (uri: { fsPath: string }) => {
        await fs.mkdir(uri.fsPath, { recursive: true });
      },
    },
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    joinPath: (uri: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(uri.fsPath, ...parts) }),
  },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  window: {},
}));

const { handleFsBridgeMessage } = await import('./bridge-fs-runtime');
const helpers = await import('./bridge-fs-helpers-runtime');

const deps = {
  resolveUserPath: helpers.resolveUserPath,
  listDirectoryEntries: helpers.listDirectoryEntries,
  normalizeFsPath: helpers.normalizeFsPath,
  execGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  searchDirectory: async () => [],
  resolveFileReadPath: helpers.resolveFileReadPath,
  resolveDirectoryListPath: helpers.resolveDirectoryListPath,
  resolveDirectoryCreatePath: helpers.resolveDirectoryCreatePath,
  parseDroppedFileReference: () => {
    throw new Error('not used by fs:mkdir tests');
  },
  readUriAsAttachment: async () => {
    throw new Error('not used by fs:mkdir tests');
  },
} as unknown as Parameters<typeof handleFsBridgeMessage>[1];

const createdBases: string[] = [];
let restoreHomedir: (() => void) | undefined;

const setupTree = async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-mkdir-containment-'));
  createdBases.push(base);
  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  const home = path.join(base, 'home');
  await fs.mkdir(path.join(workspace, 'inner'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.symlink(outside, path.join(workspace, 'escape-link'), 'dir');
  await fs.symlink(path.join(workspace, 'inner'), path.join(workspace, 'alias-link'), 'dir');
  await fs.symlink(path.join(base, 'nowhere'), path.join(workspace, 'dangling-link'), 'dir');
  const homedirSpy = spyOn(os, 'homedir').mockReturnValue(home);
  restoreHomedir = () => (homedirSpy as unknown as { mockRestore: () => void }).mockRestore();
  state.workspaceRoot = workspace;
  return { base, workspace, outside, home };
};

afterEach(async () => {
  restoreHomedir?.();
  restoreHomedir = undefined;
  state.workspaceRoot = '';
  while (createdBases.length > 0) {
    const base = createdBases.pop() as string;
    await fs.rm(base, { recursive: true, force: true });
  }
});

const mkdir = async (target: string) => {
  const result = await handleFsBridgeMessage(
    { id: 'mkdir-1', type: 'api:fs:mkdir', payload: { path: target } },
    deps,
  );
  return result as { success: boolean; error?: string; data?: { path: string } };
};

const exists = async (target: string) => {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
};

describe('api:fs:mkdir workspace containment', () => {
  test('creates a relative directory inside the workspace', async () => {
    const { workspace } = await setupTree();
    const result = await mkdir('newdir');
    expect(result.success).toBe(true);
    expect(await exists(path.join(workspace, 'newdir'))).toBe(true);
  });

  test('creates nested directories inside the workspace', async () => {
    const { workspace } = await setupTree();
    const result = await mkdir(path.join('a', 'b', 'c'));
    expect(result.success).toBe(true);
    expect(await exists(path.join(workspace, 'a', 'b', 'c'))).toBe(true);
  });

  test('creates a directory addressed by an absolute in-workspace path', async () => {
    const { workspace } = await setupTree();
    const target = path.join(workspace, 'absdir');
    const result = await mkdir(target);
    expect(result.success).toBe(true);
    expect(await exists(target)).toBe(true);
  });

  test('rejects an absolute path outside the workspace and creates nothing', async () => {
    const { outside } = await setupTree();
    const target = path.join(outside, 'evil');
    const result = await mkdir(target);
    expect(result.success).toBe(false);
    expect(await exists(target)).toBe(false);
  });

  test('rejects a .. traversal outside the workspace and creates nothing', async () => {
    const { outside } = await setupTree();
    const result = await mkdir(path.join('..', 'outside', 'evil'));
    expect(result.success).toBe(false);
    expect(await exists(path.join(outside, 'evil'))).toBe(false);
  });

  test('rejects a create through a symlinked ancestor pointing outside', async () => {
    const { outside } = await setupTree();
    const result = await mkdir(path.join('escape-link', 'evil'));
    expect(result.success).toBe(false);
    expect(await exists(path.join(outside, 'evil'))).toBe(false);
  });

  test('rejects a create through a dangling symlink ancestor', async () => {
    const { base } = await setupTree();
    const result = await mkdir(path.join('dangling-link', 'evil'));
    expect(result.success).toBe(false);
    expect(await exists(path.join(base, 'nowhere'))).toBe(false);
  });

  test('allows a create through a symlinked ancestor that stays inside', async () => {
    const { workspace } = await setupTree();
    const result = await mkdir(path.join('alias-link', 'newdir'));
    expect(result.success).toBe(true);
    expect(await exists(path.join(workspace, 'inner', 'newdir'))).toBe(true);
  });

  test('creates under the managed Chats root outside the workspace', async () => {
    const { home } = await setupTree();
    const target = path.join(home, '.config', 'openchamber', 'chats', 'day', 'session-a');
    const result = await mkdir(target);
    expect(result.success).toBe(true);
    expect(await exists(target)).toBe(true);
  });

  test('rejects a create elsewhere under home and creates nothing', async () => {
    const { home } = await setupTree();
    const target = path.join(home, 'evil');
    const result = await mkdir(target);
    expect(result.success).toBe(false);
    expect(await exists(target)).toBe(false);
  });
});

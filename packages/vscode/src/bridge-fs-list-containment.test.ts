import { afterEach, describe, expect, mock, test } from 'bun:test';
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
      readDirectory: async (uri: { fsPath: string }) => {
        const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
        return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1] as [string, number]);
      },
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
  parseDroppedFileReference: () => {
    throw new Error('not used by fs:list tests');
  },
  readUriAsAttachment: async () => {
    throw new Error('not used by fs:list tests');
  },
} as unknown as Parameters<typeof handleFsBridgeMessage>[1];

const createdBases: string[] = [];

const setupTree = async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-list-containment-'));
  createdBases.push(base);
  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await fs.mkdir(path.join(workspace, 'sub'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'inner'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(workspace, 'sub', 'a.txt'), 'a');
  await fs.writeFile(path.join(workspace, 'inner', 'b.txt'), 'b');
  await fs.writeFile(path.join(outside, 'marker.txt'), 'outside');
  await fs.symlink(outside, path.join(workspace, 'escape-link'), 'dir');
  await fs.symlink(path.join(workspace, 'inner'), path.join(workspace, 'alias-link'), 'dir');
  state.workspaceRoot = workspace;
  return { base, workspace, outside };
};

afterEach(async () => {
  state.workspaceRoot = '';
  while (createdBases.length > 0) {
    const base = createdBases.pop() as string;
    await fs.rm(base, { recursive: true, force: true });
  }
});

const list = async (payload: unknown) => {
  const result = await handleFsBridgeMessage({ id: 'list-1', type: 'api:fs:list', payload }, deps);
  if (!result) {
    throw new Error('fs:list returned no response');
  }
  return result;
};

const entryNames = (result: Awaited<ReturnType<typeof list>>) =>
  ((result.data as { entries: Array<{ name: string }> }).entries ?? []).map((entry) => entry.name);

describe('api:fs:list workspace containment', () => {
  test('rejects an absolute path outside the workspace', async () => {
    const { outside } = await setupTree();
    const result = await list({ path: outside });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Access to directory denied');
  });

  test('rejects a relative path escaping through ..', async () => {
    await setupTree();
    const result = await list({ path: '../outside' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Access to directory denied');
  });

  test('rejects a path escaping through a symlink ancestor', async () => {
    await setupTree();
    const result = await list({ path: 'escape-link' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Access to directory denied');
  });

  test('lists an in-workspace directory', async () => {
    await setupTree();
    const result = await list({ path: 'sub' });
    expect(result.success).toBe(true);
    expect(entryNames(result)).toContain('a.txt');
  });

  test('lists through a symlink whose target stays inside the workspace', async () => {
    await setupTree();
    const result = await list({ path: 'alias-link' });
    expect(result.success).toBe(true);
    expect(entryNames(result)).toContain('b.txt');
  });

  test('defaults to the workspace root', async () => {
    await setupTree();
    const result = await list({});
    expect(result.success).toBe(true);
    expect(entryNames(result)).toContain('sub');
  });

  test('reports a missing in-workspace directory instead of listing it', async () => {
    await setupTree();
    const result = await list({ path: 'nope' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Directory not found');
  });
});

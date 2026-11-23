import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// The workspace root is created per test on the real filesystem, so the
// vscode mock reads it through this mutable holder instead of a fixed path.
const state = { workspaceRoot: '' };
const revealed: Array<{ command: string; fsPath: string }> = [];

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
  commands: {
    executeCommand: async (command: string, uri: { fsPath: string }) => {
      revealed.push({ command, fsPath: uri.fsPath });
    },
  },
  Uri: {
    file: (fsPath: string) => ({ scheme: 'file', fsPath }),
    parse: (value: string) => {
      const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(value);
      if (!match) {
        return { scheme: '', fsPath: value };
      }
      const [, scheme, rest] = match;
      return { scheme: scheme.toLowerCase(), fsPath: scheme.toLowerCase() === 'file' ? decodeURIComponent(`/${rest.replace(/^[^/]*/, '')}`.replace(/^\/\//, '/')) : '' };
    },
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
  resolveRevealPath: helpers.resolveRevealPath,
  parseDroppedFileReference: () => {
    throw new Error('not used by fs:reveal tests');
  },
  readUriAsAttachment: async () => {
    throw new Error('not used by fs:reveal tests');
  },
} as unknown as Parameters<typeof handleFsBridgeMessage>[1];

const createdBases: string[] = [];

const setupTree = async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-reveal-containment-'));
  createdBases.push(base);
  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await fs.mkdir(path.join(workspace, 'inner'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(workspace, 'inner', 'b.txt'), 'b');
  await fs.writeFile(path.join(outside, 'marker.txt'), 'outside');
  await fs.symlink(path.join(outside, 'marker.txt'), path.join(workspace, 'escape.txt'), 'file');
  await fs.symlink(path.join(workspace, 'inner', 'b.txt'), path.join(workspace, 'alias.txt'), 'file');
  state.workspaceRoot = workspace;
  return { base, workspace, outside };
};

afterEach(async () => {
  state.workspaceRoot = '';
  revealed.length = 0;
  while (createdBases.length > 0) {
    const base = createdBases.pop() as string;
    await fs.rm(base, { recursive: true, force: true });
  }
});

const reveal = async (payload: unknown) => {
  const result = await handleFsBridgeMessage({ id: 'reveal-1', type: 'api:fs:reveal', payload }, deps);
  if (!result) {
    throw new Error('fs:reveal returned no response');
  }
  return result;
};

describe('api:fs:reveal workspace containment', () => {
  test('rejects an absolute path outside the workspace', async () => {
    const { outside } = await setupTree();
    const result = await reveal({ path: path.join(outside, 'marker.txt') });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Access to path denied');
    expect(revealed).toEqual([]);
  });

  test('rejects a path escaping through a symlink', async () => {
    const { workspace } = await setupTree();
    const result = await reveal({ path: path.join(workspace, 'escape.txt') });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Access to path denied');
    expect(revealed).toEqual([]);
  });

  test('reveals an in-workspace file at its canonical path', async () => {
    const { workspace } = await setupTree();
    const target = path.join(workspace, 'inner', 'b.txt');
    const result = await reveal({ path: target });
    expect(result.success).toBe(true);
    expect(revealed).toEqual([{ command: 'revealFileInOS', fsPath: await fs.realpath(target) }]);
  });

  test('reveals an in-workspace symlink whose target stays inside', async () => {
    const { workspace } = await setupTree();
    const target = path.join(workspace, 'alias.txt');
    const result = await reveal({ path: target });
    expect(result.success).toBe(true);
    expect(revealed).toEqual([{ command: 'revealFileInOS', fsPath: await fs.realpath(target) }]);
  });

  test('reveals a file:// URI for an in-workspace path', async () => {
    const { workspace } = await setupTree();
    const target = path.join(workspace, 'inner', 'b.txt');
    const result = await reveal({ path: `file://${target}` });
    expect(result.success).toBe(true);
    expect(revealed).toEqual([{ command: 'revealFileInOS', fsPath: await fs.realpath(target) }]);
  });

  test('refuses a non-file URI', async () => {
    await setupTree();
    const result = await reveal({ path: 'https://example.com/file.txt' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Only local file paths can be revealed');
    expect(revealed).toEqual([]);
  });

  test('reports a missing in-workspace path as not found', async () => {
    const { workspace } = await setupTree();
    const result = await reveal({ path: path.join(workspace, 'missing.txt') });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Path not found');
    expect(revealed).toEqual([]);
  });
});

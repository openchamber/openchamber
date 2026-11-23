import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// The workspace root is created per test on the real filesystem, so the
// vscode mock reads it through this mutable holder instead of a fixed path.
const state = { workspaceRoot: '' };

// Every base the RelativePattern search is invoked with, so a test can prove
// the pattern path is never rooted outside the workspace either.
const findFilesBases: string[] = [];

class RelativePattern {
  base: string;

  pattern: string;

  constructor(baseUri: { fsPath: string }, pattern: string) {
    this.base = baseUri.fsPath;
    this.pattern = pattern;
  }
}

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
    },
    findFiles: async (pattern: RelativePattern, _exclude: string, maxResults?: number) => {
      findFilesBases.push(pattern.base);
      // Stand-in for VS Code's glob search: the helper builds
      // `**/*<literal>*` patterns, so match file names on the literal part.
      const literal = pattern.pattern
        .replace(/^\*\*\//, '')
        .replace(/^\*/, '')
        .replace(/\*$/, '')
        .replace(/\\(.)/g, '$1');
      const found: Array<{ fsPath: string }> = [];
      const walk = async (dir: string): Promise<void> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
          } else if (entry.name.includes(literal)) {
            found.push({ fsPath: full });
          }
        }
      };
      await walk(pattern.base);
      return typeof maxResults === 'number' ? found.slice(0, maxResults) : found;
    },
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    joinPath: (uri: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(uri.fsPath, ...parts) }),
  },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  RelativePattern,
  window: {},
}));

mock.module('./bridge-git-process-runtime', () => ({
  execGit: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
}));

const { handleFsBridgeMessage } = await import('./bridge-fs-runtime');
const helpers = await import('./bridge-fs-helpers-runtime');

const deps = {
  resolveUserPath: helpers.resolveUserPath,
  listDirectoryEntries: helpers.listDirectoryEntries,
  normalizeFsPath: helpers.normalizeFsPath,
  execGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  searchDirectory: helpers.searchDirectory,
  resolveFileReadPath: helpers.resolveFileReadPath,
  resolveDirectoryListPath: helpers.resolveDirectoryListPath,
  parseDroppedFileReference: () => {
    throw new Error('not used by fs:search tests');
  },
  readUriAsAttachment: async () => {
    throw new Error('not used by fs:search tests');
  },
} as unknown as Parameters<typeof handleFsBridgeMessage>[1];

const createdBases: string[] = [];

const setupTree = async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-search-containment-'));
  createdBases.push(base);
  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await fs.mkdir(path.join(workspace, 'sub'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'inner'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(workspace, 'sub', 'a.txt'), 'a');
  await fs.writeFile(path.join(workspace, 'inner', 'b.txt'), 'b');
  await fs.writeFile(path.join(outside, 'secret-marker.txt'), 'outside');
  await fs.symlink(outside, path.join(workspace, 'escape-link'), 'dir');
  await fs.symlink(path.join(workspace, 'inner'), path.join(workspace, 'alias-link'), 'dir');
  state.workspaceRoot = workspace;
  return { base, workspace, outside };
};

afterEach(async () => {
  state.workspaceRoot = '';
  findFilesBases.length = 0;
  while (createdBases.length > 0) {
    const base = createdBases.pop() as string;
    await fs.rm(base, { recursive: true, force: true });
  }
});

const search = async (payload: unknown) => {
  const result = await handleFsBridgeMessage({ id: 'search-1', type: 'api:fs:search', payload }, deps);
  if (!result) {
    throw new Error('fs:search returned no response');
  }
  return result;
};

const searchedPaths = (result: Awaited<ReturnType<typeof search>>) =>
  ((result.data as { files: Array<{ path: string }> }).files ?? []).map((file) => file.path);

describe('api:fs:search workspace containment', () => {
  test('rejects an absolute directory outside the workspace', async () => {
    const { outside } = await setupTree();
    const result = await search({ directory: outside, query: 'secret-marker' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Access to directory denied');
    expect(findFilesBases).toEqual([]);
  });

  test('rejects a workspace symlink pointing outside', async () => {
    const { workspace } = await setupTree();
    const result = await search({ directory: path.join(workspace, 'escape-link'), query: 'secret' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Access to directory denied');
    expect(findFilesBases).toEqual([]);
  });

  test('rejects an outside root on the recursive fallback path too', async () => {
    const { outside } = await setupTree();
    const result = await search({ directory: outside, query: 'secret', includeHidden: true });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Access to directory denied');
  });

  test('returns in-workspace results through the RelativePattern path', async () => {
    const { workspace, outside } = await setupTree();
    const result = await search({ directory: workspace, query: 'a.txt' });
    expect(result.success).toBe(true);
    const paths = searchedPaths(result);
    expect(paths).toContain(path.join(workspace, 'sub', 'a.txt'));
    expect(paths.every((filePath) => !filePath.startsWith(outside))).toBe(true);
    expect(findFilesBases.length).toBeGreaterThan(0);
    expect(findFilesBases.every((base) => base === workspace)).toBe(true);
  });

  test('returns in-workspace results through the recursive fallback path', async () => {
    const { workspace } = await setupTree();
    const result = await search({
      directory: path.join(workspace, 'sub'),
      query: 'a',
      includeHidden: true,
    });
    expect(result.success).toBe(true);
    expect(searchedPaths(result)).toEqual([path.join(workspace, 'sub', 'a.txt')]);
  });

  test('searches through a symlink whose target stays inside the workspace', async () => {
    const { workspace } = await setupTree();
    const result = await search({ directory: path.join(workspace, 'alias-link'), query: 'b.txt' });
    expect(result.success).toBe(true);
    expect(searchedPaths(result)).toEqual([path.join(workspace, 'inner', 'b.txt')]);
  });
});

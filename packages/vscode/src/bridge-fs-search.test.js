import { afterEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFsSearchRuntime } from '../../web/server/lib/fs/search.js';

const uri = (fsPath) => ({ fsPath });
let directoryEntries;
mock.module('vscode', () => ({
  Uri: { file: uri, joinPath: (base, name) => uri(path.join(base.fsPath, name)) },
  FileType: { File: 1, Directory: 2 },
  workspace: {
    workspaceFolders: [],
    fs: {
      readDirectory: async (directory) => directoryEntries
        ? directoryEntries.get(directory.fsPath) ?? []
        : (await fs.readdir(directory.fsPath, { withFileTypes: true }))
          .map((entry) => [entry.name, entry.isDirectory() ? 2 : entry.isFile() ? 1 : 64]),
    },
  },
}));
mock.module('./bridge-git-process-runtime', () => ({
  execGit: async (args, cwd, options) => {
    if (directoryEntries) return { stdout: '', exitCode: 1 };
    try {
      return { stdout: execFileSync('git', args, { cwd, encoding: 'utf8', input: options?.input }), exitCode: 0 };
    } catch (error) {
      return { stdout: '', exitCode: error.status };
    }
  },
}));

const { searchDirectory } = await import('./bridge-fs-helpers-runtime');
let root;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe('filesystem search inspected-file ceiling', () => {
  const web = createFsSearchRuntime({
    path,
    fsPromises: {
      readdir: async (directory) => (directoryEntries.get(directory) ?? []).map(([name, type]) => ({
        name, isFile: () => type === 1, isDirectory: () => type === 2,
      })),
    },
    spawn: () => { throw new Error('Not a Git repository'); },
    resolveGitBinaryForSpawn: () => 'git',
  });
  const searches = [
    ['VS Code', () => searchDirectory('/workspace', 'needle', 1)],
    ['web', () => web.searchFilesystemFiles('/workspace', { query: 'needle', limit: 1 })],
  ];
  for (const [label, search] of searches) {
    test(`${label} query searches stop on inspected files, not the old candidate cap`, async () => {
      try {
        directoryEntries = new Map([
          ['/workspace', [...Array.from({ length: 201 }, (_, index) => [`${'needle'.split('').join('x'.repeat(30))}-${index}`, 1]), ['deep', 2]]],
          ['/workspace/deep', [['needle', 1]]],
        ]);
        expect((await search()).map((file) => file.relativePath)).toEqual(['deep/needle']);

        for (const inspected of [9_999, 10_000]) {
          directoryEntries = new Map([
            ['/workspace', [...Array.from({ length: inspected }, (_, index) => [`haystack-${index}`, 1]), ['deep', 2]]],
            ['/workspace/deep', [['needle', 1]]],
          ]);
          expect((await search()).map((file) => file.relativePath))
            .toEqual(inspected === 9_999 ? ['deep/needle'] : []);
        }
      } finally {
        directoryEntries = undefined;
      }
    });
  }
});

describe('workspace file search supplements', () => {
  test('respects ignored Unicode and whitespace names when hidden files are included', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-file-search-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    await fs.writeFile(path.join(root, '.gitignore'), '.ігнор.ts\n*ignored.ts\n space.ts\\ \n');
    for (const name of ['.ігнор.ts', '.line\nignored.ts', ' space.ts ', '.visible.ts']) {
      await fs.writeFile(path.join(root, name), '');
    }
    expect((await searchDirectory(root, 'ts', 60, true, true)).map((file) => file.name)).toEqual(['.visible.ts']);
  });

  test('a stopped walk rejects and reads no more of the tree', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-file-search-'));
    await fs.mkdir(path.join(root, 'deep'));
    await fs.writeFile(path.join(root, 'deep/needle.ts'), '');
    const abort = new AbortController();
    abort.abort();
    await expect(searchDirectory(root, 'needle', 60, true, false, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('includes ignored build files and honors the hidden flag with real filesystem entries', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-file-search-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    await fs.mkdir(path.join(root, 'build'));
    await fs.writeFile(path.join(root, 'build/needle.ts'), '');
    await fs.writeFile(path.join(root, '.needle.ts'), '');
    await fs.writeFile(path.join(root, '.gitignore'), 'build/\n');

    const paths = async (hidden, respect) => (await searchDirectory(root, 'needle', 60, hidden, respect))
      .map((file) => file.relativePath).sort();
    expect(await paths(false, false)).toEqual(['build/needle.ts']);
    expect(await paths(true, false)).toEqual(['.needle.ts', 'build/needle.ts']);
    expect(await paths(true, true)).toEqual(['.needle.ts']);
    await expect(searchDirectory(path.join(root, 'missing'), 'needle', 60, false, false)).rejects.toBeDefined();
  });
});

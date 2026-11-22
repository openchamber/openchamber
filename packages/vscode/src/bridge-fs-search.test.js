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
// The options of the last check-ignore read, so a test can see its deadline.
let lastCheckIgnoreOptions;
mock.module('./bridge-git-process-runtime', () => ({
  execGit: async (args, cwd, options) => {
    if (args[0] === 'check-ignore') lastCheckIgnoreOptions = options;
    if (directoryEntries) return { stdout: '', exitCode: 1 };
    try {
      return { stdout: execFileSync('git', args, { cwd, encoding: 'utf8', input: options?.input }), exitCode: 0 };
    } catch (error) {
      return { stdout: '', exitCode: error.status };
    }
  },
}));

const { fetchModelsMetadata, searchDirectory } = await import('./bridge-fs-helpers-runtime');
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

describe('filesystem search directory-visit ceiling', () => {
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
  // The root counts as one of the 50,000 directories a search may read, so
  // with this many siblings the last one is never opened.
  const siblings = 50_000;
  const searches = [
    ['VS Code', () => searchDirectory('/workspace', 'needle', 60)],
    ['web', () => web.searchFilesystemFiles('/workspace', { query: 'needle', limit: 60 })],
  ];
  for (const [label, search] of searches) {
    test(`${label} file search bounds directory visits at the named ceiling`, async () => {
      const name = (index) => `d${String(index).padStart(5, '0')}`;
      try {
        directoryEntries = new Map([['/workspace', Array.from({ length: siblings }, (_, index) => [name(index), 2])]]);
        directoryEntries.set(`/workspace/${name(siblings - 2)}`, [['needle-inside', 1]]);
        directoryEntries.set(`/workspace/${name(siblings - 1)}`, [['needle-past', 1]]);
        expect((await search()).map((file) => file.name)).toEqual(['needle-inside']);
      } finally {
        directoryEntries = undefined;
      }
    }, 60_000);
  }
});

describe('check-ignore deadline from OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS', () => {
  const name = 'OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS';
  let loads = 0;
  // The value is read when the module loads, so each case loads a fresh copy.
  const deadlineFor = async (value) => {
    const saved = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try {
      loads += 1;
      const fresh = await import(`./bridge-fs-helpers-runtime.ts?check-ignore-${loads}`);
      directoryEntries = new Map([['/workspace', [['file.ts', 1]]]]);
      lastCheckIgnoreOptions = undefined;
      await fresh.searchDirectory('/workspace', 'file', 60, false, true);
      return lastCheckIgnoreOptions?.timeoutMs;
    } finally {
      directoryEntries = undefined;
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  };

  test('falls back to 2500 ms when unset or not a plain decimal', async () => {
    for (const value of [undefined, '', ' ', '1e3', '0x10', '5.9', '-5']) {
      expect(await deadlineFor(value)).toBe(2500);
    }
  });

  test('honours a plain decimal value, including an explicit 0', async () => {
    expect(await deadlineFor('4000')).toBe(4000);
    expect(await deadlineFor('0')).toBe(0);
  });

  test('falls back to the default above the timer maximum', async () => {
    expect(await deadlineFor('2147483647')).toBe(2_147_483_647);
    expect(await deadlineFor('3000000000')).toBe(2500);
    expect(await deadlineFor('9007199254740993')).toBe(2500);
  });
});

describe('models.dev catalog read ceiling', () => {
  const CAP = 16 * 1024 * 1024;
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  const answer = (response) => {
    globalThis.fetch = async () => response;
  };
  const streamed = (chunks, onPull) => {
    let index = 0;
    return new ReadableStream({
      pull(controller) {
        onPull?.();
        if (index >= chunks.length) controller.close();
        else controller.enqueue(chunks[index++]);
      },
    });
  };

  test('parses a catalog read in pieces', async () => {
    const payload = JSON.stringify({ openai: { id: 'openai' } });
    const encoder = new TextEncoder();
    answer(new Response(streamed([encoder.encode(payload.slice(0, 5)), encoder.encode(payload.slice(5))])));
    expect(await fetchModelsMetadata()).toEqual({ openai: { id: 'openai' } });
  });

  test('refuses a declared over-cap length without reading the body', async () => {
    let pulls = 0;
    answer(new Response(streamed([new Uint8Array(1)], () => { pulls += 1; }), { headers: { 'content-length': String(CAP + 1) } }));
    await expect(fetchModelsMetadata()).rejects.toThrow('models.dev response exceeded size limit');
    expect(pulls).toBeLessThanOrEqual(1);
  });

  test('cancels a stream as soon as it passes the cap, and a body at the cap is read whole', async () => {
    let pulls = 0;
    const chunk = new Uint8Array(9 * 1024 * 1024).fill(32);
    answer(new Response(streamed([chunk, chunk, chunk, chunk, chunk], () => { pulls += 1; })));
    await expect(fetchModelsMetadata()).rejects.toThrow('models.dev response exceeded size limit');
    expect(pulls).toBeLessThan(5);

    const atCap = new Uint8Array(CAP).fill(32);
    atCap[0] = 0x7b; // '{'
    atCap[CAP - 1] = 0x7d; // '}'
    answer(new Response(streamed([atCap])));
    expect(await fetchModelsMetadata()).toEqual({});
  });

  test('a non-OK status still throws its own error', async () => {
    answer(new Response('down', { status: 503 }));
    await expect(fetchModelsMetadata()).rejects.toThrow('models.dev responded with 503');
  });
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

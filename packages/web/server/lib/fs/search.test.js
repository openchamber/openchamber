import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFsSearchRuntime, createGitCheckIgnoreTimeoutMs } from './search.js';

// i, n, d, e and x in order, each buried under filler characters with the
// maximum gap penalty: a weak in-order subsequence of "index".
const WEAK_SUBSEQUENCE_STEM = 'qqqqqqqqqiqqqqqqqqqqnqqqqqqqqqqdqqqqqqqqqqeqqqqqqqqqqx';

const createSearchRuntime = (spawn) =>
  createFsSearchRuntime({ fsPromises: fs, path, spawn, resolveGitBinaryForSpawn: () => 'git' });

const neverSpawn = () => {
  throw new Error('spawn must not run while respectGitignore is disabled');
};

describe('filesystem search', () => {
  it('reaches an exact deep match after weak shallow subsequence matches', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-fs-search-'));
    try {
      const shallow = path.join(root, 'a_shallow');
      const deep = path.join(root, 'z_deep', 'nested');
      await fs.mkdir(shallow, { recursive: true });
      await fs.mkdir(deep, { recursive: true });
      // 220 weak shallow matches exceed the old 200-candidate stop and would
      // end the walk before the deep directory is ever read.
      for (let index = 1; index <= 220; index += 1) {
        const name = `${WEAK_SUBSEQUENCE_STEM}_${String(index).padStart(3, '0')}.txt`;
        await fs.writeFile(path.join(shallow, name), '');
      }
      await fs.writeFile(path.join(deep, 'index.ts'), '');

      const search = createSearchRuntime(neverSpawn);
      const files = await search.searchFilesystemFiles(root, {
        query: 'index',
        limit: 20,
        respectGitignore: false,
      });

      expect(files[0]?.relativePath).toBe('z_deep/nested/index.ts');
      expect(files).toHaveLength(20);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('stops an empty query at the limit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-fs-search-'));
    try {
      for (let index = 1; index <= 5; index += 1) {
        await fs.writeFile(path.join(root, `file_${index}.txt`), '');
      }

      const search = createSearchRuntime(neverSpawn);
      const files = await search.searchFilesystemFiles(root, {
        query: '',
        limit: 3,
        respectGitignore: false,
      });

      expect(files).toHaveLength(3);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('bounds a directory-heavy walk at the directory-visit cap and returns partial results', async () => {
    const rootPath = '/virtual-dir-cap';
    const fileDirent = { name: 'favicon.ico', isDirectory: () => false, isFile: () => true };
    const emptyDirs = Array.from({ length: 60_000 }, (_, index) => ({
      name: `dir_${index}`,
      isDirectory: () => true,
      isFile: () => false,
    }));
    let readdirCalls = 0;
    const readdir = async (dirPath) => {
      readdirCalls += 1;
      return dirPath === rootPath ? [fileDirent, ...emptyDirs] : [];
    };
    const search = createFsSearchRuntime({
      fsPromises: { readdir },
      path,
      spawn: neverSpawn,
      resolveGitBinaryForSpawn: () => 'git',
    });

    const files = await search.searchFilesystemFiles(rootPath, {
      query: 'favicon',
      limit: 10,
      respectGitignore: false,
    });

    // The root plus the 49,999 directories admitted under the 50,000
    // directory-visit ceiling are read; the remaining offered directories
    // are never enqueued, and the match found before the ceiling is kept.
    expect(files.map((file) => file.relativePath)).toEqual(['favicon.ico']);
    expect(readdirCalls).toBe(50_000);
  });

  it('returns complete results from a tree that exactly reaches the directory cap', async () => {
    const rootPath = '/virtual-at-cap';
    const targetPath = path.join(rootPath, 'target');
    const needleDirent = { name: 'needle.txt', isDirectory: () => false, isFile: () => true };
    const rootEntries = [
      { name: 'target', isDirectory: () => true, isFile: () => false },
      ...Array.from({ length: 49_998 }, (_, index) => ({
        name: `empty_${index}`,
        isDirectory: () => true,
        isFile: () => false,
      })),
    ];
    let readdirCalls = 0;
    const readdir = async (dirPath) => {
      readdirCalls += 1;
      if (dirPath === rootPath) return rootEntries;
      if (dirPath === targetPath) return [needleDirent];
      return [];
    };
    const search = createFsSearchRuntime({
      fsPromises: { readdir },
      path,
      spawn: neverSpawn,
      resolveGitBinaryForSpawn: () => 'git',
    });

    const files = await search.searchFilesystemFiles(rootPath, {
      query: 'needle',
      limit: 10,
      respectGitignore: false,
    });

    // Root + target + 49,998 empty directories reach the ceiling exactly;
    // every admitted directory is still read, so the deep match is found.
    expect(files.map((file) => file.relativePath)).toEqual(['target/needle.txt']);
    expect(readdirCalls).toBe(50_000);
  });

  it('treats a non-ASCII path as ignored when check-ignore output splits a multi-byte character (#1540)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-fs-search-'));
    try {
      await fs.writeFile(path.join(root, 'café.txt'), '');
      await fs.writeFile(path.join(root, 'visible.txt'), '');

      // The ignored name arrives in two chunks split inside the two-byte
      // encoding of é (0xC3 0xA9): per-chunk decoding would corrupt it to
      // U+FFFD and the name would never match the directory entry.
      const full = Buffer.from('café.txt\n', 'utf8');
      const splitAt = full.indexOf(0xc3) + 1;
      const chunkedSpawn = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.kill = () => {};
        queueMicrotask(() => {
          child.stdout.emit('data', full.subarray(0, splitAt));
          child.stdout.emit('data', full.subarray(splitAt));
          child.emit('close', 0, null);
        });
        return child;
      };

      const search = createSearchRuntime(chunkedSpawn);
      const files = await search.searchFilesystemFiles(root, {
        query: '',
        limit: 10,
        respectGitignore: true,
      });

      expect(files.map((file) => file.name)).toEqual(['visible.txt']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('kills a stuck git check-ignore instead of hanging the search', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-fs-search-'));
    const previousTimeout = process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS;
    let guard;
    try {
      await fs.writeFile(path.join(root, 'visible.txt'), '');
      process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS = '50';

      const kills = [];
      const neverCloses = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.kill = (signal) => {
          kills.push(signal);
          child.emit('close');
        };
        return child;
      };

      const search = createSearchRuntime(neverCloses);
      const files = await Promise.race([
        search.searchFilesystemFiles(root, { query: '', limit: 10, respectGitignore: true }),
        new Promise((_, reject) => {
          guard = setTimeout(() => reject(new Error('git check-ignore outlived its timeout')), 2000);
        }),
      ]);

      expect(files.map((file) => file.name)).toEqual(['visible.txt']);
      expect(kills).toEqual(['SIGKILL']);
    } finally {
      clearTimeout(guard);
      if (previousTimeout === undefined) {
        delete process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS;
      } else {
        process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS = previousTimeout;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('git check-ignore timeout env reader (#696)', () => {
  const NAME = 'OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS';

  const readWith = (value) => {
    const previous = process.env[NAME];
    if (value === undefined) delete process.env[NAME];
    else process.env[NAME] = value;
    try {
      return createGitCheckIgnoreTimeoutMs();
    } finally {
      if (previous === undefined) delete process.env[NAME];
      else process.env[NAME] = previous;
    }
  };

  it('honours plain decimal spellings, including an explicit 0, and defaults when unset', () => {
    expect(readWith('5000')).toBe(5000);
    expect(readWith('50')).toBe(50);
    expect(readWith(' 250 ')).toBe(250);
    expect(readWith('0')).toBe(0);
    expect(readWith(undefined)).toBe(2500);
  });

  it('falls back to the default for non-plain-decimal spellings', () => {
    for (const invalid of ['', ' ', '1e3', '0x10', '5.9', '5000junk']) {
      expect(readWith(invalid)).toBe(2500);
    }
  });

  it('falls back to the default above the timer maximum', () => {
    expect(readWith('2147483647')).toBe(2_147_483_647);
    expect(readWith('3000000000')).toBe(2500);
    expect(readWith('9007199254740993')).toBe(2500);
  });
});

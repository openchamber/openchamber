import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFsSearchRuntime } from './search.js';

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

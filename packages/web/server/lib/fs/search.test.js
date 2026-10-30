import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
  it('respects ignored Unicode and whitespace names when hidden files are included', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-fs-search-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      await fs.writeFile(path.join(root, '.gitignore'), '.ігнор.ts\n*ignored.ts\n space.ts\\ \n');
      for (const name of ['.ігнор.ts', '.line\nignored.ts', ' space.ts ', '.visible.ts']) {
        await fs.writeFile(path.join(root, name), '');
      }
      const search = createFsSearchRuntime({ fsPromises: fs, path, spawn, resolveGitBinaryForSpawn: () => 'git', workspaceSearch: true });
      const files = await search.searchFilesystemFiles(root, { query: 'ts', limit: 60, includeHidden: true, respectGitignore: true });
      expect(files.map((file) => file.name)).toEqual(['.visible.ts']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

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

  it('workspace search includes generated directories and goes past the icon-search ceiling', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-workspace-search-'));
    try {
      await fs.mkdir(path.join(root, 'build'));
      await fs.writeFile(path.join(root, 'build/needle.ts'), '');
      const search = createFsSearchRuntime({
        fsPromises: {
          ...fs,
          async readdir(directory, options) {
            if (directory !== root) return fs.readdir(directory, options);
            return [
              ...Array.from({ length: 10_001 }, (_, index) => ({ name: `ordinary-${index}.ts`, isDirectory: () => false, isFile: () => true })),
              ...(await fs.readdir(directory, options)),
            ];
          },
        },
        path, spawn: neverSpawn, resolveGitBinaryForSpawn: () => 'git', workspaceSearch: true,
      });
      expect((await search.searchFilesystemFiles(root, { query: 'needle', limit: 10, respectGitignore: false }))
        .map((file) => file.relativePath)).toEqual(['build/needle.ts']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unreadable workspace searches instead of returning an empty success', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-workspace-search-'));
    try {
      const search = createFsSearchRuntime({ fsPromises: fs, path, spawn: neverSpawn, workspaceSearch: true });
      await expect(search.searchFilesystemFiles(path.join(root, 'missing'), { query: 'needle', limit: 10, respectGitignore: false }))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a workspace search that completes after its deadline', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(30_001);
    try {
      const search = createFsSearchRuntime({ fsPromises: { readdir: async () => [] }, path, spawn: neverSpawn, workspaceSearch: true });
      await expect(search.searchFilesystemFiles('/repo', { query: 'needle', limit: 10, respectGitignore: false }))
        .rejects.toThrow('File search exceeded its time limit');
    } finally {
      clock.mockRestore();
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
        child.stdin = { on() {}, end() {} };
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

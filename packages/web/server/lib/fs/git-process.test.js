import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFsSearchRuntime } from './search.js';
import { registerFsRoutes } from './routes.js';

// Use real OS pipes. A mocked data event cannot reproduce a full stderr pipe.
const noisyGit = `
  const fs = require('node:fs');
  const chunk = Buffer.alloc(65536, 'x');
  for (let i = 0; i < 32; i++) fs.writeSync(2, chunk);
  fs.writeSync(1, 'ignored.txt\\0');
`;

describe('filesystem Git process ownership', () => {
  for (const operation of ['search', 'list']) {
    it(`${operation} completes repeated checks with more diagnostics than an OS pipe can hold`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-git-pipes-'));
      const children = [];
      const exits = [];
      const launch = (binary, args, options) => {
        expect(binary).toBe('git');
        expect(args).toContain('check-ignore');
        expect(args).toContain('ignored.txt');
        const child = spawn(process.execPath, ['-e', noisyGit], options);
        children.push(child);
        exits.push(new Promise((resolve) => child.once('close', (code) => resolve(code))));
        return child;
      };
      let deadline;
      try {
        await fs.writeFile(path.join(root, 'ignored.txt'), 'ignored');
        await fs.writeFile(path.join(root, 'visible.txt'), 'visible');
        const dependencies = { fsPromises: fs, path, spawn: launch, resolveGitBinaryForSpawn: () => 'git' };
        const search = createFsSearchRuntime(dependencies);
        const routes = new Map();
        registerFsRoutes({
          get(route, handler) { routes.set(route, handler); }, post() {}, put() {}, delete() {},
        }, {
          ...dependencies, os, crypto, normalizeDirectoryPath: (value) => value,
          resolveProjectDirectory: async () => ({ directory: root }),
          buildAugmentedPath: () => process.env.PATH,
          openchamberUserConfigRoot: root,
          gitCheckIgnoreTimeoutMs: 10_000,
        });
        const work = Array.from({ length: 12 }, async () => {
          if (operation === 'search') {
            const files = await search.searchFilesystemFiles(root, { query: '', limit: 10, respectGitignore: true });
            expect(files.map((file) => file.name)).toEqual(['visible.txt']);
          } else {
            const response = { status() { return this; }, json(value) { this.body = value; } };
            await routes.get('/api/fs/list')({ query: { path: root, respectGitignore: 'true' } }, response);
            expect(response.body.entries.map((entry) => entry.name)).toEqual(['visible.txt']);
          }
        });
        await Promise.race([
          Promise.all(work),
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Git blocked on unread diagnostics')), 5000); }),
        ]);
        expect(children).toHaveLength(12);
        expect(await Promise.all(exits)).toEqual(Array(12).fill(0));
        for (const child of children) expect(child.exitCode).toBe(0);
      } finally {
        clearTimeout(deadline);
        for (const child of children) {
          child.stderr?.resume();
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
        await Promise.all(exits);
        await fs.rm(root, { recursive: true, force: true });
      }
    }, 15_000);
  }

  it('does not hide blocked Gitignore cleanup in list or search fallbacks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-git-cleanup-fallback-'));
    const cleanupFailure = Object.assign(new Error('Git process tree cleanup was not confirmed'), {
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      descendantsTerminated: false,
      rootClosed: false,
      pid: 9191,
    });
    const gitExecutionService = {
      withRawRead: async () => { throw cleanupFailure; },
    };
    const dependencies = {
      fsPromises: fs,
      path,
      spawn: () => { throw new Error('spawn should not run after admission failure'); },
      resolveGitBinaryForSpawn: () => 'git',
      gitExecutionService,
    };

    try {
      await fs.writeFile(path.join(root, 'visible.txt'), 'visible');
      const search = createFsSearchRuntime(dependencies);
      await expect(search.searchFilesystemFiles(root, {
        query: '',
        limit: 10,
        respectGitignore: true,
      })).rejects.toMatchObject({
        code: 'ERR_PROCESS_TREE_TERMINATION',
        cleanupBlocked: true,
        descendantsTerminated: false,
      });

      const routes = new Map();
      registerFsRoutes({
        get(route, handler) { routes.set(route, handler); },
        post() {},
        put() {},
        delete() {},
      }, {
        ...dependencies,
        os,
        crypto,
        normalizeDirectoryPath: (value) => value,
        resolveProjectDirectory: async () => ({ directory: root }),
        buildAugmentedPath: () => process.env.PATH,
        openchamberUserConfigRoot: root,
      });
      const response = {
        writableEnded: false,
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; },
      };
      await routes.get('/api/fs/list')({ query: { path: root, respectGitignore: 'true' } }, response);
      expect(response.statusCode).toBe(500);
      expect(response.body.error).toMatch(/cleanup was not confirmed/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { resolveRepoNetwork } = await import('./fork-detection.js');
const execFileAsync = promisify(execFile);
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('GitHub fork network discovery', () => {
  it('resolves an alternate configured remote through the fork network with cancellation', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-github-fork-'));
    temporaryRoots.push(directory);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
    await execFileAsync('git', ['remote', 'add', 'upstream', 'git@github.com:fork-owner/project.git'], { cwd: directory });
    const controller = new AbortController();
    const octokit = {
      rest: {
        repos: {
          get: vi.fn(async ({ signal }) => {
            expect(signal).toBe(controller.signal);
            return {
              data: {
                parent: {
                  owner: { login: 'upstream-owner' },
                  name: 'project',
                  html_url: 'https://github.com/upstream-owner/project',
                },
              },
            };
          }),
        },
      },
    };

    await expect(resolveRepoNetwork(
      octokit,
      directory,
      'upstream',
      { signal: controller.signal },
    )).resolves.toEqual([
      expect.objectContaining({ owner: 'fork-owner', source: 'origin' }),
      expect.objectContaining({ owner: 'upstream-owner', source: 'upstream' }),
    ]);
  });
});

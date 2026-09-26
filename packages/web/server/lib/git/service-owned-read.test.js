import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGitExecutionService } from './execution-service.js';
import { getLog, getRangeDiff, getRemotes } from './service.js';

const temporaryRoots = [];
const execFileAsync = promisify(execFile);

const runGit = async (directory, args) => {
  await execFileAsync('git', args, {
    cwd: directory,
    windowsHide: true,
  });
};

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('owned web Git reads', () => {
  it('reads alternate remotes through the signal-enabled owned adapter', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-owned-remotes-'));
    temporaryRoots.push(directory);
    await runGit(directory, ['init', '-b', 'main']);
    await runGit(directory, ['remote', 'add', 'origin', 'https://github.com/acme/project.git']);
    await runGit(directory, ['remote', 'add', 'upstream', 'git@github.com:upstream/project.git']);

    await expect(getRemotes(directory, { signal: new AbortController().signal })).resolves.toEqual([
      {
        name: 'origin',
        fetchUrl: 'https://github.com/acme/project.git',
        pushUrl: 'https://github.com/acme/project.git',
      },
      {
        name: 'upstream',
        fetchUrl: 'git@github.com:upstream/project.git',
        pushUrl: 'git@github.com:upstream/project.git',
      },
    ]);
  });

  it('keeps the signal-enabled log response contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-owned-log-'));
    temporaryRoots.push(directory);
    await runGit(directory, ['init', '-b', 'main']);
    await runGit(directory, ['config', 'user.email', 'test@example.com']);
    await runGit(directory, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(directory, 'README.md'), 'log\n');
    await runGit(directory, ['add', 'README.md']);
    await runGit(directory, ['commit', '-m', 'owned log']);

    await expect(getLog(directory, { signal: new AbortController().signal })).resolves.toMatchObject({
      total: 1,
      latest: { message: 'owned log' },
    });
  });

  it('cancels a range read through the owned process-tree boundary', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-owned-read-'));
    const marker = path.join(directory, 'diff-started');
    const externalDiff = path.join(directory, 'external-diff.mjs');
    temporaryRoots.push(directory);

    await runGit(directory, ['init', '-b', 'main']);
    await runGit(directory, ['config', 'user.email', 'test@example.com']);
    await runGit(directory, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(directory, 'file.txt'), 'base\n');
    await runGit(directory, ['add', 'file.txt']);
    await runGit(directory, ['commit', '-m', 'base']);
    await runGit(directory, ['switch', '-c', 'feature']);
    await fs.writeFile(path.join(directory, 'file.txt'), 'feature\n');
    await runGit(directory, ['commit', '-am', 'feature']);

    await fs.writeFile(externalDiff, `import fs from 'node:fs';

fs.writeFileSync(${JSON.stringify(marker)}, 'started');
setInterval(() => {}, 1_000);
`);
    await fs.chmod(externalDiff, 0o755);
    await runGit(directory, ['config', 'diff.external', `${process.execPath} ${externalDiff}`]);

    const controller = new AbortController();
    const pending = getRangeDiff(directory, {
      base: 'main',
      head: 'feature',
      signal: controller.signal,
    });

    await vi.waitFor(async () => {
      await expect(fs.readFile(marker, 'utf8')).resolves.toBe('started');
    });
    controller.abort(new Error('cancelled by test'));

    await expect(pending).rejects.toThrow();
  });

  it('keeps a cancelled status source leased until expansion cleanup settles once', async () => {
    let expansionStarted = false;
    let finishExpansionCleanup;
    let cleanupCount = 0;
    const execution = createGitExecutionService({
      raw: {
        getStatus: (_directory, options = {}) => new Promise((_resolve, reject) => {
          expansionStarted = true;
          options.signal?.addEventListener('abort', () => {
            finishExpansionCleanup = () => {
              if (cleanupCount > 0) return;
              cleanupCount += 1;
              reject(Object.assign(new Error('The untracked expansion was aborted'), { code: 'ABORT_ERR' }));
            };
          }, { once: true });
        }),
      },
      resolver: {
        resolve: async () => ({
          isRepository: true,
          commonId: 'common',
          worktreeId: 'worktree',
        }),
      },
    });
    const controller = new AbortController();
    const pending = execution.getStatus('/repo', { signal: controller.signal, mode: 'light' });

    await vi.waitFor(() => expect(expansionStarted).toBe(true));
    controller.abort('status expansion cancelled');

    await expect(pending).rejects.toMatchObject({ code: 'GIT_EXECUTION_CANCELLED' });
    expect(execution.coordinator.getStats()).toMatchObject({ active: 1, statusInFlight: 1 });
    finishExpansionCleanup?.();
    await vi.waitFor(() => expect(execution.coordinator.getStats()).toMatchObject({
      active: 0,
      statusInFlight: 0,
    }));
    expect(cleanupCount).toBe(1);
  });
});

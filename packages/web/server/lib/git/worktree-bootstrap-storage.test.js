import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { completeWorktreeCheckoutHydration, getWorktreeBootstrapStatus } from './service.js';
import { createWorktreeBootstrapStore } from './worktree-bootstrap-storage.js';

const directories = [];
const temporaryDirectory = async (prefix) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
};
const gitAvailable = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('worktree bootstrap storage', () => {
  it('persists status by directory fingerprint without writing the directory', async () => {
    const dataDirectory = await temporaryDirectory('worktree-bootstrap-store-');
    const filePath = path.join(dataDirectory, 'bootstrap.json');
    const directory = '/private/worktrees/feature-one';
    const store = createWorktreeBootstrapStore({ filePath });
    const status = { status: 'ready', phase: 'setup-ready', error: null, updatedAt: 12 };

    await store.write(directory, status);

    await expect(createWorktreeBootstrapStore({ filePath }).read(directory)).resolves.toEqual(status);
    expect(await fs.readFile(filePath, 'utf8')).not.toContain(directory);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it('stores only bounded public bootstrap errors', async () => {
    const dataDirectory = await temporaryDirectory('worktree-bootstrap-errors-');
    const filePath = path.join(dataDirectory, 'bootstrap.json');
    const directory = '/private/worktrees/feature-errors';
    const store = createWorktreeBootstrapStore({ filePath });

    const stored = await store.write(directory, {
      status: 'failed',
      phase: 'git-ready',
      error: 'Failed at /private/worktrees/feature-errors with token_secret',
      errorCode: 'TRANSPORT_FAILED',
      updatedAt: 12,
      hydration: {
        status: 'failed',
        submodules: [{
          path: 'vendor/module',
          status: 'failed',
          endpoint: { displayUrl: 'git@example.com:owner/module.git', fingerprint: 'module_fingerprint' },
          error: { code: 'TRANSPORT_FAILED', message: 'token_secret process output' },
        }],
        lfs: [],
      },
    });

    expect(stored.error).toBe('Worktree checkout hydration failed');
    const encoded = await fs.readFile(filePath, 'utf8');
    expect(encoded).not.toContain(directory);
    expect(encoded).not.toContain('git@example.com');
    expect(encoded).not.toContain('token_secret');
    expect(encoded).not.toContain('process output');
  });

  it('turns a restarted pending bootstrap into a git-ready repair blocker without resuming it', async () => {
    if (!gitAvailable()) return;
    const dataDirectory = await temporaryDirectory('worktree-bootstrap-restart-');
    const repository = await temporaryDirectory('worktree-bootstrap-repository-');
    const worktree = await temporaryDirectory('worktree-bootstrap-checkout-');
    execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repository });
    await fs.writeFile(path.join(repository, 'README.md'), '# Test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repository });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repository, stdio: 'ignore' });
    await fs.rm(worktree, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'add', '-b', 'feature/restart', worktree, 'HEAD'], {
      cwd: repository, stdio: 'ignore',
    });
    const store = createWorktreeBootstrapStore({ filePath: path.join(dataDirectory, 'bootstrap.json') });
    await store.write(worktree, {
      status: 'pending', phase: 'directory-created', error: null, updatedAt: 1,
    });

    const result = await getWorktreeBootstrapStatus(worktree, { bootstrapStore: store });

    expect(result).toMatchObject({
      status: 'failed',
      phase: 'git-ready',
      errorCode: 'UNKNOWN',
      error: expect.stringContaining('repair'),
    });
    await expect(store.read(worktree)).resolves.toEqual(result);
  });

  it('reads a populated checkout with no durable record as ready and writes nothing', async () => {
    if (!gitAvailable()) return;
    const dataDirectory = await temporaryDirectory('worktree-bootstrap-missing-');
    const repository = await temporaryDirectory('worktree-bootstrap-missing-repository-');
    const worktree = await temporaryDirectory('worktree-bootstrap-missing-checkout-');
    execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repository });
    await fs.writeFile(path.join(repository, 'README.md'), '# Test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repository });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repository, stdio: 'ignore' });
    await fs.rm(worktree, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'add', '-b', 'feature/missing', worktree, 'HEAD'], {
      cwd: repository, stdio: 'ignore',
    });
    const store = createWorktreeBootstrapStore({ filePath: path.join(dataDirectory, 'bootstrap.json') });

    const result = await getWorktreeBootstrapStatus(worktree, { bootstrapStore: store });

    expect(result).toMatchObject({ status: 'ready', phase: 'setup-ready' });
    await expect(store.read(worktree)).resolves.toBeNull();
  });

  it('completes only hydration-owned failures and publishes the transition in memory', async () => {
    const dataDirectory = await temporaryDirectory('worktree-bootstrap-complete-');
    const hydrationWorktree = path.join(dataDirectory, 'hydration-repair');
    const unrelatedWorktree = path.join(dataDirectory, 'setup-failure');
    const store = createWorktreeBootstrapStore({ filePath: path.join(dataDirectory, 'bootstrap.json') });
    await store.write(hydrationWorktree, {
      status: 'failed', phase: 'directory-created', error: 'Hydration failed',
      errorCode: 'AUTHENTICATION_REQUIRED', updatedAt: 1,
      hydration: {
        status: 'authorization-required',
        submodules: [{
          path: 'vendor/module', status: 'authorization-required',
          endpoint: { displayUrl: 'https://modules.example/module.git', fingerprint: 'module_fingerprint' },
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'Grant required' },
        }],
        lfs: [],
      },
    });
    const unrelated = {
      status: 'failed', phase: 'git-ready', error: 'Setup failed', errorCode: 'UNKNOWN', updatedAt: 2,
    };
    const persistedUnrelated = await store.write(unrelatedWorktree, unrelated);

    await expect(completeWorktreeCheckoutHydration(hydrationWorktree, { bootstrapStore: store }))
      .resolves.toMatchObject({ status: 'ready', phase: 'setup-ready', error: null });
    await expect(getWorktreeBootstrapStatus(hydrationWorktree, { bootstrapStore: store }))
      .resolves.toMatchObject({ status: 'ready', phase: 'setup-ready' });
    await expect(completeWorktreeCheckoutHydration(unrelatedWorktree, { bootstrapStore: store })).resolves.toBeNull();
    await expect(store.read(unrelatedWorktree)).resolves.toEqual(persistedUnrelated);
  });

  it('serializes hydration completion across store instances', async () => {
    const dataDirectory = await temporaryDirectory('worktree-bootstrap-complete-race-');
    const worktree = path.join(dataDirectory, 'hydration-repair');
    const filePath = path.join(dataDirectory, 'bootstrap.json');
    const first = createWorktreeBootstrapStore({ filePath });
    const second = createWorktreeBootstrapStore({ filePath });
    await first.write(worktree, {
      status: 'failed', phase: 'git-ready', error: 'Hydration failed',
      errorCode: 'TRANSPORT_FAILED', updatedAt: 1,
      hydration: {
        status: 'failed',
        submodules: [{ path: 'vendor/module', status: 'failed', error: { code: 'TRANSPORT_FAILED', message: 'Failed' } }],
        lfs: [],
      },
    });

    const completions = await Promise.all([first.completeHydration(worktree), second.completeHydration(worktree)]);

    expect(completions.filter(Boolean)).toHaveLength(1);
    await expect(first.read(worktree)).resolves.toMatchObject({ status: 'ready', phase: 'setup-ready' });
  });
});

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VCS_INIT_CONFIRMATION_HEADER, VCS_INIT_CONFIRMATION_VALUE, resolveVcsInitRefusalBody } from './vcs-init-guard.js';

const tempDirs = [];

/** Create a temp dir and register it for afterEach cleanup. */
const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vcs-init-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const runGit = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const canRunGit = () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vcs-init-check-'));
  try {
    execFileSync('git', ['--version'], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
};

const header = (directory) => ({ 'x-opencode-directory': encodeURIComponent(directory) });
const confirmedHeader = (directory) => ({
  ...header(directory),
  [VCS_INIT_CONFIRMATION_HEADER]: VCS_INIT_CONFIRMATION_VALUE,
});

const initGit = (directory) => runGit(directory, ['init', '-q']);

describe('VCS init guard', () => {
  it('refuses a directory with nested repositories and names them', async () => {
    if (!canRunGit()) return;

    const root = createTempDir();
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    initGit(nested);

    const body = await resolveVcsInitRefusalBody('POST', '/api/vcs/init', header(root));

    expect(body._tag).toBe('VcsInitConfirmationRequiredError');
    expect(body.code).toBe('confirmation-required');
    expect(body.message).toContain(nested);
  });

  it('lets the same request through with the confirmation header', async () => {
    if (!canRunGit()) return;

    const root = createTempDir();
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    initGit(nested);

    await expect(resolveVcsInitRefusalBody('POST', '/api/vcs/init', confirmedHeader(root))).resolves.toBeNull();
  });

  it('treats a .git file as a nested repository boundary', async () => {
    if (!canRunGit()) return;

    const root = createTempDir();
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(root, 'gitdir')}\n`);

    const body = await resolveVcsInitRefusalBody('POST', '/api/vcs/init', header(root));

    expect(body?.code).toBe('confirmation-required');
  });

  it('refuses when a repository sits deeper than the scan reaches', async () => {
    if (!canRunGit()) return;

    const root = createTempDir();
    const deep = path.join(root, 'a', 'b', 'c', 'deep-repo');
    fs.mkdirSync(deep, { recursive: true });
    initGit(deep);

    const body = await resolveVcsInitRefusalBody('POST', '/api/vcs/init', header(root));

    expect(body._tag).toBe('VcsInitConfirmationRequiredError');
    expect(body.code).toBe('confirmation-required');
    expect(body.message).toMatch(/fully scanned/);
  });

  it('refuses when the visit cap leaves directories unchecked', async () => {
    if (!canRunGit()) return;

    const root = createTempDir();
    for (let index = 0; index < 120; index += 1) {
      fs.mkdirSync(path.join(root, `folder-${index}`));
    }

    const body = await resolveVcsInitRefusalBody('POST', '/api/vcs/init', header(root));

    expect(body?._tag).toBe('VcsInitConfirmationRequiredError');
    expect(body?.code).toBe('confirmation-required');
  });

  it('passes a complete scan that found no repositories', async () => {
    if (!canRunGit()) return;

    const root = createTempDir();
    fs.mkdirSync(path.join(root, 'src'));

    await expect(resolveVcsInitRefusalBody('POST', '/api/vcs/init', header(root))).resolves.toBeNull();
  });

  it('passes reinitializing an established repository that contains nested repositories', async () => {
    if (!canRunGit()) return;

    const root = createTempDir();
    initGit(root);
    runGit(root, ['config', 'user.email', 'test@example.com']);
    runGit(root, ['config', 'user.name', 'Test User']);
    runGit(root, ['commit', '--allow-empty', '-q', '-m', 'Initial commit']);
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    initGit(nested);

    await expect(resolveVcsInitRefusalBody('POST', '/api/vcs/init', header(root))).resolves.toBeNull();
  });

  it('passes reinitializing an unborn repository that contains nested repositories', async () => {
    if (!canRunGit()) return;

    const root = createTempDir();
    initGit(root);
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    initGit(nested);

    await expect(resolveVcsInitRefusalBody('POST', '/api/vcs/init', header(root))).resolves.toBeNull();
  });

  it('refuses a root .git entry that is not a valid repository', async () => {
    if (!canRunGit()) return;

    const root = createTempDir();
    fs.mkdirSync(path.join(root, '.git'));
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    initGit(nested);

    const body = await resolveVcsInitRefusalBody('POST', '/api/vcs/init', header(root));

    expect(body?._tag).toBe('VcsInitConfirmationRequiredError');
    expect(body?.code).toBe('confirmation-required');
  });

  it('keeps refusing home and disk roots even with the confirmation header', async () => {
    const home = createTempDir();

    const homeBody = await resolveVcsInitRefusalBody('POST', '/api/vcs/init', confirmedHeader(home), home);
    expect(homeBody._tag).toBe('InvalidRequestError');
    expect(homeBody.message).toMatch(/home directory/);

    const diskBody = await resolveVcsInitRefusalBody(
      'POST',
      '/api/vcs/init',
      confirmedHeader(path.parse(home).root),
      home,
    );
    expect(diskBody._tag).toBe('InvalidRequestError');
    expect(diskBody.message).toMatch(/root of a disk/);

    const noDirectoryBody = await resolveVcsInitRefusalBody(
      'POST',
      '/api/vcs/init',
      { [VCS_INIT_CONFIRMATION_HEADER]: VCS_INIT_CONFIRMATION_VALUE },
      home,
    );
    expect(noDirectoryBody._tag).toBe('InvalidRequestError');
    expect(noDirectoryBody.message).toMatch(/project directory/);
  });

  it('leaves other requests untouched', async () => {
    const root = createTempDir();
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    initGit(nested);

    await expect(resolveVcsInitRefusalBody('GET', '/api/vcs/init', header(root))).resolves.toBeNull();
    await expect(resolveVcsInitRefusalBody('POST', '/api/session', header(root))).resolves.toBeNull();
    await expect(resolveVcsInitRefusalBody('POST', '/api/vcs', header(root))).resolves.toBeNull();
  });

  it('allows an init the guard cannot scan, with a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const missing = path.join(createTempDir(), 'does-not-exist');

      await expect(resolveVcsInitRefusalBody('POST', '/api/vcs/init', header(missing))).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { directoryReachability } from '../directory-reachability/index.js';
import { assertRepositoryReachable } from './reachable-disk.js';
import { canonicalizeWorktreeState, getWorktrees, isGitRepository } from './service.js';

const OFFLINE = path.resolve('/offline');
let root;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-metadata-')));
  const original = directoryReachability.assertReachable;
  vi.spyOn(directoryReachability, 'assertReachable').mockImplementation(async (directory) => {
    if (directory.startsWith(OFFLINE)) throw new Error('offline');
    return original(directory);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const layouts = {
  'a .git link file': () => fs.writeFileSync(path.join(root, '.git'), `gitdir: ${OFFLINE}/repo/.git/worktrees/one\n`),
  'a .git symlink': () => fs.symlinkSync(`${OFFLINE}/repo/.git`, path.join(root, '.git')),
  'a symlink on the way': () => {
    fs.symlinkSync(OFFLINE, path.join(root, 'nas'));
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: nas/repo/.git\n');
  },
  'a common directory': () => {
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(root, '.git', 'commondir'), `${OFFLINE}/repo/.git\n`);
  },
  'a repository around an unusable .git': () => {
    git(root, 'init', '-q');
    fs.rmSync(path.join(root, '.git', 'objects'), { recursive: true });
    fs.symlinkSync(`${OFFLINE}/objects`, path.join(root, '.git', 'objects'));
    const inner = path.join(root, 'src', '.git');
    for (const part of ['objects', 'refs']) fs.mkdirSync(path.join(inner, part), { recursive: true });
    fs.writeFileSync(path.join(inner, 'HEAD'), 'broken\n');
  },
  'a bare layout': () => {
    git(root, 'init', '-q', '--bare');
    fs.rmSync(path.join(root, 'objects'), { recursive: true });
    fs.symlinkSync(`${OFFLINE}/objects`, path.join(root, 'objects'));
  },
  'an objects symlink': () => {
    git(root, 'init', '-q');
    fs.rmSync(path.join(root, '.git', 'objects'), { recursive: true });
    fs.symlinkSync(`${OFFLINE}/objects`, path.join(root, '.git', 'objects'));
  },
};

describe.skipIf(process.platform === 'win32').each(Object.entries(layouts))('a repository behind %s on an offline disk', (_name, layout) => {
  it('is never reported as no repository', async () => {
    layout();
    const folder = path.join(root, 'src');
    fs.mkdirSync(folder, { recursive: true });
    for (const directory of [root, folder]) {
      await expect(isGitRepository(directory)).rejects.toThrow('offline');
      await expect(isGitRepository(directory, { failOnGitError: true })).rejects.toThrow('offline');
      await expect(canonicalizeWorktreeState(directory)).rejects.toThrow('offline');
      await expect(getWorktrees(directory)).rejects.toThrow('offline');
    }
  });

  it('does not affect a healthy repository inside it', async () => {
    layout();
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    git(nested, 'init', '-q');
    await expect(assertRepositoryReachable(nested)).resolves.toBeUndefined();
    await expect(isGitRepository(nested)).resolves.toBe(true);
    const bare = path.join(root, 'bare');
    fs.mkdirSync(bare);
    git(bare, 'init', '-q', '--bare');
    await expect(isGitRepository(bare)).resolves.toBe(true);
  });
});

it.skipIf(process.platform === 'win32')('reports a folder with an ordinary HEAD file as no repository, whatever its objects link names', async () => {
  fs.writeFileSync(path.join(root, 'HEAD'), 'notes\n');
  fs.symlinkSync(`${OFFLINE}/objects`, path.join(root, 'objects'));
  await expect(isGitRepository(root)).resolves.toBe(false);
});

it('still reports a plain folder as no repository', async () => {
  await expect(isGitRepository(root)).resolves.toBe(false);
  await expect(isGitRepository(root, { failOnGitError: true })).resolves.toBe(false);
});

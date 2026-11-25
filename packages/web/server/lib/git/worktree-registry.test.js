import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { directoryReachability } from '../directory-reachability/index.js';
import { createWorktreeRegistry } from './worktree-registry.js';

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];
let root;
let repo;
let offline;
let started;

const git = (cwd, ...args) => execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const list = () => git(repo, 'worktree', 'list', '--porcelain');

const touchesEveryWorktree = (args) => args[0] === 'worktree' && (args[1] === 'list' || args[1] === 'prune'
  || (args[1] === 'add' && !args.some((arg) => arg.includes('.openchamber-add-'))));
const runGit = async (cwd, args) => {
  started.push(args.slice(0, 2).join(' '));
  if (offline && touchesEveryWorktree(args)) return new Promise(() => {});
  return promisify(execFile)('git', [...IDENTITY, ...args], { cwd });
};

const init = (...args) => {
  git(root, 'init', '-q', '-b', 'main', ...args, repo);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'one');
};
const goOffline = (directory) => { offline = path.join(root, directory); };

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-registry-')));
  repo = path.join(root, 'repo');
  offline = null;
  started = [];
  const original = directoryReachability.check;
  const check = async (directory) => (offline && (path.resolve(directory) + path.sep).startsWith(offline + path.sep) ? 'unreachable' : original(directory));
  vi.spyOn(directoryReachability, 'check').mockImplementation(check);
  vi.spyOn(directoryReachability, 'isUnreachable').mockImplementation(async (directory) => await check(directory) === 'unreachable');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const withoutReasons = (porcelain) => porcelain.replace(/^(locked|prunable) .*$/gm, '$1');

describe('worktree registry while a linked worktree does not answer', () => {
  const layouts = {
    'loose refs': () => init(),
    'packed refs': () => { init(); git(repo, 'pack-refs', '--all'); },
    'a reftable repository': () => init('--ref-format=reftable'),
    'a SHA-256 repository': () => init('--object-format=sha256'),
  };

  it.each(Object.entries(layouts))('lists the same rows Git lists (%s)', async (_name, prepare) => {
    prepare();
    for (const branch of ['nas', 'plain', 'gone']) git(repo, 'worktree', 'add', '-q', '-b', branch, path.join(root, branch));
    git(repo, 'worktree', 'add', '-q', '--detach', path.join(root, 'detached'));
    git(repo, 'worktree', 'add', '-q', '-b', 'held', path.join(root, 'held'));
    git(repo, 'worktree', 'lock', '--reason', 'mine', path.join(root, 'held'));
    git(path.join(root, 'plain'), 'switch', '-q', '--orphan', 'unborn');
    fs.rmSync(path.join(root, 'gone'), { recursive: true });
    const expected = withoutReasons(list());
    expect(expected).toContain('prunable');
    goOffline('nas');
    expect(await createWorktreeRegistry(runGit).readPorcelain(path.join(root, 'detached'))).toBe(expected);
    expect(started).not.toContain('worktree list');
  });

  it('lists the bare entry and a branch that is an alias of another', async () => {
    git(root, 'init', '-q', '--bare', '-b', 'main', repo);
    const tree = git(repo, 'hash-object', '-w', '-t', 'tree', '--stdin').trim();
    git(repo, 'update-ref', 'refs/heads/main', git(repo, 'commit-tree', tree, '-m', 'one').trim());
    git(repo, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/main');
    git(repo, 'worktree', 'add', '-q', '-b', 'nas', path.join(root, 'nas'), 'main');
    git(repo, 'worktree', 'add', '-q', path.join(root, 'aliased'), 'alias');
    const expected = list();
    goOffline('nas');
    expect(await createWorktreeRegistry(runGit).readPorcelain(repo)).toBe(expected);
  });

  it('never calls a worktree on an absent volume prunable, and forgets only the one asked for', async () => {
    init();
    git(repo, 'worktree', 'add', '-q', '-b', 'nas', path.join(root, 'nas'));
    fs.rmSync(path.join(root, 'nas'), { recursive: true });
    expect(list()).toContain('prunable');
    goOffline('nas');
    const registry = createWorktreeRegistry(runGit);
    expect(await registry.readPorcelain(repo)).not.toContain('prunable');
    await registry.forget(repo, path.join(root, 'nas'));
    expect(await registry.readPorcelain(repo)).toContain('branch refs/heads/nas');
    offline = null;
    await registry.forget(repo, path.join(root, 'other'));
    expect(await registry.readPorcelain(repo)).toContain('branch refs/heads/nas');
    await registry.forget(repo, path.join(root, 'nas'));
    expect(await registry.readPorcelain(repo)).not.toContain('branch refs/heads/nas');
  });

  it('adds a worktree without Git reading the others, and refuses a registered path', async () => {
    init();
    git(repo, 'worktree', 'add', '-q', '-b', 'nas', path.join(root, 'nas'));
    goOffline('nas');
    const registry = createWorktreeRegistry(runGit);
    const target = path.join(root, 'fresh');
    const add = (branch, directory) => registry.add(repo, ['worktree', 'add', '-b', branch, directory], directory, 'failed');
    await add('fresh', target);
    await expect(add('again', path.join(root, 'nas'))).rejects.toThrow('already registered');
    expect(fs.readdirSync(root).sort()).toEqual(['fresh', 'nas', 'repo']);
    expect(git(target, 'status', '--porcelain', '--branch').trim()).toBe('## fresh');
    expect(list().replaceAll('\\', '/')).toContain(`worktree ${target.replaceAll('\\', '/')}\n`);
  });

  it.each([
    ['plain', 'taken'],
    ['spaced and non-ASCII', 'мій тека з файлом'],
  ])('refuses a nonempty folder the way Git does (%s)', async (_label, name) => {
    init();
    git(repo, 'worktree', 'add', '-q', '-b', 'nas', path.join(root, 'nas'));
    const target = path.join(root, name);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'mine'), 'x');
    goOffline('nas');
    const registry = createWorktreeRegistry(runGit);
    const add = () => registry.add(repo, ['worktree', 'add', '-b', 'fresh', target], target, 'failed');
    await expect(add()).rejects.toThrow('already exists');
    expect(fs.readdirSync(target)).toEqual(['mine']);
    expect(git(repo, 'branch', '--list', 'fresh')).toBe('');
    fs.rmSync(path.join(target, 'mine'));
    await add();
    expect(git(target, 'status', '--porcelain', '--branch').trim()).toBe('## fresh');
    expect(fs.readdirSync(root).sort()).toEqual([name, 'nas', 'repo'].sort());
  });

  it.skipIf(process.platform === 'win32')('refuses a folder that fills while Git is adding', async () => {
    init();
    git(repo, 'worktree', 'add', '-q', '-b', 'nas', path.join(root, 'nas'));
    goOffline('nas');
    const target = path.join(root, 'late');
    const registry = createWorktreeRegistry(async (cwd, args) => {
      const result = await runGit(cwd, args);
      if (args[1] === 'add') {
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'mine'), 'x');
      }
      return result;
    });
    await expect(registry.add(repo, ['worktree', 'add', '-b', 'late', target], target, 'failed')).rejects.toThrow('already exists');
    expect(fs.readdirSync(target)).toEqual(['mine']);
    expect(fs.readdirSync(root).sort()).toEqual(['late', 'nas', 'repo']);
    expect(list()).not.toContain('refs/heads/late');
  });

  it.skipIf(process.platform === 'win32')('leaves nothing behind when Git fails after making the checkout', async () => {
    init();
    git(repo, 'worktree', 'add', '-q', '-b', 'nas', path.join(root, 'nas'));
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    goOffline('nas');
    const target = path.join(root, 'fresh');
    await expect(createWorktreeRegistry(runGit).add(repo, ['worktree', 'add', '--detach', target], target, 'failed')).rejects.toThrow();
    expect(fs.readdirSync(root).sort()).toEqual(['nas', 'repo']);
    expect(list().match(/^worktree /gm)).toHaveLength(2);
  });

  it.skipIf(process.platform === 'win32')('takes the checkout back when its record cannot be rewritten', async () => {
    init();
    git(repo, 'worktree', 'add', '-q', '-b', 'nas', path.join(root, 'nas'));
    goOffline('nas');
    const target = path.join(root, 'fresh');
    const real = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('gitdir')) throw Object.assign(new Error('full'), { code: 'ENOSPC' });
      return real(from, to);
    });
    await expect(createWorktreeRegistry(runGit).add(repo, ['worktree', 'add', '-b', 'fresh', target], target, 'failed')).rejects.toThrow('full');
    expect(fs.readdirSync(root).sort()).toEqual(['nas', 'repo']);
    expect(list().match(/^worktree /gm)).toHaveLength(2);
  });

  it('forgets nothing for a root path, a locked record or a checkout that is there', async () => {
    init();
    for (const branch of ['nas', 'held', 'half']) git(repo, 'worktree', 'add', '-q', '-b', branch, path.join(root, branch));
    git(repo, 'worktree', 'lock', path.join(root, 'held'));
    fs.rmSync(path.join(root, 'held'), { recursive: true });
    const registry = createWorktreeRegistry(runGit);
    for (const target of [path.parse(root).root, `${root}${path.sep}x${path.sep}..`, path.join(root, 'held'), path.join(root, 'nas')]) await registry.forget(repo, target);
    expect(list().match(/^branch /gm)).toHaveLength(4);
    const record = path.join(repo, '.git', 'worktrees', 'half');
    fs.rmSync(path.join(record, 'gitdir'));
    await registry.forget(repo, path.join(root, 'half'));
    expect(fs.existsSync(record)).toBe(false);
  });

  it('does not leave a record locked when it cannot be deleted', async () => {
    init();
    const checkout = path.join(root, 'nas');
    git(repo, 'worktree', 'add', '-q', '-b', 'nas', checkout);
    fs.rmSync(checkout, { recursive: true });
    const real = fs.promises.rm;
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      if (options?.recursive) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      return real(target, options);
    });
    const registry = createWorktreeRegistry(runGit);
    await expect(registry.forget(repo, checkout)).rejects.toThrow('busy');
    expect(list()).not.toContain('locked');
    vi.mocked(fs.promises.rm).mockRestore();
    await registry.forget(repo, checkout);
    expect(list()).not.toContain('refs/heads/nas');
  });

  it('gives a record back when the disk fails the second look', async () => {
    init();
    const checkout = path.join(root, 'nas');
    git(repo, 'worktree', 'add', '-q', '-b', 'nas', checkout);
    fs.rmSync(checkout, { recursive: true });
    const real = fs.promises.readFile;
    vi.spyOn(fs.promises, 'readFile').mockImplementation(async (file, options) => {
      if (String(file).endsWith('gitdir') && fs.existsSync(path.join(path.dirname(file), 'locked'))) throw Object.assign(new Error('io'), { code: 'EIO' });
      return real(file, options);
    });
    await createWorktreeRegistry(runGit).forget(repo, checkout);
    vi.restoreAllMocks();
    expect(list()).toContain('branch refs/heads/nas');
    expect(list()).not.toContain('locked');
  });

  it('gives a record back when the checkout returns while it is being forgotten', async () => {
    init();
    const checkout = path.join(root, 'nas');
    git(repo, 'worktree', 'add', '-q', '-b', 'nas', checkout);
    fs.renameSync(checkout, path.join(root, 'away'));
    const real = fs.promises.writeFile;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, ...rest) => {
      if (String(file).endsWith('locked')) fs.renameSync(path.join(root, 'away'), checkout);
      return real(file, ...rest);
    });
    await createWorktreeRegistry(runGit).forget(repo, checkout);
    expect(git(checkout, 'status', '--porcelain', '--branch').trim()).toBe('## nas');
    expect(list()).not.toContain('locked');
  });

  it('keeps relative links working', async () => {
    init();
    git(repo, 'worktree', 'add', '-q', '-b', 'nas', path.join(root, 'nas'));
    git(repo, 'config', 'worktree.useRelativePaths', 'true');
    goOffline('nas');
    const target = path.join(root, 'fresh');
    await createWorktreeRegistry(runGit).add(repo, ['worktree', 'add', '-b', 'fresh', target], target, 'failed');
    expect(git(target, 'status', '--porcelain', '--branch').trim()).toBe('## fresh');
    expect(list().replaceAll('\\', '/')).toContain(`worktree ${target.replaceAll('\\', '/')}\n`);
    expect(list()).not.toMatch(/prunable|locked/);
  });

  it('leaves out a checkout removed while it is read, and still reports a record it cannot read', async () => {
    init();
    for (const branch of ['nas', 'leaving']) git(repo, 'worktree', 'add', '-q', '-b', branch, path.join(root, branch));
    goOffline('nas');
    const record = path.join(repo, '.git', 'worktrees', 'leaving');
    fs.writeFileSync(path.join(record, 'HEAD'), 'broken');
    const registry = createWorktreeRegistry(async (cwd, args) => {
      if (args.includes('worktrees/leaving/HEAD') && args[0] === 'symbolic-ref') fs.rmSync(record, { recursive: true });
      return runGit(cwd, args);
    });
    const porcelain = await registry.readPorcelain(repo);
    expect(porcelain).toContain('refs/heads/nas');
    expect(porcelain).not.toContain('leaving');
    fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'nas', 'HEAD'), 'broken');
    await expect(createWorktreeRegistry(runGit).readPorcelain(repo)).rejects.toThrow();
  });

  it.skipIf(process.platform !== 'darwin').each([
    ['its .git', (checkout) => { fs.rmSync(path.join(checkout, '.git')); fs.symlinkSync('/Volumes/openchamber-absent/git', path.join(checkout, '.git')); }],
    ['its folder', (checkout) => { fs.rmSync(checkout, { recursive: true }); fs.symlinkSync('/Volumes/openchamber-absent/wt', checkout); }],
  ])('never forgets a worktree when %s links to an absent volume', async (_label, relink) => {
    init();
    git(repo, 'worktree', 'add', '-q', '-b', 'nas', path.join(root, 'nas'));
    relink(path.join(root, 'nas'));
    const registry = createWorktreeRegistry(runGit);
    await registry.forget(repo, path.join(root, 'nas'));
    const porcelain = await registry.readPorcelain(repo);
    expect(porcelain).toContain('branch refs/heads/nas');
    expect(porcelain).not.toContain('prunable');
  });

  it('refuses where Git would resolve an unreachable relative link', async () => {
    init();
    git(repo, 'worktree', 'add', '-q', '-b', 'nas', path.join(root, 'nas'));
    fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'nas', 'gitdir'), '../../../../nas/.git\n');
    const registry = createWorktreeRegistry(runGit);
    await registry.assertEnumerable(repo);
    goOffline('nas');
    const target = path.join(root, 'fresh');
    await expect(registry.add(repo, ['worktree', 'add', target], target, 'failed')).rejects.toMatchObject({ code: 'DIRECTORY_UNREACHABLE' });
    await expect(registry.assertEnumerable(repo)).rejects.toMatchObject({ code: 'DIRECTORY_UNREACHABLE' });
  });

  it('answers from the records when Git is stuck, and starts no second listing meanwhile', async () => {
    init();
    git(repo, 'worktree', 'add', '-q', '-b', 'nas', path.join(root, 'nas'));
    const expected = list();
    const waiting = [];
    let stuck = true;
    const registry = createWorktreeRegistry((cwd, args) => (stuck && args[1] === 'list'
      ? new Promise((resolve) => { waiting.push(resolve); })
      : runGit(cwd, args)), { listDeadlineMs: 200 });
    const burst = await Promise.all(Array.from({ length: 8 }, () => registry.readPorcelain(repo)));
    expect(new Set(burst)).toEqual(new Set([expected]));
    expect(await registry.readPorcelain(repo)).toBe(expected);
    expect(waiting).toHaveLength(1);
    waiting.shift()({ stdout: expected });
    stuck = false;
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(await registry.readPorcelain(repo)).toBe(expected);
    expect(started).toContain('worktree list');
  });

  it('throws instead of answering with no rows', async () => {
    await expect(createWorktreeRegistry(runGit).readPorcelain(root)).rejects.toThrow(/not a git repository/i);
    init();
    git(repo, 'worktree', 'add', '-q', '-b', 'nas', path.join(root, 'nas'));
    goOffline('nas');
    const failing = createWorktreeRegistry((cwd, args) => (args[0] === 'for-each-ref' ? Promise.reject(new Error('refs')) : runGit(cwd, args)));
    await expect(failing.readPorcelain(repo)).rejects.toThrow('refs');
  });
});

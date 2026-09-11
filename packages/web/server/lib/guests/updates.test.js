import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { findInstalledGuest, listInstalledGuests } from './catalog.js';
import { isGitRef, parseGitInstallUrl } from './clone.js';
import { installGuestFromGitSource } from './install.js';
import { readExtensionStore } from './persist.js';
import {
  UPDATE_CHECK_TTL_MS,
  checkAllGuestUpdates,
  checkGuestUpdate,
  clearGuestUpdateCache,
  compareSemver,
  getCachedGuestUpdate,
  updateGuest,
} from './updates.js';

const git = (cwd, args) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
};

const manifest = (id, version, extra = {}) => JSON.stringify({
  name: `@openchamber/${id}`,
  version,
  openchamber: {
    apiVersion: 1,
    contributes: {
      panel: { id, name: id, icon: 'window', entry: 'panel/index.html' },
      ...extra,
    },
  },
});

const writeGuest = async (root, id, version, extra) => {
  await fs.mkdir(path.join(root, 'panel'), { recursive: true });
  await fs.writeFile(path.join(root, 'panel', 'index.html'), '<html></html>');
  await fs.writeFile(path.join(root, 'package.json'), manifest(id, version, extra));
};

const commit = (cwd, message) => {
  git(cwd, ['add', '.']);
  git(cwd, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message]);
};

/**
 * A working repo plus a bare "remote" the install clones from, the way a
 * hosted repository behaves: the bare repo has no working tree and gets new
 * commits pushed to it.
 */
const setupRemote = async (dir, id, version = '1.0.0') => {
  const work = path.join(dir, 'work');
  const bare = path.join(dir, 'remote.git');
  await writeGuest(work, id, version);
  git(work, ['init', '-q', '--template=', '-b', 'main']);
  commit(work, 'init');
  git(dir, ['init', '-q', '--bare', '--template=', bare]);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['push', '-q', 'origin', 'main']);
  return { work, bare };
};

const pushVersion = async (work, id, version, extra) => {
  await fs.writeFile(path.join(work, 'package.json'), manifest(id, version, extra));
  commit(work, `v${version}`);
  git(work, ['push', '-q', 'origin', 'HEAD']);
};

const installFrom = async (bare, persistPath, ref) => {
  const installed = await installGuestFromGitSource(bare, persistPath, { openchamberVersion: '1.30.0', ref });
  if (!installed.ok) {
    throw new Error(`install failed: ${installed.code}`);
  }
  return installed.guest;
};

const loadGuest = async (id, persistPath) => {
  const guest = await findInstalledGuest(id, persistPath);
  if (!guest) {
    throw new Error(`guest ${id} missing`);
  }
  return guest;
};

describe('compareSemver', () => {
  test('orders releases and puts prereleases below their release', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1);
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1);
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
    expect(compareSemver('1.1.0-beta.1', '1.1.0')).toBe(-1);
    expect(compareSemver('1.1.0', '1.1.0-rc.1')).toBe(1);
    expect(compareSemver('1.1.0-alpha', '1.1.0-beta')).toBe(-1);
    expect(compareSemver('1.1.0-beta.2', '1.1.0-beta.10')).toBe(-1);
    expect(compareSemver('1.1.0-beta', '1.1.0-beta.1')).toBe(-1);
    expect(compareSemver('1.0.0+build.1', '1.0.0')).toBe(0);
    expect(compareSemver('v1.0.0', '1.0.0')).toBeNull();
    expect(compareSemver('1.0', '1.0.0')).toBeNull();
  });
});

describe('parseGitInstallUrl', () => {
  test('splits a #ref and refuses unusable refs', () => {
    expect(parseGitInstallUrl('https://github.com/acme/panel.git')).toEqual({ url: 'https://github.com/acme/panel.git' });
    expect(parseGitInstallUrl('https://github.com/acme/panel.git#v1.2.0')).toEqual({
      url: 'https://github.com/acme/panel.git',
      ref: 'v1.2.0',
    });
    expect(parseGitInstallUrl('https://github.com/acme/panel#release/2.x')).toEqual({
      url: 'https://github.com/acme/panel',
      ref: 'release/2.x',
    });
    expect(parseGitInstallUrl('https://github.com/acme/panel.git#')).toBeNull();
    expect(parseGitInstallUrl('https://github.com/acme/panel.git#--upload-pack=evil')).toBeNull();
    expect(parseGitInstallUrl('https://github.com/acme/panel.git#a..b')).toBeNull();
    expect(parseGitInstallUrl('https://localhost/panel.git#main')).toBeNull();
    expect(parseGitInstallUrl('http://github.com/acme/panel.git#main')).toBeNull();
    expect(isGitRef('main')).toBe(true);
    expect(isGitRef('-x')).toBe(false);
    expect(isGitRef('feature/')).toBe(false);
    expect(isGitRef('a//b')).toBe(false);
  });
});

describe('checkGuestUpdate', () => {
  test('reports a newer remote version and stays quiet on the same one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-upd-'));
    const persistPath = path.join(dir, 'data', 'extensions.json');
    const { work, bare } = await setupRemote(dir, 'upd-hello');
    await installFrom(bare, persistPath);
    const guest = await loadGuest('upd-hello', persistPath);
    expect(guest.gitOrigin).toEqual({ url: bare });
    expect((await readExtensionStore(persistPath)).gitOrigins).toEqual({ [guest.packageRoot]: { url: bare } });

    const same = await checkGuestUpdate({ guest, origin: guest.gitOrigin });
    expect(same).toEqual({ available: false, version: '1.0.0' });

    await pushVersion(work, 'upd-hello', '1.1.0', { capabilities: ['prompt'], filesystem: ['~/notes/**'] });
    const newer = await checkGuestUpdate({ guest, origin: guest.gitOrigin });
    expect(newer).toEqual({ available: true, version: '1.1.0', requested: ['prompt', 'filesystem'] });

    await pushVersion(work, 'upd-hello', '1.0.1');
    const older = await checkGuestUpdate({ guest: { ...guest, version: '1.2.0' }, origin: guest.gitOrigin });
    expect(older).toEqual({ available: false, version: '1.0.1' });

    await pushVersion(work, 'upd-hello', '2.0.0-beta.1');
    const pre = await checkGuestUpdate({ guest, origin: guest.gitOrigin });
    expect(pre).toEqual({ available: true, version: '2.0.0-beta.1', requested: [] });

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('follows a pinned tag and never throws on a broken remote', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-upd-'));
    const persistPath = path.join(dir, 'data', 'extensions.json');
    const { work, bare } = await setupRemote(dir, 'upd-tag');
    git(work, ['tag', 'stable']);
    git(work, ['push', '-q', 'origin', 'stable']);
    await installFrom(bare, persistPath, 'stable');
    const guest = await loadGuest('upd-tag', persistPath);
    expect(guest.gitOrigin).toEqual({ url: bare, ref: 'stable' });

    // main moves ahead; the tag does not.
    await pushVersion(work, 'upd-tag', '1.5.0');
    expect(await checkGuestUpdate({ guest, origin: guest.gitOrigin })).toEqual({ available: false, version: '1.0.0' });

    git(work, ['tag', '-f', 'stable']);
    git(work, ['push', '-q', '-f', 'origin', 'stable']);
    expect(await checkGuestUpdate({ guest, origin: guest.gitOrigin })).toEqual({ available: true, version: '1.5.0', requested: [] });

    await fs.rm(bare, { recursive: true, force: true });
    expect(await checkGuestUpdate({ guest, origin: guest.gitOrigin })).toEqual({ available: false, error: 'fetch-failed' });
    expect(await checkGuestUpdate({ guest, origin: undefined })).toEqual({ available: false, error: 'not-git' });
    expect(await checkGuestUpdate({ guest, origin: { url: bare }, gitBinary: '/nonexistent/git' })).toEqual({ available: false, error: 'fetch-failed' });

    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('checkAllGuestUpdates', () => {
  test('caches per guest for an hour unless forced and feeds the catalog row', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-upd-'));
    const persistPath = path.join(dir, 'data', 'extensions.json');
    const { work, bare } = await setupRemote(dir, 'upd-cache');
    await installFrom(bare, persistPath);
    const start = Date.now();

    expect(await checkAllGuestUpdates({ persistPath, now: start })).toEqual({});
    await pushVersion(work, 'upd-cache', '1.1.0');
    // Inside the hour: the stale answer stands.
    expect(await checkAllGuestUpdates({ persistPath, now: start + UPDATE_CHECK_TTL_MS - 1 })).toEqual({});
    expect(getCachedGuestUpdate(persistPath, 'upd-cache')).toBeNull();
    // Forced: the network is asked again.
    expect(await checkAllGuestUpdates({ persistPath, force: true, now: start + 1 })).toEqual({ 'upd-cache': { version: '1.1.0' } });
    expect(getCachedGuestUpdate(persistPath, 'upd-cache')).toEqual({ version: '1.1.0' });
    // After the hour: refreshed on its own.
    await pushVersion(work, 'upd-cache', '1.2.0');
    expect(await checkAllGuestUpdates({ persistPath, now: start + 1 + UPDATE_CHECK_TTL_MS })).toEqual({ 'upd-cache': { version: '1.2.0' } });

    clearGuestUpdateCache(persistPath, 'upd-cache');
    expect(getCachedGuestUpdate(persistPath, 'upd-cache')).toBeNull();

    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('updateGuest', () => {
  test('swaps in the new clone and keeps grants, then reports a new version', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-upd-'));
    const persistPath = path.join(dir, 'data', 'extensions.json');
    const { work, bare } = await setupRemote(dir, 'upd-swap');
    await installFrom(bare, persistPath);
    const before = await loadGuest('upd-swap', persistPath);
    const store = await readExtensionStore(persistPath);
    await fs.writeFile(persistPath, `${JSON.stringify({
      paths: store.paths,
      sources: store.sources,
      gitOrigins: store.gitOrigins,
      capabilityGrants: { 'upd-swap': ['prompt'] },
      disabledGuests: { 'upd-swap': true },
    })}\n`);

    await pushVersion(work, 'upd-swap', '1.1.0', { capabilities: ['prompt', 'sessions'] });
    await checkAllGuestUpdates({ persistPath, force: true });
    expect(getCachedGuestUpdate(persistPath, 'upd-swap')).toEqual({ version: '1.1.0' });

    const updated = await updateGuest({ guest: before, origin: before.gitOrigin, persistPath, openchamberVersion: '1.30.0' });
    expect(updated).toEqual({ ok: true, id: 'upd-swap' });

    const after = await loadGuest('upd-swap', persistPath);
    expect(after.version).toBe('1.1.0');
    expect(after.packageRoot).toBe(before.packageRoot);
    expect(after.gitOrigin).toEqual({ url: bare });
    expect(after.capabilityGrants).toEqual(['prompt']);
    expect(after.enabled).toBe(false);
    expect(after.capabilities).toEqual(['prompt', 'sessions']);
    expect(getCachedGuestUpdate(persistPath, 'upd-swap')).toBeNull();
    const leftovers = (await fs.readdir(path.dirname(before.packageRoot))).filter((name) => name.startsWith('.'));
    expect(leftovers).toEqual([]);
    expect((await readExtensionStore(persistPath)).paths).toEqual([before.packageRoot]);

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a failure before the swap leaves the install untouched', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-upd-'));
    const persistPath = path.join(dir, 'data', 'extensions.json');
    const { work, bare } = await setupRemote(dir, 'upd-keep');
    await installFrom(bare, persistPath);
    const guest = await loadGuest('upd-keep', persistPath);
    const copiesDir = path.dirname(guest.packageRoot);
    const noLeftovers = async () => {
      const names = (await fs.readdir(copiesDir)).filter((name) => name.startsWith('.'));
      expect(names).toEqual([]);
    };

    // Remote now needs a host this build does not have.
    await fs.writeFile(path.join(work, 'package.json'), JSON.stringify({
      name: '@openchamber/upd-keep',
      version: '1.1.0',
      openchamber: {
        apiVersion: 1,
        engines: { openchamber: '>=9.9.9' },
        contributes: { panel: { id: 'upd-keep', name: 'Keep', icon: 'window', entry: 'panel/index.html' } },
      },
    }));
    commit(work, 'needs newer host');
    git(work, ['push', '-q', 'origin', 'HEAD']);
    expect(await updateGuest({ guest, origin: guest.gitOrigin, persistPath, openchamberVersion: '1.30.0' })).toEqual({
      ok: false,
      code: 'host-too-old',
      required: '9.9.9',
    });
    await noLeftovers();
    expect((await loadGuest('upd-keep', persistPath)).version).toBe('1.0.0');

    // Remote now ships an unbuilt panel.
    await fs.writeFile(path.join(work, 'package.json'), manifest('upd-keep', '1.2.0'));
    await fs.writeFile(path.join(work, 'panel', 'index.html'), '<script src="./main.js"></script>');
    commit(work, 'unbuilt');
    git(work, ['push', '-q', 'origin', 'HEAD']);
    expect(await updateGuest({ guest, origin: guest.gitOrigin, persistPath, openchamberVersion: '1.30.0' })).toEqual({
      ok: false,
      code: 'missing-build',
    });
    await noLeftovers();

    // Remote renamed the panel: not an update of this extension.
    await fs.writeFile(path.join(work, 'package.json'), manifest('other-id', '1.3.0'));
    await fs.writeFile(path.join(work, 'panel', 'index.html'), '<html></html>');
    commit(work, 'renamed');
    git(work, ['push', '-q', 'origin', 'HEAD']);
    expect(await updateGuest({ guest, origin: guest.gitOrigin, persistPath, openchamberVersion: '1.30.0' })).toEqual({
      ok: false,
      code: 'invalid-manifest',
    });
    await noLeftovers();

    // Remote is gone.
    await fs.rm(bare, { recursive: true, force: true });
    expect(await updateGuest({ guest, origin: guest.gitOrigin, persistPath, openchamberVersion: '1.30.0' })).toEqual({
      ok: false,
      code: 'clone-failed',
    });
    await noLeftovers();

    // Folder installs never update.
    expect(await updateGuest({ guest: { ...guest, source: 'path' }, origin: guest.gitOrigin, persistPath })).toEqual({
      ok: false,
      code: 'not-git',
    });

    const still = await loadGuest('upd-keep', persistPath);
    expect(still.version).toBe('1.0.0');
    expect(still.packageRoot).toBe(guest.packageRoot);
    expect(await fs.readFile(path.join(guest.packageRoot, 'panel', 'index.html'), 'utf8')).toBe('<html></html>');
    expect((await listInstalledGuests({ persistPath })).map((entry) => entry.id)).toEqual(['upd-keep']);

    await fs.rm(dir, { recursive: true, force: true });
  });
});

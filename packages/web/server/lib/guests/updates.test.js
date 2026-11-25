import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { setTimeout as delay } from 'node:timers/promises';

import { findInstalledGuest, invalidateGuestCatalog, listInstalledGuests } from './catalog.js';
import { createGuestAgentContext } from './agent-context.js';
import { isGitRef, parseGitInstallUrl } from './clone.js';
import { installGuestFromGitSource, uninstallGuest } from './install.js';
import { readExtensionStore, setCapabilityGrants } from './persist.js';
import { registerGuestRoutes } from './routes.js';
import { guestDataDir } from './storage.js';
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
  // The bare repo's HEAD must name the branch that gets pushed; without -b
  // it follows the machine's init.defaultBranch (master on CI), and a clone
  // of a bare repo whose HEAD points at a missing branch checks out nothing.
  git(dir, ['init', '-q', '--bare', '--template=', '-b', 'main', bare]);
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

const readInSecondHost = (persistPath) => {
  const script = `
    const { listInstalledGuests } = await import(${JSON.stringify(new URL('./catalog.js', import.meta.url).href)});
    const { createGuestAgentContext } = await import(${JSON.stringify(new URL('./agent-context.js', import.meta.url).href)});
    const persistPath = ${JSON.stringify(persistPath)};
    const ids = (await listInstalledGuests({ persistPath })).map((guest) => guest.id);
    const plugins = await createGuestAgentContext({ persistPath, instructions: { forDirectory: async () => [] } }).pluginDirectories();
    console.log(JSON.stringify({ ids, plugins }));
  `;
  const result = spawnSync('node', ['--import', new URL('../../../scripts/register-server-sources.mjs', import.meta.url).href, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 8_000 });
  if (result.status !== 0) throw new Error(result.stderr || 'second host failed');
  return JSON.parse(result.stdout);
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

// A git that logs each fetch and takes a moment over it, so two checks can overlap.
const slowFetchGit = async (dir) => {
  const calls = path.join(dir, 'fetch-calls');
  const gitBinary = path.join(dir, 'slow-git');
  await fs.writeFile(gitBinary, `#!/bin/sh
case "$*" in *fetch*) echo fetch >> '${calls}'; sleep 0.3;; esac
exec git "$@"
`, { mode: 0o755 });
  return { gitBinary, calls };
};

describe.skipIf(process.platform === 'win32')('checkGuestUpdate overlap', () => {
  test('overlapping checks of one install share a single fetch', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-upd-'));
    const persistPath = path.join(dir, 'data', 'extensions.json');
    const { work, bare } = await setupRemote(dir, 'upd-overlap');
    await installFrom(bare, persistPath);
    const guest = await loadGuest('upd-overlap', persistPath);
    await pushVersion(work, 'upd-overlap', '1.1.0');
    const { gitBinary, calls } = await slowFetchGit(dir);

    const results = await Promise.all([
      checkGuestUpdate({ guest, origin: guest.gitOrigin, gitBinary }),
      checkGuestUpdate({ guest, origin: guest.gitOrigin, gitBinary }),
    ]);

    expect(results).toEqual([
      { available: true, version: '1.1.0', requested: [] },
      { available: true, version: '1.1.0', requested: [] },
    ]);
    expect((await fs.readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(1);
    // Once settled, the next check fetches again.
    await checkGuestUpdate({ guest, origin: guest.gitOrigin, gitBinary });
    expect((await fs.readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(2);

    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('checkAllGuestUpdates', () => {
  test('does not cache a failed fetch, so the next check retries', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-upd-'));
    const persistPath = path.join(dir, 'data', 'extensions.json');
    const { work, bare } = await setupRemote(dir, 'upd-retry');
    await installFrom(bare, persistPath);
    await pushVersion(work, 'upd-retry', '1.1.0');
    const start = Date.now();

    await fs.rename(bare, `${bare}.away`);
    expect(await checkAllGuestUpdates({ persistPath, now: start })).toEqual({});
    await fs.rename(`${bare}.away`, bare);
    // Inside the TTL, and not forced: the failure was not remembered.
    expect(await checkAllGuestUpdates({ persistPath, now: start + 1 })).toEqual({ 'upd-retry': { version: '1.1.0' } });

    // A failed forced check keeps the answer already cached.
    await fs.rename(bare, `${bare}.away`);
    expect(await checkAllGuestUpdates({ persistPath, force: true, now: start + 2 })).toEqual({ 'upd-retry': { version: '1.1.0' } });

    await fs.rm(dir, { recursive: true, force: true });
  });

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
    expect(getCachedGuestUpdate(persistPath, { id: 'upd-cache', version: '1.0.0' })).toBeNull();
    // Forced: the network is asked again.
    expect(await checkAllGuestUpdates({ persistPath, force: true, now: start + 1 })).toEqual({ 'upd-cache': { version: '1.1.0' } });
    expect(getCachedGuestUpdate(persistPath, { id: 'upd-cache', version: '1.0.0' })).toEqual({ version: '1.1.0' });
    // After the hour: refreshed on its own.
    await pushVersion(work, 'upd-cache', '1.2.0');
    expect(await checkAllGuestUpdates({ persistPath, now: start + 1 + UPDATE_CHECK_TTL_MS })).toEqual({ 'upd-cache': { version: '1.2.0' } });

    clearGuestUpdateCache(persistPath, 'upd-cache');
    expect(getCachedGuestUpdate(persistPath, { id: 'upd-cache', version: '1.0.0' })).toBeNull();

    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('updateGuest', () => {
  test('Remove waits for the checkout swap and clears data only when the registration is gone', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-upd-remove-'));
    const persistPath = path.join(dir, 'data', 'extensions.json');
    const id = 'upd-remove';
    const gap = Promise.withResolvers();
    const allowSwap = Promise.withResolvers();
    const rename = fs.rename;
    const operations = [];
    try {
      const { work, bare } = await setupRemote(dir, id);
      await installFrom(bare, persistPath);
      const guest = await loadGuest(id, persistPath);
      const store = await readExtensionStore(persistPath);
      const dataDir = guestDataDir(persistPath, id);
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(path.join(dataDir, 'marker'), 'extension data');
      await pushVersion(work, id, '1.1.0');
      fs.rename = async (from, to) => {
        if (to === guest.packageRoot && path.basename(from).startsWith('.tmp-')) {
          gap.resolve();
          await allowSwap.promise;
        }
        return rename(from, to);
      };
      const updated = updateGuest({ guest, origin: guest.gitOrigin, persistPath, openchamberVersion: '1.30.0' });
      operations.push(updated);
      await Promise.race([gap.promise, updated.then(() => { throw new Error('Update did not reach the checkout swap'); })]);
      invalidateGuestCatalog(persistPath);
      expect(await listInstalledGuests({ persistPath })).toEqual([]);
      const removed = uninstallGuest(id, persistPath);
      operations.push(removed);
      expect(await Promise.race([removed, delay(100, 'waiting')])).toBe('waiting');
      expect(await readExtensionStore(persistPath)).toEqual(store);
      expect(await fs.readFile(path.join(dataDir, 'marker'), 'utf8')).toBe('extension data');
      allowSwap.resolve();
      expect(await updated).toEqual({ ok: true, id });
      expect(await removed).toEqual({ ok: true });
      expect((await readExtensionStore(persistPath)).paths).toEqual([]);
      await expect(fs.access(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      allowSwap.resolve();
      await Promise.allSettled(operations);
      fs.rename = rename;
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('managed plugin discovery waits for an extension checkout to be published', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-upd-managed-'));
    const persistPath = path.join(dir, 'data', 'extensions.json');
    const id = 'upd-managed';
    const gap = Promise.withResolvers();
    const allowSwap = Promise.withResolvers();
    const rename = fs.rename;
    const operations = [];
    try {
      const { work, bare } = await setupRemote(dir, id);
      await fs.mkdir(path.join(work, 'plugin'));
      await fs.writeFile(path.join(work, 'plugin', 'index.js'), 'export default {}');
      await pushVersion(work, id, '1.1.0', { opencodePlugin: 'plugin' });
      await installFrom(bare, persistPath);
      await setCapabilityGrants(id, persistPath, ['opencodePlugin']);
      const guest = await loadGuest(id, persistPath);
      await pushVersion(work, id, '1.2.0', { opencodePlugin: 'plugin' });
      const context = createGuestAgentContext({
        persistPath,
        instructions: { forDirectory: async () => [] },
      });
      fs.rename = async (from, to) => {
        if (to === guest.packageRoot && path.basename(from).startsWith('.tmp-')) {
          gap.resolve();
          await allowSwap.promise;
        }
        return rename(from, to);
      };
      const updated = updateGuest({ guest, origin: guest.gitOrigin, persistPath, openchamberVersion: '1.30.0' });
      operations.push(updated);
      await Promise.race([gap.promise, updated.then(() => { throw new Error('Update did not reach the checkout swap'); })]);
      invalidateGuestCatalog(persistPath);
      expect(await listInstalledGuests({ persistPath })).toEqual([]);
      const directories = context.pluginDirectories();
      const observed = Promise.race([directories, delay(100, 'waiting')]);
      operations.push(directories);
      expect(await observed).toBe('waiting');
      allowSwap.resolve();
      expect(await updated).toEqual({ ok: true, id });
      expect(await directories).toEqual([path.join(guest.packageRoot, 'plugin')]);
    } finally {
      allowSwap.resolve();
      await Promise.allSettled(operations);
      fs.rename = rename;
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  for (const watched of [false, true]) {
    test(`a refused publication and restore${watched ? ' with parked folders' : ''} recovers once the obstruction clears`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-upd-recover-'));
      const persistPath = path.join(dir, 'data', 'extensions.json');
      const id = 'upd-recover';
      const rename = fs.rename;
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      try {
        const { work, bare } = await setupRemote(dir, id);
        await fs.mkdir(path.join(work, 'plugin', 'lib'), { recursive: true });
        await fs.writeFile(path.join(work, 'plugin', 'index.js'), 'export default {}');
        await fs.writeFile(path.join(work, 'plugin', 'lib', 'helper.js'), 'export {}');
        await pushVersion(work, id, '1.1.0', { opencodePlugin: 'plugin' });
        await installFrom(bare, persistPath);
        await setCapabilityGrants(id, persistPath, ['opencodePlugin']);
        const guest = await loadGuest(id, persistPath);
        const store = await readExtensionStore(persistPath);
        const data = path.join(guestDataDir(persistPath, id), 'marker');
        await fs.mkdir(path.dirname(data), { recursive: true });
        await fs.writeFile(data, 'kept');
        await pushVersion(work, id, '1.2.0', { opencodePlugin: 'plugin' });
        const busy = () => Object.assign(new Error('busy'), { code: 'EPERM' });
        const pluginRoot = path.join(guest.packageRoot, 'plugin');
        const held = new Set(watched ? [guest.packageRoot, pluginRoot] : []);
        fs.rename = async (from, to) => {
          if (held.delete(from)) {
            Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
            throw busy();
          }
          if (to === guest.packageRoot) throw busy();
          return rename(from, to);
        };
        expect(await updateGuest({ guest, origin: guest.gitOrigin, persistPath, openchamberVersion: '1.30.0' })).toEqual({ ok: false, code: 'swap-failed' });
        Object.defineProperty(process, 'platform', platform);
        expect(await listInstalledGuests({ persistPath })).toEqual([]);
        expect((await uninstallGuest(id, persistPath)).ok).toBe(false);
        expect(await readExtensionStore(persistPath)).toEqual(store);
        const context = createGuestAgentContext({ persistPath, instructions: { forDirectory: async () => [] } });
        let configured = await context.pluginDirectories();
        expect(configured).toEqual([]);
        const refreshed = Promise.withResolvers();
        registerGuestRoutes(express(), {
          openchamberDataDir: path.dirname(persistPath),
          resolveGitBinaryForSpawn: () => 'git',
          onGuestActivated: async () => {
            configured = await context.pluginDirectories();
            refreshed.resolve();
          },
        });
        fs.rename = rename;

        if (watched) {
          // A folder something recreated is kept beside the parked original until it is gone.
          const copies = path.dirname(guest.packageRoot);
          const old = (await fs.readdir(copies)).find((name) => name.startsWith('.old-'));
          await fs.mkdir(path.join(copies, old, 'plugin'));
          invalidateGuestCatalog(persistPath);
          await listInstalledGuests({ persistPath });
          expect(await fs.readdir(pluginRoot)).toEqual([]);
          expect((await fs.readdir(copies)).some((name) => name.startsWith('.swap-'))).toBe(true);
          await fs.rmdir(pluginRoot);
          // A fresh host has no memory of the swap.
          expect(readInSecondHost(persistPath)).toEqual({ ids: [id], plugins: [path.join(guest.packageRoot, 'plugin')] });
        }
        invalidateGuestCatalog(persistPath);
        const [restored] = await listInstalledGuests({ persistPath });
        expect(restored).toMatchObject({ id, version: '1.1.0', packageRoot: guest.packageRoot });
        if (!watched) {
          // The config built during the obstruction is rebuilt with the plugin.
          await refreshed.promise;
          expect(configured).toEqual([path.join(guest.packageRoot, 'plugin')]);
        }
        expect(await fs.readFile(path.join(guest.packageRoot, 'plugin', 'index.js'), 'utf8')).toBe('export default {}');
        expect(await fs.readFile(path.join(guest.packageRoot, 'plugin', 'lib', 'helper.js'), 'utf8')).toBe('export {}');
        expect(await readExtensionStore(persistPath)).toEqual(store);
        expect(await fs.readFile(data, 'utf8')).toBe('kept');
        expect(await updateGuest({ guest: restored, origin: guest.gitOrigin, persistPath, openchamberVersion: '1.30.0' })).toEqual({ ok: true, id });
      } finally {
        Object.defineProperty(process, 'platform', platform);
        fs.rename = rename;
        await fs.rm(dir, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test('recovery leaves a newer checkout alone', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-upd-newer-'));
    const persistPath = path.join(dir, 'data', 'extensions.json');
    const id = 'upd-newer';
    const rename = fs.rename;
    try {
      const { work, bare } = await setupRemote(dir, id);
      await installFrom(bare, persistPath);
      const guest = await loadGuest(id, persistPath);
      await pushVersion(work, id, '1.1.0');
      fs.rename = async (from, to) => {
        if (to === guest.packageRoot) throw Object.assign(new Error('busy'), { code: 'EPERM' });
        return rename(from, to);
      };
      expect(await updateGuest({ guest, origin: guest.gitOrigin, persistPath, openchamberVersion: '1.30.0' })).toEqual({ ok: false, code: 'swap-failed' });
      fs.rename = rename;
      await writeGuest(guest.packageRoot, id, '3.0.0');
      invalidateGuestCatalog(persistPath);
      expect((await loadGuest(id, persistPath)).version).toBe('3.0.0');
      expect((await fs.readdir(path.dirname(guest.packageRoot))).filter((name) => name.startsWith('.swap-'))).toEqual([]);
    } finally {
      fs.rename = rename;
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  for (const operation of ['update', 'remove']) {
    test(`a second host reads the catalog and plugin folders while ${operation} cleans up slowly`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-upd-slow-'));
      const persistPath = path.join(dir, 'data', 'extensions.json');
      const id = 'upd-slow';
      const rm = fs.rm;
      const cleaning = Promise.withResolvers();
      const finish = Promise.withResolvers();
      const operations = [];
      try {
        const { work, bare } = await setupRemote(dir, id);
        await installFrom(bare, persistPath);
        const guest = await loadGuest(id, persistPath);
        await pushVersion(work, id, '1.1.0');
        fs.rm = async (target, options) => {
          if (path.basename(target).startsWith('.old-') || (operation === 'remove' && target === guest.packageRoot)) {
            cleaning.resolve();
            await finish.promise;
          }
          return rm(target, options);
        };
        const running = operation === 'update'
          ? updateGuest({ guest, origin: guest.gitOrigin, persistPath, openchamberVersion: '1.30.0' })
          : uninstallGuest(id, persistPath);
        operations.push(running);
        await cleaning.promise;
        expect(readInSecondHost(persistPath)).toEqual({ ids: operation === 'update' ? [id] : [], plugins: [] });
        finish.resolve();
        expect((await running).ok).toBe(true);
      } finally {
        finish.resolve();
        await Promise.allSettled(operations);
        fs.rm = rm;
        await fs.rm(dir, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test('the next update deletes a backup whose deletion was refused', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-upd-leftover-'));
    const persistPath = path.join(dir, 'data', 'extensions.json');
    const id = 'upd-leftover';
    const rm = fs.rm;
    const update = async () => {
      const guest = await loadGuest(id, persistPath);
      return updateGuest({ guest, origin: guest.gitOrigin, persistPath, openchamberVersion: '1.30.0' });
    };
    try {
      const { work, bare } = await setupRemote(dir, id);
      await installFrom(bare, persistPath);
      const copies = path.dirname((await loadGuest(id, persistPath)).packageRoot);
      await pushVersion(work, id, '1.1.0');
      fs.rm = async (target, options) => {
        if (path.basename(target).startsWith('.old-')) throw Object.assign(new Error('busy'), { code: 'EPERM' });
        return rm(target, options);
      };
      expect(await update()).toEqual({ ok: true, id });
      expect((await fs.readdir(copies)).filter((name) => name.startsWith('.old-'))).toHaveLength(1);
      fs.rm = rm;
      await pushVersion(work, id, '1.2.0');
      expect(await update()).toEqual({ ok: true, id });
      expect(await fs.readdir(copies)).toEqual([id]);
    } finally {
      fs.rm = rm;
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('a refused lock release does not shut out a second host', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-upd-unlock-'));
    const persistPath = path.join(dir, 'data', 'extensions.json');
    const id = 'upd-unlock';
    const unlink = fs.unlink;
    try {
      const { work, bare } = await setupRemote(dir, id);
      await installFrom(bare, persistPath);
      const guest = await loadGuest(id, persistPath);
      await pushVersion(work, id, '1.1.0');
      fs.unlink = async (target) => {
        if (String(target).endsWith('.checkouts.lock')) throw Object.assign(new Error('busy'), { code: 'EPERM' });
        return unlink(target);
      };
      expect(await updateGuest({ guest, origin: guest.gitOrigin, persistPath, openchamberVersion: '1.30.0' })).toEqual({ ok: true, id });
      fs.unlink = unlink;
      await fs.access(`${persistPath}.checkouts.lock`);
      expect(readInSecondHost(persistPath)).toEqual({ ids: [id], plugins: [] });
      await expect(fs.access(`${persistPath}.checkouts.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      fs.unlink = unlink;
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('a slow check neither touches the checkout nor replaces a newer answer after the swap', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-upd-stale-'));
    const persistPath = path.join(dir, 'data', 'extensions.json');
    const id = 'upd-stale';
    const gate = path.join(dir, 'gate');
    const globalConfig = process.env.GIT_CONFIG_GLOBAL;
    let checking;
    try {
      const { work, bare } = await setupRemote(dir, id);
      await installFrom(bare, persistPath);
      const guest = await loadGuest(id, persistPath);
      await pushVersion(work, id, '1.1.0');
      const started = path.join(dir, 'started');
      const hook = path.join(dir, 'gate.sh');
      const config = path.join(dir, 'gitconfig');
      // Git runs this hook with its own shell on every platform; only the first fetch waits in it.
      const posix = (target) => target.replaceAll('\\', '/');
      await fs.writeFile(hook, `mkdir '${posix(started)}' 2>/dev/null && while [ ! -e '${posix(gate)}' ]; do sleep 0.02; done
exec "$@"
`);
      git(dir, ['config', '--file', config, 'uploadpack.packObjectsHook', `sh '${posix(hook)}'`]);
      process.env.GIT_CONFIG_GLOBAL = config;
      checking = checkAllGuestUpdates({ persistPath, force: true });
      while (!await fs.access(started).then(() => true, () => false)) await delay(10);
      expect(await updateGuest({ guest, origin: guest.gitOrigin, persistPath, openchamberVersion: '1.30.0' })).toEqual({ ok: true, id });
      expect(readInSecondHost(persistPath)).toEqual({ ids: [id], plugins: [] });
      await pushVersion(work, id, '1.2.0');
      expect(await checkAllGuestUpdates({ persistPath, force: true })).toEqual({ [id]: { version: '1.2.0' } });
      await fs.writeFile(gate, '');
      expect(await checking).toEqual({ [id]: { version: '1.2.0' } });
      expect(getCachedGuestUpdate(persistPath, await loadGuest(id, persistPath))).toEqual({ version: '1.2.0' });
      await expect(fs.access(path.join(guest.packageRoot, '.git', 'FETCH_HEAD'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.writeFile(gate, '');
      await Promise.allSettled([checking]);
      if (globalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = globalConfig;
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test.skipIf(process.platform !== 'win32')('updates a watched Windows checkout and preserves its registration', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-upd-locked-'));
    const persistPath = path.join(dir, 'data', 'extensions.json');
    const id = 'upd-watched';
    let watcher;
    try {
      const { work, bare } = await setupRemote(dir, id);
      await fs.mkdir(path.join(work, 'plugin', 'dist'), { recursive: true });
      await fs.writeFile(path.join(work, 'plugin', 'index.js'), 'export default { id: "fixture", async setup() {} }');
      await fs.writeFile(path.join(work, 'plugin', 'dist', 'helper.js'), 'export {}');
      await fs.mkdir(path.join(work, 'skills', 'hello'), { recursive: true });
      await fs.writeFile(path.join(work, 'skills', 'hello', 'SKILL.md'), 'hello');
      await pushVersion(work, id, '1.1.0', { opencodePlugin: 'plugin' });
      await installFrom(bare, persistPath);
      await setCapabilityGrants(id, persistPath, ['opencodePlugin']);
      const before = await loadGuest(id, persistPath);
      const store = await readExtensionStore(persistPath);

      // Real Windows watches hold the directories OpenCode watches: the plugin, the folder of a file it loads, and the skills.
      watcher = spawn('node', ['-e', 'for (const target of process.argv.slice(1)) require("node:fs").watch(target, () => {}).on("error", () => {}); console.log("ready")',
        ...['plugin', 'plugin/dist', 'skills'].map((folder) => path.join(before.packageRoot, folder))], {
        stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      });
      await once(watcher.stdout, 'data', { signal: AbortSignal.timeout(5_000) });
      await pushVersion(work, id, '1.2.0', { opencodePlugin: 'plugin' });
      const options = { guest: before, origin: before.gitOrigin, persistPath, openchamberVersion: '1.30.0' };
      expect(await updateGuest(options)).toEqual({ ok: true, id });
      const after = await loadGuest(id, persistPath);
      expect(after.version).toBe('1.2.0');
      expect(after.packageRoot).toBe(before.packageRoot);
      expect(await readExtensionStore(persistPath)).toEqual(store);
      expect(await fs.readdir(path.dirname(after.packageRoot))).toEqual([path.basename(after.packageRoot)]);
      await pushVersion(work, id, '1.3.0', { opencodePlugin: 'plugin' });
      expect(await checkAllGuestUpdates({ persistPath, force: true })).toEqual({ [id]: { version: '1.3.0' } });
      expect(await updateGuest(options)).toEqual({ ok: false, code: 'swap-failed' });
      const [updated] = await Promise.all([
        updateGuest({ ...options, guest: after }),
        checkAllGuestUpdates({ persistPath, force: true }),
      ]);
      expect(updated).toEqual({ ok: true, id });
      expect(getCachedGuestUpdate(persistPath, await loadGuest(id, persistPath))).toBeNull();
      expect((await loadGuest(id, persistPath)).version).toBe('1.3.0');
    } finally {
      if (watcher?.pid && watcher.exitCode === null && !watcher.signalCode) {
        const closed = once(watcher, 'close', { signal: AbortSignal.timeout(5_000) });
        watcher.kill();
        await closed;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

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
       storageIds: store.storageIds,
      capabilityGrants: { 'upd-swap': ['prompt'] },
      disabledGuests: { 'upd-swap': true },
    })}\n`);

    await pushVersion(work, 'upd-swap', '1.1.0', { capabilities: ['prompt', 'sessions'] });
    await checkAllGuestUpdates({ persistPath, force: true });
    expect(getCachedGuestUpdate(persistPath, { id: 'upd-swap', version: '1.0.0' })).toEqual({ version: '1.1.0' });

    const updated = await updateGuest({ guest: before, origin: before.gitOrigin, persistPath, openchamberVersion: '1.30.0' });
    expect(updated).toEqual({ ok: true, id: 'upd-swap' });

    const after = await loadGuest('upd-swap', persistPath);
    expect(after.version).toBe('1.1.0');
    expect(after.packageRoot).toBe(before.packageRoot);
    expect(after.gitOrigin).toEqual({ url: bare });
    expect(after.capabilityGrants).toEqual(['prompt']);
    expect(after.enabled).toBe(false);
    expect(after.capabilities).toEqual(['prompt', 'sessions']);
    expect(getCachedGuestUpdate(persistPath, { id: 'upd-swap', version: '1.0.0' })).toBeNull();
    const leftovers = (await fs.readdir(path.dirname(before.packageRoot))).filter((name) => name.startsWith('.'));
    expect(leftovers).toEqual([]);
    expect((await readExtensionStore(persistPath)).paths).toEqual([before.packageRoot]);
    expect((await readExtensionStore(persistPath)).storageIds['upd-swap']).toBe(store.storageIds['upd-swap']);

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

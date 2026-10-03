import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { spawnSync } from 'node:child_process';

import { listInstalledGuests } from './catalog.js';
import { buildStoreZip } from './extract-zip.test.js';
import { gitNetworkArgs } from './clone.js';
import {
  downloadZip,
  installGuestFromGitSource,
  installGuestFromPath,
  installGuestFromUrl,
  parseInstallRequest,
  uninstallGuest,
} from './install.js';
import { guestCopiesDir } from './persist.js';

const writeGuest = async (root, id) => {
  await fs.mkdir(path.join(root, 'panel'), { recursive: true });
  await fs.writeFile(path.join(root, 'panel', 'index.html'), '<html></html>');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: `@openchamber/${id}`,
    version: '1.0.0',
    openchamber: {
      apiVersion: 1,
      contributes: {
        panel: { id, name: id, icon: 'window', entry: 'panel/index.html' },
      },
    },
  }));
};

describe('installGuestFromPath', () => {
  test('installs a folder extension and refuses a second copy', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const persistPath = path.join(dir, 'extensions.json');
    const guestRoot = path.join(dir, 'clone');
    await writeGuest(guestRoot, 'clone-hello');

    expect(parseInstallRequest({ path: guestRoot })).toEqual({ path: guestRoot });
    expect(parseInstallRequest({ url: 'https://github.com/acme/panel.git' })).toEqual({
      url: 'https://github.com/acme/panel.git',
    });
    expect(parseInstallRequest({ path: guestRoot, replace: true })).toEqual({
      path: guestRoot,
      replace: true,
    });
    expect(parseInstallRequest({})).toBeNull();
    expect(parseInstallRequest({ path: guestRoot, url: 'https://github.com/acme/panel.git' })).toBeNull();

    const installed = await installGuestFromPath(guestRoot, persistPath);
    expect(installed.ok).toBe(true);
    if (!installed.ok) {
      throw new Error('expected install');
    }
    expect(installed.guest.id).toBe('clone-hello');
    expect(installed.guest.source).toBe('path');

    const listed = await listInstalledGuests({ persistPath });
    expect(listed.some((guest) => guest.id === 'clone-hello')).toBe(true);

    const again = await installGuestFromPath(guestRoot, persistPath);
    expect(again).toEqual({ ok: false, code: 'already-installed', id: 'clone-hello' });

    const replacedSame = await installGuestFromPath(guestRoot, persistPath, { replace: true });
    expect(replacedSame.ok).toBe(true);
    if (!replacedSame.ok) {
      throw new Error('expected replace');
    }
    expect(replacedSame.replaced).toBe(true);

    const otherRoot = path.join(dir, 'other');
    await writeGuest(otherRoot, 'clone-hello');
    const taken = await installGuestFromPath(otherRoot, persistPath);
    expect(taken).toEqual({ ok: false, code: 'id-taken', id: 'clone-hello' });

    const replacedOther = await installGuestFromPath(otherRoot, persistPath, { replace: true });
    expect(replacedOther.ok).toBe(true);
    if (!replacedOther.ok) {
      throw new Error('expected replace other');
    }
    expect(replacedOther.replaced).toBe(true);
    expect(replacedOther.guest.path).toBe(await fs.realpath(otherRoot));

    const relative = await installGuestFromPath('clone', persistPath);
    expect(relative).toEqual({ ok: false, code: 'invalid-path' });

    const badIdRoot = path.join(dir, 'bad-id');
    await writeGuest(badIdRoot, 'Not Kebab');
    const badId = await installGuestFromPath(badIdRoot, persistPath);
    expect(badId).toEqual({ ok: false, code: 'invalid-manifest' });

    const removed = await uninstallGuest('clone-hello', persistPath);
    expect(removed).toEqual({ ok: true });
    const after = await listInstalledGuests({ persistPath });
    expect(after.some((guest) => guest.id === 'clone-hello')).toBe(false);

    const missing = await uninstallGuest('hello', persistPath);
    expect(missing).toEqual({ ok: false, code: 'not-found' });

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('refuses a panel that has TypeScript but no built script', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const persistPath = path.join(dir, 'extensions.json');
    const guestRoot = path.join(dir, 'source-only');
    await fs.mkdir(path.join(guestRoot, 'panel'), { recursive: true });
    await fs.writeFile(path.join(guestRoot, 'panel', 'index.html'), '<script src="./main.js"></script>');
    await fs.writeFile(path.join(guestRoot, 'panel', 'main.ts'), 'console.log(1)');
    await fs.writeFile(path.join(guestRoot, 'package.json'), JSON.stringify({
      name: '@openchamber/source-only',
      version: '1.0.0',
      openchamber: {
        apiVersion: 1,
        contributes: {
          panel: { id: 'source-only', name: 'Source', icon: 'window', entry: 'panel/index.html' },
        },
      },
    }));
    const missing = await installGuestFromPath(guestRoot, persistPath);
    expect(missing).toEqual({ ok: false, code: 'missing-build' });
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('refuses engines.openchamber newer than the host', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const persistPath = path.join(dir, 'extensions.json');
    const guestRoot = path.join(dir, 'future');
    await fs.mkdir(path.join(guestRoot, 'panel'), { recursive: true });
    await fs.writeFile(path.join(guestRoot, 'panel', 'index.html'), '<html></html>');
    await fs.writeFile(path.join(guestRoot, 'package.json'), JSON.stringify({
      name: '@openchamber/future',
      version: '1.0.0',
      openchamber: {
        apiVersion: 1,
        engines: { openchamber: '>=9.9.9' },
        contributes: {
          panel: { id: 'future', name: 'Future', icon: 'window', entry: 'panel/index.html' },
        },
      },
    }));

    const refused = await installGuestFromPath(guestRoot, persistPath, { openchamberVersion: '1.22.0' });
    expect(refused).toEqual({ ok: false, code: 'host-too-old', required: '9.9.9' });

    const allowed = await installGuestFromPath(guestRoot, persistPath, { openchamberVersion: '9.9.9' });
    expect(allowed.ok).toBe(true);

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('keeps two instance catalogs apart', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const persistA = path.join(parent, 'a', 'extensions.json');
    const persistB = path.join(parent, 'b', 'extensions.json');
    const guestRoot = path.join(parent, 'clone');
    await writeGuest(guestRoot, 'clone-hello');

    const installed = await installGuestFromPath(guestRoot, persistA);
    expect(installed.ok).toBe(true);
    expect(await listInstalledGuests({ persistPath: persistB })).toEqual([]);
    expect((await listInstalledGuests({ persistPath: persistA })).some((guest) => guest.id === 'clone-hello')).toBe(true);

    await fs.rm(parent, { recursive: true, force: true });
  });

  test('installs a zip and deletes the copy on uninstall', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const persistPath = path.join(dir, 'extensions.json');
    const zipPath = path.join(dir, 'panel.zip');
    await fs.writeFile(zipPath, buildStoreZip([
      { name: 'package.json', data: JSON.stringify({
        name: '@openchamber/zip-hello',
        version: '1.0.0',
        openchamber: {
          apiVersion: 1,
          contributes: {
            panel: { id: 'zip-hello', name: 'Zip', icon: 'window', entry: 'panel/index.html' },
          },
        },
      }) },
      { name: 'panel/index.html', data: '<html></html>' },
    ]));

    const installed = await installGuestFromPath(zipPath, persistPath);
    expect(installed.ok).toBe(true);
    if (!installed.ok) {
      throw new Error('expected zip install');
    }
    expect(installed.guest.id).toBe('zip-hello');
    expect(installed.guest.source).toBe('zip');
    const copy = path.join(guestCopiesDir(persistPath), 'zip-hello');
    expect(await fs.stat(copy).then((stat) => stat.isDirectory())).toBe(true);

    const removed = await uninstallGuest('zip-hello', persistPath);
    expect(removed).toEqual({ ok: true });
    expect(await fs.stat(copy).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.stat(zipPath).then((stat) => stat.isFile())).toBe(true);

    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('installGuestFromUrl', () => {
  test('refuses a non-https url', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const persistPath = path.join(dir, 'extensions.json');
    expect(await installGuestFromUrl('http://example.com/panel.git', persistPath)).toEqual({
      ok: false,
      code: 'invalid-url',
    });
    for (const privateUrl of [
      'https://127.0.0.1/panel.git',
      'https://localhost/panel.zip',
      'https://10.0.0.5/panel.git',
      'https://192.168.1.2/panel.zip',
      'https://[::1]/panel.git',
      'https://user:pass@example.com/panel.git',
    ]) {
      expect(await installGuestFromUrl(privateUrl, persistPath)).toEqual({ ok: false, code: 'invalid-url' });
    }
    expect(await installGuestFromUrl('ftp://example.com/panel.git', persistPath)).toEqual({
      ok: false,
      code: 'invalid-url',
    });
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('installGuestFromGitSource', () => {
  test('clones a local repo and deletes the copy on uninstall', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const persistPath = path.join(dir, 'extensions.json');
    const repo = path.join(dir, 'repo');
    await writeGuest(repo, 'git-hello');
    const git = (args) => {
      const result = spawnSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      if (result.status !== 0) {
        throw new Error(result.stderr || 'git failed');
      }
    };
    git(['init', '--template=']);
    git(['add', '.']);
    git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init']);

    const installed = await installGuestFromGitSource(repo, persistPath);
    expect(installed.ok).toBe(true);
    if (!installed.ok) {
      throw new Error('expected git install');
    }
    expect(installed.guest.id).toBe('git-hello');
    expect(installed.guest.source).toBe('git');
    const copy = path.join(guestCopiesDir(persistPath), 'git-hello');
    expect(await fs.stat(copy).then((stat) => stat.isDirectory())).toBe(true);
    expect(await fs.stat(path.join(repo, 'package.json')).then((stat) => stat.isFile())).toBe(true);

    const removed = await uninstallGuest('git-hello', persistPath);
    expect(removed).toEqual({ ok: true });
    expect(await fs.stat(copy).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.stat(path.join(repo, 'package.json')).then((stat) => stat.isFile())).toBe(true);

    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('downloadZip', () => {
  const publicLookup = async () => [{ address: '93.184.216.34' }];

  test('follows a public redirect by hand, pinned to the checked address, and returns the bytes', async () => {
    const seen = [];
    const request = async (url, target) => {
      seen.push({ url, address: target.address });
      if (url === 'https://example.com/panel.zip') {
        return { status: 302, location: 'https://cdn.example.com/signed/abc', body: null };
      }
      return { status: 200, location: null, body: Buffer.from([1, 2, 3]) };
    };
    const bytes = await downloadZip('https://example.com/panel.zip', { request, lookup: publicLookup });
    expect(bytes && [...bytes]).toEqual([1, 2, 3]);
    expect(seen).toEqual([
      { url: 'https://example.com/panel.zip', address: '93.184.216.34' },
      { url: 'https://cdn.example.com/signed/abc', address: '93.184.216.34' },
    ]);
  });

  test('refuses a redirect to a private or non-https address before requesting it', async () => {
    for (const location of ['http://127.0.0.1:8080/panel.zip', 'https://localhost/panel.zip', 'https://10.0.0.5/x.zip', 'http://example.com/panel.zip']) {
      const requested = [];
      const request = async (url) => {
        requested.push(url);
        return { status: 302, location, body: null };
      };
      expect(await downloadZip('https://example.com/panel.zip', { request, lookup: publicLookup })).toBeNull();
      expect(requested).toEqual(['https://example.com/panel.zip']);
    }
  });

  test('refuses a public name that resolves to a private address', async () => {
    let requested = 0;
    const request = async () => {
      requested += 1;
      return { status: 200, location: null, body: Buffer.from([1]) };
    };
    const lookup = async () => [{ address: '93.184.216.34' }, { address: '10.1.1.1' }];
    expect(await downloadZip('https://example.com/panel.zip', { request, lookup })).toBeNull();
    expect(requested).toBe(0);
  });

  test('gives up after too many redirects', async () => {
    let hops = 0;
    const request = async (url) => {
      hops += 1;
      return { status: 302, location: `${url}0`, body: null };
    };
    expect(await downloadZip('https://example.com/panel.zip', { request, lookup: publicLookup })).toBeNull();
    expect(hops).toBeLessThanOrEqual(6);
  });
});

describe('gitNetworkArgs', () => {
  test('pins a public https host to its resolved addresses and forbids redirects', async () => {
    const lookup = async () => [{ address: '93.184.216.34' }, { address: '2606:2800:220:1:248:1893:25c8:1946' }];
    expect(await gitNetworkArgs('https://example.com/org/panel.git', lookup)).toEqual([
      '-c', 'http.followRedirects=false',
      '-c', 'http.curloptResolve=example.com:443:93.184.216.34,2606:2800:220:1:248:1893:25c8:1946',
    ]);
    expect(await gitNetworkArgs('https://example.com/org/panel.git', async () => [{ address: '127.0.0.1' }])).toBeNull();
    expect(await gitNetworkArgs('/tmp/local/repo')).toEqual([]);
  });
});

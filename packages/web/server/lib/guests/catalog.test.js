import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { guestAssetContentType, inspectGuestPackage, listInstalledGuests, resolveGuestAssetPath, resolveGuestServedFile, toPublicGuest } from './catalog.js';
import { setCapabilityGrants, writeExtensionPaths } from './persist.js';

const writeBuiltGuest = async (root) => {
  await fs.mkdir(path.join(root, 'panel'), { recursive: true });
  await fs.writeFile(path.join(root, 'panel', 'index.html'), '<script src="./main.js"></script>');
  await fs.writeFile(path.join(root, 'panel', 'main.js'), 'console.log("hello")');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: '@openchamber/hello',
    openchamber: {
      apiVersion: 1,
      contributes: {
        panel: { id: 'hello', name: 'Hello', icon: 'window', entry: 'panel/index.html' },
        attach: 'dialog',
      },
    },
  }));
};

describe('resolveGuestAssetPath', () => {
  test('stays inside the package and rejects escapes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-'));
    await fs.writeFile(path.join(root, 'index.html'), '<html></html>');
    await fs.mkdir(path.join(root, 'panel'));
    await fs.writeFile(path.join(root, 'panel', 'index.html'), '<html></html>');

    expect(await resolveGuestAssetPath(root, 'index.html')).toBe(await fs.realpath(path.join(root, 'index.html')));
    expect(await resolveGuestAssetPath(root, 'panel/index.html')).toBe(await fs.realpath(path.join(root, 'panel', 'index.html')));
    expect(await resolveGuestAssetPath(root, '../secret.html')).toBeNull();
    expect(await resolveGuestAssetPath(root, '/etc/passwd')).toBeNull();
    expect(await resolveGuestAssetPath(root, 'missing.html')).toBeNull();

    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('guestAssetContentType', () => {
  test('refuses unknown extensions', () => {
    expect(guestAssetContentType('panel/index.html')).toContain('text/html');
    expect(guestAssetContentType('icon.svg')).toBe('image/svg+xml');
    expect(guestAssetContentType('notes.md')).toBeNull();
  });
});

describe('listInstalledGuests', () => {
  test('does not auto-install the repo sample', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-'));
    const persistPath = path.join(dir, 'extensions.json');
    expect(await listInstalledGuests({ persistPath })).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('serves a path-installed guest', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-'));
    const persistPath = path.join(dir, 'extensions.json');
    const guestRoot = path.join(dir, 'hello');
    await writeBuiltGuest(guestRoot);
    await writeExtensionPaths([guestRoot], persistPath);

    const guests = await listInstalledGuests({ persistPath });
    const hello = guests.find((guest) => guest.id === 'hello');
    expect(hello?.name).toBe('Hello');
    expect(hello?.source).toBe('path');
    expect(hello?.attach).toBe('dialog');
    expect(hello).toBeTruthy();
    if (!hello) {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    }
    expect(toPublicGuest(hello)).toEqual({
      id: 'hello',
      name: 'Hello',
      icon: 'window',
      entry: 'panel/index.html',
      source: 'path',
      path: hello.path,
      attach: 'dialog',
      enabled: true,
      capabilities: { requested: [], granted: [] },
    });
    expect(toPublicGuest({
      ...hello,
      integration: {
        name: 'ClickUp',
        description: 'Tasks',
        oauth: {
          authorizeUrl: 'https://app.clickup.com/api',
          tokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
          apiOrigin: 'https://api.clickup.com',
        },
        settings: [{ id: 'list-id', label: 'List ID' }],
      },
    })).toEqual({
      id: 'hello',
      name: 'Hello',
      icon: 'window',
      entry: 'panel/index.html',
      source: 'path',
      path: hello.path,
      attach: 'dialog',
      enabled: true,
      capabilities: { requested: ['network'], granted: [] },
      integration: {
        name: 'ClickUp',
        description: 'Tasks',
        apiOrigin: 'https://api.clickup.com',
        auth: 'oauth',
        settings: [{ id: 'list-id', label: 'List ID' }],
      },
    });
    const served = await resolveGuestServedFile(hello.packageRoot, 'panel/main.js');
    expect(served?.contentType).toContain('javascript');
    expect(await resolveGuestServedFile(hello.packageRoot, 'panel/main.ts')).toBeNull();

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('skips a missing folder and keeps the rest', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-'));
    const persistPath = path.join(dir, 'extensions.json');
    const guestRoot = path.join(dir, 'clone');
    await fs.mkdir(path.join(guestRoot, 'panel'), { recursive: true });
    await fs.writeFile(path.join(guestRoot, 'panel', 'index.html'), '<html></html>');
    await fs.writeFile(path.join(guestRoot, 'package.json'), JSON.stringify({
      name: '@openchamber/clone-hello',
      openchamber: {
        apiVersion: 1,
        contributes: {
          panel: { id: 'clone-hello', name: 'Clone', icon: 'window', entry: 'panel/index.html' },
        },
      },
    }));
    await writeExtensionPaths([path.join(dir, 'gone'), guestRoot], persistPath);

    const guests = await listInstalledGuests({ persistPath });
    expect(guests.some((guest) => guest.id === 'clone-hello' && guest.source === 'path')).toBe(true);
    expect(guests.some((guest) => guest.path === path.join(dir, 'gone'))).toBe(false);

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('skips a package whose entry script was never built', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-'));
    const persistPath = path.join(dir, 'extensions.json');
    const guestRoot = path.join(dir, 'source-only');
    await fs.mkdir(path.join(guestRoot, 'panel'), { recursive: true });
    await fs.writeFile(path.join(guestRoot, 'panel', 'index.html'), '<script src="./main.js"></script>');
    await fs.writeFile(path.join(guestRoot, 'panel', 'main.ts'), 'console.log(1)');
    await fs.writeFile(path.join(guestRoot, 'package.json'), JSON.stringify({
      name: '@openchamber/source-only',
      openchamber: {
        apiVersion: 1,
        contributes: {
          panel: { id: 'source-only', name: 'Source', icon: 'window', entry: 'panel/index.html' },
        },
      },
    }));
    await writeExtensionPaths([guestRoot], persistPath);

    expect(await listInstalledGuests({ persistPath })).toEqual([]);

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('checks a declared dialog entry like panel.entry and exposes it on the public row', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-'));
    const guestRoot = path.join(dir, 'tasks');
    const writeManifest = async () => fs.writeFile(path.join(guestRoot, 'package.json'), JSON.stringify({
      name: '@openchamber/tasks',
      version: '1.0.0',
      openchamber: {
        apiVersion: 1,
        contributes: {
          panel: { id: 'tasks', name: 'Tasks', icon: 'window', entry: 'panel/index.html' },
          attach: { mode: 'dialog', entry: 'panel/attach.html' },
        },
      },
    }));
    await fs.mkdir(path.join(guestRoot, 'panel'), { recursive: true });
    await fs.writeFile(path.join(guestRoot, 'panel', 'index.html'), '<script src="./main.js"></script>');
    await fs.writeFile(path.join(guestRoot, 'panel', 'main.js'), 'console.log("main")');
    await writeManifest();

    expect(await inspectGuestPackage(guestRoot, { openchamberVersion: '1.0.0' })).toEqual({ ok: false, code: 'invalid-manifest' });

    await fs.writeFile(path.join(guestRoot, 'panel', 'attach.html'), '<script src="./attach.js"></script>');
    expect(await inspectGuestPackage(guestRoot, { openchamberVersion: '1.0.0' })).toEqual({ ok: false, code: 'missing-build' });

    await fs.writeFile(path.join(guestRoot, 'panel', 'attach.js'), 'console.log("attach")');
    const inspected = await inspectGuestPackage(guestRoot, { openchamberVersion: '1.0.0' });
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      expect(inspected.guest.attach).toBe('dialog');
      expect(inspected.guest.attachEntry).toBe('panel/attach.html');
      expect(toPublicGuest({ ...inspected.guest, source: 'path', path: guestRoot })).toMatchObject({
        attach: 'dialog',
        attachEntry: 'panel/attach.html',
      });
    }

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a page docked beside a shared surface reaches the public row with its edge and size', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-'));
    const guestRoot = path.join(dir, 'sim');
    await fs.mkdir(path.join(guestRoot, 'panel'), { recursive: true });
    await fs.writeFile(path.join(guestRoot, 'panel', 'index.html'), '<script src="./main.js"></script>');
    await fs.writeFile(path.join(guestRoot, 'panel', 'main.js'), 'console.log("strip")');
    await fs.writeFile(path.join(guestRoot, 'service.js'), 'console.log("service")');
    await fs.writeFile(path.join(guestRoot, 'package.json'), JSON.stringify({
      name: '@openchamber/sim',
      version: '1.0.0',
      openchamber: {
        apiVersion: 1,
        contributes: {
          panel: { id: 'sim', name: 'Sim', icon: 'window', entry: 'panel/index.html', dock: 'right', size: 240 },
          service: { entry: 'service.js', runtime: 'host', surface: true },
        },
      },
    }));

    const inspected = await inspectGuestPackage(guestRoot, { openchamberVersion: '1.0.0' });
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      expect(toPublicGuest({ ...inspected.guest, source: 'path', path: guestRoot })).toMatchObject({
        entry: 'panel/index.html',
        entryDock: 'right',
        entrySize: 240,
        service: expect.objectContaining({ surface: true }),
      });
    }

    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('page-less packages', () => {
  test('validates full-screen HTML and built scripts and publishes its title', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-page-'));
    try {
      await fs.mkdir(path.join(dir, 'panel'));
      await fs.writeFile(path.join(dir, 'panel/index.html'), '<p>Panel</p>');
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0', openchamber: {
        apiVersion: 1, contributes: { panel: { id: 'board', name: 'Board', icon: 'window', entry: 'panel/index.html' }, page: { entry: 'panel/page.html', title: 'Tasks' } },
      } }));
      expect(await inspectGuestPackage(dir)).toMatchObject({ ok: false, code: 'invalid-manifest' });
      await fs.writeFile(path.join(dir, 'panel/page.html'), '<script src="page.js"></script>');
      expect(await inspectGuestPackage(dir)).toMatchObject({ ok: false, code: 'missing-build' });
      await fs.writeFile(path.join(dir, 'panel/page.js'), 'console.log("page")');
      const inspected = await inspectGuestPackage(dir);
      expect(inspected.ok).toBe(true);
      expect(toPublicGuest(inspected.guest)).toMatchObject({ pageEntry: 'panel/page.html', pageTitle: 'Tasks' });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  test('a status-section-only package validates its HTML and scripts and publishes title and height without a panel entry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-status-'));
    try {
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0', openchamber: {
        apiVersion: 1, contributes: {
          panel: { id: 'git-graph', name: 'Git graph', icon: 'git-commit' },
          statusSection: { entry: 'status/index.html', title: 'Recent commits', height: 160 },
        },
      } }));
      expect(await inspectGuestPackage(dir)).toMatchObject({ ok: false, code: 'invalid-manifest' });
      await fs.mkdir(path.join(dir, 'status'));
      await fs.writeFile(path.join(dir, 'status/index.html'), '<script src="main.js"></script>');
      expect(await inspectGuestPackage(dir)).toMatchObject({ ok: false, code: 'missing-build' });
      await fs.writeFile(path.join(dir, 'status/main.js'), 'console.log("status")');
      const inspected = await inspectGuestPackage(dir);
      expect(inspected.ok).toBe(true);
      const row = toPublicGuest(inspected.guest);
      expect(row).toMatchObject({ statusEntry: 'status/index.html', statusTitle: 'Recent commits', statusHeight: 160 });
      expect(row).not.toHaveProperty('entry');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  test('installs a tools-only package without entry, omits entry from the row, and never serves it a frame', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-'));
    const guestRoot = path.join(dir, 'tools-only');
    await fs.mkdir(path.join(guestRoot, 'icons'), { recursive: true });
    await fs.writeFile(path.join(guestRoot, 'icons', 'tool.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await fs.writeFile(path.join(guestRoot, 'stray.html'), '<script src="./stray.js"></script>');
    await fs.writeFile(path.join(guestRoot, 'stray.js'), 'console.log(1)');
    await fs.writeFile(path.join(guestRoot, 'package.json'), JSON.stringify({
      name: '@openchamber/tools-only',
      version: '1.0.0',
      openchamber: {
        apiVersion: 1,
        contributes: {
          panel: { id: 'tools-only', name: 'Tools Only', icon: 'tools' },
          tools: [{ match: 'mcp.*', icon: 'icons/tool.svg', output: 'json' }],
        },
      },
    }));

    const inspected = await inspectGuestPackage(guestRoot, { openchamberVersion: '1.0.0' });
    expect(inspected).toEqual({
      ok: true,
      guest: {
        id: 'tools-only',
        name: 'Tools Only',
        icon: 'tools',
        packageRoot: guestRoot,
        version: '1.0.0',
        tools: [{ match: 'mcp.*', icon: 'icons/tool.svg', output: 'json' }],
      },
    });
    if (!inspected.ok) {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    }
    const row = toPublicGuest({ ...inspected.guest, source: 'path', path: guestRoot });
    expect(row).not.toHaveProperty('entry');
    expect(row.tools).toEqual([{ match: 'mcp.*', icon: 'icons/tool.svg', output: 'json' }]);

    const hasRuntime = false;
    expect((await resolveGuestServedFile(guestRoot, 'icons/tool.svg', { hasRuntime }))?.contentType).toBe('image/svg+xml');
    expect(await resolveGuestServedFile(guestRoot, 'stray.html', { hasRuntime })).toBeNull();
    expect(await resolveGuestServedFile(guestRoot, 'stray.js', { hasRuntime })).toBeNull();
    expect((await resolveGuestServedFile(guestRoot, 'stray.html', { hasRuntime: true }))?.contentType).toContain('html');

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('refuses a page-less package that declares a page-only contribution', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-'));
    const guestRoot = path.join(dir, 'no-entry');
    await fs.mkdir(guestRoot, { recursive: true });
    await fs.writeFile(path.join(guestRoot, 'package.json'), JSON.stringify({
      name: '@openchamber/no-entry',
      version: '1.0.0',
      openchamber: {
        apiVersion: 1,
        contributes: {
          panel: { id: 'no-entry', name: 'No Entry', icon: 'tools' },
          attach: 'dialog',
        },
      },
    }));
    expect(await inspectGuestPackage(guestRoot, { openchamberVersion: '1.0.0' })).toEqual({ ok: false, code: 'invalid-manifest' });
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('actions and commands on the public row', () => {
  test('copies declared actions and commands and asks for conversation when a session action wants messages', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-'));
    await writeBuiltGuest(root);
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    pkg.version = '1.0.0';
    pkg.openchamber.contributes.actions = [
      { id: 'create-task', label: 'Create task', where: 'message', roles: ['assistant'] },
      { id: 'summarize', label: 'Summarize', where: 'session', payload: ['messages'] },
    ];
    pkg.openchamber.contributes.commands = [{ name: 'task', description: 'Attach a task' }];
    pkg.openchamber.contributes.tools = [
      { match: 'mcp.tasks.*', name: 'Tasks', icon: 'checkbox-circle', title: '{input.id}', output: 'table', columns: ['id', 'title'] },
    ];
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));

    const inspected = await inspectGuestPackage(root);
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      const row = toPublicGuest({ ...inspected.guest, source: 'path', path: root, capabilityGrants: [] });
      expect(row.actions).toEqual(pkg.openchamber.contributes.actions);
      expect(row.commands).toEqual(pkg.openchamber.contributes.commands);
      expect(row.tools).toEqual(pkg.openchamber.contributes.tools);
      expect(row.capabilities).toEqual({ requested: ['conversation'], granted: [] });
    }

    pkg.openchamber.contributes.actions = [{ id: 'x', label: 'X', where: 'message', payload: ['messages'] }];
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
    expect(await inspectGuestPackage(root)).toMatchObject({ ok: false, code: 'invalid-manifest' });

    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('grant scopes', () => {
  const writeScopedGuest = async (root, filesystem) => {
    await fs.mkdir(path.join(root, 'panel'), { recursive: true });
    await fs.writeFile(path.join(root, 'panel', 'index.html'), '<script src="./main.js"></script>');
    await fs.writeFile(path.join(root, 'panel', 'main.js'), 'console.log("hello")');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: '@openchamber/scoped',
      version: '1.0.0',
      openchamber: {
        apiVersion: 1,
        contributes: {
          panel: { id: 'scoped', name: 'Scoped', icon: 'window', entry: 'panel/index.html' },
          capabilities: ['prompt'],
          filesystem,
        },
      },
    }));
  };

  test('a widened filesystem list drops that grant until the user approves again', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-'));
    const persistPath = path.join(dir, 'extensions.json');
    const root = path.join(dir, 'scoped');
    try {
      await writeScopedGuest(root, ['~/notes/**']);
      await writeExtensionPaths([root], persistPath);
      await setCapabilityGrants('scoped', persistPath, ['prompt', 'filesystem'], { filesystem: ['~/notes/**'] });
      const [approved] = await listInstalledGuests({ persistPath });
      expect(approved.capabilityGrants).toEqual(['prompt', 'filesystem']);

      await writeScopedGuest(root, ['~/**']);
      // Any store write drops the 5s catalog cache, as an update or a reinstall would.
      await writeExtensionPaths([root], persistPath);
      const [widened] = await listInstalledGuests({ persistPath });
      expect(widened.capabilityGrants).toEqual(['prompt']);
      expect(toPublicGuest(widened).capabilities).toEqual({ requested: ['prompt', 'filesystem'], granted: ['prompt'] });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('catalog cache under a store write', () => {
  test('a listing that started before a withdrawal is not cached as current', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-'));
    const persistPath = path.join(dir, 'extensions.json');
    const root = path.join(dir, 'hello');
    try {
      await writeBuiltGuest(root);
      await writeExtensionPaths([root], persistPath);
      await setCapabilityGrants('hello', persistPath, ['prompt'], null);
      // Start a listing (it reads the old file) and withdraw while it runs.
      const early = listInstalledGuests({ persistPath });
      await setCapabilityGrants('hello', persistPath, [], null);
      await early;
      const [after] = await listInstalledGuests({ persistPath });
      expect(after.capabilityGrants).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

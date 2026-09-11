import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { guestAssetContentType, inspectGuestPackage, listInstalledGuests, resolveGuestAssetPath, resolveGuestServedFile, toPublicGuest } from './catalog.js';
import { writeExtensionPaths } from './persist.js';

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
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));

    const inspected = await inspectGuestPackage(root);
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      const row = toPublicGuest({ ...inspected.guest, source: 'path', path: root, capabilityGrants: [] });
      expect(row.actions).toEqual(pkg.openchamber.contributes.actions);
      expect(row.commands).toEqual(pkg.openchamber.contributes.commands);
      expect(row.capabilities).toEqual({ requested: ['conversation'], granted: [] });
    }

    pkg.openchamber.contributes.actions = [{ id: 'x', label: 'X', where: 'message', payload: ['messages'] }];
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
    expect(await inspectGuestPackage(root)).toMatchObject({ ok: false, code: 'invalid-manifest' });

    await fs.rm(root, { recursive: true, force: true });
  });
});

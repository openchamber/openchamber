import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  extensionsPersistPath,
  guestCopiesDir,
  isCopiedGuestRoot,
  readExtensionPaths,
  readExtensionStore,
  writeExtensionPaths,
  writeExtensionStore,
} from './persist.js';

describe('extensionsPersistPath', () => {
  test('joins the instance data dir and refuses a relative path', () => {
    const dataDir = path.join(os.tmpdir(), 'oc-instance-a');
    expect(extensionsPersistPath(dataDir)).toBe(path.join(dataDir, 'extensions.json'));
    expect(() => extensionsPersistPath('relative')).toThrow('absolute OpenChamber data dir');
    expect(() => extensionsPersistPath('')).toThrow('absolute OpenChamber data dir');
  });
});

describe('extension persist', () => {
  test('round-trips paths and treats a missing file as empty', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const file = extensionsPersistPath(dir);
    expect(await readExtensionPaths(file)).toEqual([]);
    await writeExtensionPaths(['/one', '/two'], file);
    expect(await readExtensionPaths(file)).toEqual(['/one', '/two']);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('keeps two instance stores apart', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const a = extensionsPersistPath(path.join(parent, 'a'));
    const b = extensionsPersistPath(path.join(parent, 'b'));
    await writeExtensionPaths(['/one'], a);
    await writeExtensionPaths(['/two'], b);
    expect(await readExtensionPaths(a)).toEqual(['/one']);
    expect(await readExtensionPaths(b)).toEqual(['/two']);
    await fs.rm(parent, { recursive: true, force: true });
  });

  test('reads a path-only store and keeps zip sources', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const file = extensionsPersistPath(dir);
    await fs.writeFile(file, `${JSON.stringify({ paths: ['/one'] })}\n`, 'utf8');
    expect(await readExtensionStore(file)).toEqual({
      paths: ['/one'],
      sources: {},
      gitOrigins: {},
      capabilityGrants: {},
      disabledGuests: {},
      serviceSocketOverrides: {},
    });
    await writeExtensionStore(file, {
      paths: ['/one', '/two'],
      sources: { '/one': 'path', '/two': 'zip' },
    });
    expect(await readExtensionStore(file)).toEqual({
      paths: ['/one', '/two'],
      sources: { '/two': 'zip' },
      gitOrigins: {},
      capabilityGrants: {},
      disabledGuests: {},
      serviceSocketOverrides: {},
    });
    await writeExtensionPaths(['/two'], file);
    expect(await readExtensionStore(file)).toEqual({
      paths: ['/two'],
      sources: { '/two': 'zip' },
      gitOrigins: {},
      capabilityGrants: {},
      disabledGuests: {},
      serviceSocketOverrides: {},
    });
    expect(guestCopiesDir(file)).toBe(path.join(dir, 'extensions'));
    expect(isCopiedGuestRoot(path.join(dir, 'extensions', 'hello'), file)).toBe(true);
    expect(isCopiedGuestRoot(path.join(dir, 'other', 'hello'), file)).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('round-trips service grants', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const file = extensionsPersistPath(dir);
    await writeExtensionStore(file, {
      paths: ['/one'],
      sources: {},
      gitOrigins: {},
      capabilityGrants: { docker: ['service'] },
    });
    expect(await readExtensionStore(file)).toEqual({
      paths: ['/one'],
      sources: {},
      gitOrigins: {},
      capabilityGrants: { docker: ['service'] },
      disabledGuests: {},
      serviceSocketOverrides: {},
    });
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('round-trips service socket overrides', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const file = extensionsPersistPath(dir);
    await writeExtensionStore(file, {
      paths: ['/one'],
      sources: {},
      gitOrigins: {},
      capabilityGrants: { docker: ['service'] },
      serviceSocketOverrides: { docker: { docker: '/custom/docker.sock' } },
    });
    expect(await readExtensionStore(file)).toEqual({
      paths: ['/one'],
      sources: {},
      gitOrigins: {},
      capabilityGrants: { docker: ['service'] },
      disabledGuests: {},
      serviceSocketOverrides: { docker: { docker: '/custom/docker.sock' } },
    });
    await writeExtensionPaths(['/one'], file);
    expect(await readExtensionStore(file)).toEqual({
      paths: ['/one'],
      sources: {},
      gitOrigins: {},
      capabilityGrants: { docker: ['service'] },
      disabledGuests: {},
      serviceSocketOverrides: { docker: { docker: '/custom/docker.sock' } },
    });
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('round-trips disabled guests', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const file = extensionsPersistPath(dir);
    await writeExtensionStore(file, {
      paths: ['/one'],
      sources: {},
      disabledGuests: { docker: true },
    });
    expect(await readExtensionStore(file)).toEqual({
      paths: ['/one'],
      sources: {},
      gitOrigins: {},
      capabilityGrants: {},
      disabledGuests: { docker: true },
      serviceSocketOverrides: {},
    });
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('keeps the store whole under concurrent writes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-persist-'));
    const file = extensionsPersistPath(dir);
    try {
      await Promise.all(Array.from({ length: 12 }, (_, index) => (
        writeExtensionStore(file, { paths: [`/guests/${index}`] })
      )));
      const store = await readExtensionStore(file);
      expect(store.paths).toHaveLength(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('drops grants this build no longer knows instead of refusing the store', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const persistPath = extensionsPersistPath(dir);
    await fs.writeFile(persistPath, JSON.stringify({
      paths: ['/tmp/old-echo', '/tmp/tasks'],
      capabilityGrants: { 'old-echo': ['agent'], tasks: ['prompt', 'made-up', 'sessions'] },
    }));
    try {
      const store = await readExtensionStore(persistPath);
      expect(store.paths).toEqual(['/tmp/old-echo', '/tmp/tasks']);
      expect(store.capabilityGrants).toEqual({ 'old-echo': [], tasks: ['prompt', 'sessions'] });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses a corrupt store', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const file = extensionsPersistPath(dir);
    await fs.writeFile(file, '{"paths":[1]}', 'utf8');
    try {
      await readExtensionPaths(file);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('Invalid extensions store');
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('keeps git origins for installed git copies and drops malformed ones', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const file = extensionsPersistPath(dir);
    await writeExtensionStore(file, {
      paths: ['/git', '/zip', '/folder'],
      sources: { '/git': 'git', '/zip': 'zip' },
      gitOrigins: {
        '/git': { url: 'https://github.com/acme/panel.git', ref: 'v1' },
        '/zip': { url: 'https://example.com/ignored.git' },
        '/folder': { url: 'https://example.com/ignored.git' },
        '/gone': { url: 'https://example.com/ignored.git' },
      },
    });
    expect((await readExtensionStore(file)).gitOrigins).toEqual({
      '/git': { url: 'https://github.com/acme/panel.git', ref: 'v1' },
    });

    await writeExtensionPaths(['/zip'], file);
    expect((await readExtensionStore(file)).gitOrigins).toEqual({});

    await fs.writeFile(file, `${JSON.stringify({
      paths: ['/a', '/b'],
      sources: { '/a': 'git', '/b': 'git' },
      gitOrigins: { '/a': { url: 'https://github.com/acme/a.git' }, '/b': { ref: 'main' }, '/c': 'nope' },
    })}\n`, 'utf8');
    const tolerant = await readExtensionStore(file);
    expect(tolerant.paths).toEqual(['/a', '/b']);
    expect(tolerant.gitOrigins).toEqual({ '/a': { url: 'https://github.com/acme/a.git' } });

    await fs.rm(dir, { recursive: true, force: true });
  });
});

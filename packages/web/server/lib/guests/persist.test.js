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
      agentGrants: {},
      disabledGuests: {},
      agentSocketOverrides: {},
    });
    await writeExtensionStore(file, {
      paths: ['/one', '/two'],
      sources: { '/one': 'path', '/two': 'zip' },
    });
    expect(await readExtensionStore(file)).toEqual({
      paths: ['/one', '/two'],
      sources: { '/two': 'zip' },
      agentGrants: {},
      disabledGuests: {},
      agentSocketOverrides: {},
    });
    await writeExtensionPaths(['/two'], file);
    expect(await readExtensionStore(file)).toEqual({
      paths: ['/two'],
      sources: { '/two': 'zip' },
      agentGrants: {},
      disabledGuests: {},
      agentSocketOverrides: {},
    });
    expect(guestCopiesDir(file)).toBe(path.join(dir, 'guests'));
    expect(isCopiedGuestRoot(path.join(dir, 'guests', 'hello'), file)).toBe(true);
    expect(isCopiedGuestRoot(path.join(dir, 'other', 'hello'), file)).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('round-trips agent grants', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const file = extensionsPersistPath(dir);
    await writeExtensionStore(file, {
      paths: ['/one'],
      sources: {},
      agentGrants: { docker: true },
    });
    expect(await readExtensionStore(file)).toEqual({
      paths: ['/one'],
      sources: {},
      agentGrants: { docker: true },
      disabledGuests: {},
      agentSocketOverrides: {},
    });
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('round-trips agent socket overrides', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-'));
    const file = extensionsPersistPath(dir);
    await writeExtensionStore(file, {
      paths: ['/one'],
      sources: {},
      agentGrants: { docker: true },
      agentSocketOverrides: { docker: { docker: '/custom/docker.sock' } },
    });
    expect(await readExtensionStore(file)).toEqual({
      paths: ['/one'],
      sources: {},
      agentGrants: { docker: true },
      disabledGuests: {},
      agentSocketOverrides: { docker: { docker: '/custom/docker.sock' } },
    });
    await writeExtensionPaths(['/one'], file);
    expect(await readExtensionStore(file)).toEqual({
      paths: ['/one'],
      sources: {},
      agentGrants: { docker: true },
      disabledGuests: {},
      agentSocketOverrides: { docker: { docker: '/custom/docker.sock' } },
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
      agentGrants: {},
      disabledGuests: { docker: true },
      agentSocketOverrides: {},
    });
    await fs.rm(dir, { recursive: true, force: true });
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
});

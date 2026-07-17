import { describe, expect, it, vi } from 'bun:test';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';

import { createManagedTunnelConfigRuntime } from './managed-config.js';

const createRuntime = (initial) => {
  let stored = initial === undefined ? null : JSON.stringify(initial);
  let writeOptions = null;
  const temporary = new Map();
  const runtime = createManagedTunnelConfigRuntime({
    fsPromises: {
      mkdir: async () => {},
      readFile: async (file) => {
        if (file.endsWith('legacy.json') || stored === null) {
          const error = new Error('missing');
          error.code = 'ENOENT';
          throw error;
        }
        return stored;
      },
      writeFile: async (_file, value, options) => {
        temporary.set(_file, value);
        writeOptions = options;
      },
      chmod: async () => {},
      rename: async (from) => { stored = temporary.get(from); temporary.delete(from); },
      unlink: async (file) => { temporary.delete(file); },
    },
    path: { dirname: () => '/config' },
    normalizeManagedRemoteTunnelHostname: (value) => typeof value === 'string' ? value.trim().toLowerCase() : '',
    normalizeManagedRemoteTunnelPresets: (value) => value,
    constants: {
      CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: '/config/current.json',
      CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: '/config/legacy.json',
      CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1,
    },
  });
  return { runtime, getStored: () => JSON.parse(stored), getWriteOptions: () => writeOptions };
};

const profile = (overrides = {}) => ({
  id: 'profile-a', name: 'A', hostname: 'a.example.com', token: 'secret-a', updatedAt: 1, ...overrides,
});

const createRuntimeWithFs = (fs) => createManagedTunnelConfigRuntime({
  fsPromises: fs,
  path: { dirname: () => '/config' },
  normalizeManagedRemoteTunnelHostname: (value) => typeof value === 'string' ? value.trim().toLowerCase() : '',
  normalizeManagedRemoteTunnelPresets: (value) => value,
  constants: {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: '/config/current.json',
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: '/config/legacy.json',
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1,
  },
});

describe('managed remote tunnel config', () => {
  it('returns empty only when both current and legacy configs are genuinely missing', async () => {
    const readFile = vi.fn(async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    });
    const runtime = createRuntimeWithFs({ readFile });

    await expect(runtime.readManagedRemoteTunnelConfigFromDisk()).resolves.toEqual({ version: 1, tunnels: [] });
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('propagates malformed JSON and non-ENOENT current read failures', async () => {
    const malformed = createRuntimeWithFs({ readFile: async () => '{invalid' });
    await expect(malformed.readManagedRemoteTunnelConfigFromDisk()).rejects.toBeInstanceOf(SyntaxError);

    const denied = new Error('permission denied');
    denied.code = 'EACCES';
    const unreadable = createRuntimeWithFs({ readFile: async () => { throw denied; } });
    await expect(unreadable.readManagedRemoteTunnelConfigFromDisk()).rejects.toBe(denied);
  });

  it('rejects valid JSON with malformed current config shapes', async () => {
    for (const value of [null, [], { tunnels: {} }]) {
      const runtime = createRuntimeWithFs({ readFile: async () => JSON.stringify(value) });
      await expect(runtime.readManagedRemoteTunnelConfigFromDisk()).rejects.toThrow(
        'Managed remote tunnel config must be an object with a tunnels array',
      );
    }
  });

  it('rejects valid JSON with a malformed legacy config shape', async () => {
    const runtime = createRuntimeWithFs({
      readFile: async (file) => {
        if (file.endsWith('current.json')) {
          const missing = new Error('missing');
          missing.code = 'ENOENT';
          throw missing;
        }
        return JSON.stringify({ tunnels: {} });
      },
    });

    await expect(runtime.readManagedRemoteTunnelConfigFromDisk()).rejects.toThrow(
      'Managed remote tunnel config must be an object with a tunnels array',
    );
  });

  it('propagates non-ENOENT legacy reads and migration writes', async () => {
    const denied = new Error('legacy permission denied');
    denied.code = 'EACCES';
    const legacyUnreadable = createRuntimeWithFs({
      readFile: async (file) => {
        if (file.endsWith('current.json')) {
          const missing = new Error('missing');
          missing.code = 'ENOENT';
          throw missing;
        }
        throw denied;
      },
    });
    await expect(legacyUnreadable.readManagedRemoteTunnelConfigFromDisk()).rejects.toBe(denied);

    const writeFailure = new Error('migration write failed');
    const migrationWriteFailed = createRuntimeWithFs({
      readFile: async (file) => {
        if (file.endsWith('current.json')) {
          const missing = new Error('missing');
          missing.code = 'ENOENT';
          throw missing;
        }
        return JSON.stringify({ version: 1, tunnels: [profile()] });
      },
      mkdir: async () => {},
      writeFile: async () => { throw writeFailure; },
      unlink: async () => {},
    });
    await expect(migrationWriteFailed.readManagedRemoteTunnelConfigFromDisk()).rejects.toBe(writeFailure);
  });

  it('does not run the mutation write after an authoritative read failure', async () => {
    const readFailure = new Error('read failed');
    const writeFile = vi.fn(async () => {});
    const readPresetId = vi.fn(() => 'profile-a');
    const presets = [{ get id() { return readPresetId(); } }];
    const runtime = createRuntimeWithFs({
      readFile: async () => { throw readFailure; },
      writeFile,
    });

    await expect(runtime.syncManagedRemoteTunnelConfigWithPresets(presets)).rejects.toBe(readFailure);
    expect(readPresetId).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('preserves malformed valid-JSON real-disk bytes when a mutation fails to read them', async () => {
    const directory = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'openchamber-managed-config-corrupt-'));
    const current = nodePath.join(directory, 'current.json');
    const legacy = nodePath.join(directory, 'legacy.json');
    const corruptBytes = Buffer.from('{"version":1,"tunnels":{}}');
    await fsPromises.writeFile(current, corruptBytes);
    const runtime = createManagedTunnelConfigRuntime({
      fsPromises,
      path: nodePath,
      normalizeManagedRemoteTunnelHostname: (value) => typeof value === 'string' ? value.trim().toLowerCase() : '',
      normalizeManagedRemoteTunnelPresets: (value) => value,
      constants: {
        CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: current,
        CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: legacy,
        CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1,
      },
    });
    try {
      await expect(runtime.upsertManagedRemoteTunnelToken(profile())).rejects.toBeInstanceOf(TypeError);
      expect(await fsPromises.readFile(current)).toEqual(corruptBytes);
      expect((await fsPromises.readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await fsPromises.rm(directory, { recursive: true, force: true });
    }
  });

  it('normalizes missing and non-boolean direct E2EE flags to false', async () => {
    const { runtime } = createRuntime({ version: 1, tunnels: [profile(), profile({ id: 'profile-b', hostname: 'b.example.com', directE2eeEnabled: 'true' })] });
    const config = await runtime.readManagedRemoteTunnelConfigFromDisk();
    expect(config.tunnels.map((entry) => entry.directE2eeEnabled)).toEqual([false, false]);
  });

  it('preserves the flag when an upsert omits it and writes mode 0600', async () => {
    const { runtime, getStored, getWriteOptions } = createRuntime({ version: 1, tunnels: [profile({ directE2eeEnabled: true })] });
    await runtime.upsertManagedRemoteTunnelToken({ id: 'profile-a', name: 'Renamed', hostname: 'a.example.com', token: 'new-secret' });
    expect(getStored().tunnels[0]).toMatchObject({ name: 'Renamed', token: 'new-secret', directE2eeEnabled: true });
    expect(getWriteOptions().mode).toBe(0o600);
  });

  it('serially mutates only the selected profile flag', async () => {
    const { runtime, getStored } = createRuntime({
      version: 1,
      tunnels: [profile(), profile({ id: 'profile-b', hostname: 'b.example.com', token: 'secret-b' })],
    });
    await runtime.setManagedRemoteTunnelDirectE2eeEnabled({ id: 'profile-b', directE2eeEnabled: true });
    expect(getStored().tunnels.map(({ id, directE2eeEnabled }) => ({ id, directE2eeEnabled }))).toEqual([
      { id: 'profile-a', directE2eeEnabled: false },
      { id: 'profile-b', directE2eeEnabled: true },
    ]);
  });

  it('recovers the serialization lock after a failed write', async () => {
    let writes = 0;
    let stored = JSON.stringify({ version: 1, tunnels: [profile()] });
    const runtime = createManagedTunnelConfigRuntime({
      fsPromises: {
        mkdir: async () => {},
        readFile: async () => stored,
        writeFile: async (_file, value) => {
          writes += 1;
          if (writes === 1) throw new Error('disk full');
          stored = value;
        },
        chmod: async () => {},
        rename: async () => {},
        unlink: async () => {},
      },
      path: { dirname: () => '/config' },
      normalizeManagedRemoteTunnelHostname: (value) => typeof value === 'string' ? value.trim().toLowerCase() : '',
      normalizeManagedRemoteTunnelPresets: (value) => value,
      constants: {
        CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: '/config/current.json',
        CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: '/config/legacy.json',
        CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1,
      },
    });
    await expect(runtime.setManagedRemoteTunnelDirectE2eeEnabled({ id: 'profile-a', directE2eeEnabled: true })).rejects.toThrow('disk full');
    await runtime.setManagedRemoteTunnelDirectE2eeEnabled({ id: 'profile-a', directE2eeEnabled: true });
    expect(JSON.parse(stored).tunnels[0].directE2eeEnabled).toBe(true);
  });

  it('atomically replaces a pre-existing 0644 config with owner-only 0600 permissions', async () => {
    if (process.platform === 'win32') return;
    const directory = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'openchamber-managed-config-'));
    const current = nodePath.join(directory, 'current.json');
    const legacy = nodePath.join(directory, 'legacy.json');
    await fsPromises.writeFile(current, JSON.stringify({ version: 1, tunnels: [profile()] }), { mode: 0o644 });
    const runtime = createManagedTunnelConfigRuntime({
      fsPromises, path: nodePath, managedConfigDirectoryIsPrivate: true,
      normalizeManagedRemoteTunnelHostname: (value) => typeof value === 'string' ? value.trim().toLowerCase() : '',
      normalizeManagedRemoteTunnelPresets: (value) => value,
      constants: { CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: current, CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: legacy, CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1 },
    });
    try {
      await runtime.setManagedRemoteTunnelDirectE2eeEnabled({ id: 'profile-a', directE2eeEnabled: true });
      expect((await fsPromises.stat(current)).mode & 0o777).toBe(0o600);
      expect((await fsPromises.stat(directory)).mode & 0o777).toBe(0o700);
      expect((await fsPromises.readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await fsPromises.rm(directory, { recursive: true, force: true });
    }
  });

  it('cleans the temporary file when atomic rename fails and surfaces the error', async () => {
    const files = new Set();
    const runtime = createManagedTunnelConfigRuntime({
      fsPromises: {
        mkdir: async () => {}, readFile: async () => JSON.stringify({ version: 1, tunnels: [profile()] }),
        writeFile: async (file) => { files.add(file); }, chmod: async () => {},
        rename: async () => { throw new Error('rename failed'); }, unlink: async (file) => { files.delete(file); },
      },
      path: { dirname: () => '/config' },
      normalizeManagedRemoteTunnelHostname: (value) => typeof value === 'string' ? value.trim().toLowerCase() : '',
      normalizeManagedRemoteTunnelPresets: (value) => value,
      constants: { CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: '/config/current.json', CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: '/config/legacy.json', CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1 },
    });
    await expect(runtime.setManagedRemoteTunnelDirectE2eeEnabled({ id: 'profile-a', directE2eeEnabled: true })).rejects.toThrow('rename failed');
    expect(files.size).toBe(0);
  });
});

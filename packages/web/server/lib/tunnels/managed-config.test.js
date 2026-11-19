import { describe, expect, it, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { createManagedTunnelConfigRuntime } from './managed-config.js';
import { createSettingsNormalizationRuntime } from '../settings/settings-normalization-runtime.js';

const createInMemoryRuntime = (initialFiles = [], normalizerOverrides = {}) => {
  const files = new Map(initialFiles);
  const normalizers = createSettingsNormalizationRuntime({});
  const runtime = createManagedTunnelConfigRuntime({
    fsPromises: {
      mkdir: async () => {},
      readFile: async (file) => {
        if (!files.has(file)) {
          throw Object.assign(new Error('File not found'), { code: 'ENOENT' });
        }
        return files.get(file);
      },
      writeFile: async (file, data) => { files.set(file, data); },
    },
    path,
    normalizeManagedRemoteTunnelHostname: normalizers.normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets: normalizers.normalizeManagedRemoteTunnelPresets,
    ...normalizerOverrides,
    constants: {
      CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: '/managed.json',
      CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: '/legacy.json',
      CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1,
    },
  });
  return { runtime, files };
};

describe('managed remote tunnel config', () => {
  it.each([null, false, 7, 'text', [], {}, { tunnels: {} }, { tunnels: 'constructor' }])(
    'reads an empty list from invalid config %j',
    async (input) => {
      const { runtime } = createInMemoryRuntime([['/managed.json', JSON.stringify(input)]]);
      expect(await runtime.readManagedRemoteTunnelConfigFromDisk()).toEqual({ version: 1, tunnels: [] });
    }
  );

  it('retains only complete, unique entries and preserves finite timestamps', async () => {
    const timestamp = vi.spyOn(Date, 'now').mockReturnValue(1234);
    const entry = { id: ' a ', name: ' A ', hostname: 'https://A.EXAMPLE.COM/path', token: ' secret ', updatedAt: -1.5 };
    const { runtime } = createInMemoryRuntime([['/managed.json', JSON.stringify({
      tunnels: [
        null, false, 'text', [], {}, { ...entry, id: 7 }, { ...entry, token: false },
        entry,
        { ...entry, hostname: 'b.example.com' },
        { ...entry, id: 'b' },
        { ...entry, id: 'c', hostname: 'c.example.com', updatedAt: '100' },
      ],
    })]]);
    try {
      expect((await runtime.readManagedRemoteTunnelConfigFromDisk()).tunnels).toEqual([
        { id: 'a', name: 'A', hostname: 'a.example.com', token: 'secret', updatedAt: -1.5 },
        { id: 'c', name: 'A', hostname: 'c.example.com', token: 'secret', updatedAt: 1234 },
      ]);
    } finally {
      timestamp.mockRestore();
    }
  });

  it('migrates only when the current file is absent', async () => {
    const legacy = JSON.stringify({ tunnels: [{ id: 'a', name: 'A', hostname: 'a.example.com', token: 'secret', updatedAt: 1 }] });
    const { runtime, files } = createInMemoryRuntime([['/legacy.json', legacy]]);
    const migrated = await runtime.readManagedRemoteTunnelConfigFromDisk();
    expect(migrated.tunnels).toHaveLength(1);
    expect(JSON.parse(files.get('/managed.json'))).toEqual(migrated);
    files.set('/managed.json', 'invalid JSON');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await runtime.readManagedRemoteTunnelConfigFromDisk()).toEqual({ version: 1, tunnels: [] });
      expect(files.get('/managed.json')).toBe('invalid JSON');
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves prototype-like preset ids and resolves id before hostname', async () => {
    const preset = Object.create({ id: 'constructor', name: 'Constructor', hostname: 'a.example.com' });
    const { runtime } = createInMemoryRuntime();
    await runtime.upsertManagedRemoteTunnelToken({ id: preset.id, name: preset.name, hostname: preset.hostname, token: 'first' });
    await runtime.upsertManagedRemoteTunnelToken({ id: 'other', name: 'Other', hostname: 'b.example.com', token: 'second' });
    expect(await runtime.resolveManagedRemoteTunnelToken({ presetId: 'constructor', hostname: 'b.example.com' })).toBe('first');
    await runtime.syncManagedRemoteTunnelConfigWithPresets([preset]);
    expect((await runtime.readManagedRemoteTunnelConfigFromDisk()).tunnels).toMatchObject([
      { id: 'constructor', name: 'Constructor', hostname: 'a.example.com', token: 'first' },
    ]);
  });

  it('forwards raw preset input to the injected normalizer', async () => {
    const normalize = vi.fn(() => []);
    const { runtime } = createInMemoryRuntime([], { normalizeManagedRemoteTunnelPresets: normalize });
    const raw = { unvalidated: true };
    await runtime.syncManagedRemoteTunnelConfigWithPresets(raw);
    expect(normalize).toHaveBeenCalledWith(raw);
    expect((await runtime.readManagedRemoteTunnelConfigFromDisk()).tunnels).toEqual([]);
  });

  it.each(['id', 'name', 'hostname', 'token'])('rejects a non-string %s before persisting', async (field) => {
    const { runtime, files } = createInMemoryRuntime();
    await runtime.upsertManagedRemoteTunnelToken({
      id: 'a', name: 'A', hostname: 'a.example.com', token: 'secret', [field]: 7,
    });
    expect(files.size).toBe(0);
  });

  it('writes the next update after one failed with a full disk', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-managed-tunnels-'));
    const configPath = path.join(tempRoot, 'cloudflare-managed-remote-tunnels.json');
    let failNextWrite = true;
    const runtime = createManagedTunnelConfigRuntime({
      fsPromises: {
        ...fsPromises,
        writeFile: async (file, ...rest) => {
          if (failNextWrite && file === configPath) {
            failNextWrite = false;
            const error = new Error('ENOSPC: no space left on device, write');
            error.code = 'ENOSPC';
            throw error;
          }
          return fsPromises.writeFile(file, ...rest);
        },
      },
      path,
      normalizeManagedRemoteTunnelHostname: (value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''),
      normalizeManagedRemoteTunnelPresets: (value) => value,
      constants: {
        CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: configPath,
        CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: path.join(tempRoot, 'legacy.json'),
        CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1,
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tunnel = { id: 'a', name: 'A', hostname: 'a.example.com' };
    try {
      await expect(runtime.upsertManagedRemoteTunnelToken({ ...tunnel, token: 'first' })).rejects.toThrow('ENOSPC');
      await expect(runtime.upsertManagedRemoteTunnelToken({ ...tunnel, token: 'second' })).resolves.toBeUndefined();
      const onDisk = await runtime.readManagedRemoteTunnelConfigFromDisk();
      expect(onDisk.tunnels).toMatchObject([{ ...tunnel, token: 'second' }]);
    } finally {
      warn.mockRestore();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

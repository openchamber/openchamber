import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_DURABLE_JSON_MAX_BYTES } from '../shared/durable-json-store.js';
import { createManagedTunnelConfigRuntime, LEGACY_NAMED_TUNNELS_MAX_BYTES } from './managed-config.js';

const temporaryDirectories = [];

// Test doubles for the two normalizers this runtime consumes (the real
// implementations live in lib/opencode/settings-normalization-runtime.js
// and have their own suite): hostname -> trimmed lowercase string or
// undefined; presets -> deduped { id, name, hostname } list or undefined.
const normalizeManagedRemoteTunnelHostname = (value) => {
  const trimmed = String(value ?? '').trim().toLowerCase();
  return trimmed || undefined;
};

const normalizeManagedRemoteTunnelPresets = (value) => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = [];
  const seenIds = new Set();
  const seenHostnames = new Set();
  for (const entry of value) {
    if (!entry || Object(entry) !== entry) continue;
    const id = String(entry.id ?? '').trim();
    const name = String(entry.name ?? '').trim();
    const hostname = normalizeManagedRemoteTunnelHostname(entry.hostname);
    if (!id || !name || !hostname) continue;
    if (seenIds.has(id) || seenHostnames.has(hostname)) continue;
    seenIds.add(id);
    seenHostnames.add(hostname);
    result.push({ id, name, hostname });
  }
  return result;
};

const makeRuntime = async (overrides = {}) => {
  const dir = overrides.dir ?? (await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openchamber-managed-tunnels-')));
  if (!overrides.dir) {
    temporaryDirectories.push(dir);
  }
  const filePath = path.join(dir, 'cloudflare-managed-remote-tunnels.json');
  const legacyPath = path.join(dir, 'cloudflare-named-tunnels.json');
  const runtime = createManagedTunnelConfigRuntime({
    fsPromises: overrides.fsPromises ?? fsPromises,
    path,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets,
    constants: {
      CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: filePath,
      CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: legacyPath,
      CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1,
    },
  });
  return { dir, filePath, legacyPath, runtime };
};

const tunnel = (id, hostname, token) => ({ id, name: `Tunnel ${id}`, hostname, token, updatedAt: 1000 });

const preservedFiles = (dir) => fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('managed tunnel config runtime', () => {
  it('upserts and resolves tokens, writing a 0600 file with no temp left behind', async () => {
    const { dir, filePath, runtime } = await makeRuntime();
    await runtime.upsertManagedRemoteTunnelToken({ id: 'a', name: 'Tunnel a', hostname: 'a.example.com', token: 'token-a' });
    await runtime.upsertManagedRemoteTunnelToken({ id: 'b', name: 'Tunnel b', hostname: 'b.example.com', token: 'token-b' });

    expect(await runtime.resolveManagedRemoteTunnelToken({ presetId: 'a', hostname: '' })).toBe('token-a');
    expect(await runtime.resolveManagedRemoteTunnelToken({ presetId: '', hostname: 'b.example.com' })).toBe('token-b');
    const config = await runtime.readManagedRemoteTunnelConfigFromDisk();
    expect(config.tunnels.map((entry) => entry.id)).toEqual(['a', 'b']);
    if (process.platform !== 'win32') {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('keeps preset-sync semantics: renames known tunnels, drops unknown presets', async () => {
    const { runtime } = await makeRuntime();
    await runtime.upsertManagedRemoteTunnelToken({ id: 'a', name: 'Old name', hostname: 'a.example.com', token: 'token-a' });
    await runtime.syncManagedRemoteTunnelConfigWithPresets([
      { id: 'a', name: 'New name', hostname: 'a.example.com' },
      { id: 'ghost', name: 'Ghost', hostname: 'ghost.example.com' },
    ]);
    const config = await runtime.readManagedRemoteTunnelConfigFromDisk();
    expect(config.tunnels).toHaveLength(1);
    expect(config.tunnels[0]).toMatchObject({ id: 'a', name: 'New name', token: 'token-a' });
  });

  it('preserves a corrupt config instead of silently discarding every tunnel token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { dir, filePath, runtime } = await makeRuntime();
    const corrupt = JSON.stringify({ version: 1, tunnels: [tunnel('a', 'a.example.com', 'token-a'), tunnel('b', 'b.example.com', 'token-b')] }).slice(0, 40);
    await fsPromises.writeFile(filePath, corrupt);

    expect((await runtime.readManagedRemoteTunnelConfigFromDisk()).tunnels).toEqual([]);
    const preserved = preservedFiles(dir);
    expect(preserved).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, preserved[0]), 'utf8')).toBe(corrupt);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(preserved[0]), expect.anything());

    // The next upsert lands in a fresh file; the corrupt bytes stay preserved.
    await runtime.upsertManagedRemoteTunnelToken({ id: 'c', name: 'Tunnel c', hostname: 'c.example.com', token: 'token-c' });
    expect((await runtime.readManagedRemoteTunnelConfigFromDisk()).tunnels.map((entry) => entry.id)).toEqual(['c']);
    expect(fs.readFileSync(path.join(dir, preserved[0]), 'utf8')).toBe(corrupt);
  });

  it('does not preserve a file another process replaced with valid state after the corrupt read', async () => {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openchamber-managed-tunnels-'));
    temporaryDirectories.push(dir);
    const filePath = path.join(dir, 'cloudflare-managed-remote-tunnels.json');
    const corrupt = '{"version":1,"tunnels":[{"id":"a","name":"Tunnel a","hos';
    await fsPromises.writeFile(filePath, corrupt);
    const validRaw = JSON.stringify({ version: 1, tunnels: [tunnel('b', 'b.example.com', 'token-b')] }, null, 2);
    // The other process lands its save in the window between this process
    // validating the corrupt bytes and preserving them: the primitive's
    // preservation candidate-name check (an access call on the
    // .corrupt- candidate) is the last step before the re-read/rename.
    let swapped = false;
    const racingFs = {
      ...fsPromises,
      access: async (...args) => {
        if (!swapped && String(args[0]).includes('.corrupt-')) {
          swapped = true;
          await fsPromises.writeFile(filePath, validRaw);
        }
        return fsPromises.access(...args);
      },
    };
    const { runtime } = await makeRuntime({ dir, fsPromises: racingFs });
    const config = await runtime.readManagedRemoteTunnelConfigFromDisk();
    expect(swapped).toBe(true);
    expect(config.tunnels.map((entry) => entry.id)).toEqual(['b']);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(validRaw);
    expect(preservedFiles(dir)).toEqual([]);
    expect(await runtime.resolveManagedRemoteTunnelToken({ presetId: 'b', hostname: '' })).toBe('token-b');
  });

  it('preserves a corrupt config before an upsert overwrites it, without a prior read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { dir, filePath, runtime } = await makeRuntime();
    const corrupt = '{"version":1,"tunnels":[{"id":"a","name":"Tunnel a","hos';
    await fsPromises.writeFile(filePath, corrupt);

    await runtime.upsertManagedRemoteTunnelToken({ id: 'c', name: 'Tunnel c', hostname: 'c.example.com', token: 'token-c' });
    const preserved = preservedFiles(dir);
    expect(preserved).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, preserved[0]), 'utf8')).toBe(corrupt);
    expect((await runtime.readManagedRemoteTunnelConfigFromDisk()).tunnels.map((entry) => entry.id)).toEqual(['c']);
  });

  it('preserves a config file that parses but is not a config object', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { dir, filePath, runtime } = await makeRuntime();
    await fsPromises.writeFile(filePath, 'null');
    expect((await runtime.readManagedRemoteTunnelConfigFromDisk()).tunnels).toEqual([]);
    expect(preservedFiles(dir)).toHaveLength(1);
  });

  it('leaves the previous valid file intact when the atomic rename fails', async () => {
    const seeded = await makeRuntime();
    await seeded.runtime.upsertManagedRemoteTunnelToken({ id: 'a', name: 'Tunnel a', hostname: 'a.example.com', token: 'token-a' });
    const before = fs.readFileSync(seeded.filePath, 'utf8');

    const failingFs = {
      ...fsPromises,
      rename: async () => {
        const error = new Error('simulated rename failure');
        error.code = 'EIO';
        throw error;
      },
    };
    const failing = await makeRuntime({ fsPromises: failingFs, dir: seeded.dir });
    await expect(
      failing.runtime.upsertManagedRemoteTunnelToken({ id: 'b', name: 'Tunnel b', hostname: 'b.example.com', token: 'token-b' }),
    ).rejects.toThrow('simulated rename failure');
    expect(fs.readFileSync(seeded.filePath, 'utf8')).toBe(before);
    expect(fs.readdirSync(seeded.dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('migrates a legacy named-tunnels file when the managed file is missing', async () => {
    const { filePath, legacyPath, runtime } = await makeRuntime();
    await fsPromises.writeFile(
      legacyPath,
      JSON.stringify({ tunnels: [tunnel('legacy', 'legacy.example.com', 'token-legacy')] }),
    );
    const config = await runtime.readManagedRemoteTunnelConfigFromDisk();
    expect(config.tunnels.map((entry) => entry.id)).toEqual(['legacy']);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).tunnels.map((entry) => entry.id)).toEqual(['legacy']);
  });

  it('returns an empty config for a missing file with no legacy file and writes nothing', async () => {
    const { dir, runtime } = await makeRuntime();
    expect(await runtime.readManagedRemoteTunnelConfigFromDisk()).toEqual({ version: 1, tunnels: [] });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  it('treats an empty config file as missing: reads empty, preserves nothing', async () => {
    const { dir, filePath, runtime } = await makeRuntime();
    await fsPromises.writeFile(filePath, '');
    expect(await runtime.readManagedRemoteTunnelConfigFromDisk()).toEqual({ version: 1, tunnels: [] });
    expect(preservedFiles(dir)).toEqual([]);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('');
  });

  it('migrates the legacy file when the managed file is empty', async () => {
    const { filePath, legacyPath, runtime } = await makeRuntime();
    await fsPromises.writeFile(filePath, '');
    await fsPromises.writeFile(
      legacyPath,
      JSON.stringify({ tunnels: [tunnel('legacy', 'legacy.example.com', 'token-legacy')] }),
    );
    const config = await runtime.readManagedRemoteTunnelConfigFromDisk();
    expect(config.tunnels.map((entry) => entry.id)).toEqual(['legacy']);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).tunnels.map((entry) => entry.id)).toEqual(['legacy']);
  });

  it('migrates legacy tunnels on a read when the corrupt file vanishes before preservation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seeded = await makeRuntime();
    await fsPromises.writeFile(
      seeded.legacyPath,
      JSON.stringify({ tunnels: [tunnel('legacy', 'legacy.example.com', 'token-legacy')] }),
    );
    const corrupt = '{"version":1,"tunnels":[{"id":"x"';
    let reads = 0;
    const vanishingFs = {
      ...fsPromises,
      readFile: async (...args) => {
        if (String(args[0]).endsWith('cloudflare-managed-remote-tunnels.json')) {
          reads += 1;
          if (reads <= 2) return corrupt;
          const error = new Error('simulated vanish');
          error.code = 'ENOENT';
          throw error;
        }
        return fsPromises.readFile(...args);
      },
    };
    const { runtime } = await makeRuntime({ fsPromises: vanishingFs, dir: seeded.dir });
    const config = await runtime.readManagedRemoteTunnelConfigFromDisk();
    expect(config.tunnels.map((entry) => entry.id)).toEqual(['legacy']);
  });

  it('migrates legacy tunnels in the locked migration when the corrupt file vanishes before preservation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seeded = await makeRuntime();
    await fsPromises.writeFile(
      seeded.legacyPath,
      JSON.stringify({ tunnels: [tunnel('legacy', 'legacy.example.com', 'token-legacy')] }),
    );
    const corrupt = '{"version":1,"tunnels":[{"id":"x"';
    let reads = 0;
    const vanishingFs = {
      ...fsPromises,
      readFile: async (...args) => {
        if (String(args[0]).endsWith('cloudflare-managed-remote-tunnels.json')) {
          reads += 1;
          if (reads === 2) return corrupt;
          const error = new Error('simulated vanish');
          error.code = 'ENOENT';
          throw error;
        }
        return fsPromises.readFile(...args);
      },
    };
    const { runtime } = await makeRuntime({ fsPromises: vanishingFs, dir: seeded.dir });
    const config = await runtime.readManagedRemoteTunnelConfigFromDisk();
    expect(config.tunnels.map((entry) => entry.id)).toEqual(['legacy']);
  });

  it('upserts onto the migrated legacy config when the corrupt file vanishes before preservation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seeded = await makeRuntime();
    await fsPromises.writeFile(
      seeded.legacyPath,
      JSON.stringify({ tunnels: [tunnel('legacy', 'legacy.example.com', 'token-legacy')] }),
    );
    const corrupt = '{"version":1,"tunnels":[{"id":"x"';
    let reads = 0;
    const vanishingFs = {
      ...fsPromises,
      readFile: async (...args) => {
        if (String(args[0]).endsWith('cloudflare-managed-remote-tunnels.json')) {
          reads += 1;
          if (reads === 1) return corrupt;
          const error = new Error('simulated vanish');
          error.code = 'ENOENT';
          throw error;
        }
        return fsPromises.readFile(...args);
      },
    };
    const { runtime } = await makeRuntime({ fsPromises: vanishingFs, dir: seeded.dir });
    await runtime.upsertManagedRemoteTunnelToken({ id: 'new', name: 'Tunnel new', hostname: 'new.example.com', token: 'token-new' });
    const written = JSON.parse(fs.readFileSync(seeded.filePath, 'utf8'));
    expect(written.tunnels.map((entry) => entry.id)).toEqual(['legacy', 'new']);
  });

  it('refuses an upsert when preservation fails and the live file is gone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seeded = await makeRuntime();
    const corrupt = '{"version":1,"tunnels":[{"id":"x"';
    let reads = 0;
    const failingFs = {
      ...fsPromises,
      readFile: async (...args) => {
        if (String(args[0]).endsWith('cloudflare-managed-remote-tunnels.json')) {
          reads += 1;
          if (reads <= 2) return corrupt;
          const error = new Error('simulated vanish');
          error.code = 'ENOENT';
          throw error;
        }
        return fsPromises.readFile(...args);
      },
      access: async (...args) => {
        if (String(args[0]).includes('.corrupt-')) {
          const error = new Error('simulated preserve failure');
          error.code = 'EIO';
          throw error;
        }
        return fsPromises.access(...args);
      },
    };
    const { runtime } = await makeRuntime({ fsPromises: failingFs, dir: seeded.dir });
    await expect(
      runtime.upsertManagedRemoteTunnelToken({ id: 'new', name: 'Tunnel new', hostname: 'new.example.com', token: 'token-new' }),
    ).rejects.toThrow('Refusing to overwrite');
    expect(fs.existsSync(seeded.filePath)).toBe(false);
  });

  it('refuses an update when the existing config cannot be read (non-ENOENT)', async () => {
    const seeded = await makeRuntime();
    await seeded.runtime.upsertManagedRemoteTunnelToken({ id: 'a', name: 'Tunnel a', hostname: 'a.example.com', token: 'token-a' });
    const before = fs.readFileSync(seeded.filePath, 'utf8');
    const failingFs = {
      ...fsPromises,
      readFile: async (...args) => {
        if (String(args[0]).endsWith('cloudflare-managed-remote-tunnels.json')) {
          const error = new Error('simulated read failure');
          error.code = 'EIO';
          throw error;
        }
        return fsPromises.readFile(...args);
      },
    };
    const failing = await makeRuntime({ fsPromises: failingFs, dir: seeded.dir });
    await expect(
      failing.runtime.upsertManagedRemoteTunnelToken({ id: 'b', name: 'Tunnel b', hostname: 'b.example.com', token: 'token-b' }),
    ).rejects.toThrow('Refusing to overwrite');
    expect(fs.readFileSync(seeded.filePath, 'utf8')).toBe(before);
  });

  it('does not let a concurrent ENOENT read migrate legacy data over an in-flight upsert', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let releaseTempWrite;
    let markTempWriteStarted;
    const tempWriteGate = new Promise((resolve) => { releaseTempWrite = resolve; });
    const tempWriteStarted = new Promise((resolve) => { markTempWriteStarted = resolve; });
    let releaseLegacyRead;
    const legacyReadGate = new Promise((resolve) => { releaseLegacyRead = resolve; });
    let tempGateUsed = false;
    const gatedFs = {
      ...fsPromises,
      writeFile: async (...args) => {
        if (!tempGateUsed && String(args[0]).includes('.tmp-')) {
          tempGateUsed = true;
          markTempWriteStarted();
          await tempWriteGate;
        }
        return fsPromises.writeFile(...args);
      },
      readFile: async (...args) => {
        if (String(args[0]).endsWith('cloudflare-named-tunnels.json')) {
          await legacyReadGate;
        }
        return fsPromises.readFile(...args);
      },
    };
    const { filePath, legacyPath, runtime } = await makeRuntime({ fsPromises: gatedFs });
    await fsPromises.writeFile(legacyPath, JSON.stringify({ tunnels: [tunnel('legacy', 'legacy.example.com', 'token-legacy')] }));
    await fsPromises.writeFile(filePath, '{"version":1,"tunnels":[{"id":"a","name":"Tunnel a","hos');

    const upsertPromise = runtime.upsertManagedRemoteTunnelToken({ id: 'c', name: 'Tunnel c', hostname: 'c.example.com', token: 'token-c' });
    // The upsert now holds the persist lock in the window after the corrupt
    // file was preserved aside and before its temp write lands: the managed
    // path is absent, so a concurrent read observes ENOENT here.
    await tempWriteStarted;
    const readPromise = runtime.readManagedRemoteTunnelConfigFromDisk();
    // Let the read's continuation run: on the broken code it entered the
    // unlocked legacy migration (its legacy read is gated above); with the
    // fix it queues behind the persist lock instead.
    for (let i = 0; i < 50; i += 1) {
      await Promise.resolve();
    }
    releaseTempWrite();
    await upsertPromise;
    releaseLegacyRead();
    const config = await readPromise;
    expect(config.tunnels.map((entry) => entry.id)).toEqual(['c']);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).tunnels.map((entry) => entry.id)).toEqual(['c']);
  });

  it('pins the legacy migration cap to the managed store bound (#1692)', () => {
    expect(LEGACY_NAMED_TUNNELS_MAX_BYTES).toBe(DEFAULT_DURABLE_JSON_MAX_BYTES);
  });

  it('degrades to an empty config for an over-cap legacy file and writes nothing (#1692)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { filePath, legacyPath, runtime } = await makeRuntime();
    const header = '{"tunnels":[{"id":"big","name":"Tunnel big","hostname":"big.example.com","token":"';
    const footer = '","updatedAt":1000}]}';
    await fsPromises.writeFile(legacyPath, header + 'x'.repeat(LEGACY_NAMED_TUNNELS_MAX_BYTES) + footer);
    expect(fs.statSync(legacyPath).size).toBeGreaterThan(LEGACY_NAMED_TUNNELS_MAX_BYTES);

    const config = await runtime.readManagedRemoteTunnelConfigFromDisk();
    expect(config.tunnels).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(warn).toHaveBeenCalled();
    // The refusal settles promptly and the persist lock stays usable:
    // a later read takes the same degraded answer instead of hanging.
    const again = await runtime.readManagedRemoteTunnelConfigFromDisk();
    expect(again.tunnels).toEqual([]);
  }, 30_000);

  it('refuses a FIFO at the legacy path promptly and leaves the persist lock usable (#1692)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { filePath, legacyPath, runtime } = await makeRuntime();
    execFileSync('mkfifo', [legacyPath]);

    const settled = await Promise.race([
      runtime.readManagedRemoteTunnelConfigFromDisk(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('legacy FIFO read did not settle within 4s')), 4_000);
      }),
    ]);
    expect(settled.tunnels).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false);

    // The lock is not wedged: with a real legacy file in place, the
    // next read migrates it normally.
    fs.rmSync(legacyPath, { force: true });
    await fsPromises.writeFile(
      legacyPath,
      JSON.stringify({ tunnels: [tunnel('legacy', 'legacy.example.com', 'token-legacy')] }),
    );
    const config = await runtime.readManagedRemoteTunnelConfigFromDisk();
    expect(config.tunnels.map((entry) => entry.id)).toEqual(['legacy']);
  }, 30_000);
});

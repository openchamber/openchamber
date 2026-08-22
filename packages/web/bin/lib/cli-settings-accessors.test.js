import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import { createSettingsAccessors } from './cli-settings-accessors.js';
import { createRelayIdentityRuntime } from '../../server/lib/relay/identity.js';

const withTempDir = async (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-settings-accessors-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const makeAccessors = (dir, overrides = {}) =>
  createSettingsAccessors({
    fsPromises: fs.promises,
    path,
    dataDir: dir,
    settingsFileName: 'settings.json',
    ...overrides,
  });

// Wraps writeFile so each write lands in two chunks with a pause in between —
// a stand-in for a large, slow write on a real disk (one open handle, so the
// file grows from the prefix to the full payload). With a non-atomic writer a
// concurrent reader deterministically catches the half-written file in that
// window; with the atomic tmp+rename writer the target only ever changes via a
// complete rename, so the window is never observable.
const makeSlowWriteFs = () => {
  const realFs = fs.promises;
  const slowWriteFile = async (filePath, data) => {
    const handle = await realFs.open(filePath, 'w');
    try {
      const half = Math.floor(data.length / 2);
      await handle.writeFile(data.slice(0, half), 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 30));
      await handle.writeFile(data.slice(half), 'utf8');
    } finally {
      await handle.close();
    }
  };
  return { slowWriteFile, fsPromises: { ...realFs, writeFile: slowWriteFile } };
};

// Runs `writer` against filePath while a concurrent reader hammers it; returns
// how many times the reader observed an unparseable (torn) payload. ENOENT
// during the very first write is not a tear and is excluded.
const countTornReads = async (filePath, writer, iterations) => {
  const big = { theme: 'dark', filler: 'x'.repeat(4096) };
  let torn = 0;
  let stop = false;
  const reader = (async () => {
    while (!stop) {
      try {
        const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          expect(parsed.theme).toBe('dark');
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          torn += 1;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  })();
  for (let i = 0; i < iterations; i += 1) {
    await writer({ ...big, n: i });
  }
  stop = true;
  await reader;
  return torn;
};

describe('cli settings accessors', () => {
  it('persists the full object atomically and cleans up its tmp file', async () => {
    await withTempDir(async (dir) => {
      const accessors = makeAccessors(dir);
      await accessors.writeSettingsToDisk({ theme: 'dark', count: 3 });

      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
      expect(raw).toEqual({ theme: 'dark', count: 3 });

      const leftovers = fs.readdirSync(dir).filter((name) => name.startsWith('settings.json.tmp-'));
      expect(leftovers).toEqual([]);
    });
  });

  it('atomic writes: concurrent readers never observe a torn file, even under slow writes', async () => {
    await withTempDir(async (dir) => {
      const { fsPromises } = makeSlowWriteFs();
      const accessors = makeAccessors(dir, { fsPromises });
      const filePath = path.join(dir, 'settings.json');

      // Each write is chunked with a pause, yet the reader must never see a
      // partial payload: the target only changes via a complete atomic rename.
      const torn = await countTornReads(filePath, (settings) => accessors.writeSettingsToDisk(settings), 20);
      expect(torn).toBe(0);

      const leftovers = fs.readdirSync(dir).filter((name) => name.startsWith('settings.json.tmp-'));
      expect(leftovers).toEqual([]);
    });
  });

  it('demonstrates the protected failure mode: a naive direct writer tears under the same slow write', async () => {
    await withTempDir(async (dir) => {
      const { slowWriteFile } = makeSlowWriteFs();
      const filePath = path.join(dir, 'settings.json');

      // The old CLI accessor wrote straight to settings.json with writeFile.
      // The same slow-write load therefore MUST produce torn reads — proving
      // the concurrency test above can actually fail on the pre-fix writer.
      const torn = await countTornReads(
        filePath,
        (settings) => slowWriteFile(filePath, JSON.stringify(settings)),
        20,
      );
      expect(torn).toBeGreaterThan(0);
    });
  });

  it('lenient read maps a corrupt file to {} for config lookup', async () => {
    await withTempDir(async (dir) => {
      const accessors = makeAccessors(dir);
      fs.writeFileSync(path.join(dir, 'settings.json'), '{"unfinished": "trunc');
      expect(await accessors.readSettingsFromDiskMigrated()).toEqual({});
    });
  });

  it('strict read throws on a corrupt file instead of reporting "no settings"', async () => {
    await withTempDir(async (dir) => {
      const accessors = makeAccessors(dir);
      fs.writeFileSync(path.join(dir, 'settings.json'), '{"unfinished": "trunc');
      await expect(accessors.readSettingsStrict()).rejects.toThrow();
    });
  });

  it('strict read throws on a non-object payload', async () => {
    await withTempDir(async (dir) => {
      const accessors = makeAccessors(dir);
      fs.writeFileSync(path.join(dir, 'settings.json'), '"just a string"');
      await expect(accessors.readSettingsStrict()).rejects.toThrow(/non-object payload/);
    });
  });

  it('strict read treats only a genuinely missing file as no settings', async () => {
    await withTempDir(async (dir) => {
      const accessors = makeAccessors(dir);
      expect(await accessors.readSettingsStrict()).toEqual({});
    });
  });

  it('does not regenerate the relay identity off a corrupt settings file', async () => {
    await withTempDir(async (dir) => {
      const accessors = makeAccessors(dir);
      fs.writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({
          relaySigningKey: {
            privateJwk: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }),
            publicJwk: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }),
          },
        }),
      );
      const identity = await createRelayIdentityRuntime({ crypto, ...accessors }).getRelayIdentity();
      const serverIdBefore = identity.serverId;

      // Corrupt the file, then ask for the identity again: the strict gate must
      // make this FAIL rather than mint a replacement keypair.
      fs.writeFileSync(path.join(dir, 'settings.json'), '{"relaySigningKey": {"unfinished');
      await expect(createRelayIdentityRuntime({ crypto, ...accessors }).getRelayIdentity()).rejects.toThrow();
      expect(serverIdBefore).toBeTruthy();
    });
  });
});

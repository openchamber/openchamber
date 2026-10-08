import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createRelayKeyStore } from './key-store.js';

const makePair = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateJwk: privateKey.export({ format: 'jwk' }), publicJwk: publicKey.export({ format: 'jwk' }) };
};

let dataDir;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-relay-keys-'));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const identityPath = () => path.join(dataDir, 'relay-identity.json');
const settingsPath = () => path.join(dataDir, 'settings.json');
const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const writeJson = (filePath, value) => fs.writeFileSync(filePath, JSON.stringify(value));

// Settings accessors over a real settings.json, strict like the app's.
const makeStore = ({ writeSettingsToDisk } = {}) => {
  const readSettingsStrict = async () => {
    try {
      return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  };
  return createRelayKeyStore({
    fsPromises: fs.promises,
    path,
    dataDir,
    readSettingsFromDiskMigrated: async () => readSettingsStrict().catch(() => ({})),
    readSettingsStrict,
    writeSettingsToDisk: writeSettingsToDisk ?? (async (next) => writeJson(settingsPath(), next)),
    logger: { warn: () => {} },
  });
};

describe('relay key store', () => {
  it('mints a key on first run into its own owner-only file, not settings.json', async () => {
    writeJson(settingsPath(), { theme: 'dark' });
    const pair = makePair();
    let generations = 0;
    const stored = await makeStore().getOrCreate('signing', async () => {
      generations += 1;
      return pair;
    });

    expect(stored).toEqual(pair);
    expect(generations).toBe(1);
    expect(readJson(identityPath()).signingKey).toEqual(pair);
    expect(readJson(settingsPath())).toEqual({ theme: 'dark' });
    if (process.platform !== 'win32') {
      expect(fs.statSync(identityPath()).mode & 0o777).toBe(0o600);
    }
  });

  it('moves legacy keys out of settings.json unchanged and keeps the other settings', async () => {
    const signing = makePair();
    const encryption = makePair();
    writeJson(settingsPath(), { theme: 'dark', relaySigningKey: signing, relayEncryptionKey: encryption });
    const store = makeStore();
    const mint = async () => {
      throw new Error('must not mint a key that settings.json already holds');
    };

    expect(await store.getOrCreate('signing', mint)).toEqual(signing);
    expect(await store.getOrCreate('encryption', mint)).toEqual(encryption);

    expect(readJson(identityPath())).toEqual({ signingKey: signing, encryptionKey: encryption });
    expect(readJson(settingsPath())).toEqual({ theme: 'dark' });
  });

  it('strips from settings.json only the keys the identity file already holds', async () => {
    writeJson(settingsPath(), { relaySigningKey: makePair(), relayEncryptionKey: makePair() });
    await makeStore().getOrCreate('signing', async () => makePair());

    const settings = readJson(settingsPath());
    expect(settings.relaySigningKey).toBeUndefined();
    expect(settings.relayEncryptionKey).toBeDefined();
  });

  it('keeps the identity file authoritative over a key an older build put back into settings.json', async () => {
    const current = makePair();
    writeJson(identityPath(), { signingKey: current });
    writeJson(settingsPath(), { relaySigningKey: makePair() });

    expect(await makeStore().getOrCreate('signing', async () => makePair())).toEqual(current);
    expect(readJson(settingsPath()).relaySigningKey).toBeUndefined();
  });

  it('mints one key when two callers ask at the same time', async () => {
    const store = makeStore();
    let generations = 0;
    const mint = async () => {
      generations += 1;
      return makePair();
    };
    const [first, second] = await Promise.all([store.getOrCreate('signing', mint), store.getOrCreate('signing', mint)]);

    expect(generations).toBe(1);
    expect(second).toEqual(first);
  });

  it('refuses to mint over a corrupt identity file', async () => {
    fs.writeFileSync(identityPath(), '{"signingKey": {"unfinished');
    await expect(makeStore().getOrCreate('signing', async () => makePair())).rejects.toThrow(/corrupt/);
    expect(fs.readFileSync(identityPath(), 'utf8')).toBe('{"signingKey": {"unfinished');
  });

  it('refuses to mint while a corrupt settings.json may still hold the legacy key', async () => {
    fs.writeFileSync(settingsPath(), '{"relaySigningKey": {"unfinished');
    await expect(makeStore().getOrCreate('signing', async () => makePair())).rejects.toThrow();
    expect(fs.existsSync(identityPath())).toBe(false);
  });

  it('still returns the key when stripping settings.json fails', async () => {
    const signing = makePair();
    writeJson(settingsPath(), { relaySigningKey: signing });
    const store = makeStore({
      writeSettingsToDisk: async () => {
        throw new Error('disk full');
      },
    });

    expect(await store.getOrCreate('signing', async () => makePair())).toEqual(signing);
    expect(readJson(identityPath()).signingKey).toEqual(signing);
  });
});

// Host relay identity keys (the signing and encryption keypairs, private JWKs
// included) live in their own 0600 file, `<data-dir>/relay-identity.json`,
// not in settings.json, so the private keys do not travel with every copy of
// the settings file.
//
// Installs that predate the split keep the keys in settings.json as
// `relaySigningKey` / `relayEncryptionKey`. The first load moves them here
// unchanged, so serverId and the E2EE trust anchor stay the same, then strips
// them from settings.json. An older build sharing the data dir no longer finds
// them there and mints its own identity, which it warns about loudly.
//
// A key is minted only when neither file holds it. Both files are read
// strictly: a corrupt or unreadable file throws instead of reading as "first
// run", because a new key orphans every paired device and push binding.

import { z } from 'zod';

const SLOTS = Object.freeze({
  signing: { field: 'signingKey', legacySettingsKey: 'relaySigningKey' },
  encryption: { field: 'encryptionKey', legacySettingsKey: 'relayEncryptionKey' },
});

const jwkSchema = z.looseObject({ kty: z.string().min(1) });
const jwkPairSchema = z.looseObject({ privateJwk: jwkSchema, publicJwk: jwkSchema });
// Unknown fields are kept so a newer build's additions survive our rewrites.
const storeSchema = z.looseObject({
  signingKey: jwkPairSchema.optional(),
  encryptionKey: jwkPairSchema.optional(),
});

/** @typedef {z.infer<typeof jwkPairSchema>} RelayJwkPair */
/** @typedef {'signing' | 'encryption'} RelayKeySlot */

const isJwkPair = (value) => jwkPairSchema.safeParse(value).success;

/**
 * @param {{
 *   fsPromises: typeof import('node:fs/promises'),
 *   path: typeof import('node:path'),
 *   dataDir: string,
 *   readSettingsFromDiskMigrated: () => Promise<object>,
 *   readSettingsStrict: () => Promise<object>,
 *   writeSettingsToDisk: (settings: object) => Promise<void>,
 *   logger?: Pick<Console, 'warn'>,
 * }} deps
 */
export const createRelayKeyStore = ({
  fsPromises,
  path,
  dataDir,
  readSettingsFromDiskMigrated,
  readSettingsStrict,
  writeSettingsToDisk,
  logger = console,
}) => {
  const filePath = path.join(dataDir, 'relay-identity.json');
  // The push relay and the private relay ask for the signing key at the same
  // boot; serialized, the second caller reads what the first one wrote
  // instead of minting a second key over it.
  let queue = Promise.resolve();
  const serialized = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  const readStore = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
    const corrupt = (cause) => new Error(`Relay identity file is corrupt: ${filePath} (fix or remove it, then retry)`, { cause });
    let json;
    try {
      json = JSON.parse(raw);
    } catch (cause) {
      throw corrupt(cause);
    }
    const parsed = storeSchema.safeParse(json);
    if (!parsed.success) throw corrupt(parsed.error);
    return parsed.data;
  };

  const writeStore = async (store) => {
    const directory = path.dirname(filePath);
    const created = await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    if (created && process.platform !== 'win32') await fsPromises.chmod(directory, 0o700);
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fsPromises.writeFile(tmp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
      if (process.platform !== 'win32') await fsPromises.chmod(tmp, 0o600);
      await fsPromises.rename(tmp, filePath);
    } catch (error) {
      await fsPromises.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  };

  // Drops from settings.json every legacy key this file already holds. Best
  // effort: the identity is valid without it, and the next load retries.
  const scrubLegacySettings = async (store) => {
    try {
      const raw = await readSettingsStrict();
      const stale = Object.values(SLOTS)
        .filter(({ field, legacySettingsKey }) => isJwkPair(store[field]) && Object.hasOwn(raw, legacySettingsKey))
        .map(({ legacySettingsKey }) => legacySettingsKey);
      if (stale.length === 0) return;
      const next = { ...(await readSettingsFromDiskMigrated()), ...raw };
      for (const key of stale) delete next[key];
      await writeSettingsToDisk(next);
    } catch (error) {
      logger.warn('[relay-identity] Could not remove the moved relay keys from settings.json:', error);
    }
  };

  /**
   * @param {RelayKeySlot} slot
   * @param {() => Promise<RelayJwkPair>} generate Mints a new keypair; called only when no file holds one.
   * @returns {Promise<RelayJwkPair>}
   */
  const getOrCreate = (slot, generate) => serialized(async () => {
    const { field, legacySettingsKey } = SLOTS[slot];
    let store = await readStore();
    if (!isJwkPair(store[field])) {
      const legacy = (await readSettingsStrict())[legacySettingsKey];
      // Another process may have moved or minted the key between the two reads.
      store = await readStore();
      if (!isJwkPair(store[field])) {
        store = { ...store, [field]: isJwkPair(legacy) ? legacy : await generate() };
        await writeStore(store);
      }
    }
    await scrubLegacySettings(store);
    return store[field];
  });

  return { getOrCreate };
};

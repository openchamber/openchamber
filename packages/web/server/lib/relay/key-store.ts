
import { z } from 'zod';

const SLOTS = Object.freeze({
  signing: { field: 'signingKey', legacySettingsKey: 'relaySigningKey' } as const,
  encryption: { field: 'encryptionKey', legacySettingsKey: 'relayEncryptionKey' } as const,
});

const jwkSchema = z.looseObject({ kty: z.string().min(1) });
const jwkPairSchema = z.looseObject({ privateJwk: jwkSchema, publicJwk: jwkSchema });
const storeSchema = z.looseObject({
  signingKey: jwkPairSchema.optional(),
  encryptionKey: jwkPairSchema.optional(),
});

export interface RelayPublicJwk {
  kty?: string | undefined;
  crv?: string | undefined;
  x?: string | undefined;
  y?: string | undefined;
}
export interface RelayJwkPair { privateJwk: JsonWebKey; publicJwk: RelayPublicJwk }
type RelayKeySlot = keyof typeof SLOTS;
type IdentityFile = z.infer<typeof storeSchema>;
type WritableIdentity = { [Field in 'signingKey' | 'encryptionKey']?: IdentityFile[Field] | RelayJwkPair };
const legacySettingsSchema = z.looseObject({ relaySigningKey: z.unknown().optional(), relayEncryptionKey: z.unknown().optional() });
export type RelayLegacySettings = z.infer<typeof legacySettingsSchema>;
type RelayLegacyKeyFields = Pick<RelayLegacySettings, typeof SLOTS[RelayKeySlot]['legacySettingsKey']>;
export interface RelaySettingsAccess<MigratedSettings = RelayLegacySettings> {
  readSettingsFromDiskMigrated: () => Promise<MigratedSettings>;
  readSettingsStrict: () => Promise<RelayLegacyKeyFields>;
  writeSettingsToDisk: (settings: RelayLegacySettings) => Promise<void>;
}

const isJwkPair = (value: unknown): value is z.infer<typeof jwkPairSchema> => jwkPairSchema.safeParse(value).success;
const hasErrorCode = (value: unknown): value is { code: unknown } => value !== null && typeof value === 'object' && 'code' in value;

interface RelayKeyStoreDependencies<MigratedSettings> extends RelaySettingsAccess<MigratedSettings> {
  fsPromises: typeof import('node:fs/promises');
  path: typeof import('node:path');
  dataDir: string;
  logger?: Pick<Console, 'warn'>;
}
export type RelayKeyStore = ReturnType<typeof createRelayKeyStore>;
export const createRelayKeyStore = <MigratedSettings>({
  fsPromises,
  path,
  dataDir,
  readSettingsFromDiskMigrated,
  readSettingsStrict,
  writeSettingsToDisk,
  logger = console,
}: RelayKeyStoreDependencies<MigratedSettings>) => {
  const filePath = path.join(dataDir, 'relay-identity.json');
  let queue = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>) => {
    const run = queue.then(task, task);
    queue = run.then(() => {}, () => {});
    return run;
  };

  const readStore = async (): Promise<IdentityFile> => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') return {};
      throw error;
    }
    const corrupt = (cause: unknown) => new Error(`Relay identity file is corrupt: ${filePath} (fix or remove it, then retry)`, { cause });
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (cause) {
      throw corrupt(cause);
    }
    const parsed = storeSchema.safeParse(json);
    if (!parsed.success) throw corrupt(parsed.error);
    return parsed.data;
  };

  const writeStore = async (store: WritableIdentity) => {
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

  const scrubLegacySettings = async (store: WritableIdentity) => {
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

  const getOrCreate = (slot: RelayKeySlot, generate: () => Promise<RelayJwkPair>): Promise<RelayJwkPair> => serialized(async () => {
    const { field, legacySettingsKey } = SLOTS[slot];
    let store: WritableIdentity = await readStore();
    if (!isJwkPair(store[field])) {
      const legacy = (await readSettingsStrict())[legacySettingsKey];
      store = await readStore();
      if (!isJwkPair(store[field])) {
        store = { ...store, [field]: isJwkPair(legacy) ? legacy : await generate() };
        await writeStore(store);
      }
    }
    await scrubLegacySettings(store);
    const pair = store[field];
    if (!pair) throw new Error('Relay identity key is missing');
    return pair;
  });

  let generation = 0;

  const reset = () => serialized(async () => {
    const { [SLOTS.signing.field]: _signing, [SLOTS.encryption.field]: _encryption, ...rest } = await readStore();
    await writeStore(rest);
    const raw = await readSettingsStrict();
    const legacyKeys = Object.values(SLOTS).map(({ legacySettingsKey }) => legacySettingsKey).filter((key) => Object.hasOwn(raw, key));
    if (legacyKeys.length > 0) {
      const next = { ...(await readSettingsFromDiskMigrated()), ...raw };
      for (const key of legacyKeys) delete next[key];
      await writeSettingsToDisk(next);
    }
    generation += 1;
  });

  return { getOrCreate, reset, generation: () => generation };
};

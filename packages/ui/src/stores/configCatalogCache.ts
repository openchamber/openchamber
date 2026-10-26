import { z } from 'zod';
import type { Agent, Model, Provider } from '@/lib/opencode/model';

/**
 * Last known provider/model and agent catalogs, per runtime and config
 * directory, so the model and agent pickers render at once on the next start
 * while OpenCode is still starting. The stored catalog is display continuity
 * only: the live load always revalidates it, and nothing destructive ever
 * reads it.
 *
 * IndexedDB rather than localStorage: VS Code gives every OpenChamber webview
 * one origin, and a localStorage write reaches every webview in every window
 * as a StorageEvent carrying the old and new value. IndexedDB fires none.
 *
 * Only what the pickers and the composer show is stored. Provider, model and
 * variant `settings`/`headers`/`body` and an agent's request carry API keys and
 * authorization headers, and an agent's system prompt is user content; none of
 * them is ever written. Records are built field by field from an allowlist and
 * read back through strict schemas, so a record holding anything else is
 * dropped.
 */

export type CachedProvider = Provider & { models: Model[] };

export type CachedCatalog = {
  providers?: CachedProvider[];
  defaultProviders?: Record<string, string>;
  agents?: Agent[];
};

const DATABASE = 'openchamber-config-catalog';
const DATABASE_VERSION = 1;
const STORE = 'catalogs';
const SAVED_AT_INDEX = 'savedAt';
/** Bump when the stored provider, model or agent shape changes; older records are dropped. */
export const CATALOG_CACHE_SCHEMA = 2;
/** Directories kept across all runtimes; the least recently saved go first. */
export const CATALOG_CACHE_MAX_RECORDS = 24;

const recordKey = (runtimeKey: string, directoryKey: string): string => `${runtimeKey}\n${directoryKey}`;

let databasePromise: Promise<IDBDatabase | null> | null = null;

const openDatabase = (): Promise<IDBDatabase | null> => {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase | null>((resolve) => {
    const factory = globalThis.indexedDB;
    if (!factory) {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DATABASE, DATABASE_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex(SAVED_AT_INDEX, 'savedAt');
    };
    request.onsuccess = () => resolve(request.result);
    // Private modes and locked-down webviews refuse IndexedDB; the cache is
    // then simply absent and the pickers wait for the live load as before.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return databasePromise;
};

const storedModelSchema = z.strictObject({
  id: z.string(),
  modelID: z.string(),
  providerID: z.string(),
  canonical: z.string().optional(),
  family: z.string().optional(),
  name: z.string(),
  compatibility: z.strictObject({
    reasoningField: z.string().optional(),
    requireReasoning: z.boolean().optional(),
  }).optional(),
  capabilities: z.strictObject({ tools: z.boolean(), input: z.array(z.string()), output: z.array(z.string()) }),
  variants: z.array(z.strictObject({ id: z.string() })),
  time: z.strictObject({ released: z.number() }),
  cost: z.array(z.strictObject({
    tier: z.strictObject({ type: z.literal('context'), size: z.number() }).optional(),
    input: z.number(),
    output: z.number(),
    cache: z.strictObject({ read: z.number(), write: z.number() }),
  })),
  status: z.enum(['alpha', 'beta', 'deprecated', 'active']),
  enabled: z.boolean(),
  limit: z.strictObject({ context: z.number(), input: z.number().optional(), output: z.number() }),
});

const storedProviderSchema = z.strictObject({
  id: z.string(),
  canonical: z.string().optional(),
  integrationID: z.string().optional(),
  name: z.string(),
  activation: z.enum(['auto', 'enabled', 'disabled']),
  package: z.string(),
  models: z.array(storedModelSchema),
});

/** An agent without its request and system prompt; only the sampling values the composer shows. */
const storedAgentSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  model: z.strictObject({ id: z.string(), providerID: z.string(), variant: z.string().optional() }).optional(),
  description: z.string().optional(),
  mode: z.enum(['subagent', 'primary', 'all']),
  hidden: z.boolean(),
  color: z.string().optional(),
  steps: z.number().optional(),
  permissions: z.array(z.strictObject({
    action: z.string(),
    resource: z.string(),
    effect: z.enum(['allow', 'deny', 'ask']),
  })),
  sampling: z.strictObject({ temperature: z.number().optional(), topP: z.number().optional() }),
});

const storedRecordSchema = z.strictObject({
  key: z.string(),
  schema: z.number(),
  runtimeKey: z.string(),
  directoryKey: z.string(),
  savedAt: z.number(),
  providers: z.array(storedProviderSchema).optional(),
  defaultProviders: z.record(z.string(), z.string()).optional(),
  agents: z.array(storedAgentSchema).optional(),
});

type StoredRecord = z.infer<typeof storedRecordSchema>;
type StoredProvider = z.infer<typeof storedProviderSchema>;
type StoredModel = z.infer<typeof storedModelSchema>;
type StoredAgent = z.infer<typeof storedAgentSchema>;
type StoredCatalog = Pick<StoredRecord, 'providers' | 'defaultProviders' | 'agents'>;

const toStoredModel = (model: Model): StoredModel => ({
  id: model.id,
  modelID: model.modelID,
  providerID: model.providerID,
  canonical: model.canonical,
  family: model.family,
  name: model.name,
  compatibility: model.compatibility && {
    reasoningField: model.compatibility.reasoningField,
    requireReasoning: model.compatibility.requireReasoning,
  },
  capabilities: {
    tools: model.capabilities.tools,
    input: [...model.capabilities.input],
    output: [...model.capabilities.output],
  },
  variants: model.variants.map((variant) => ({ id: variant.id })),
  time: { released: model.time.released },
  cost: model.cost.map((entry) => ({
    tier: entry.tier && { type: entry.tier.type, size: entry.tier.size },
    input: entry.input,
    output: entry.output,
    cache: { read: entry.cache.read, write: entry.cache.write },
  })),
  status: model.status,
  enabled: model.enabled,
  limit: { context: model.limit.context, input: model.limit.input, output: model.limit.output },
});

const toStoredProvider = (provider: CachedProvider): StoredProvider => ({
  id: provider.id,
  canonical: provider.canonical,
  integrationID: provider.integrationID,
  name: provider.name,
  activation: provider.activation,
  package: provider.package,
  models: provider.models.map(toStoredModel),
});

// The request body is free-form JSON; a sampling value is kept only when it is a number.
const samplingValue = z.number();

const toStoredAgent = (agent: Agent): StoredAgent => ({
  id: agent.id,
  name: agent.name,
  displayName: agent.displayName,
  model: agent.model && { id: agent.model.id, providerID: agent.model.providerID, variant: agent.model.variant },
  description: agent.description,
  mode: agent.mode,
  hidden: agent.hidden,
  color: agent.color,
  steps: agent.steps,
  permissions: agent.permissions.map((rule) => ({ action: rule.action, resource: rule.resource, effect: rule.effect })),
  sampling: {
    temperature: samplingValue.safeParse(agent.request.body.temperature).data,
    topP: samplingValue.safeParse(agent.request.body.topP).data,
  },
});

/** The cached agent as the store holds agents: an empty request apart from its sampling values. */
const fromStoredAgent = ({ sampling, ...agent }: StoredAgent): Agent => ({
  ...agent,
  request: { settings: {}, headers: {}, body: { ...sampling } },
});

const toStoredCatalog = (catalog: CachedCatalog): StoredCatalog => {
  const stored: StoredCatalog = {};
  if (catalog.providers) stored.providers = catalog.providers.map(toStoredProvider);
  if (catalog.defaultProviders) stored.defaultProviders = { ...catalog.defaultProviders };
  if (catalog.agents) stored.agents = catalog.agents.map(toStoredAgent);
  return stored;
};

/**
 * A record is trusted only when it carries the current schema and the identity
 * it was asked for. Anything else is from another build or another place and
 * is dropped, never shown.
 */
const isRecordFor = (record: StoredRecord, runtimeKey: string, directoryKey: string): boolean =>
  record.schema === CATALOG_CACHE_SCHEMA && record.runtimeKey === runtimeKey && record.directoryKey === directoryKey;

const toCachedCatalog = (record: StoredRecord): CachedCatalog => {
  const catalog: CachedCatalog = {};
  if (record.providers) catalog.providers = record.providers;
  if (record.defaultProviders) catalog.defaultProviders = record.defaultProviders;
  if (record.agents) catalog.agents = record.agents.map(fromStoredAgent);
  return catalog;
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('Catalog cache request failed.'));
});

/** Reads one record, parsed at the IndexedDB boundary. */
const readStoredRecord = async (database: IDBDatabase, key: string): Promise<StoredRecord | 'missing' | 'corrupt'> => {
  const stored = await requestResult(database.transaction(STORE, 'readonly').objectStore(STORE).get(key));
  if (stored === undefined) return 'missing';
  const parsed = storedRecordSchema.safeParse(stored);
  return parsed.success ? parsed.data : 'corrupt';
};

/**
 * The cached catalog for a runtime and directory; null when there is none,
 * IndexedDB is unavailable, or the record is corrupt (corrupt records are
 * deleted).
 */
export const readCachedCatalog = async (runtimeKey: string, directoryKey: string): Promise<CachedCatalog | null> => {
  const database = await openDatabase();
  if (!database) return null;
  try {
    const key = recordKey(runtimeKey, directoryKey);
    const stored = await readStoredRecord(database, key);
    if (stored === 'missing') return null;
    if (stored === 'corrupt' || !isRecordFor(stored, runtimeKey, directoryKey)) {
      void requestResult(database.transaction(STORE, 'readwrite').objectStore(STORE).delete(key)).catch(() => undefined);
      return null;
    }
    return toCachedCatalog(stored);
  } catch {
    return null;
  }
};

// Writes for one record are serialized, so a provider write and an agent write
// landing together cannot drop each other's half of the record.
let writeChain: Promise<void> = Promise.resolve();

/**
 * Stores the part of a catalog a live load just produced, keeping the other
 * part of the record. Callers write only authoritative, non-empty catalogs.
 */
export const writeCachedCatalog = (runtimeKey: string, directoryKey: string, update: CachedCatalog): Promise<void> => {
  writeChain = writeChain.then(async () => {
    const database = await openDatabase();
    if (!database) return;
    const key = recordKey(runtimeKey, directoryKey);
    const stored = await readStoredRecord(database, key).catch(() => 'missing' as const);
    const previous: StoredCatalog = stored === 'missing' || stored === 'corrupt' || !isRecordFor(stored, runtimeKey, directoryKey)
      ? {}
      : { providers: stored.providers, defaultProviders: stored.defaultProviders, agents: stored.agents };
    const record: StoredRecord = {
      ...previous,
      ...toStoredCatalog(update),
      key,
      schema: CATALOG_CACHE_SCHEMA,
      runtimeKey,
      directoryKey,
      savedAt: Date.now(),
    };
    await requestResult(database.transaction(STORE, 'readwrite').objectStore(STORE).put(record));
    await pruneCachedCatalogs(database);
  }).catch(() => undefined);
  return writeChain;
};

/**
 * How long a loaded catalog must go without a newer catalog event before it is
 * stored. OpenCode announces a starting location's full catalog about two
 * seconds after its first, partial answer.
 */
export const CATALOG_PERSIST_SETTLE_MS = 3_000;

/**
 * Stores a loaded catalog after the settle delay, unless `isSuperseded` says a
 * newer load replaces it by then (a catalog event, a runtime switch).
 */
export const writeCachedCatalogWhenSettled = (
  runtimeKey: string,
  directoryKey: string,
  update: CachedCatalog,
  isSuperseded: () => boolean,
  schedule: (callback: () => void, delayMs: number) => void = (callback, delayMs) => { setTimeout(callback, delayMs); },
): void => {
  schedule(() => {
    if (isSuperseded()) return;
    void writeCachedCatalog(runtimeKey, directoryKey, update);
  }, CATALOG_PERSIST_SETTLE_MS);
};

/** Deletes the least recently saved records beyond the limit, reading keys only. */
const pruneCachedCatalogs = (database: IDBDatabase): Promise<void> => new Promise((resolve, reject) => {
  const transaction = database.transaction(STORE, 'readwrite');
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error ?? new Error('Catalog cache prune failed.'));
  transaction.onabort = () => reject(transaction.error ?? new Error('Catalog cache prune aborted.'));
  const store = transaction.objectStore(STORE);
  const countRequest = store.count();
  countRequest.onsuccess = () => {
    let excess = countRequest.result - CATALOG_CACHE_MAX_RECORDS;
    if (excess <= 0) return;
    const cursorRequest = store.index(SAVED_AT_INDEX).openKeyCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || excess <= 0) return;
      store.delete(cursor.primaryKey);
      excess -= 1;
      cursor.continue();
    };
  };
});

/**
 * Whether a freshly loaded catalog may replace one shown from the cache on
 * its first load. A location OpenCode is still starting answers empty, then
 * partial (no plugin providers or agents), and complete about two seconds
 * later; a first answer with fewer entries than the cache is held back once
 * and re-read, and the re-read replaces the cache whatever it holds.
 */
export const shouldHoldFirstLoadAgainstCache = (cachedCount: number, loadedCount: number): boolean =>
  cachedCount > 0 && loadedCount < cachedCount;

export const resetCatalogCacheForTests = (): void => {
  databasePromise = null;
  writeChain = Promise.resolve();
};

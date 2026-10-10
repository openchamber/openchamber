import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Agent, Model } from '@/lib/opencode/model';
import {
  type CachedProvider,
  CATALOG_CACHE_MAX_RECORDS,
  CATALOG_PERSIST_SETTLE_MS,
  CATALOG_CACHE_SCHEMA,
  readCachedCatalog,
  resetCatalogCacheForTests,
  shouldHoldFirstLoadAgainstCache,
  writeCachedCatalog,
  writeCachedCatalogWhenSettled,
} from './configCatalogCache';

// A minimal in-memory IndexedDB covering what the cache uses: one object store
// keyed by `key`, get/put/delete/count, and a key cursor over `savedAt`.
// Seeded fields are loose on purpose: corrupt-record tests store shapes the
// cache must reject.
type SeedCatalog = {
  schema?: number;
  providers?: ReadonlyArray<{ id: string | number; name?: string; headers?: { [name: string]: string }; models?: ReadonlyArray<{ id: string; providerID: string; name?: string }> }>;
  defaultProviders?: { [providerID: string]: string };
  agents?: ReadonlyArray<{ name: string }>;
};
type StoredRecord = SeedCatalog & { key: string; savedAt?: number; runtimeKey?: string; directoryKey?: string };

class FakeRequest<T> {
  result: T | undefined = undefined;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class FakeOpenRequest<T> extends FakeRequest<T> {
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;
  private pending = 0;

  constructor(private readonly records: Map<string, StoredRecord>) {}

  objectStore() {
    const records = this.records;
    const respond = <T>(compute: () => T, request = new FakeRequest<T>(), then?: () => void) => {
      this.pending += 1;
      setTimeout(() => {
        request.result = compute();
        request.onsuccess?.();
        then?.();
        this.settle();
      }, 0);
      return request;
    };
    return {
      get: (key: string) => respond(() => (records.has(key) ? structuredClone(records.get(key)) : undefined)),
      put: (record: StoredRecord) => respond(() => { records.set(record.key, structuredClone(record)); return record.key; }),
      delete: (key: string) => respond(() => { records.delete(key); return undefined; }),
      count: () => respond(() => records.size),
      index: () => ({
        openKeyCursor: () => {
          const keys = [...records.values()]
            .filter((record) => record.savedAt !== undefined)
            .sort((left, right) => (left.savedAt ?? 0) - (right.savedAt ?? 0))
            .map((record) => record.key);
          const request = new FakeRequest<{ primaryKey: string; continue: () => void } | null>();
          let position = 0;
          const step = () => respond(() => (position < keys.length
            ? { primaryKey: keys[position], continue: () => { position += 1; step(); } }
            : null), request);
          step();
          return request;
        },
      }),
    };
  }

  private settle() {
    this.pending -= 1;
    setTimeout(() => { if (this.pending === 0) this.oncomplete?.(); }, 0);
  }
}

const installFakeIndexedDB = () => {
  const records = new Map<string, StoredRecord>();
  const database = {
    transaction: () => new FakeTransaction(records),
    createObjectStore: () => ({ createIndex: () => undefined }),
  };
  const factory = {
    open: () => {
      const request = new FakeOpenRequest<typeof database>();
      setTimeout(() => {
        request.result = database;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory });
  return records;
};

const indexedDBDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
let records: Map<string, StoredRecord>;

beforeEach(() => {
  resetCatalogCacheForTests();
  records = installFakeIndexedDB();
});

afterEach(() => {
  if (indexedDBDescriptor) Object.defineProperty(globalThis, 'indexedDB', indexedDBDescriptor);
  else Reflect.deleteProperty(globalThis, 'indexedDB');
});

// Records are seeded raw, the way an earlier session or build left them.
const seed = (runtimeKey: string, directoryKey: string, catalog: SeedCatalog) => {
  const key = `${runtimeKey}\n${directoryKey}`;
  records.set(key, { key, schema: CATALOG_CACHE_SCHEMA, runtimeKey, directoryKey, savedAt: 1, ...catalog });
};

const SECRET = 'sk-live-secret';

const bigPickle: Model = {
  id: 'big-pickle',
  modelID: 'big-pickle',
  providerID: 'zen',
  name: 'Big Pickle',
  compatibility: { reasoningField: 'reasoning_content', supportsPromptCacheKey: true },
  settings: { apiKey: SECRET },
  headers: { Authorization: `Bearer ${SECRET}` },
  body: { api_key: SECRET },
  capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
  variants: [{ id: 'high', headers: { 'x-api-key': SECRET }, settings: { apiKey: SECRET }, body: { key: SECRET } }],
  time: { released: 1 },
  cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
  status: 'active',
  enabled: true,
  limit: { context: 200_000, output: 32_000 },
};

const zen: CachedProvider = {
  id: 'zen',
  name: 'Zen',
  activation: 'auto',
  package: '@ai-sdk/openai-compatible',
  settings: { apiKey: SECRET, timeout: 1_000 },
  headers: { Authorization: `Bearer ${SECRET}` },
  body: { token: SECRET },
  models: [bigPickle],
};

const build: Agent = {
  id: 'build',
  name: 'build',
  displayName: 'Build',
  model: { id: 'big-pickle', providerID: 'zen' },
  request: {
    settings: { apiKey: SECRET },
    headers: { Authorization: `Bearer ${SECRET}` },
    body: { temperature: 0.2, topP: 0.9, api_key: SECRET },
  },
  system: `private prompt ${SECRET}`,
  mode: 'primary',
  hidden: false,
  permissions: [{ action: 'edit', resource: '*', effect: 'ask' }],
};

describe('configCatalogCache', () => {
  test('a directory with nothing cached reads as missing', async () => {
    expect(await readCachedCatalog('runtime-a', '/project')).toBeNull();
  });

  test('a written catalog reads back with what the pickers show', async () => {
    await writeCachedCatalog('runtime-a', '/project', { providers: [zen], defaultProviders: { zen: 'big-pickle' }, agents: [build] });
    const cached = await readCachedCatalog('runtime-a', '/project');
    expect(cached?.providers?.map((entry) => entry.id)).toEqual(['zen']);
    const model = cached?.providers?.[0]?.models[0];
    expect(model?.name).toBe('Big Pickle');
    expect(model?.variants.map((variant) => variant.id)).toEqual(['high']);
    expect(model?.compatibility?.reasoningField).toBe('reasoning_content');
    expect(model?.limit.context).toBe(200_000);
    expect(cached?.defaultProviders).toEqual({ zen: 'big-pickle' });
    const agent = cached?.agents?.[0];
    expect(agent?.name).toBe('build');
    expect(agent?.displayName).toBe('Build');
    expect(agent?.request.body).toEqual({ temperature: 0.2, topP: 0.9 });
    expect(agent?.permissions).toEqual([{ action: 'edit', resource: '*', effect: 'ask' }]);
  });

  test('credentials, headers, request bodies and system prompts are never stored', async () => {
    await writeCachedCatalog('runtime-a', '/project', { providers: [zen], agents: [build] });
    const stored = records.get('runtime-a\n/project');
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(SECRET);
    for (const key of ['settings', 'headers', 'body', 'request', 'system', 'apiKey', 'api_key', 'Authorization', 'supportsPromptCacheKey']) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });

  test('providers and agents written separately are kept together', async () => {
    await writeCachedCatalog('runtime-a', '/project', { providers: [zen], defaultProviders: { zen: 'big-pickle' } });
    await writeCachedCatalog('runtime-a', '/project', { agents: [build] });
    const cached = await readCachedCatalog('runtime-a', '/project');
    expect(cached?.providers?.map((entry) => entry.id)).toEqual(['zen']);
    expect(cached?.defaultProviders).toEqual({ zen: 'big-pickle' });
    expect(cached?.agents?.map((entry) => entry.name)).toEqual(['build']);
  });

  test('another runtime or directory never sees the record', async () => {
    await writeCachedCatalog('runtime-a', '/project', { agents: [build] });
    expect(await readCachedCatalog('runtime-b', '/project')).toBeNull();
    expect(await readCachedCatalog('runtime-a', '/other')).toBeNull();
  });

  test('a corrupt record is not shown and is deleted', async () => {
    seed('runtime-a', '/project', { providers: [{ id: 7 }] });
    expect(await readCachedCatalog('runtime-a', '/project')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(records.has('runtime-a\n/project')).toBe(false);
  });

  test('a record holding fields outside the allowlist is dropped', async () => {
    await writeCachedCatalog('runtime-a', '/project', { providers: [zen] });
    const stored = records.get('runtime-a\n/project');
    const provider = stored?.providers?.[0];
    if (!stored || !provider) throw new Error('expected a stored provider');
    records.set(stored.key, { ...stored, providers: [{ ...provider, headers: { Authorization: SECRET } }] });
    expect(await readCachedCatalog('runtime-a', '/project')).toBeNull();
  });

  test('a record from an earlier schema version is dropped', async () => {
    seed('runtime-a', '/project', { schema: CATALOG_CACHE_SCHEMA - 1, agents: [{ name: 'build' }] });
    expect(await readCachedCatalog('runtime-a', '/project')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(records.has('runtime-a\n/project')).toBe(false);
  });

  test('without IndexedDB the cache is absent and writes do nothing', async () => {
    Reflect.deleteProperty(globalThis, 'indexedDB');
    resetCatalogCacheForTests();
    await writeCachedCatalog('runtime-a', '/project', { defaultProviders: { zen: 'big-pickle' } });
    expect(await readCachedCatalog('runtime-a', '/project')).toBeNull();
  });

  test('only the most recently saved directories are kept', async () => {
    for (let index = 0; index < CATALOG_CACHE_MAX_RECORDS + 3; index += 1) {
      await writeCachedCatalog('runtime-a', `/project-${index}`, { defaultProviders: { zen: 'big-pickle' } });
      // Distinct save times, so the oldest are well defined.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(records.size).toBe(CATALOG_CACHE_MAX_RECORDS);
    expect(await readCachedCatalog('runtime-a', '/project-0')).toBeNull();
    expect(await readCachedCatalog('runtime-a', `/project-${CATALOG_CACHE_MAX_RECORDS + 2}`)).not.toBeNull();
  });
});

describe('writeCachedCatalogWhenSettled', () => {
  const manualSchedule = () => {
    const pending: Array<{ callback: () => void; delayMs: number }> = [];
    return {
      pending,
      schedule: (callback: () => void, delayMs: number) => { pending.push({ callback, delayMs }); },
    };
  };
  const settleWrites = () => new Promise((resolve) => setTimeout(resolve, 10));

  test('stores a catalog no catalog event superseded once the delay has passed', async () => {
    const { pending, schedule } = manualSchedule();
    writeCachedCatalogWhenSettled('runtime-a', '/project', { agents: [build] }, () => false, schedule);
    await settleWrites();
    expect(records.size).toBe(0);
    expect(pending[0]?.delayMs).toBe(CATALOG_PERSIST_SETTLE_MS);
    pending[0]?.callback();
    await settleWrites();
    expect((await readCachedCatalog('runtime-a', '/project'))?.agents?.map((agent) => agent.name)).toEqual(['build']);
  });

  test('never stores the partial first answer of a starting location', async () => {
    const { pending, schedule } = manualSchedule();
    let superseded = false;
    writeCachedCatalogWhenSettled('runtime-a', '/project', { providers: [zen] }, () => superseded, schedule);
    // OpenCode announces the full catalog before the delay ends.
    superseded = true;
    pending[0]?.callback();
    await settleWrites();
    expect(records.size).toBe(0);
  });
});

describe('shouldHoldFirstLoadAgainstCache', () => {
  test('an empty or partial first answer is held against a fuller cache', () => {
    expect(shouldHoldFirstLoadAgainstCache(12, 0)).toBe(true);
    expect(shouldHoldFirstLoadAgainstCache(12, 9)).toBe(true);
  });

  test('a first answer at least as full as the cache replaces it', () => {
    expect(shouldHoldFirstLoadAgainstCache(12, 12)).toBe(false);
    expect(shouldHoldFirstLoadAgainstCache(12, 15)).toBe(false);
  });

  test('nothing is held when the cache showed nothing', () => {
    expect(shouldHoldFirstLoadAgainstCache(0, 0)).toBe(false);
  });
});

import { describe, expect, mock, test } from 'bun:test';

let runtimeKey = 'local';
let getRuntimeKeyCalls = 0;

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => {
    getRuntimeKeyCalls += 1;
    return runtimeKey;
  },
}));

const {
  getRuntimeScopedStorageKey,
  readRuntimeScopedStorage,
  writeRuntimeScopedStorage,
} = await import('./runtimeScopedStorage');

const createStorage = () => {
  const values = new Map<string, string>();
  const getItemCalls: string[] = [];
  return {
    getItem: (key: string) => {
      getItemCalls.push(key);
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    getItemCalls,
  };
};

describe('runtimeScopedStorage', () => {
  test('isolates local and remote runtime values', () => {
    const storage = createStorage();
    const key = 'oc.sessions.expanded';
    const remoteRuntimeKey = 'url:https://remote.example';

    writeRuntimeScopedStorage(storage, key, 'local-value', 'local');
    writeRuntimeScopedStorage(storage, key, 'remote-value', remoteRuntimeKey);

    expect(readRuntimeScopedStorage(storage, key, 'local')).toBe('local-value');
    expect(readRuntimeScopedStorage(storage, key, remoteRuntimeKey)).toBe('remote-value');
    expect(getRuntimeScopedStorageKey(key, 'local')).toBe(`${key}:local`);
    expect(getRuntimeScopedStorageKey(key, remoteRuntimeKey)).toBe(`${key}:${encodeURIComponent(remoteRuntimeKey)}`);
  });

  test('uses getRuntimeKey when no runtime key is supplied', () => {
    const key = 'oc.sessions.expanded';
    runtimeKey = 'local';
    expect(getRuntimeScopedStorageKey(key)).toBe(`${key}:local`);

    runtimeKey = 'url:https://remote.example';
    expect(getRuntimeScopedStorageKey(key)).toBe(`${key}:${encodeURIComponent(runtimeKey)}`);
  });

  test('uses unscoped legacy storage only for the local runtime', () => {
    const storage = createStorage();
    const key = 'oc.sessions.expanded';
    storage.setItem(key, 'legacy-local-value');

    expect(readRuntimeScopedStorage(storage, key, 'local')).toBe('legacy-local-value');
    expect(readRuntimeScopedStorage(storage, key, 'url:https://remote.example')).toBeNull();
  });

  test('resolves null through getRuntimeKey and preserves local legacy storage', () => {
    const storage = createStorage();
    const key = 'oc.sessions.expanded';
    runtimeKey = 'local';
    getRuntimeKeyCalls = 0;
    storage.setItem(key, 'legacy-local-value');

    expect(readRuntimeScopedStorage(storage, key, null)).toBe('legacy-local-value');
    expect(getRuntimeKeyCalls).toBe(1);
    expect(storage.getItemCalls).toEqual([`${key}:local`, key]);
  });

  test('rejects blank explicit runtime keys before writing a shared bucket', () => {
    const storage = createStorage();
    const key = 'oc.sessions.expanded';

    expect(() => getRuntimeScopedStorageKey(key, '')).toThrow('Runtime storage key must be non-empty when explicitly provided');
    expect(() => writeRuntimeScopedStorage(storage, key, 'value', '   ')).toThrow('Runtime storage key must be non-empty when explicitly provided');
    expect(storage.getItem(`${key}:default`)).toBeNull();
  });

  test('rejects blank explicit read runtime keys before inspecting storage', () => {
    const storage = createStorage();
    const key = 'oc.sessions.expanded';

    expect(() => readRuntimeScopedStorage(storage, key, '')).toThrow('Runtime storage key must be non-empty when explicitly provided');
    expect(() => readRuntimeScopedStorage(storage, key, ' \t ')).toThrow('Runtime storage key must be non-empty when explicitly provided');
    expect(storage.getItemCalls).toEqual([]);
  });
});

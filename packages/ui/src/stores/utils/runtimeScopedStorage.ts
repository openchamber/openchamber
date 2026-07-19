import { getRuntimeKey } from '@/lib/runtime-switch';

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

const normalizeRuntimeStorageKey = (value?: string | null): string => {
  if (value === undefined || value === null) {
    return getRuntimeKey().trim() || 'default';
  }

  const key = value.trim();
  if (!key) {
    throw new Error('Runtime storage key must be non-empty when explicitly provided');
  }
  return key;
};

export const getRuntimeScopedStorageKey = (key: string, runtimeKey?: string | null): string => {
  return `${key}:${encodeURIComponent(normalizeRuntimeStorageKey(runtimeKey))}`;
};

export const readRuntimeScopedStorage = (
  storage: ReadableStorage,
  key: string,
  runtimeKey?: string | null,
): string | null => {
  const normalizedRuntimeKey = normalizeRuntimeStorageKey(runtimeKey);
  const scoped = storage.getItem(getRuntimeScopedStorageKey(key, normalizedRuntimeKey));
  if (scoped !== null) {
    return scoped;
  }

  return normalizedRuntimeKey === 'local' ? storage.getItem(key) : null;
};

export const writeRuntimeScopedStorage = (
  storage: WritableStorage,
  key: string,
  value: string,
  runtimeKey?: string | null,
): void => {
  storage.setItem(getRuntimeScopedStorageKey(key, runtimeKey), value);
};

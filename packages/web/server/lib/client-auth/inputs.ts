import type { StoreDependencies, StoredInput, StoreInput } from './contracts.js';

export const isString = (value: unknown): value is string => typeof value === 'string';

export const isStoredInput = (value: unknown): value is StoredInput =>
  value !== null && typeof value === 'object';

export const isStoreInput = (value: unknown): value is StoreInput =>
  value !== null && typeof value === 'object';

export const isInputArray = (value: unknown): value is unknown[] => Array.isArray(value);

export const isMissingFile = (value: unknown): value is { code: 'ENOENT' } =>
  value !== null && typeof value === 'object' && 'code' in value && value.code === 'ENOENT';

export const hasChmod = (value: StoreDependencies['fsPromises']): value is StoreDependencies['fsPromises'] & {
  chmod: NonNullable<StoreDependencies['fsPromises']['chmod']>;
} => typeof value.chmod === 'function';

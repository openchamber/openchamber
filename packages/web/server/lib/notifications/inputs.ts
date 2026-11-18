import type { JsonValue, SessionRecords } from './contracts.js';

export const isString = (value: unknown): value is string => typeof value === 'string';

export const isNumber = (value: unknown): value is number => typeof value === 'number';

export const isMissingFile = (value: unknown): value is { code: 'ENOENT' } =>
  value !== null && typeof value === 'object' && 'code' in value && value.code === 'ENOENT';

export const isJsonObject = (value: JsonValue | undefined): value is { [key: string]: JsonValue | undefined } =>
  value !== null && typeof value === 'object';

export const isSessionRecords = (value: JsonValue | undefined): value is SessionRecords => isJsonObject(value);

export const hasStatusCode = (value: unknown): value is { statusCode: number } =>
  value !== null && typeof value === 'object' && 'statusCode' in value && typeof value.statusCode === 'number';

export const hasErrorMessage = (value: unknown): value is { message?: unknown } =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

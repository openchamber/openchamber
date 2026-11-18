import type fs from 'node:fs';
import type path from 'node:path';
import type { JsonValue } from '@opencode/client';

export interface FileStoreOptions {
  dataDir: string;
  fsPromises?: typeof fs.promises;
  path?: typeof path;
  now?: () => number;
}

export const hasMessage = (value: unknown): value is { message?: unknown } =>
  value !== null && value !== undefined && 'message' in Object(value);

export const hasCode = (value: unknown): value is { code?: unknown } =>
  value !== null && value !== undefined && 'code' in Object(value);

export const hasTag = (value: unknown): value is { _tag?: unknown } =>
  value !== null && value !== undefined && '_tag' in Object(value);

export const isRecord = (value: JsonValue): value is Record<string, JsonValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

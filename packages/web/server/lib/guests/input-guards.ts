export const hasErrorCode = (value: unknown): value is { code: unknown } => value !== null
  && (typeof value === 'object' || typeof value === 'function')
  && 'code' in value;

export const isString = (value: unknown): value is string => typeof value === 'string';

export const hasErrorMessage = (value: unknown): value is { message: unknown } => value !== null
  && (typeof value === 'object' || typeof value === 'function')
  && 'message' in value;

export const hasErrorName = (value: unknown): value is { name: unknown } => value !== null
  && (typeof value === 'object' || typeof value === 'function')
  && 'name' in value;

export const hasStatusCode = (value: unknown): value is { statusCode: unknown } => value !== null
  && (typeof value === 'object' || typeof value === 'function')
  && 'statusCode' in value;
import type { JsonValue, JsonObject } from './contracts.js';

export const isJsonObject = (value: JsonValue | undefined): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);

export const isJsonContainer = (value: JsonValue | undefined): value is JsonObject | JsonValue[] => !!value && typeof value === 'object';

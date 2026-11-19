import type { JsonObject, JsonValue } from './contracts.js';

export const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const isString = (value: unknown): value is string => typeof value === 'string';
export const isJsonContainer = (value: JsonValue | undefined): value is JsonObject | JsonValue[] =>
  value !== null && typeof value === 'object';
export const isNumber = (value: unknown): value is number => typeof value === 'number';

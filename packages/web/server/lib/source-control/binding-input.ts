import { isPlainObject } from '../shared/guards.js';
import { isSourceControlString as isString } from './input-guards.js';
import type { SourceControlJson, SourceControlJsonObject } from '@openchamber/sdk';

export const bindingInputError = (message: string) => {
  const error = Object.assign(new Error(message), { code: 'INVALID_SOURCE_CONTROL_BINDING', status: 400 });
  return error;
};

export const requiredString = <Value>(value: Value, name: string, makeError = bindingInputError) => {
  if (!isString(value) || !value.trim()) throw makeError(`${name} is required`);
  return value.trim();
};

export const isOneOf = <Choice extends string>(choices: readonly Choice[], value: unknown): value is Choice => choices.some((choice) => choice === value);

export function assertRequiredString(value: unknown, name: string): asserts value is string {
  requiredString(value, name);
}

export function assertExactStrings<Fields extends object, Key extends keyof Fields & string>(fields: Fields, keys: readonly Key[]): asserts fields is Fields & { readonly [Field in Key]: string } {
  for (const key of keys) {
    if (requiredString(fields[key], key) !== fields[key]) throw bindingInputError(`${key} is invalid`);
  }
}

export const readContextError = (code: string, message: string, status: number) => {
  const error = Object.assign(new Error(message), { code, status });
  return error;
};

export const mutationContextError = (message: string) => readContextError(
  'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT',
  message,
  400,
);

export function assertMutationContextObject(input: SourceControlJson): asserts input is SourceControlJsonObject {
  if (!isPlainObject(input)) throw mutationContextError('Source control read context is required');
}

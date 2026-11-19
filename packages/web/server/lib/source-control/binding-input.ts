import { isPlainObject } from '../shared/guards.js';
import type { SourceControlJson, SourceControlJsonObject } from '@openchamber/sdk';

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

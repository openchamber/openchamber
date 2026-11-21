import type { SourceControlEmptyMutationResult } from '@openchamber/ui/lib/api/types';
import type { MutationReceiptDTO, MutationResultDTO } from './source-control';

type ExactKeyValue = MutationReceiptDTO
  | MutationReceiptDTO['actor']
  | MutationReceiptDTO['target']
  | MutationReceiptDTO['target']['project']
  | MutationResultDTO;

export const hasExactKeys = (value: ExactKeyValue, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

export const parseEmptyMutationResult = (result: MutationResultDTO): SourceControlEmptyMutationResult => {
  if (!hasExactKeys(result, [])) throw new Error('Source control response contained an invalid mutation result');
  return {};
};

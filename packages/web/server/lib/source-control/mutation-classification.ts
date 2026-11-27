import { isString } from '../shared/guards.js';

interface MutationFailure {
  code?: unknown;
  status?: unknown;
  response?: unknown;
  cause?: unknown;
}

const isMutationFailure = (value: unknown): value is MutationFailure => value != null;
const mutationFailureOf = (cause: unknown): MutationFailure | undefined => (isMutationFailure(cause) ? cause : undefined);
const isStatusHolder = (value: unknown): value is { status?: unknown } => value != null;
const isStatus = (value: unknown): value is number => Number.isInteger(value);

export const upstreamStatusOf = (cause: unknown) => {
  const error = mutationFailureOf(cause);
  const nestedResponse = mutationFailureOf(error?.cause)?.response;
  return (isStatusHolder(nestedResponse) ? nestedResponse.status : undefined)
    ?? (isStatusHolder(error?.response) ? error.response.status : undefined)
    ?? error?.status;
};

export const classifyMutationError = (cause: unknown): 'failed' | 'outcome-unknown' => {
  const error = mutationFailureOf(cause);
  const status = upstreamStatusOf(cause);
  const localSourceControlError = isString(error?.code)
    && (error.code.startsWith('SOURCE_CONTROL_') || error.code.startsWith('INVALID_SOURCE_CONTROL_'));
  if (!localSourceControlError && isStatus(status) && status >= 400 && status < 500) {
    if (error && !isStatus(error.status)) error.status = status;
    return 'failed';
  }
  return 'outcome-unknown';
};

const NOT_APPLIED = Symbol('source-control-mutation-not-applied');

export const notApplied = <Failure extends Error>(error: Failure): Failure => Object.assign(error, { [NOT_APPLIED]: true });

export const classifyNotAppliedMutationError = (cause: unknown): 'failed' | 'outcome-unknown' => (
  cause instanceof Error && NOT_APPLIED in cause ? 'failed' : classifyMutationError(cause)
);

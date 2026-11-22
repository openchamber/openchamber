// The queue binding the session-activity snapshot reports (observability
// contract v1). A fork module.
import { asNonEmptyString, isRecord } from '../shared/guards.js';
import type { JsonValue } from '../shared/json-values.js';

const isNumber = (value: unknown): value is number => typeof value === 'number';

// Allowlist projection for a session's queue binding (observability
// contract v1, #1473): only the four binding components can reach the
// snapshot, each an explicit null when the source cannot verify it, and
// a non-object source value means no known binding at all.
export const normalizeQueueBinding = (binding: JsonValue | undefined): SessionQueueBinding | null => {
  if (!isRecord(binding)) return null;
  const numberOrNull = <Value>(value: Value) => (isNumber(value) && Number.isFinite(value) ? value : null);
  return {
    taskId: numberOrNull(binding.taskId),
    issueNumber: numberOrNull(binding.issueNumber),
    queue: asNonEmptyString(binding.queue),
    lane: asNonEmptyString(binding.lane),
  };
};

/** The launch side's source of a session's queue binding: the task ledger row bound to the session id. */
export type SessionQueueBindingSource = (sessionId: string) => JsonValue | undefined;

export interface SessionQueueBinding {
  taskId: number | null;
  issueNumber: number | null;
  queue: string | null;
  lane: string | null;
}

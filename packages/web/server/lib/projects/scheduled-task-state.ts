import { asNonEmptyString } from '../shared/object-guards.js';
import type { ScheduledTaskInput, ScheduledTaskState, ScheduledTaskStatePatch, ScheduledTaskStatus } from './contracts.js';

export const MAX_BRANCH_LENGTH = 200;
const MAX_LAST_ERROR_LENGTH = 2_000;

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export const hasStateFields = (value: unknown): value is ScheduledTaskStatePatch => Boolean(value) && typeof value === 'object';

export const clampLength = (value: string, maxLength: number) => {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
};

const isTaskStatus = (value: unknown): value is ScheduledTaskStatus =>
  value === 'running' || value === 'success' || value === 'error' || value === 'idle' || value === 'queued' || value === 'sent' || value === 'skipped' || value === 'failed' || value === 'cancelled';

export const normalizeState = (value: ScheduledTaskInput['state'], fallback: ScheduledTaskState | undefined): ScheduledTaskState => {
  const source = hasStateFields(value) ? value : fallback || {};
  const lastRunAt = isFiniteNumber(source.lastRunAt)
    ? Math.max(0, Math.round(source.lastRunAt))
    : undefined;
  const lastDurationMs = isFiniteNumber(source.lastDurationMs)
    ? Math.max(0, Math.round(source.lastDurationMs))
    : undefined;
  const nextRunAt = isFiniteNumber(source.nextRunAt)
    ? Math.max(0, Math.round(source.nextRunAt))
    : undefined;
  const lastScheduledFor = isFiniteNumber(source.lastScheduledFor)
    ? Math.max(0, Math.round(source.lastScheduledFor))
    : undefined;
  const waitingForFolder = isFiniteNumber(source.waitingForFolder)
    ? Math.max(0, Math.round(source.waitingForFolder))
    : undefined;
  const lastSessionId = asNonEmptyString(source.lastSessionId);
  const lastErrorRaw = asNonEmptyString(source.lastError);
  const lastError = lastErrorRaw ? clampLength(lastErrorRaw, MAX_LAST_ERROR_LENGTH) : undefined;
  const lastRunIsolated = source.lastRunIsolated === true;
  const lastRunBranchRaw = asNonEmptyString(source.lastRunBranch);
  const lastRunBranch = lastRunBranchRaw ? clampLength(lastRunBranchRaw, MAX_BRANCH_LENGTH) : undefined;

  const state: ScheduledTaskState = {
    createdAt: isFiniteNumber(source.createdAt)
      ? Math.max(0, Math.round(source.createdAt))
      : Date.now(),
    updatedAt: isFiniteNumber(source.updatedAt)
      ? Math.max(0, Math.round(source.updatedAt))
      : Date.now(),
    lastStatus: isTaskStatus(source.lastStatus) ? source.lastStatus : 'idle',
  };
  if (lastRunAt !== undefined) state.lastRunAt = lastRunAt;
  if (lastDurationMs !== undefined) state.lastDurationMs = lastDurationMs;
  if (nextRunAt !== undefined) state.nextRunAt = nextRunAt;
  if (lastScheduledFor !== undefined) state.lastScheduledFor = lastScheduledFor;
  if (waitingForFolder !== undefined) state.waitingForFolder = waitingForFolder;
  if (lastSessionId) state.lastSessionId = lastSessionId;
  if (lastError) state.lastError = lastError;
  state.lastRunIsolated = lastRunIsolated || undefined;
  state.lastRunBranch = lastRunBranch;
  return state;
};

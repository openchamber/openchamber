import { DateTime, IANAZone } from 'luxon';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { readProcessInstance } from '../scheduled-tasks/process-instance.js';
import { asNonEmptyString, isBoolean, isRecord, isString } from '../shared/object-guards.js';
import type { promises as fsPromises } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { PlatformPath } from 'node:path';
import type { JsonObject, JsonValue } from '../magic-prompts/runtime.js';
import type { StorageSwitch } from '../project-context/contracts.js';
import type { DiscoveredLoop, LoopDefinition } from '../scheduled-tasks/loops.js';
import type { ScheduledTask, ScheduledTaskExecution, ScheduledTaskInput, ScheduledTaskSchedule, ScheduledTaskState, ScheduledTaskStatePatch, ScheduledTaskStatus, ScheduledWorktreeCleanup, SharedProjectDocument, SharedProjectRead } from './contracts.js';

import { projectConfigFileStemOf, projectPathFromId } from './project-id.js';
import { MAX_TASK_NAME_LENGTH, MAX_TASK_PROMPT_LENGTH, assertTaskTextWithinLimits } from './task-text-limits.js';
import {
  DEFAULT_PLANS_DIR,
  EMPTY_SHARED_PROJECT_CONFIG,
  NOTES_TODOS_RELATIVE_PATH,
  SHARED_CONFIG_RELATIVE_PATH,
  SHARED_SETUP_KEYS,
  applySharedProjectSetupPatch,
  defineOwnEntry,
  isSharedProjectConfigEmpty,
  mergeProjectSetup,
  parseSharedProjectConfig,
  projectSetupPatchToStored,
  projectSetupViewOf,
  serializeSharedProjectConfig,
  sharedTrustHashOf,
} from './project-setup.js';

const PROJECT_CONFIG_VERSION = 1;
const MAX_CRON_LENGTH = 200;
const MAX_BRANCH_LENGTH = 200;
const MAX_LAST_ERROR_LENGTH = 2_000;
const worktreeCleanupSchema = z.object({
  projectID: z.string().regex(/^[a-zA-Z0-9._:-]+$/),
  projectDirectory: z.string().min(1),
  worktreeDirectory: z.string().min(1),
  directoryIdentity: z.string().min(1),
  sessionID: z.string().min(1),
  branch: z.string().nullable(),
  startedAt: z.number().finite(),
  ownerPID: z.number().int().nonnegative(),
  ownerInstance: z.string().min(1).optional(),
  phase: z.enum(['waiting', 'removing']),
});

export interface ProjectConfigDependencies {
  fsPromises: Pick<typeof fsPromises, 'mkdir' | 'open' | 'readFile' | 'readdir' | 'rename' | 'rm' | 'rmdir' | 'stat' | 'unlink' | 'writeFile'>;
  path: PlatformPath;
  projectsDirPath: string;
  createTaskID?: () => string;
  switchNotesTodosStorage?: (projectID: string, change: StorageSwitch) => Promise<void>;
}

interface NormalizeTaskOptions {
  now: number;
  createId: () => string;
  existingTask: ScheduledTask | null | undefined;
  allowCreate: boolean;
  refreshUpdatedAt?: boolean;
}

interface StoredProjectTasks {
  rawTasksByID: Map<string, JsonValue>;
}

interface StoredTaskSelection {
  replacedIDs?: Set<string>;
  stateUpdatedID?: string | null;
}

type TaskScheduleSource = { times?: unknown; time?: unknown; timezone?: unknown };
type CleanupDecision = ScheduledWorktreeCleanup | null | undefined;
type ResolvedLoop = DiscoveredLoop & { definition: LoopDefinition };
type StoredTasks = { version: number; scheduledTasks: (ScheduledTask | JsonValue | { state: ScheduledTaskState })[] };
type CleanupInput = Omit<ScheduledWorktreeCleanup, 'projectID'>;
type SharedEntryMutation = (stored: JsonValue | undefined) => JsonValue | undefined;

const hasScheduleFields = (value: unknown): value is TaskScheduleSource & { kind?: unknown; weekdays?: unknown; date?: unknown; cron?: unknown } =>
  Boolean(value) && typeof value === 'object';
const hasExecutionFields = (value: unknown): value is { prompt?: unknown; providerID?: unknown; modelID?: unknown; variant?: unknown; agent?: unknown; goalEnabled?: unknown; permissionAutoAccept?: unknown; useDefaults?: unknown; goalTokenBudget?: unknown } =>
  Boolean(value) && typeof value === 'object';
const hasTaskFields = (value: unknown): value is ScheduledTaskInput => Boolean(value) && typeof value === 'object';
const hasStateFields = (value: unknown): value is ScheduledTaskStatePatch => Boolean(value) && typeof value === 'object';
const hasObjectErrorFields = (value: unknown): value is { code?: unknown } => Boolean(value) && typeof value === 'object';
const hasReadableErrorFields = (value: unknown): value is { code?: unknown; message?: unknown } => value !== null && value !== undefined;
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isInteger = (value: unknown): value is number => Number.isInteger(value);
const isInputArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isJsonArray = (value: JsonValue | undefined): value is JsonValue[] => Array.isArray(value);
const isJsonObject = (value: JsonValue | undefined): value is JsonObject => isRecord(value);
const isTaskFactory = (value: ProjectConfigDependencies['createTaskID']): value is () => string => typeof value === 'function';
const isTaskPredicate = (value: ((task: ScheduledTask) => boolean) | undefined): value is (task: ScheduledTask) => boolean => typeof value === 'function';
const hasRandomUUID = (value: Crypto | undefined): value is Crypto =>
  typeof value !== 'undefined' && typeof value.randomUUID === 'function';
const hasLoopDefinition = (loop: DiscoveredLoop): loop is ResolvedLoop =>
  Boolean(loop.definition) && typeof loop.definition === 'object';
const cleanupSessionIDOf = (value: JsonValue) => isJsonObject(value) ? value.sessionID : undefined;

const clampLength = (value: string, maxLength: number) => {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
};

const isTaskStatus = (value: unknown): value is ScheduledTaskStatus =>
  value === 'running' || value === 'success' || value === 'error' || value === 'idle' || value === 'queued' || value === 'sent' || value === 'skipped' || value === 'failed' || value === 'cancelled';

const normalizeTimeValue = (time: string | null) => {
  if (!time) {
    return null;
  }
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
    return null;
  }
  return time;
};

const normalizeDateValue = (date: string | null) => {
  if (!date) {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }
  const parsed = DateTime.fromISO(date, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat('yyyy-LL-dd') !== date) {
    return null;
  }
  return date;
};

const normalizeWeekdays = (value: unknown[]) => {
  const unique = new Set<number>();
  for (const entry of value) {
    if (!isInteger(entry)) {
      return null;
    }
    if (entry < 0 || entry > 6) {
      return null;
    }
    unique.add(entry);
  }

  if (unique.size === 0) {
    return null;
  }

  return Array.from(unique).sort((a, b) => a - b);
};

const resolveScheduleTimes = (value: TaskScheduleSource, existingSchedule: TaskScheduleSource | undefined) => {
  const times = [];

  if (isInputArray(value?.times)) {
    for (const item of value.times) {
      const normalized = normalizeTimeValue(asNonEmptyString(item));
      if (!normalized) {
        throw new Error('schedule.times is invalid: every entry must be HH:mm');
      }
      times.push(normalized);
    }
  }

  const legacySingleTime = normalizeTimeValue(asNonEmptyString(value?.time));
  if (legacySingleTime) {
    times.push(legacySingleTime);
  }

  if (times.length === 0 && isInputArray(existingSchedule?.times)) {
    for (const item of existingSchedule.times) {
      const normalized = normalizeTimeValue(asNonEmptyString(item));
      if (normalized) {
        times.push(normalized);
      }
    }
  }

  const uniqueSorted = Array.from(new Set(times)).sort((a, b) => a.localeCompare(b));
  if (uniqueSorted.length === 0) {
    return null;
  }
  return uniqueSorted;
};

const resolveDefaultTimezone = () => {
  const resolved = DateTime.local().zoneName;
  if (resolved && IANAZone.isValidZone(resolved)) {
    return resolved;
  }
  return 'UTC';
};

const normalizeTimezone = (timezone: string | null, fallback: string) => {
  if (!timezone) {
    return fallback;
  }
  return IANAZone.isValidZone(timezone) ? timezone : null;
};

const validateCronExpression = (expression: string, timezone: string) => {
  try {
    const iterator = CronExpressionParser.parse(expression, {
      tz: timezone,
      currentDate: new Date(),
    });
    iterator.next();
    return true;
  } catch {
    return false;
  }
};

const normalizeSchedule = (value: ScheduledTaskInput['schedule'], existingSchedule: ScheduledTaskSchedule | undefined): ScheduledTaskSchedule => {
  if (!hasScheduleFields(value)) {
    throw new Error('schedule is required');
  }

  const kind = asNonEmptyString(value.kind);
  if (kind !== 'daily' && kind !== 'weekly' && kind !== 'once' && kind !== 'cron') {
    throw new Error('schedule.kind is invalid: use daily, weekly, once, or cron');
  }

  const fallbackTimezone = existingSchedule?.timezone || resolveDefaultTimezone();
  const timezone = normalizeTimezone(asNonEmptyString(value.timezone), fallbackTimezone);
  if (!timezone) {
    throw new Error('schedule.timezone is invalid: use an IANA timezone name');
  }

  if (kind === 'daily') {
    const times = resolveScheduleTimes(value, existingSchedule);
    if (!times) {
      throw new Error('schedule.times is invalid: a daily schedule needs at least one HH:mm value');
    }
    return { kind, times, timezone };
  }

  if (kind === 'weekly') {
    const times = resolveScheduleTimes(value, existingSchedule);
    if (!times) {
      throw new Error('schedule.times is invalid: a weekly schedule needs at least one HH:mm value');
    }
    const weekdays = isInputArray(value.weekdays) ? normalizeWeekdays(value.weekdays) : null;
    if (!weekdays) {
      throw new Error('schedule.weekdays is invalid: a weekly schedule needs values from 0 to 6');
    }
    return { kind, times, weekdays, timezone };
  }

  if (kind === 'once') {
    const date = normalizeDateValue(asNonEmptyString(value.date));
    if (!date) {
      throw new Error('schedule.date is invalid: a once schedule needs YYYY-MM-DD');
    }

    const time = normalizeTimeValue(asNonEmptyString(value.time));
    if (!time) {
      throw new Error('schedule.time is invalid: a once schedule needs HH:mm');
    }

    return { kind, date, time, timezone };
  }

  const cron = clampLength(asNonEmptyString(value.cron) || '', MAX_CRON_LENGTH);
  if (!cron) {
    throw new Error('schedule.cron is required for cron schedule');
  }

  if (!validateCronExpression(cron, timezone)) {
    throw new Error('schedule.cron is invalid');
  }

  return { kind, cron, timezone };
};

const normalizeExecution = (value: ScheduledTaskInput['execution'], targetSessionId: string | null): ScheduledTaskExecution => {
  if (!hasExecutionFields(value)) {
    throw new Error('execution is required');
  }

  const prompt = clampLength(asNonEmptyString(value.prompt) || '', MAX_TASK_PROMPT_LENGTH);
  const providerID = asNonEmptyString(value.providerID);
  const modelID = asNonEmptyString(value.modelID);
  const variant = asNonEmptyString(value.variant);
  const agent = asNonEmptyString(value.agent);
  const goalEnabled = value.goalEnabled === true;
  const permissionAutoAccept = value.permissionAutoAccept === true;
  const useDefaults = value.useDefaults === true;
  const goalTokenBudget = isFiniteNumber(value.goalTokenBudget)
    && value.goalTokenBudget > 0
    ? Math.floor(value.goalTokenBudget)
    : undefined;

  if (!prompt) {
    throw new Error('execution.prompt is required');
  }
  if (!useDefaults && !targetSessionId && !providerID) {
    throw new Error('execution.providerID is required');
  }
  if (!useDefaults && !targetSessionId && !modelID) {
    throw new Error('execution.modelID is required');
  }
  if (targetSessionId && Boolean(providerID) !== Boolean(modelID)) throw new Error('execution providerID and modelID are required together');

  const execution: ScheduledTaskExecution = { prompt };
  if (providerID && modelID) {
    execution.providerID = providerID;
    execution.modelID = modelID;
  }
  if (useDefaults) execution.useDefaults = true;
  if (variant) execution.variant = variant;
  if (agent) execution.agent = agent;
  if (goalEnabled) execution.goalEnabled = true;
  if (goalEnabled && goalTokenBudget) execution.goalTokenBudget = goalTokenBudget;
  if (permissionAutoAccept) execution.permissionAutoAccept = true;
  return execution;
};

const normalizeState = (value: ScheduledTaskInput['state'], fallback: ScheduledTaskState | undefined): ScheduledTaskState => {
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
  if (lastSessionId) state.lastSessionId = lastSessionId;
  if (lastError) state.lastError = lastError;
  state.lastRunIsolated = lastRunIsolated || undefined;
  state.lastRunBranch = lastRunBranch;
  return state;
};

const normalizeTaskForStorage = (value: JsonValue | ScheduledTaskInput, options: NormalizeTaskOptions): ScheduledTask => {
  const {
    now,
    createId,
    existingTask,
    allowCreate,
    refreshUpdatedAt = true,
  } = options;

  if (!hasTaskFields(value)) {
    throw new Error('task is required');
  }

  const incomingId = asNonEmptyString(value.id);
  const existingId = asNonEmptyString(existingTask?.id);

  if (existingTask) {
    if (incomingId && incomingId !== existingId) {
      throw new Error('task.id is immutable');
    }
  }

  if (!existingTask && incomingId && !allowCreate) {
    throw new Error('task.id does not exist');
  }

  const id = existingId || incomingId || createId();
  const name = clampLength(asNonEmptyString(value.name) || '', MAX_TASK_NAME_LENGTH);
  if (!name) {
    throw new Error('task.name is required');
  }

  const enabled = isBoolean(value.enabled)
    ? value.enabled
    : (existingTask?.enabled ?? true);

  const schedule = normalizeSchedule(value.schedule, existingTask?.schedule);
  const targetSessionId = asNonEmptyString(value.targetSessionId);
  if (value.targetSessionId != null && value.targetSessionId !== '' && !targetSessionId) throw new Error('targetSessionId is invalid');
  if (targetSessionId && !/^[A-Za-z0-9_-]{4,128}$/.test(targetSessionId)) throw new Error('targetSessionId is invalid');
  const execution = normalizeExecution(value.execution, targetSessionId);

  const runInWorktree = value.runInWorktree === true || value.runInWorktree === false
    ? value.runInWorktree
    : existingTask?.runInWorktree === true;
  const branchValue = value.baseBranch;
  const branchCleared = branchValue === null || branchValue === '';
  const branchSource = branchCleared
    ? null
    : (asNonEmptyString(branchValue) ?? asNonEmptyString(existingTask?.baseBranch));
  const baseBranchRaw = branchSource || '';
  if (baseBranchRaw.length > MAX_BRANCH_LENGTH) {
    throw new Error(`baseBranch is invalid: at most ${MAX_BRANCH_LENGTH} characters, got ${baseBranchRaw.length}`);
  }
  if (baseBranchRaw && (/\s/.test(baseBranchRaw) || Array.from(baseBranchRaw).some((char) => char.charCodeAt(0) < 32))) {
    throw new Error('baseBranch is invalid: a branch name cannot contain spaces or control characters');
  }
  const cleanupWorktree = value.cleanupWorktree === true || value.cleanupWorktree === false
    ? value.cleanupWorktree
    : existingTask?.cleanupWorktree !== false;

  const loopFile = asNonEmptyString(value.loopFile) ?? asNonEmptyString(existingTask?.loopFile);

  const nowMs = Math.max(0, Math.round(now));
  const baseState = normalizeState(value.state, existingTask?.state);
  const state = {
    ...baseState,
    createdAt: existingTask?.state?.createdAt ?? baseState.createdAt ?? nowMs,
    updatedAt: refreshUpdatedAt ? nowMs : baseState.updatedAt ?? nowMs,
  };

  const storedTask: ScheduledTask = {
    id,
    name,
    enabled,
    schedule,
    execution,
    state,
  };
  if (loopFile) storedTask.loopFile = loopFile;
  if (runInWorktree) storedTask.runInWorktree = true;
  if (baseBranchRaw) storedTask.baseBranch = baseBranchRaw;
  if (cleanupWorktree === false) storedTask.cleanupWorktree = false;
  if (targetSessionId) storedTask.targetSessionId = targetSessionId;
  return storedTask;
};

const readLoopApprovals = (raw: JsonObject) => (
  isJsonObject(raw.loopApprovals)
    ? raw.loopApprovals
    : {}
);

export const createProjectConfigRuntime = (deps: ProjectConfigDependencies) => {
  const {
    fsPromises,
    path,
    projectsDirPath,
    createTaskID,
    switchNotesTodosStorage,
  } = deps;

  const taskIDFactory = isTaskFactory(createTaskID)
    ? createTaskID
    : (() => {
      if (hasRandomUUID(globalThis.crypto)) {
        return crypto.randomUUID();
      }
      return `task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    });

  const writeLocks = new Map<string, Promise<void>>();
  const PROJECT_FILE_LOCK_WAIT_MS = 10_000;
  const PROJECT_FILE_LOCK_STALE_MS = 60_000;
  const PROJECT_FILE_LOCK_RETRY_MS = 20;

  const sanitizeProjectID = (projectID: string | undefined) => {
    const value = asNonEmptyString(projectID);
    if (!value) {
      throw new Error('projectId is required');
    }
    if (!/^[a-zA-Z0-9._:-]+$/.test(value)) {
      throw new Error('projectId contains unsupported characters');
    }
    return value;
  };

  const resolveProjectConfigPath = (projectID: string | undefined) => {
    const safeProjectID = sanitizeProjectID(projectID);
    return path.join(projectsDirPath, `${projectConfigFileStemOf(safeProjectID)}.json`);
  };

  const parseWorktreeCleanup = (value: JsonValue | (CleanupInput & { projectID: string })) => {
    const record = worktreeCleanupSchema.parse(value);
    if (!path.isAbsolute(record.projectDirectory) || !path.isAbsolute(record.worktreeDirectory)) {
      throw new Error('Worktree cleanup directories must be absolute');
    }
    return record;
  };

  const resolveLegacyProjectConfigPath = (projectID: string | undefined) => {
    const safeProjectID = sanitizeProjectID(projectID);
    if (projectConfigFileStemOf(safeProjectID) === safeProjectID) return null;
    return path.join(projectsDirPath, `${safeProjectID}.json`);
  };

  const isProcessAlive = (pid: number) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return hasReadableErrorFields(error) && error.code === 'EPERM';
    }
  };

  const acquireProjectFileLock = async (projectID: string | undefined) => {
    const configPath = resolveProjectConfigPath(projectID);
    const lockPath = `${configPath}.lock`;
    const startedAt = Date.now();

    await fsPromises.mkdir(path.dirname(configPath), { recursive: true });

    while (Date.now() - startedAt < PROJECT_FILE_LOCK_WAIT_MS) {
      let handle: FileHandle | undefined;
      try {
        const opened = await fsPromises.open(lockPath, 'wx');
        handle = opened;
        const lockPayload = {
          pid: process.pid,
          at: Date.now(),
        };
        await handle.writeFile(JSON.stringify(lockPayload));
        return {
          release: async () => {
            try {
              await opened.close();
            } catch {
              void 0;
            }
            try {
              const raw = await fsPromises.readFile(lockPath, 'utf8');
              const parsed: JsonValue = JSON.parse(raw);
              if (Number(isJsonObject(parsed) ? parsed.pid : undefined) !== process.pid) {
                return;
              }
              await fsPromises.unlink(lockPath);
            } catch {
              return;
            }
          },
        };
      } catch (error) {
        if (handle) {
          try {
            await handle.close();
          } catch {
            void 0;
          }
        }
        if (!hasReadableErrorFields(error) || error.code !== 'EEXIST') {
          throw error;
        }

        try {
          const raw = await fsPromises.readFile(lockPath, 'utf8');
          const parsed: JsonValue = JSON.parse(raw);
          const lockPid = Number(isJsonObject(parsed) ? parsed.pid : undefined);
          const lockAt = Number(isJsonObject(parsed) ? parsed.at : undefined);
          const staleByPid = Number.isInteger(lockPid) && lockPid > 0 && !isProcessAlive(lockPid);
          const staleByAge = Number.isFinite(lockAt) && (Date.now() - lockAt) > PROJECT_FILE_LOCK_STALE_MS;
          if (staleByPid || staleByAge || !Number.isInteger(lockPid)) {
            await fsPromises.unlink(lockPath).catch(() => {});
            continue;
          }
        } catch {
          try {
            const stat = await fsPromises.stat(lockPath);
            const mtimeMs = Number(stat?.mtimeMs);
            if (Number.isFinite(mtimeMs) && (Date.now() - mtimeMs) > PROJECT_FILE_LOCK_STALE_MS) {
              await fsPromises.unlink(lockPath).catch(() => {});
              continue;
            }
          } catch {
            void 0;
          }
        }

        await new Promise((resolve) => {
          setTimeout(resolve, PROJECT_FILE_LOCK_RETRY_MS);
        });
      }
    }

    throw new Error(`timeout acquiring project config lock for ${projectID}`);
  };

  const readJsonDocumentIfPresent = async (filePath: string, missingCodes: string[]) => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      const code = hasObjectErrorFields(error) ? error.code : null;
      if (isString(code) && missingCodes.includes(code)) return null;
      throw error;
    }
    const parsed: JsonValue = JSON.parse(raw);
    return isJsonObject(parsed) ? parsed : {};
  };

  const readRawProjectConfigFromDisk = async (projectID: string | undefined) => {
    const current = await readJsonDocumentIfPresent(resolveProjectConfigPath(projectID), ['ENOENT']);
    if (current) return current;
    const legacyPath = resolveLegacyProjectConfigPath(projectID);
    const legacy = legacyPath ? await readJsonDocumentIfPresent(legacyPath, ['ENOENT', 'ENAMETOOLONG']) : null;
    return legacy ?? {};
  };

  const readProjectConfigFromDisk = async (projectID: string) => {
    const parsed = await readRawProjectConfigFromDisk(projectID);
    const tasksRaw = isJsonArray(parsed.scheduledTasks) ? parsed.scheduledTasks : [];
    const now = Date.now();
    const scheduledTasks: ScheduledTask[] = [];
    const rawTasksByID = new Map<string, JsonValue>();
    for (const task of tasksRaw) {
      try {
        const normalized = normalizeTaskForStorage(task, {
          now,
          createId: taskIDFactory,
          existingTask: null,
          allowCreate: true,
          refreshUpdatedAt: false,
        });
        scheduledTasks.push(normalized);
        rawTasksByID.set(normalized.id, task);
      } catch {
        continue;
      }
    }
    return {
      version: PROJECT_CONFIG_VERSION,
      scheduledTasks,
      rawTasksByID,
    };
  };

  const toStoredTasks = (config: StoredProjectTasks, tasks: ScheduledTask[], { replacedIDs = new Set(), stateUpdatedID = null }: StoredTaskSelection = {}) => (
    tasks.map((task) => {
      if (replacedIDs.has(task.id)) return task;
      const stored = config.rawTasksByID.get(task.id);
      if (!isJsonObject(stored) && !isJsonArray(stored)) return task;
      return task.id === stateUpdatedID ? { ...stored, state: task.state } : stored;
    })
  );

  const writeRawProjectConfigToDisk = async (projectID: string | undefined, document: SharedProjectDocument) => {
    const filePath = resolveProjectConfigPath(projectID);
    const parentDirectory = path.dirname(filePath);
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    await fsPromises.mkdir(parentDirectory, { recursive: true });
    try {
      await fsPromises.writeFile(temporaryPath, JSON.stringify(document, null, 2), 'utf8');
      await fsPromises.rename(temporaryPath, filePath);
    } catch (error) {
      await fsPromises.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
    const legacyPath = resolveLegacyProjectConfigPath(projectID);
    if (legacyPath) {
      await fsPromises.rm(legacyPath, { force: true }).catch(() => {});
    }
  };

  const writeProjectConfigToDisk = async (projectID: string, config: StoredTasks) => {
    const existing = await readRawProjectConfigFromDisk(projectID);
    await writeRawProjectConfigToDisk(projectID, {
      ...existing,
      version: PROJECT_CONFIG_VERSION,
      scheduledTasks: Array.isArray(config?.scheduledTasks) ? config.scheduledTasks : [],
    });
  };

  const withProjectWriteLock = async <Result>(projectID: string | undefined, mutate: () => Promise<Result>) => {
    const key = sanitizeProjectID(projectID);
    const previous = writeLocks.get(key) || Promise.resolve();
    let release: (() => void) | undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.finally(() => next);
    writeLocks.set(key, chained);

    await previous;
    try {
      const fileLock = await acquireProjectFileLock(projectID);
      try {
        return await mutate();
      } finally {
        await fileLock.release();
      }
    } finally {
      release?.();
      const current = writeLocks.get(key);
      if (current === chained) {
        writeLocks.delete(key);
      }
    }
  };

  const listScheduledTasks = async (projectID: string) => {
    const config = await readProjectConfigFromDisk(projectID);
    return config.scheduledTasks;
  };

  const upsertScheduledTask = async (projectID: string, taskInput: ScheduledTaskInput) => {
    return withProjectWriteLock(projectID, async () => {
      const now = Date.now();
      const current = await readProjectConfigFromDisk(projectID);
      const incomingID = asNonEmptyString(taskInput?.id);
      const existingIndex = incomingID
        ? current.scheduledTasks.findIndex((task) => task.id === incomingID)
        : -1;
      const existingTask = existingIndex >= 0 ? current.scheduledTasks[existingIndex] : null;

      const normalizedTask = normalizeTaskForStorage(assertTaskTextWithinLimits(taskInput), {
        now,
        createId: taskIDFactory,
        existingTask,
        allowCreate: true,
      });

      const nextTasks = current.scheduledTasks.slice();
      const created = !existingTask;
      if (existingIndex >= 0) {
        nextTasks[existingIndex] = normalizedTask;
      } else {
        nextTasks.push(normalizedTask);
      }

      const nextConfig = {
        version: PROJECT_CONFIG_VERSION,
        scheduledTasks: toStoredTasks(current, nextTasks, { replacedIDs: new Set([normalizedTask.id]) }),
      };
      await writeProjectConfigToDisk(projectID, nextConfig);

      return {
        task: normalizedTask,
        tasks: nextTasks,
        created,
      };
    });
  };

  const deleteScheduledTask = async (projectID: string, taskID: string) => {
    return withProjectWriteLock(projectID, async () => {
      const normalizedTaskID = asNonEmptyString(taskID);
      if (!normalizedTaskID) {
        throw new Error('taskId is required');
      }

      const current = await readProjectConfigFromDisk(projectID);
      const nextTasks = current.scheduledTasks.filter((task) => task.id !== normalizedTaskID);
      const deleted = nextTasks.length !== current.scheduledTasks.length;

      if (deleted) {
        await writeProjectConfigToDisk(projectID, {
          version: PROJECT_CONFIG_VERSION,
          scheduledTasks: toStoredTasks(current, nextTasks),
        });
      }

      return {
        deleted,
        tasks: nextTasks,
      };
    });
  };

  const updateScheduledTaskState = async (projectID: string, taskID: string, statePatch: ScheduledTaskStatePatch) => {
    return withProjectWriteLock(projectID, async () => {
      const normalizedTaskID = asNonEmptyString(taskID);
      if (!normalizedTaskID) {
        throw new Error('taskId is required');
      }

      const current = await readProjectConfigFromDisk(projectID);
      const taskIndex = current.scheduledTasks.findIndex((task) => task.id === normalizedTaskID);
      const currentTask = current.scheduledTasks[taskIndex];
      if (!currentTask) {
        return { task: null, tasks: current.scheduledTasks, updated: false };
      }

      const patchObject = hasStateFields(statePatch) ? statePatch : {};
      const nextTask: ScheduledTask = {
        ...currentTask,
        state: normalizeState(
          {
            ...currentTask.state,
            ...patchObject,
            updatedAt: Date.now(),
          },
          currentTask.state,
        ),
      };

      const nextTasks = current.scheduledTasks.slice();
      nextTasks[taskIndex] = nextTask;

      await writeProjectConfigToDisk(projectID, {
        version: PROJECT_CONFIG_VERSION,
        scheduledTasks: toStoredTasks(current, nextTasks, { stateUpdatedID: nextTask.id }),
      });

      return {
        task: nextTask,
        tasks: nextTasks,
        updated: true,
      };
    });
  };

  const updateScheduledTaskStateIf = async (projectID: string, taskID: string, predicate: (task: ScheduledTask) => boolean, statePatch: ScheduledTaskStatePatch) => {
    return withProjectWriteLock(projectID, async () => {
      const normalizedTaskID = asNonEmptyString(taskID);
      if (!normalizedTaskID) {
        throw new Error('taskId is required');
      }
      if (!isTaskPredicate(predicate)) {
        throw new Error('predicate is required');
      }

      const current = await readProjectConfigFromDisk(projectID);
      const taskIndex = current.scheduledTasks.findIndex((task) => task.id === normalizedTaskID);
      const currentTask = current.scheduledTasks[taskIndex];
      if (!currentTask) {
        return { task: null, tasks: current.scheduledTasks, updated: false };
      }

      if (!predicate(currentTask)) {
        return {
          task: currentTask,
          tasks: current.scheduledTasks,
          updated: false,
        };
      }

      const patchObject = hasStateFields(statePatch) ? statePatch : {};
      const nextTask: ScheduledTask = {
        ...currentTask,
        state: normalizeState(
          {
            ...currentTask.state,
            ...patchObject,
            updatedAt: Date.now(),
          },
          currentTask.state,
        ),
      };

      const nextTasks = current.scheduledTasks.slice();
      nextTasks[taskIndex] = nextTask;

      await writeProjectConfigToDisk(projectID, {
        version: PROJECT_CONFIG_VERSION,
        scheduledTasks: toStoredTasks(current, nextTasks, { stateUpdatedID: nextTask.id }),
      });

      return {
        task: nextTask,
        tasks: nextTasks,
        updated: true,
      };
    });
  };

  const reconcileLoopTasks = async (projectID: string, loops: DiscoveredLoop[]) => {
    return withProjectWriteLock(projectID, async () => {
      const now = Date.now();
      const current = await readProjectConfigFromDisk(projectID);
      const tasks = current.scheduledTasks;
      const approvals = readLoopApprovals(await readRawProjectConfigFromDisk(projectID));
      const heldBack = new Map<string, NonNullable<ScheduledTask['loopApproval']>>();
      loops = loops.map((loop) => {
        if (loop?.scope !== 'project' || loop.definition?.enabled !== true || approvals[loop.filePath] === loop.fingerprint) {
          return loop;
        }
        heldBack.set(loop.filePath, approvals[loop.filePath] ? 'outdated' : 'required');
        return { ...loop, definition: { ...loop.definition, enabled: false } };
      });

      const activeLoopFilePaths = new Set();
      const pendingLoops = new Map<string, ResolvedLoop>();
      const loopsByPath = new Map<string, ResolvedLoop>();
      for (const loop of loops) {
        if (!loop || !isString(loop.filePath) || !loop.filePath) {
          continue;
        }
        activeLoopFilePaths.add(loop.filePath);
        if (hasLoopDefinition(loop)) {
          pendingLoops.set(loop.definition.name, loop);
          loopsByPath.set(loop.filePath, loop);
        }
      }

      const consumedLoopPaths = new Set();
      const nextTasks = [];
      const replacedIDs = new Set<string>();
      for (const task of tasks) {
        if (task.loopFile && !activeLoopFilePaths.has(task.loopFile)) {
          continue;
        }

        const loop = task.loopFile
          ? loopsByPath.get(task.loopFile) || null
          : pendingLoops.get(task.name) || null;
        if (loop) {
          try {
            const adopted = normalizeTaskForStorage(
              {
                ...task,
                ...loop.definition,
                execution: { ...task.execution, ...loop.definition.execution },
                loopFile: loop.filePath,
              },
              {
                now,
                createId: taskIDFactory,
                existingTask: task,
                allowCreate: false,
                refreshUpdatedAt: false,
              },
            );
            nextTasks.push(adopted);
            replacedIDs.add(adopted.id);
            pendingLoops.delete(loop.definition.name);
            if (task.loopFile) {
              consumedLoopPaths.add(task.loopFile);
              loopsByPath.delete(task.loopFile);
            }
          } catch (error) {
            console.warn(`[scheduled-tasks] skipped loop ${loop.filePath} for task "${task.name}":`, (hasReadableErrorFields(error) ? error.message : undefined) ?? error);
            nextTasks.push(task);
          }
          continue;
        }

        if (task.loopFile && consumedLoopPaths.has(task.loopFile)) {
          continue;
        }

        nextTasks.push(task);
      }

      for (const loop of pendingLoops.values()) {
        try {
          const id = `loop:${loop.scope}:${loop.definition.name}`;
          const created = normalizeTaskForStorage(
            { id, ...loop.definition, loopFile: loop.filePath },
            {
              now,
              createId: taskIDFactory,
              existingTask: null,
              allowCreate: true,
              refreshUpdatedAt: false,
            },
          );
          nextTasks.push(created);
          replacedIDs.add(created.id);
        } catch (error) {
          console.warn(`[scheduled-tasks] skipped loop ${loop.filePath}:`, (hasReadableErrorFields(error) ? error.message : undefined) ?? error);
        }
      }

      await writeProjectConfigToDisk(projectID, {
        version: PROJECT_CONFIG_VERSION,
        scheduledTasks: toStoredTasks(current, nextTasks, { replacedIDs }),
      });

      return nextTasks.map((task) => {
        const loopApproval = task.loopFile ? heldBack.get(task.loopFile) : undefined;
        return loopApproval ? { ...task, loopApproval } : task;
      });
    });
  };

  const setLoopApproval = async (projectID: string, filePath: string, fingerprint: string | null) => withProjectWriteLock(projectID, async () => {
    const existing = await readRawProjectConfigFromDisk(projectID);
    const loopApprovals = { ...readLoopApprovals(existing) };
    if (fingerprint) {
      loopApprovals[filePath] = fingerprint;
    } else {
      delete loopApprovals[filePath];
    }
    await writeRawProjectConfigToDisk(projectID, { ...existing, version: PROJECT_CONFIG_VERSION, loopApprovals });
  });

  const projectPathOf = (projectID: string | undefined, personalRaw: SharedProjectDocument) => (
    projectPathFromId(projectID ?? '') || (isString(personalRaw.projectPath) ? personalRaw.projectPath.trim() : '')
  );
  const sharedConfigPathOf = (projectPath: string) => path.join(projectPath, ...SHARED_CONFIG_RELATIVE_PATH.split('/'));

  const readSharedProjectFile = async (projectPath: string): Promise<SharedProjectRead<JsonObject>> => {
    let raw;
    try {
      raw = await fsPromises.readFile(sharedConfigPathOf(projectPath), 'utf8');
    } catch (error) {
      if (hasObjectErrorFields(error) && error.code === 'ENOENT') return { status: 'missing' };
      return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
    }
    return parseSharedProjectConfig(raw);
  };

  const readSharedProjectConfig = async (projectID: string | undefined, personalRaw: SharedProjectDocument): Promise<SharedProjectRead<JsonObject>> => {
    const projectPath = projectPathOf(projectID, personalRaw);
    if (!projectPath) return { status: 'missing' };
    return readSharedProjectFile(projectPath);
  };

  const assertProjectCheckout = async (projectPath: string) => {
    if (!projectPath) throw new Error('project checkout not found');
    try {
      if (!(await fsPromises.stat(projectPath)).isDirectory()) throw new Error('project checkout not found');
    } catch {
      throw new Error('project checkout not found');
    }
  };

  const writeSharedProjectFile = async (projectPath: string, text: string | null) => {
    const filePath = sharedConfigPathOf(projectPath);
    if (text === null) {
      await fsPromises.rm(filePath, { force: true });
      await fsPromises.rmdir(path.dirname(filePath)).catch(() => {});
      return;
    }
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await fsPromises.writeFile(temporaryPath, text, 'utf8');
      await fsPromises.rename(temporaryPath, filePath);
    } catch (error) {
      await fsPromises.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  };

  const mergedProjectSetupOf = async (projectID: string | undefined, personalRaw: SharedProjectDocument) => (
    mergeProjectSetup(projectSetupViewOf(personalRaw), await readSharedProjectConfig(projectID, personalRaw))
  );

  const listScheduledWorktreeCleanups = async () => {
    let entries;
    try {
      entries = await fsPromises.readdir(projectsDirPath, { withFileTypes: true });
    } catch (error) {
      if (hasReadableErrorFields(error) && error.code === 'ENOENT') return [];
      throw error;
    }
    const records: ScheduledWorktreeCleanup[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const document = await readJsonDocumentIfPresent(path.join(projectsDirPath, entry.name), ['ENOENT']);
        const stored = document?.scheduledWorktreeCleanups ?? [];
        if (!isJsonArray(stored) && !isString(stored)) throw new TypeError('object is not iterable (cannot read property Symbol(Symbol.iterator))');
        for (const value of stored) {
          try {
            const record = parseWorktreeCleanup(value);
            if (path.basename(resolveProjectConfigPath(record.projectID)) !== entry.name) {
              throw new Error('Cleanup record belongs to another project config');
            }
            records.push(record);
          } catch (error) {
            console.warn('[ScheduledTasks] invalid worktree cleanup record', entry.name, (hasReadableErrorFields(error) ? error.message : undefined) ?? error);
          }
        }
      } catch (error) {
        console.warn('[ScheduledTasks] failed to read worktree cleanup records', entry.name, (hasReadableErrorFields(error) ? error.message : undefined) ?? error);
      }
    }
    return records;
  };

  const saveScheduledWorktreeCleanup = async (projectID: string, value: CleanupInput) => withProjectWriteLock(projectID, async () => {
    const record = parseWorktreeCleanup({ ...value, projectID });
    const raw = await readRawProjectConfigFromDisk(projectID);
    const records = raw.scheduledWorktreeCleanups ?? [];
    const document: SharedProjectDocument = raw;
    if (!isJsonArray(records)) throw new TypeError('records.filter is not a function');
    const remaining: (JsonValue | ScheduledWorktreeCleanup)[] = records.filter((entry) => cleanupSessionIDOf(entry) !== record.sessionID);
    remaining.push(record);
    document.scheduledWorktreeCleanups = remaining;
    await writeRawProjectConfigToDisk(projectID, document);
    return record;
  });

  const changeScheduledWorktreeCleanup = <Decision extends CleanupDecision>(
    projectID: string, sessionID: string, decide: (record: ScheduledWorktreeCleanup) => Decision | Promise<Decision>, signal?: AbortSignal,
  ) => withProjectWriteLock(projectID, async () => {
    signal?.throwIfAborted();
    const raw = await readRawProjectConfigFromDisk(projectID);
    signal?.throwIfAborted();
    const records = raw.scheduledWorktreeCleanups ?? [];
    const document: SharedProjectDocument = raw;
    if (!isJsonArray(records)) throw new TypeError('records.find is not a function');
    const value = records.find((entry) => cleanupSessionIDOf(entry) === sessionID);
    if (!value) return;
    const record = parseWorktreeCleanup(value);
    const next = await decide(record);
    signal?.throwIfAborted();
    if (next === undefined) return;
    const remaining: (JsonValue | ScheduledWorktreeCleanup)[] = records.filter((entry) => cleanupSessionIDOf(entry) !== sessionID);
    if (next) remaining.push(next);
    document.scheduledWorktreeCleanups = remaining;
    if (remaining.length === 0) delete document.scheduledWorktreeCleanups;
    await writeRawProjectConfigToDisk(projectID, document);
    return next ?? true;
  });

  const finishScheduledWorktreeCleanup = async (
    projectID: string, sessionID: string, remove: ((record: ScheduledWorktreeCleanup, resumingRemoval: boolean) => Promise<void>) | null,
    { signal }: { signal?: AbortSignal } = {},
  ) => {
    signal?.throwIfAborted();
    if (!remove) {
      return Boolean(await changeScheduledWorktreeCleanup(projectID, sessionID,
        (record) => record.phase === 'removing' ? undefined : null, signal));
    }
    const ownerInstance = await readProcessInstance(process.pid);
    if (!ownerInstance) throw new Error('Cannot identify the worktree cleanup owner');
    let resumingRemoval = false;
    const claimed = await changeScheduledWorktreeCleanup(projectID, sessionID, async (record): Promise<ScheduledWorktreeCleanup | undefined> => {
      if (record.phase === 'removing' && record.ownerInstance
        && await readProcessInstance(record.ownerPID) === record.ownerInstance) return;
      resumingRemoval = record.phase === 'removing';
      return { ...record, phase: 'removing', ownerPID: process.pid, ownerInstance };
    }, signal);
    if (!claimed) return false;
    try {
      signal?.throwIfAborted();
      await remove(claimed, resumingRemoval);
      await changeScheduledWorktreeCleanup(projectID, sessionID, () => null, signal);
    } catch (error) {
      await changeScheduledWorktreeCleanup(projectID, sessionID, (record) => ({ ...record, ownerPID: 0 }));
      throw error;
    }
    return true;
  };

  const readProjectSetup = async (projectID: string | undefined) => mergedProjectSetupOf(projectID, await readRawProjectConfigFromDisk(projectID));

  const updateProjectSetup = async (projectID: string | undefined, patch: SharedProjectDocument) => {
    const stored = projectSetupPatchToStored(patch);
    return withProjectWriteLock(projectID, async () => {
      const existing = await readRawProjectConfigFromDisk(projectID);
      const merged: SharedProjectDocument = { ...existing, ...stored };
      for (const [key, value] of Object.entries(stored)) {
        if (value === undefined) delete merged[key];
      }
      const commit = () => writeRawProjectConfigToDisk(projectID, merged);
      const enabled = merged.notesTodosInRepository === true;
      if ((existing.notesTodosInRepository === true) !== enabled && switchNotesTodosStorage && projectID !== undefined) {
        await switchNotesTodosStorage(projectID, { enabled, file: notesTodosFileOf(projectID, merged), commit });
      } else {
        await commit();
      }
      return mergedProjectSetupOf(projectID, merged);
    });
  };

  const updateSharedProjectSetup = async (projectID: string | undefined, patch: SharedProjectDocument) => (
    withProjectWriteLock(projectID, async () => {
      const personalRaw = await readRawProjectConfigFromDisk(projectID);
      const projectPath = projectPathOf(projectID, personalRaw);
      await assertProjectCheckout(projectPath);
      const currentRead = await readSharedProjectConfig(projectID, personalRaw);
      const current = currentRead.status === 'ok' ? currentRead.config : EMPTY_SHARED_PROJECT_CONFIG;
      const document = currentRead.document ?? {};
      const next = applySharedProjectSetupPatch(current, patch);

      await writeSharedProjectFile(
        projectPath,
        isSharedProjectConfigEmpty(next, document) ? null : serializeSharedProjectConfig(next, document),
      );

      const hash = sharedTrustHashOf(next);
      const personalNext = { ...personalRaw };
      if (hash) personalNext.sharedTrust = { hash, trustedAt: Date.now() };
      else delete personalNext.sharedTrust;
      await writeRawProjectConfigToDisk(projectID, personalNext);
      return mergedProjectSetupOf(projectID, personalNext);
    })
  );

  const updateSharedProjectEntry = async (projectID: string, projectPath: string, key: string, mutate: SharedEntryMutation) => {
    if (SHARED_SETUP_KEYS.includes(key)) throw new Error(`${key} belongs to the shared setup writer`);
    return withProjectWriteLock(projectID, async () => {
      await assertProjectCheckout(projectPath);
      const currentRead = await readSharedProjectFile(projectPath);
      if (currentRead.status === 'invalid') {
        throw Object.assign(new Error(`${SHARED_CONFIG_RELATIVE_PATH} is invalid: ${currentRead.reason}`), { code: 'shared_config_invalid' });
      }
      const document = currentRead.status === 'ok' ? currentRead.document : { version: 1 };
      const current = Object.prototype.hasOwnProperty.call(document, key) ? document[key] : undefined;
      const next = mutate(current);
      if (next === current) return current;

      const nextDocument = {};
      for (const [entryKey, value] of Object.entries(document)) {
        if (entryKey !== key) defineOwnEntry(nextDocument, entryKey, value);
      }
      if (next !== undefined) defineOwnEntry(nextDocument, key, next);
      const onlyVersion = Object.keys(nextDocument).every((entryKey) => entryKey === 'version');
      await writeSharedProjectFile(projectPath, onlyVersion ? null : `${JSON.stringify(nextDocument, null, 2)}\n`);
      return next;
    });
  };

  const resolveSharedPlansDir = async (projectID: string) => {
    const personalRaw = await readRawProjectConfigFromDisk(projectID);
    const projectPath = projectPathOf(projectID, personalRaw);
    if (!projectPath) return null;
    const shared = await readSharedProjectConfig(projectID, personalRaw);
    const relative = shared.status === 'ok' && shared.config.plansDir ? shared.config.plansDir : DEFAULT_PLANS_DIR;
    return path.join(projectPath, ...relative.split('/'));
  };

  const notesTodosFileOf = (projectID: string | undefined, personalRaw: SharedProjectDocument) => {
    const projectPath = projectPathOf(projectID, personalRaw);
    return projectPath ? path.join(projectPath, ...NOTES_TODOS_RELATIVE_PATH.split('/')) : null;
  };

  const resolveNotesTodosFile = async (projectID: string) => {
    const personalRaw = await readRawProjectConfigFromDisk(projectID);
    if (personalRaw.notesTodosInRepository !== true) return null;
    const file = notesTodosFileOf(projectID, personalRaw);
    if (!file) throw new Error('project checkout not found');
    return file;
  };

  return {
    readProjectSetup,
    updateProjectSetup,
    updateSharedProjectSetup,
    readSharedProjectFile,
    updateSharedProjectEntry,
    resolveSharedPlansDir,
    resolveNotesTodosFile,
    listScheduledTasks,
    listScheduledWorktreeCleanups,
    saveScheduledWorktreeCleanup,
    finishScheduledWorktreeCleanup,
    upsertScheduledTask,
    deleteScheduledTask,
    updateScheduledTaskState,
    updateScheduledTaskStateIf,
    reconcileLoopTasks,
    setLoopApproval,
    resolveProjectConfigPath,
  };
};

import { DateTime, IANAZone } from 'luxon';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { readProcessInstance } from '../scheduled-tasks/process-instance.js';

import { projectConfigFileStemOf, projectPathFromId } from './project-id.js';
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
export const MAX_TASK_NAME_LENGTH = 80;
const MAX_TASK_PROMPT_LENGTH = 20_000;
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

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const clampLength = (value, maxLength) => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.length > maxLength ? value.slice(0, maxLength) : value;
};

const normalizeStatus = (value) => {
  if (value === 'running' || value === 'success' || value === 'error' || value === 'idle' || value === 'queued' || value === 'sent' || value === 'skipped' || value === 'failed' || value === 'cancelled') {
    return value;
  }
  return 'idle';
};

const normalizeTimeValue = (value) => {
  const time = asNonEmptyString(value);
  if (!time) {
    return null;
  }
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
    return null;
  }
  return time;
};

const normalizeDateValue = (value) => {
  const date = asNonEmptyString(value);
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

const normalizeWeekdays = (value) => {
  if (!Array.isArray(value)) {
    return null;
  }

  const unique = new Set();
  for (const entry of value) {
    if (!Number.isInteger(entry)) {
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

const resolveScheduleTimes = (value, existingSchedule) => {
  const times = [];

  if (Array.isArray(value?.times)) {
    for (const item of value.times) {
      const normalized = normalizeTimeValue(item);
      if (!normalized) {
        throw new Error('schedule.times must contain HH:mm values');
      }
      times.push(normalized);
    }
  }

  const legacySingleTime = normalizeTimeValue(value?.time);
  if (legacySingleTime) {
    times.push(legacySingleTime);
  }

  if (times.length === 0 && Array.isArray(existingSchedule?.times)) {
    for (const item of existingSchedule.times) {
      const normalized = normalizeTimeValue(item);
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

const normalizeTimezone = (value, fallback = resolveDefaultTimezone()) => {
  const timezone = asNonEmptyString(value);
  if (!timezone) {
    return fallback;
  }
  return IANAZone.isValidZone(timezone) ? timezone : null;
};

const validateCronExpression = (expression, timezone) => {
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

const normalizeSchedule = (value, existingSchedule) => {
  if (!value || typeof value !== 'object') {
    throw new Error('schedule is required');
  }

  const kind = asNonEmptyString(value.kind);
  if (kind !== 'daily' && kind !== 'weekly' && kind !== 'once' && kind !== 'cron') {
    throw new Error('schedule.kind must be daily, weekly, once, or cron');
  }

  const fallbackTimezone = existingSchedule?.timezone || resolveDefaultTimezone();
  const timezone = normalizeTimezone(value.timezone, fallbackTimezone);
  if (!timezone) {
    throw new Error('schedule.timezone must be a valid IANA timezone');
  }

  if (kind === 'daily') {
    const times = resolveScheduleTimes(value, existingSchedule);
    if (!times) {
      throw new Error('schedule.times must include at least one HH:mm value for daily schedule');
    }
    return { kind, times, timezone };
  }

  if (kind === 'weekly') {
    const times = resolveScheduleTimes(value, existingSchedule);
    if (!times) {
      throw new Error('schedule.times must include at least one HH:mm value for weekly schedule');
    }
    const weekdays = normalizeWeekdays(value.weekdays);
    if (!weekdays) {
      throw new Error('schedule.weekdays must include values from 0 to 6 for weekly schedule');
    }
    return { kind, times, weekdays, timezone };
  }

  if (kind === 'once') {
    const date = normalizeDateValue(value.date);
    if (!date) {
      throw new Error('schedule.date must be YYYY-MM-DD for once schedule');
    }

    const time = normalizeTimeValue(value.time);
    if (!time) {
      throw new Error('schedule.time must be HH:mm for once schedule');
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

const normalizeExecution = (value, targetSessionId) => {
  if (!value || typeof value !== 'object') {
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
  const goalTokenBudget = typeof value.goalTokenBudget === 'number'
    && Number.isFinite(value.goalTokenBudget)
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

  return {
    prompt,
    ...(providerID && modelID ? { providerID, modelID } : {}),
    ...(useDefaults ? { useDefaults: true } : {}),
    ...(variant ? { variant } : {}),
    ...(agent ? { agent } : {}),
    ...(goalEnabled ? { goalEnabled: true } : {}),
    ...(goalEnabled && goalTokenBudget ? { goalTokenBudget } : {}),
    ...(permissionAutoAccept ? { permissionAutoAccept: true } : {}),
  };
};

const normalizeState = (value, fallback) => {
  const source = value && typeof value === 'object' ? value : fallback || {};
  const lastRunAt = typeof source.lastRunAt === 'number' && Number.isFinite(source.lastRunAt)
    ? Math.max(0, Math.round(source.lastRunAt))
    : undefined;
  const lastDurationMs = typeof source.lastDurationMs === 'number' && Number.isFinite(source.lastDurationMs)
    ? Math.max(0, Math.round(source.lastDurationMs))
    : undefined;
  const nextRunAt = typeof source.nextRunAt === 'number' && Number.isFinite(source.nextRunAt)
    ? Math.max(0, Math.round(source.nextRunAt))
    : undefined;
  // external: #2710 two server instances sharing this config must not both start a run for the same slot.
  const lastScheduledFor = typeof source.lastScheduledFor === 'number' && Number.isFinite(source.lastScheduledFor)
    ? Math.max(0, Math.round(source.lastScheduledFor))
    : undefined;
  const lastSessionId = asNonEmptyString(source.lastSessionId);
  const lastErrorRaw = asNonEmptyString(source.lastError);
  const lastError = lastErrorRaw ? clampLength(lastErrorRaw, MAX_LAST_ERROR_LENGTH) : undefined;
  const lastRunIsolated = source.lastRunIsolated === true;
  const lastRunBranchRaw = asNonEmptyString(source.lastRunBranch);
  const lastRunBranch = lastRunBranchRaw ? clampLength(lastRunBranchRaw, MAX_BRANCH_LENGTH) : undefined;

  return {
    createdAt: typeof source.createdAt === 'number' && Number.isFinite(source.createdAt)
      ? Math.max(0, Math.round(source.createdAt))
      : Date.now(),
    updatedAt: typeof source.updatedAt === 'number' && Number.isFinite(source.updatedAt)
      ? Math.max(0, Math.round(source.updatedAt))
      : Date.now(),
    lastStatus: normalizeStatus(source.lastStatus),
    ...(typeof lastRunAt === 'number' ? { lastRunAt } : {}),
    ...(typeof lastDurationMs === 'number' ? { lastDurationMs } : {}),
    ...(typeof nextRunAt === 'number' ? { nextRunAt } : {}),
    ...(typeof lastScheduledFor === 'number' ? { lastScheduledFor } : {}),
    ...(lastSessionId ? { lastSessionId } : {}),
    ...(lastError ? { lastError } : {}),
    lastRunIsolated: lastRunIsolated || undefined,
    lastRunBranch,
  };
};

const normalizeTaskForStorage = (value, options) => {
  const {
    now,
    createId,
    existingTask,
    allowCreate,
    refreshUpdatedAt = true,
  } = options;

  if (!value || typeof value !== 'object') {
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

  const enabled = typeof value.enabled === 'boolean'
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
    throw new Error(`baseBranch must be at most ${MAX_BRANCH_LENGTH} characters`);
  }
  if (baseBranchRaw && /[\s\u0000-\u001f]/.test(baseBranchRaw)) {
    throw new Error('baseBranch must be a branch name without spaces');
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

  const storedTask = {
    id,
    name,
    enabled,
    schedule,
    execution,
    state,
    ...(loopFile ? { loopFile } : {}),
  };
  if (runInWorktree) storedTask.runInWorktree = true;
  if (baseBranchRaw) storedTask.baseBranch = baseBranchRaw;
  if (cleanupWorktree === false) storedTask.cleanupWorktree = false;
  if (targetSessionId) storedTask.targetSessionId = targetSessionId;
  return storedTask;
};

const readLoopApprovals = (raw) => (
  raw.loopApprovals && typeof raw.loopApprovals === 'object' && !Array.isArray(raw.loopApprovals)
    ? raw.loopApprovals
    : {}
);

const createEmptyProjectConfig = () => ({
  version: PROJECT_CONFIG_VERSION,
  scheduledTasks: [],
});

export const createProjectConfigRuntime = (deps) => {
  const {
    fsPromises,
    path,
    projectsDirPath,
    createTaskID,
    switchNotesTodosStorage,
  } = deps;

  const taskIDFactory = typeof createTaskID === 'function'
    ? createTaskID
    : (() => {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
      return `task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    });

  const writeLocks = new Map();
  const PROJECT_FILE_LOCK_WAIT_MS = 10_000;
  const PROJECT_FILE_LOCK_STALE_MS = 60_000;
  const PROJECT_FILE_LOCK_RETRY_MS = 20;

  const sanitizeProjectID = (projectID) => {
    const value = asNonEmptyString(projectID);
    if (!value) {
      throw new Error('projectId is required');
    }
    if (!/^[a-zA-Z0-9._:-]+$/.test(value)) {
      throw new Error('projectId contains unsupported characters');
    }
    return value;
  };

  const resolveProjectConfigPath = (projectID) => {
    const safeProjectID = sanitizeProjectID(projectID);
    return path.join(projectsDirPath, `${projectConfigFileStemOf(safeProjectID)}.json`);
  };

  const parseWorktreeCleanup = (value) => {
    const record = worktreeCleanupSchema.parse(value);
    if (!path.isAbsolute(record.projectDirectory) || !path.isAbsolute(record.worktreeDirectory)) {
      throw new Error('Worktree cleanup directories must be absolute');
    }
    return record;
  };

  const resolveLegacyProjectConfigPath = (projectID) => {
    const safeProjectID = sanitizeProjectID(projectID);
    if (projectConfigFileStemOf(safeProjectID) === safeProjectID) return null;
    return path.join(projectsDirPath, `${safeProjectID}.json`);
  };

  const isProcessAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  };

  const acquireProjectFileLock = async (projectID) => {
    const configPath = resolveProjectConfigPath(projectID);
    const lockPath = `${configPath}.lock`;
    const startedAt = Date.now();

    await fsPromises.mkdir(path.dirname(configPath), { recursive: true });

    while (Date.now() - startedAt < PROJECT_FILE_LOCK_WAIT_MS) {
      let handle;
      try {
        handle = await fsPromises.open(lockPath, 'wx');
        const lockPayload = {
          pid: process.pid,
          at: Date.now(),
        };
        await handle.writeFile(JSON.stringify(lockPayload));
        return {
          release: async () => {
            try {
              await handle.close();
            } catch {
            }
            try {
              const raw = await fsPromises.readFile(lockPath, 'utf8');
              const parsed = JSON.parse(raw);
              if (Number(parsed?.pid) !== process.pid) {
                return;
              }
              await fsPromises.unlink(lockPath);
            } catch {
            }
          },
        };
      } catch (error) {
        if (handle) {
          try {
            await handle.close();
          } catch {
          }
        }
        if (error?.code !== 'EEXIST') {
          throw error;
        }

        try {
          const raw = await fsPromises.readFile(lockPath, 'utf8');
          const parsed = JSON.parse(raw);
          const lockPid = Number(parsed?.pid);
          const lockAt = Number(parsed?.at);
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
          }
        }

        await new Promise((resolve) => {
          setTimeout(resolve, PROJECT_FILE_LOCK_RETRY_MS);
        });
      }
    }

    throw new Error(`timeout acquiring project config lock for ${projectID}`);
  };

  const readJsonDocumentIfPresent = async (filePath, missingCodes) => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : null;
      if (missingCodes.includes(code)) return null;
      throw error;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  };

  const readRawProjectConfigFromDisk = async (projectID) => {
    const current = await readJsonDocumentIfPresent(resolveProjectConfigPath(projectID), ['ENOENT']);
    if (current) return current;
    const legacyPath = resolveLegacyProjectConfigPath(projectID);
    const legacy = legacyPath ? await readJsonDocumentIfPresent(legacyPath, ['ENOENT', 'ENAMETOOLONG']) : null;
    return legacy ?? {};
  };

  const readProjectConfigFromDisk = async (projectID) => {
    const parsed = await readRawProjectConfigFromDisk(projectID);
    const tasksRaw = Array.isArray(parsed.scheduledTasks) ? parsed.scheduledTasks : [];
    const now = Date.now();
    const scheduledTasks = [];
    const rawTasksByID = new Map();
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
      }
    }
    return {
      version: PROJECT_CONFIG_VERSION,
      scheduledTasks,
      rawTasksByID,
    };
  };

  const toStoredTasks = (config, tasks, { replacedIDs = new Set(), stateUpdatedID = null } = {}) => (
    tasks.map((task) => {
      if (replacedIDs.has(task.id)) return task;
      const stored = config.rawTasksByID.get(task.id);
      if (!stored) return task;
      return task.id === stateUpdatedID ? { ...stored, state: task.state } : stored;
    })
  );

  const writeRawProjectConfigToDisk = async (projectID, document) => {
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

  const writeProjectConfigToDisk = async (projectID, config) => {
    const existing = await readRawProjectConfigFromDisk(projectID);
    await writeRawProjectConfigToDisk(projectID, {
      ...existing,
      version: PROJECT_CONFIG_VERSION,
      scheduledTasks: Array.isArray(config?.scheduledTasks) ? config.scheduledTasks : [],
    });
  };

  const withProjectWriteLock = async (projectID, mutate) => {
    const key = sanitizeProjectID(projectID);
    const previous = writeLocks.get(key) || Promise.resolve();
    let release;
    const next = new Promise((resolve) => {
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
      release();
      const current = writeLocks.get(key);
      if (current === chained) {
        writeLocks.delete(key);
      }
    }
  };

  const listScheduledTasks = async (projectID) => {
    const config = await readProjectConfigFromDisk(projectID);
    return config.scheduledTasks;
  };

  const upsertScheduledTask = async (projectID, taskInput) => {
    return withProjectWriteLock(projectID, async () => {
      const now = Date.now();
      const current = await readProjectConfigFromDisk(projectID);
      const incomingID = asNonEmptyString(taskInput?.id);
      const existingIndex = incomingID
        ? current.scheduledTasks.findIndex((task) => task.id === incomingID)
        : -1;
      const existingTask = existingIndex >= 0 ? current.scheduledTasks[existingIndex] : null;

      const normalizedTask = normalizeTaskForStorage(taskInput, {
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

  const deleteScheduledTask = async (projectID, taskID) => {
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

  const updateScheduledTaskState = async (projectID, taskID, statePatch) => {
    return withProjectWriteLock(projectID, async () => {
      const normalizedTaskID = asNonEmptyString(taskID);
      if (!normalizedTaskID) {
        throw new Error('taskId is required');
      }

      const current = await readProjectConfigFromDisk(projectID);
      const taskIndex = current.scheduledTasks.findIndex((task) => task.id === normalizedTaskID);
      if (taskIndex === -1) {
        return { task: null, tasks: current.scheduledTasks, updated: false };
      }

      const currentTask = current.scheduledTasks[taskIndex];
      const patchObject = statePatch && typeof statePatch === 'object' ? statePatch : {};
      const nextTask = {
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

  const updateScheduledTaskStateIf = async (projectID, taskID, predicate, statePatch) => {
    return withProjectWriteLock(projectID, async () => {
      const normalizedTaskID = asNonEmptyString(taskID);
      if (!normalizedTaskID) {
        throw new Error('taskId is required');
      }
      if (typeof predicate !== 'function') {
        throw new Error('predicate is required');
      }

      const current = await readProjectConfigFromDisk(projectID);
      const taskIndex = current.scheduledTasks.findIndex((task) => task.id === normalizedTaskID);
      if (taskIndex === -1) {
        return { task: null, tasks: current.scheduledTasks, updated: false };
      }

      const currentTask = current.scheduledTasks[taskIndex];
      if (!predicate(currentTask)) {
        return {
          task: currentTask,
          tasks: current.scheduledTasks,
          updated: false,
        };
      }

      const patchObject = statePatch && typeof statePatch === 'object' ? statePatch : {};
      const nextTask = {
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

  const reconcileLoopTasks = async (projectID, loops) => {
    return withProjectWriteLock(projectID, async () => {
      const now = Date.now();
      const current = await readProjectConfigFromDisk(projectID);
      const tasks = current.scheduledTasks;
      const approvals = readLoopApprovals(await readRawProjectConfigFromDisk(projectID));
      const heldBack = new Map();
      loops = loops.map((loop) => {
        if (loop?.scope !== 'project' || loop.definition?.enabled !== true || approvals[loop.filePath] === loop.fingerprint) {
          return loop;
        }
        heldBack.set(loop.filePath, approvals[loop.filePath] ? 'outdated' : 'required');
        return { ...loop, definition: { ...loop.definition, enabled: false } };
      });

      const activeLoopFilePaths = new Set();
      const pendingLoops = new Map();
      const loopsByPath = new Map();
      for (const loop of loops) {
        if (!loop || typeof loop.filePath !== 'string' || !loop.filePath) {
          continue;
        }
        activeLoopFilePaths.add(loop.filePath);
        if (loop.definition && typeof loop.definition === 'object') {
          pendingLoops.set(loop.definition.name, loop);
          loopsByPath.set(loop.filePath, loop);
        }
      }

      const consumedLoopPaths = new Set();
      const nextTasks = [];
      const replacedIDs = new Set();
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
            console.warn(`[scheduled-tasks] skipped loop ${loop.filePath} for task "${task.name}":`, error?.message ?? error);
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
          console.warn(`[scheduled-tasks] skipped loop ${loop.filePath}:`, error?.message ?? error);
        }
      }

      await writeProjectConfigToDisk(projectID, {
        version: PROJECT_CONFIG_VERSION,
        scheduledTasks: toStoredTasks(current, nextTasks, { replacedIDs }),
      });

      return nextTasks.map((task) => (
        task.loopFile && heldBack.has(task.loopFile) ? { ...task, loopApproval: heldBack.get(task.loopFile) } : task
      ));
    });
  };

  const setLoopApproval = async (projectID, filePath, fingerprint) => withProjectWriteLock(projectID, async () => {
    const existing = await readRawProjectConfigFromDisk(projectID);
    const loopApprovals = { ...readLoopApprovals(existing) };
    if (fingerprint) {
      loopApprovals[filePath] = fingerprint;
    } else {
      delete loopApprovals[filePath];
    }
    await writeRawProjectConfigToDisk(projectID, { ...existing, version: PROJECT_CONFIG_VERSION, loopApprovals });
  });

  const projectPathOf = (projectID, personalRaw) => (
    projectPathFromId(projectID) || (typeof personalRaw.projectPath === 'string' ? personalRaw.projectPath.trim() : '')
  );
  const sharedConfigPathOf = (projectPath) => path.join(projectPath, ...SHARED_CONFIG_RELATIVE_PATH.split('/'));

  const readSharedProjectFile = async (projectPath) => {
    let raw;
    try {
      raw = await fsPromises.readFile(sharedConfigPathOf(projectPath), 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return { status: 'missing' };
      return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
    }
    return parseSharedProjectConfig(raw);
  };

  const readSharedProjectConfig = async (projectID, personalRaw) => {
    const projectPath = projectPathOf(projectID, personalRaw);
    if (!projectPath) return { status: 'missing' };
    return readSharedProjectFile(projectPath);
  };

  const assertProjectCheckout = async (projectPath) => {
    if (!projectPath) throw new Error('project checkout not found');
    try {
      if (!(await fsPromises.stat(projectPath)).isDirectory()) throw new Error('project checkout not found');
    } catch {
      throw new Error('project checkout not found');
    }
  };

  const writeSharedProjectFile = async (projectPath, text) => {
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

  const mergedProjectSetupOf = async (projectID, personalRaw) => (
    mergeProjectSetup(projectSetupViewOf(personalRaw), await readSharedProjectConfig(projectID, personalRaw))
  );

  const listScheduledWorktreeCleanups = async () => {
    let entries;
    try {
      entries = await fsPromises.readdir(projectsDirPath, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const document = await readJsonDocumentIfPresent(path.join(projectsDirPath, entry.name), ['ENOENT']);
        for (const value of document?.scheduledWorktreeCleanups ?? []) {
          try {
            const record = parseWorktreeCleanup(value);
            if (path.basename(resolveProjectConfigPath(record.projectID)) !== entry.name) {
              throw new Error('Cleanup record belongs to another project config');
            }
            records.push(record);
          } catch (error) {
            console.warn('[ScheduledTasks] invalid worktree cleanup record', entry.name, error?.message ?? error);
          }
        }
      } catch (error) {
        console.warn('[ScheduledTasks] failed to read worktree cleanup records', entry.name, error?.message ?? error);
      }
    }
    return records;
  };

  const saveScheduledWorktreeCleanup = async (projectID, value) => withProjectWriteLock(projectID, async () => {
    const record = parseWorktreeCleanup({ ...value, projectID });
    const document = await readRawProjectConfigFromDisk(projectID);
    const records = document.scheduledWorktreeCleanups ?? [];
    document.scheduledWorktreeCleanups = records.filter((entry) => entry?.sessionID !== record.sessionID);
    document.scheduledWorktreeCleanups.push(record);
    await writeRawProjectConfigToDisk(projectID, document);
    return record;
  });

  const changeScheduledWorktreeCleanup = (projectID, sessionID, decide, signal) => withProjectWriteLock(projectID, async () => {
    signal?.throwIfAborted();
    const document = await readRawProjectConfigFromDisk(projectID);
    signal?.throwIfAborted();
    const records = document.scheduledWorktreeCleanups ?? [];
    const value = records.find((entry) => entry?.sessionID === sessionID);
    if (!value) return;
    const record = parseWorktreeCleanup(value);
    const next = await decide(record);
    signal?.throwIfAborted();
    if (next === undefined) return;
    document.scheduledWorktreeCleanups = records.filter((entry) => entry?.sessionID !== sessionID);
    if (next) document.scheduledWorktreeCleanups.push(next);
    if (document.scheduledWorktreeCleanups.length === 0) delete document.scheduledWorktreeCleanups;
    await writeRawProjectConfigToDisk(projectID, document);
    return next ?? true;
  });

  const finishScheduledWorktreeCleanup = async (projectID, sessionID, remove, { signal } = {}) => {
    signal?.throwIfAborted();
    if (!remove) {
      return Boolean(await changeScheduledWorktreeCleanup(projectID, sessionID,
        (record) => record.phase === 'removing' ? undefined : null, signal));
    }
    const ownerInstance = await readProcessInstance(process.pid);
    if (!ownerInstance) throw new Error('Cannot identify the worktree cleanup owner');
    let resumingRemoval = false;
    const claimed = await changeScheduledWorktreeCleanup(projectID, sessionID, async (record) => {
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

  const readProjectSetup = async (projectID) => mergedProjectSetupOf(projectID, await readRawProjectConfigFromDisk(projectID));

  const updateProjectSetup = async (projectID, patch) => {
    const stored = projectSetupPatchToStored(patch);
    return withProjectWriteLock(projectID, async () => {
      const existing = await readRawProjectConfigFromDisk(projectID);
      const merged = { ...existing, ...stored };
      for (const [key, value] of Object.entries(stored)) {
        if (value === undefined) delete merged[key];
      }
      const commit = () => writeRawProjectConfigToDisk(projectID, merged);
      const enabled = merged.notesTodosInRepository === true;
      if ((existing.notesTodosInRepository === true) !== enabled && switchNotesTodosStorage) {
        await switchNotesTodosStorage(projectID, { enabled, file: notesTodosFileOf(projectID, merged), commit });
      } else {
        await commit();
      }
      return mergedProjectSetupOf(projectID, merged);
    });
  };

  const updateSharedProjectSetup = async (projectID, patch) => (
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

  const updateSharedProjectEntry = async (projectID, projectPath, key, mutate) => {
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

  const resolveSharedPlansDir = async (projectID) => {
    const personalRaw = await readRawProjectConfigFromDisk(projectID);
    const projectPath = projectPathOf(projectID, personalRaw);
    if (!projectPath) return null;
    const shared = await readSharedProjectConfig(projectID, personalRaw);
    const relative = shared.status === 'ok' && shared.config.plansDir ? shared.config.plansDir : DEFAULT_PLANS_DIR;
    return path.join(projectPath, ...relative.split('/'));
  };

  const notesTodosFileOf = (projectID, personalRaw) => {
    const projectPath = projectPathOf(projectID, personalRaw);
    return projectPath ? path.join(projectPath, ...NOTES_TODOS_RELATIVE_PATH.split('/')) : null;
  };

  const resolveNotesTodosFile = async (projectID) => {
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

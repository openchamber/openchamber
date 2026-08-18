import { DateTime, IANAZone } from 'luxon';
import parser from 'cron-parser';

const PROJECT_CONFIG_VERSION = 1;
export const MAX_TASK_NAME_LENGTH = 80;
const MAX_TASK_PROMPT_LENGTH = 20_000;
const MAX_CRON_LENGTH = 200;
const MAX_LAST_ERROR_LENGTH = 2_000;

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
  if (value === 'running' || value === 'success' || value === 'error' || value === 'idle') {
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
    const iterator = parser.parseExpression(expression, {
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

const normalizeExecution = (value) => {
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
  const goalTokenBudget = typeof value.goalTokenBudget === 'number'
    && Number.isFinite(value.goalTokenBudget)
    && value.goalTokenBudget > 0
    ? Math.floor(value.goalTokenBudget)
    : undefined;

  if (!prompt) {
    throw new Error('execution.prompt is required');
  }
  if (!providerID) {
    throw new Error('execution.providerID is required');
  }
  if (!modelID) {
    throw new Error('execution.modelID is required');
  }

  return {
    prompt,
    providerID,
    modelID,
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
  // Absolute ms of the schedule occurrence last claimed for dispatch. Used so
  // two OpenChamber server instances sharing this config cannot both start a
  // run for the same daily/weekly/cron/once slot (see issue #2710).
  const lastScheduledFor = typeof source.lastScheduledFor === 'number' && Number.isFinite(source.lastScheduledFor)
    ? Math.max(0, Math.round(source.lastScheduledFor))
    : undefined;
  const lastSessionId = asNonEmptyString(source.lastSessionId);
  const lastErrorRaw = asNonEmptyString(source.lastError);
  const lastError = lastErrorRaw ? clampLength(lastErrorRaw, MAX_LAST_ERROR_LENGTH) : undefined;

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
  const execution = normalizeExecution(value.execution);

  // Loop provenance: absolute path of the `.agents/loops/*.md` file driving
  // this task, when any. Preserved on every write so the scheduler can detect
  // removed loop files across restarts. Unknown to the UI model.
  const loopFile = asNonEmptyString(value.loopFile) ?? asNonEmptyString(existingTask?.loopFile);

  const nowMs = Math.max(0, Math.round(now));
  const baseState = normalizeState(value.state, existingTask?.state);
  const state = {
    ...baseState,
    createdAt: existingTask?.state?.createdAt ?? baseState.createdAt ?? nowMs,
    updatedAt: refreshUpdatedAt ? nowMs : baseState.updatedAt ?? nowMs,
  };

  return {
    id,
    name,
    enabled,
    schedule,
    execution,
    state,
    ...(loopFile ? { loopFile } : {}),
  };
};

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
      // EPERM: process exists but belongs to another user — treat as alive.
      return error?.code === 'EPERM';
    }
  };

  /**
   * Cross-process exclusive lock for a project config file.
   * In-process chaining alone cannot serialize Electron (port 57123) and CLI
   * serve (port 3000) writers that share the same on-disk projects dir.
   */
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
            // Only unlink if we still own the lock. A stale-recovery steal can
            // replace the file; unlinking blindly would drop the new owner's lock.
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
          // Crash between open(wx) and writeFile (or a partial write) leaves an
          // unparseable lock. Fall back to mtime age so recovery is not wedged.
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

  const readRawProjectConfigFromDisk = async (projectID) => {
    const filePath = resolveProjectConfigPath(projectID);
    try {
      const raw = await fsPromises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  };

  const readProjectConfigFromDisk = async (projectID) => {
    const parsed = await readRawProjectConfigFromDisk(projectID);
    const tasksRaw = Array.isArray(parsed.scheduledTasks) ? parsed.scheduledTasks : [];
    const now = Date.now();
    const scheduledTasks = [];
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
      } catch {
      }
    }
    return {
      version: PROJECT_CONFIG_VERSION,
      scheduledTasks,
    };
  };

  const writeProjectConfigToDisk = async (projectID, config) => {
    const filePath = resolveProjectConfigPath(projectID);
    const parentDirectory = path.dirname(filePath);
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const existing = await readRawProjectConfigFromDisk(projectID);
    const merged = {
      ...existing,
      version: PROJECT_CONFIG_VERSION,
      scheduledTasks: Array.isArray(config?.scheduledTasks) ? config.scheduledTasks : [],
    };

    await fsPromises.mkdir(parentDirectory, { recursive: true });
    await fsPromises.writeFile(temporaryPath, JSON.stringify(merged, null, 2), 'utf8');
    await fsPromises.rename(temporaryPath, filePath);
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
    // Acquire sits outside the mutate try — if it throws (10s lock timeout),
    // we must still release the in-process chain or every later write for this
    // project hangs forever on await previous.
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
        scheduledTasks: nextTasks,
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
          scheduledTasks: nextTasks,
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
        scheduledTasks: nextTasks,
      });

      return {
        task: nextTask,
        tasks: nextTasks,
        updated: true,
      };
    });
  };

  /**
   * Conditionally patch task runtime state under the project write lock.
   * `predicate(currentTask)` is evaluated after the latest on-disk read; when
   * it returns false the write is skipped and `{ updated: false }` is returned.
   * Used by the scheduled-tasks runtime to claim a single schedule occurrence
   * across concurrent OpenChamber server instances.
   */
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
        scheduledTasks: nextTasks,
      });

      return {
        task: nextTask,
        tasks: nextTasks,
        updated: true,
      };
    });
  };

  /**
   * Reconcile discovered `.agents/loops` definitions with the persisted JSON
   * task list.
   *
   * Rules (documented in scheduled-tasks/DOCUMENTATION.md):
   * - For loop-owned tasks (carrying the `loopFile` marker) identity is the
   *   LOOP FILE PATH: a loop takes its task over regardless of the task's
   *   current name, so renaming the loop (`name` field or a UI edit) renames
   *   the task in place instead of leaving a stale duplicate behind.
   * - A loop whose name matches a JSON task (no `loopFile`) takes that task
   *   over: its schedule/execution/enabled are overwritten from the file while
   *   its id and runtime state are preserved (markdown wins on conflict).
   *   Execution fields the file format does not define (goalEnabled,
   *   goalTokenBudget, permissionAutoAccept, variant) are preserved.
   * - A task whose loopFile no longer matches any discovered loop file is
   *   unscheduled (removed). JSON-configured tasks (no loopFile) are never
   *   removed.
   * - A task whose loop file still exists but is currently unparseable is
   *   KEPT with its last good definition: only a genuinely removed file
   *   unschedules a task, so transiently malformed files (mid-edit, bad
   *   merge) never delete tasks or their runtime state.
   * - Loops with no matching task are created under a deterministic
   *   `loop:<scope>:<name>` id, so runtime state survives restarts.
   * - Malformed definitions are skipped with a warning and never block valid
   *   loops; the scheduler passes them as `definition: null` entries, and
   *   normalization failures here are isolated per loop.
   */
  const reconcileLoopTasks = async (projectID, loops) => {
    return withProjectWriteLock(projectID, async () => {
      const now = Date.now();
      const current = await readProjectConfigFromDisk(projectID);
      const tasks = current.scheduledTasks;

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
      for (const task of tasks) {
        if (task.loopFile && !activeLoopFilePaths.has(task.loopFile)) {
          // The driving loop file was removed (or renamed) — unschedule.
          continue;
        }

        // Loop-owned tasks adopt by file path (covers renames of the `name`
        // field); JSON tasks adopt by name.
        const loop = task.loopFile
          ? loopsByPath.get(task.loopFile) || null
          : pendingLoops.get(task.name) || null;
        if (loop) {
          try {
            const adopted = normalizeTaskForStorage(
              {
                ...task,
                ...loop.definition,
                // File-defined execution fields win; UI-only fields the file
                // format does not define are preserved from the task.
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
          // Orphan duplicate: another task already adopted this loop file
          // (left over from a rename) — unschedule it.
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
        } catch (error) {
          console.warn(`[scheduled-tasks] skipped loop ${loop.filePath}:`, error?.message ?? error);
        }
      }

      await writeProjectConfigToDisk(projectID, {
        version: PROJECT_CONFIG_VERSION,
        scheduledTasks: nextTasks,
      });

      return nextTasks;
    });
  };

  return {
    listScheduledTasks,
    upsertScheduledTask,
    deleteScheduledTask,
    updateScheduledTaskState,
    updateScheduledTaskStateIf,
    reconcileLoopTasks,
    resolveProjectConfigPath,
  };
};

import { DateTime } from 'luxon';
import parser from 'cron-parser';

const DEFAULT_GLOBAL_CONCURRENCY = 4;
const DEFAULT_PROJECT_CONCURRENCY = 2;
const DEFAULT_MAX_RUN_MS = 30 * 60 * 1000;
const JITTER_MAX_MS = 2_000;
const TASK_TITLE_MAX_LENGTH = 120;
const TASK_DUE_SLACK_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const buildTaskKey = (projectID, taskID) => `${projectID}:${taskID}`;

const parseTimeParts = (time) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof time === 'string' ? time : '');
  if (!match) {
    return null;
  }
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
};

const applyTimeToDate = (baseDateTime, time) => {
  const parsed = parseTimeParts(time);
  if (!parsed) {
    return null;
  }
  return baseDateTime.set({
    hour: parsed.hour,
    minute: parsed.minute,
    second: 0,
    millisecond: 0,
  });
};

const resolveScheduleTimes = (schedule) => {
  const times = [];
  if (Array.isArray(schedule?.times)) {
    for (const candidate of schedule.times) {
      if (typeof candidate === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(candidate)) {
        times.push(candidate);
      }
    }
  }
  if (times.length === 0 && typeof schedule?.time === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(schedule.time)) {
    times.push(schedule.time);
  }
  return Array.from(new Set(times)).sort((a, b) => a.localeCompare(b));
};

const weekdayAsZeroBased = (dateTime) => {
  if (!dateTime || typeof dateTime.weekday !== 'number') {
    return null;
  }
  return dateTime.weekday % 7;
};

const safeErrorMessage = (error, maxLength = 2_000) => {
  const raw = error instanceof Error
    ? (error.message || String(error))
    : String(error ?? 'Unknown error');
  const trimmed = raw.trim();
  if (!trimmed) {
    return 'Unknown error';
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

export const parseScheduledCommandPrompt = (prompt) => {
  if (typeof prompt !== 'string') {
    return null;
  }

  const trimmed = prompt.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const firstLine = trimmed.split(/\r?\n/, 1)[0] || '';
  const [head, ...tail] = firstLine.split(/\s+/);
  const commandName = (head || '').slice(1).trim();
  if (!commandName) {
    return null;
  }

  return {
    command: commandName,
    arguments: tail.join(' ').trim(),
  };
};

export const computeNextRunAt = (task, nowMs = Date.now()) => {
  if (!task?.enabled) {
    return null;
  }

  const schedule = task.schedule;
  if (!schedule || typeof schedule !== 'object') {
    return null;
  }

  const zone = typeof schedule.timezone === 'string' && schedule.timezone.trim().length > 0
    ? schedule.timezone.trim()
    : DateTime.local().zoneName;

  const now = DateTime.fromMillis(nowMs, { zone });
  if (!now.isValid) {
    return null;
  }

  if (schedule.kind === 'daily') {
    const times = resolveScheduleTimes(schedule);
    if (times.length === 0) {
      return null;
    }
    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });

    for (const time of times) {
      const candidateToday = applyTimeToDate(now, time);
      if (!candidateToday || !candidateToday.isValid) {
        continue;
      }
      if (candidateToday > minAllowed) {
        return candidateToday.toMillis();
      }
    }

    const tomorrow = now.plus({ days: 1 });
    const firstTomorrow = applyTimeToDate(tomorrow, times[0]);
    return firstTomorrow?.isValid ? firstTomorrow.toMillis() : null;
  }

  if (schedule.kind === 'weekly') {
    if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) {
      return null;
    }
    const times = resolveScheduleTimes(schedule);
    if (times.length === 0) {
      return null;
    }
    const weekdaysSet = new Set(schedule.weekdays);
    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });

    for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
      const dayCandidate = now.plus({ days: dayOffset });
      const zeroBasedWeekday = weekdayAsZeroBased(dayCandidate);
      if (zeroBasedWeekday === null || !weekdaysSet.has(zeroBasedWeekday)) {
        continue;
      }
      for (const time of times) {
        const withTime = applyTimeToDate(dayCandidate, time);
        if (!withTime || !withTime.isValid) {
          continue;
        }
        if (withTime > minAllowed) {
          return withTime.toMillis();
        }
      }
    }
    return null;
  }

  if (schedule.kind === 'once') {
    if (typeof schedule.date !== 'string' || typeof schedule.time !== 'string') {
      return null;
    }

    const parsed = DateTime.fromFormat(
      `${schedule.date} ${schedule.time}`,
      'yyyy-LL-dd HH:mm',
      { zone },
    );
    if (!parsed.isValid) {
      return null;
    }

    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });
    if (parsed <= minAllowed) {
      return null;
    }

    return parsed.toMillis();
  }

  if (schedule.kind === 'cron') {
    try {
      const iterator = parser.parseExpression(schedule.cron, {
        tz: zone,
        currentDate: new Date(nowMs),
      });
      return iterator.next().getTime();
    } catch {
      return null;
    }
  }

  return null;
};

export const formatScheduledSessionTitle = (task, nowMs = Date.now()) => {
  const timezone = typeof task?.schedule?.timezone === 'string' && task.schedule.timezone.trim().length > 0
    ? task.schedule.timezone.trim()
    : DateTime.local().zoneName;
  const stamp = DateTime.fromMillis(nowMs, { zone: timezone }).toFormat('yyyy-LL-dd HH:mm');
  const taskName = typeof task?.name === 'string' && task.name.trim().length > 0
    ? task.name.trim()
    : 'Scheduled task';
  const suffix = ` ${stamp}`;
  const maxTaskNameLength = Math.max(1, TASK_TITLE_MAX_LENGTH - suffix.length);
  const trimmedName = taskName.length > maxTaskNameLength
    ? taskName.slice(0, maxTaskNameLength)
    : taskName;
  return `${trimmedName}${suffix}`;
};

export const createScheduledTasksRuntime = (deps) => {
  const {
    projectConfigRuntime,
    listProjects,
    backendRegistry,
    sessionBindingsRuntime,
    emitTaskRunEvent,
    logger = console,
    maxGlobalConcurrency = DEFAULT_GLOBAL_CONCURRENCY,
    maxProjectConcurrency = DEFAULT_PROJECT_CONCURRENCY,
    maxRunDurationMs = DEFAULT_MAX_RUN_MS,
  } = deps;

  let started = false;
  const tasksByProject = new Map();
  const projectPathByID = new Map();
  const timersByTaskKey = new Map();
  const queuedTaskKeys = new Set();
  const runningTaskKeys = new Set();
  const runningCountByProject = new Map();
  let runningGlobalCount = 0;
  const queue = [];

  const clearTimerForKey = (taskKey) => {
    const timer = timersByTaskKey.get(taskKey);
    if (timer) {
      clearTimeout(timer);
      timersByTaskKey.delete(taskKey);
    }
  };

  const clearProjectTimers = (projectID) => {
    const tasks = tasksByProject.get(projectID);
    if (!tasks) {
      return;
    }
    for (const task of tasks.values()) {
      clearTimerForKey(buildTaskKey(projectID, task.id));
      queuedTaskKeys.delete(buildTaskKey(projectID, task.id));
    }
  };

  const setProjectTasks = (projectID, tasks) => {
    clearProjectTimers(projectID);
    const taskMap = new Map();
    for (const task of tasks) {
      taskMap.set(task.id, task);
    }
    tasksByProject.set(projectID, taskMap);
  };

  const scheduleTask = (projectID, taskID, nextRunAt) => {
    const taskKey = buildTaskKey(projectID, taskID);
    clearTimerForKey(taskKey);

    if (!Number.isFinite(nextRunAt) || nextRunAt <= 0) {
      return;
    }

    const delayBase = Math.max(0, Math.round(nextRunAt - Date.now()));
    const jitter = Math.floor(Math.random() * (JITTER_MAX_MS + 1));
    const delay = delayBase + jitter;
    const boundedDelay = Math.min(delay, MAX_TIMER_DELAY_MS);

    const timer = setTimeout(async () => {
      if (delay > MAX_TIMER_DELAY_MS) {
        scheduleTask(projectID, taskID, nextRunAt);
        return;
      }

      clearTimerForKey(taskKey);
      const taskMap = tasksByProject.get(projectID);
      const task = taskMap?.get(taskID);
      if (!task || !task.enabled) {
        return;
      }
      queueTaskRun(projectID, taskID, 'scheduled');
      pumpQueue();
    }, boundedDelay);

    timersByTaskKey.set(taskKey, timer);
  };

  const updateInMemoryTask = (projectID, nextTask) => {
    if (!nextTask) {
      return;
    }
    const taskMap = tasksByProject.get(projectID);
    if (!taskMap) {
      return;
    }
    taskMap.set(nextTask.id, nextTask);
  };

  const syncTaskSchedule = async (projectID, task) => {
    if (!task) {
      return;
    }
    const nextRunAt = computeNextRunAt(task, Date.now());
    const statePatch = {
      nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : undefined,
      updatedAt: Date.now(),
    };
    const result = await projectConfigRuntime.updateScheduledTaskState(projectID, task.id, statePatch);
    if (result.task) {
      updateInMemoryTask(projectID, result.task);
      if (result.task.enabled && Number.isFinite(result.task.state?.nextRunAt)) {
        scheduleTask(projectID, result.task.id, result.task.state.nextRunAt);
      }
    }
  };

  const ensureProjectPath = async (projectID) => {
    if (projectPathByID.has(projectID)) {
      return projectPathByID.get(projectID) || null;
    }

    try {
      const projects = await listProjects();
      const project = projects.find((item) => item?.id === projectID && item?.path);
      if (project?.path) {
        projectPathByID.set(projectID, project.path);
        return project.path;
      }
    } catch {
    }

    return null;
  };

  const syncProject = async (projectID) => {
    await ensureProjectPath(projectID);

    const tasks = await projectConfigRuntime.listScheduledTasks(projectID);
    setProjectTasks(projectID, tasks);

    for (const task of tasks) {
      await syncTaskSchedule(projectID, task);
    }

    return tasks;
  };

  const syncAllProjects = async () => {
    const projects = await listProjects();
    const activeProjectIDs = new Set();
    projectPathByID.clear();
    for (const project of projects) {
      if (!project?.id || !project?.path) {
        continue;
      }
      activeProjectIDs.add(project.id);
      projectPathByID.set(project.id, project.path);
    }

    for (const existingProjectID of Array.from(tasksByProject.keys())) {
      if (!activeProjectIDs.has(existingProjectID)) {
        clearProjectTimers(existingProjectID);
        tasksByProject.delete(existingProjectID);
      }
    }

    for (const projectID of activeProjectIDs) {
      await syncProject(projectID);
    }
  };

  const queueTaskRun = (projectID, taskID, reason) => {
    const taskKey = buildTaskKey(projectID, taskID);
    if (queuedTaskKeys.has(taskKey) || runningTaskKeys.has(taskKey)) {
      return;
    }
    queuedTaskKeys.add(taskKey);
    queue.push({ projectID, taskID, reason });
  };

  const canRunTask = (projectID) => {
    if (runningGlobalCount >= maxGlobalConcurrency) {
      return false;
    }
    const projectRunning = runningCountByProject.get(projectID) || 0;
    return projectRunning < maxProjectConcurrency;
  };

  const buildPromptAsyncPayload = (task) => ({
    model: {
      providerID: task.execution.providerID,
      modelID: task.execution.modelID,
    },
    ...(task.execution.agent ? { agent: task.execution.agent } : {}),
    ...(task.execution.variant ? { variant: task.execution.variant } : {}),
    parts: [
      {
        type: 'text',
        text: task.execution.prompt,
      },
    ],
  });

  const getTaskBackendId = (task) => {
    const backendId = typeof task?.execution?.backendId === 'string' ? task.execution.backendId.trim() : '';
    return backendId || 'opencode';
  };

  const getTaskRuntime = (task) => {
    const backendId = getTaskBackendId(task);
    if (!backendRegistry?.isBackendSelectable?.(backendId)) {
      throw new Error(`Backend "${backendId}" is not available for scheduled tasks`);
    }

    const runtime = backendRegistry.getRuntime(backendId);
    if (!runtime?.createSession || !runtime?.promptAsync) {
      throw new Error(`Backend "${backendId}" does not support scheduled task execution`);
    }

    return { backendId, runtime };
  };

  const createScheduledSession = async ({ projectID, projectPath, task, title }) => {
    const { backendId, runtime } = getTaskRuntime(task);
    const session = await runtime.createSession({
      directory: projectPath,
      title,
      ...(task.execution.agent ? { mode: task.execution.agent } : {}),
      ...(task.execution.modelID ? { modelId: task.execution.modelID } : {}),
      ...(task.execution.variant ? { effort: task.execution.variant } : {}),
    });

    const sessionID = typeof session?.id === 'string' ? session.id : '';
    if (!sessionID) {
      throw new Error('failed to create session');
    }

    await sessionBindingsRuntime?.upsertBinding?.({
      sessionId: sessionID,
      backendId,
      backendSessionId: sessionID,
      directory: typeof session?.directory === 'string' && session.directory.trim().length > 0 ? session.directory.trim() : projectPath,
    });

    try {
      emitTaskRunEvent?.({
        projectID,
        taskID: task.id,
        ranAt: Date.now(),
        status: 'running',
        sessionID,
      });
    } catch {
    }

    return { backendId, runtime, sessionID };
  };

  const runPromptAsync = async ({ runtime, sessionID, projectPath, task }) => {
    await runtime.promptAsync({
      sessionID,
      directory: projectPath,
      ...buildPromptAsyncPayload(task),
    });
  };

  const runScheduledCommandIfApplicable = async ({ runtime, projectPath, sessionID, task }) => {
    const parsed = parseScheduledCommandPrompt(task?.execution?.prompt);
    if (!parsed) {
      return false;
    }

    if (!runtime?.getControlSurface) {
      return false;
    }

    let surface = null;
    try {
      surface = await runtime.getControlSurface({
        directory: projectPath,
        providerId: task.execution.providerID,
        modelId: task.execution.modelID,
      });
    } catch {
      return false;
    }

    const commandItem = Array.isArray(surface?.commandSelector?.items)
      ? surface.commandSelector.items.find((command) => command?.name === parsed.command)
      : null;
    if (!commandItem || commandItem.executionMode !== 'session-command' || !runtime?.command) {
      return false;
    }

    await runtime.command({
      sessionID,
      directory: projectPath,
      command: parsed.command,
      arguments: parsed.arguments,
      ...(task.execution.agent ? { agent: task.execution.agent } : {}),
      model: `${task.execution.providerID}/${task.execution.modelID}`,
      ...(task.execution.variant ? { variant: task.execution.variant } : {}),
    });

    return true;
  };

  const runTaskWithWatchdog = async (projectID, task, reason) => {
    const startedAt = Date.now();
    const title = formatScheduledSessionTitle(task, startedAt);
    const projectPath = projectPathByID.get(projectID);
    if (!projectPath) {
      throw new Error('project path is unavailable');
    }

    const { runtime, sessionID } = await createScheduledSession({ projectID, projectPath, task, title });

    const executedAsCommand = await runScheduledCommandIfApplicable({
      runtime,
      projectPath,
      sessionID,
      task,
    });
    if (!executedAsCommand) {
      await runPromptAsync({
        runtime,
        sessionID,
        projectPath,
        task,
      });
    }

    const finishedAt = Date.now();
    return {
      sessionID,
      durationMs: Math.max(0, finishedAt - startedAt),
      reason,
      startedAt,
      finishedAt,
    };
  };

  const runTask = async (projectID, taskID, reason) => {
    const taskMap = tasksByProject.get(projectID);
    const task = taskMap?.get(taskID);
    if (!task || !task.enabled) {
      return { ok: false, skipped: true };
    }

    const taskKey = buildTaskKey(projectID, taskID);
    if (runningTaskKeys.has(taskKey)) {
      return { ok: false, running: true };
    }

    runningTaskKeys.add(taskKey);
    runningGlobalCount += 1;
    runningCountByProject.set(projectID, (runningCountByProject.get(projectID) || 0) + 1);

    const runStartedAt = Date.now();
    await projectConfigRuntime.updateScheduledTaskState(projectID, taskID, {
      lastRunAt: runStartedAt,
      lastStatus: 'running',
      lastError: undefined,
      updatedAt: runStartedAt,
    }).then((result) => {
      if (result.task) {
        updateInMemoryTask(projectID, result.task);
      }
    });

    let status = 'success';
    let sessionID;
    let durationMs = 0;
    let errorMessage;

    try {
      const runPromise = runTaskWithWatchdog(projectID, task, reason);
      let timeoutID;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutID = setTimeout(() => {
          reject(new Error('scheduled task run timed out'));
        }, maxRunDurationMs);
      });

      const result = await Promise.race([runPromise, timeoutPromise]).finally(() => {
        if (timeoutID) {
          clearTimeout(timeoutID);
        }
      });
      sessionID = result.sessionID;
      durationMs = result.durationMs;
      status = 'success';
      logger.info?.(
        '[ScheduledTasks] run completed',
        { projectID, taskID, status, reason, sessionID, durationMs }
      );
    } catch (error) {
      status = 'error';
      errorMessage = safeErrorMessage(error);
      logger.warn?.('[ScheduledTasks] run failed', {
        projectID,
        taskID,
        reason,
        status,
        error: errorMessage,
      });
    }

    const finishedAt = Date.now();
    if (!durationMs) {
      durationMs = Math.max(0, finishedAt - runStartedAt);
    }
    let latestTask = (tasksByProject.get(projectID)?.get(taskID)) || task;
    const shouldConsumeOneTimeTask = latestTask?.schedule?.kind === 'once' && reason === 'scheduled';
    if (shouldConsumeOneTimeTask && latestTask?.enabled) {
      try {
        const consumed = await projectConfigRuntime.upsertScheduledTask(projectID, {
          ...latestTask,
          enabled: false,
        });
        latestTask = consumed.task || latestTask;
        updateInMemoryTask(projectID, latestTask);
      } catch (consumeError) {
        logger.warn?.('[ScheduledTasks] failed to consume one-time task', {
          projectID,
          taskID,
          error: safeErrorMessage(consumeError),
        });
      }
    }

    const nextRunAt = computeNextRunAt(latestTask, finishedAt);

    const statePatch = {
      lastStatus: status,
      lastDurationMs: durationMs,
      lastError: status === 'error' ? errorMessage : undefined,
      lastSessionId: status === 'success' ? sessionID : undefined,
      nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : undefined,
      updatedAt: finishedAt,
    };

    const stateResult = await projectConfigRuntime.updateScheduledTaskState(projectID, taskID, statePatch);
    if (stateResult.task) {
      updateInMemoryTask(projectID, stateResult.task);
      if (stateResult.task.enabled && Number.isFinite(stateResult.task.state?.nextRunAt)) {
        scheduleTask(projectID, taskID, stateResult.task.state.nextRunAt);
      }
    }

    try {
      emitTaskRunEvent?.({
        projectID,
        taskID,
        ranAt: finishedAt,
        status,
        ...(sessionID ? { sessionID } : {}),
      });
    } catch {
    }

    runningTaskKeys.delete(taskKey);
    runningGlobalCount = Math.max(0, runningGlobalCount - 1);
    const nextProjectCount = Math.max(0, (runningCountByProject.get(projectID) || 1) - 1);
    if (nextProjectCount === 0) {
      runningCountByProject.delete(projectID);
    } else {
      runningCountByProject.set(projectID, nextProjectCount);
    }

    return {
      ok: status === 'success',
      status,
      sessionID,
      task: stateResult.task || null,
      error: errorMessage,
    };
  };

  const pumpQueue = () => {
    if (!started) {
      return;
    }

    let consumed = false;
    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      if (!canRunTask(item.projectID)) {
        continue;
      }

      queue.splice(index, 1);
      index -= 1;

      const taskKey = buildTaskKey(item.projectID, item.taskID);
      queuedTaskKeys.delete(taskKey);
      consumed = true;

      void runTask(item.projectID, item.taskID, item.reason).finally(() => {
        pumpQueue();
      });
    }

    if (!consumed && queue.length > 0) {
      return;
    }
  };

  const runNow = async (projectID, taskID) => {
    const taskKey = buildTaskKey(projectID, taskID);
    if (runningTaskKeys.has(taskKey)) {
      return {
        ok: false,
        running: true,
        error: 'task is already running',
      };
    }
    if (queuedTaskKeys.has(taskKey)) {
      return {
        ok: false,
        queued: true,
        error: 'task is already queued',
      };
    }

    return runTask(projectID, taskID, 'manual');
  };

  const start = async () => {
    if (started) {
      return;
    }
    started = true;
    await syncAllProjects();
  };

  const stop = () => {
    if (!started) {
      return;
    }
    started = false;
    for (const timer of timersByTaskKey.values()) {
      clearTimeout(timer);
    }
    timersByTaskKey.clear();
    queuedTaskKeys.clear();
    queue.length = 0;
  };

  return {
    start,
    stop,
    syncAllProjects,
    syncProject,
    runNow,
  };
};

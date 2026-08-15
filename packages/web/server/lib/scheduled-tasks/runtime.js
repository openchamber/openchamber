import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { DateTime } from 'luxon';
import parser from 'cron-parser';
import { expandSnippets } from '../opencode/snippets.js';
import { buildGoalIntroText, createSessionGoal } from '../session-goal/create.js';
import { discoverLoops } from './loops.js';

const DEFAULT_GLOBAL_CONCURRENCY = 4;
const DEFAULT_PROJECT_CONCURRENCY = 2;
const DEFAULT_MAX_RUN_MS = 30 * 60 * 1000;
const JITTER_MAX_MS = 2_000;
const TASK_TITLE_MAX_LENGTH = 120;
const TASK_DUE_SLACK_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_ARCHIVE_MAX_WAIT_MS = 30 * 60 * 1000;

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

const readSessionStatus = (payload) => {
  if (payload?.type === 'session.idle') {
    const sessionID = typeof payload.properties?.sessionID === 'string'
      ? payload.properties.sessionID.trim()
      : '';
    return sessionID ? { sessionID, type: 'idle' } : null;
  }
  if (payload?.type !== 'session.status') {
    return null;
  }
  const sessionID = typeof payload.properties?.sessionID === 'string'
    ? payload.properties.sessionID.trim()
    : '';
  const type = typeof payload.properties?.status?.type === 'string'
    ? payload.properties.status.type.trim()
    : (typeof payload.properties?.info?.type === 'string' ? payload.properties.info.type.trim() : '');
  return sessionID && type ? { sessionID, type } : null;
};

const readSessionFailure = (payload) => {
  if (payload?.type === 'session.error') {
    const sessionID = typeof payload.properties?.sessionID === 'string'
      ? payload.properties.sessionID.trim()
      : '';
    return sessionID ? { sessionID, message: 'Scheduled run session failed' } : null;
  }
  const info = payload?.type === 'message.updated' ? payload.properties?.info : null;
  if (info?.role !== 'assistant' || !info.error || typeof info.sessionID !== 'string') {
    return null;
  }
  const errorName = typeof info.error.name === 'string' ? info.error.name : 'AssistantError';
  return { sessionID: info.sessionID, message: `Scheduled run session failed: ${errorName}` };
};

const readErrorStatus = (error) => {
  const candidates = [error?.status, error?.statusCode, error?.response?.status, error?.data?.status];
  for (const value of candidates) {
    const status = Number(value);
    if (Number.isFinite(status) && status > 0) {
      return status;
    }
  }
  return null;
};

const isSessionMissing = (error) => {
  if (!error) {
    return false;
  }
  if (error.sessionMissing === true) {
    return true;
  }
  if (readErrorStatus(error) === 404) {
    return true;
  }
  const name = typeof error.name === 'string' ? error.name : '';
  if (/notfound/i.test(name)) {
    return true;
  }
  const message = safeErrorMessage(error);
  return /\b404\b|not found|does not exist|unknown session/i.test(message);
};

const wrapSdkFailure = (error, fallback) => {
  const wrapped = new Error(safeErrorMessage(error ?? fallback));
  const status = readErrorStatus(error);
  if (status) {
    wrapped.statusCode = status;
  }
  if (isSessionMissing(error)) {
    wrapped.sessionMissing = true;
  }
  return wrapped;
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

export const expandCommandGoalObjective = (template, argumentsText) => {
  if (typeof template !== 'string' || !template.trim()) {
    return null;
  }

  const rawArguments = String(argumentsText ?? '');
  if (template.includes('$ARGUMENTS')) {
    return template.replaceAll('$ARGUMENTS', rawArguments);
  }

  const positions = [...template.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  if (positions.length > 0) {
    const parsedArguments = [...rawArguments.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
      .map((match) => match[1] ?? match[2] ?? match[3] ?? '');
    const lastPosition = Math.max(...positions);
    return template.replace(/\$(\d+)/g, (_match, value) => {
      const position = Number(value);
      return position === lastPosition
        ? parsedArguments.slice(position - 1).join(' ')
        : (parsedArguments[position - 1] ?? '');
    });
  }

  return rawArguments ? `${template}\n\n${rawArguments}` : template;
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
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    waitForOpenCodeReady,
    emitTaskRunEvent,
    setSessionAutoAccept,
    createClient = createOpencodeClient,
    createGoal = createSessionGoal,
    logger = console,
    maxGlobalConcurrency = DEFAULT_GLOBAL_CONCURRENCY,
    maxProjectConcurrency = DEFAULT_PROJECT_CONCURRENCY,
    maxRunDurationMs = DEFAULT_MAX_RUN_MS,
    archiveQuietMs = 2_000,
    archiveRetryBaseMs = 5_000,
    archiveMaxWaitMs = DEFAULT_ARCHIVE_MAX_WAIT_MS,
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
  const pendingArchives = new Map();
  const archiveQuietTimers = new Map();

  const computeRetryDelay = (attempts) => {
    const baseDelay = Math.max(1, archiveRetryBaseMs);
    return Math.min(baseDelay * (2 ** Math.min(Math.max(0, attempts - 1), 6)), 60_000);
  };

  const updateArchiveError = async (pending, error, prefix = 'Failed to archive run session') => {
    const message = `${prefix}: ${safeErrorMessage(error)}`;
    logger.warn?.('[ScheduledTasks] run session archive failed', {
      projectID: pending.projectID,
      taskID: pending.taskID,
      sessionID: pending.sessionID,
      error: message,
    });

    const currentTask = tasksByProject.get(pending.projectID)?.get(pending.taskID);
    const stillPending = currentTask?.state?.pendingArchives?.some(
      (entry) => entry.sessionId === pending.sessionID,
    );
    if (!stillPending) {
      return;
    }
    const result = await projectConfigRuntime.updateScheduledTaskState(pending.projectID, pending.taskID, {
      lastArchiveError: message,
    });
    if (result.task) {
      updateInMemoryTask(pending.projectID, result.task);
    }
    try {
      emitTaskRunEvent?.({
        projectID: pending.projectID,
        taskID: pending.taskID,
        ranAt: Date.now(),
        status: 'success',
        sessionID: pending.sessionID,
      });
    } catch {
    }
  };

  const removePersistedPendingArchive = async (pending, extraPatch = {}) => {
    const result = await projectConfigRuntime.updateScheduledTaskState(pending.projectID, pending.taskID, {
      removePendingArchiveSessionId: pending.sessionID,
      ...extraPatch,
    });
    if (result.task) {
      updateInMemoryTask(pending.projectID, result.task);
    }
  };

  const clearPendingArchiveTimer = (sessionID) => {
    const timer = archiveQuietTimers.get(sessionID);
    if (timer) {
      clearTimeout(timer);
      archiveQuietTimers.delete(sessionID);
    }
  };

  const isArchiveWaitExpired = (pending) => {
    const stallStartedAt = Number.isFinite(pending?.stallStartedAt) ? pending.stallStartedAt : 0;
    return stallStartedAt > 0 && Date.now() - stallStartedAt >= archiveMaxWaitMs;
  };

  const markPendingStillWorking = (pending) => {
    pending.stallStartedAt = 0;
    pending.quietPasses = 0;
  };

  const markPendingStalled = (pending) => {
    if (!Number.isFinite(pending.stallStartedAt) || pending.stallStartedAt <= 0) {
      pending.stallStartedAt = Date.now();
    }
    pending.quietPasses = 0;
  };

  const abandonPendingArchive = async (pending, error, prefix = 'Stopped waiting to archive run session') => {
    const sessionID = pending.sessionID;
    clearPendingArchiveTimer(sessionID);
    pendingArchives.delete(sessionID);
    const message = `${prefix}: ${safeErrorMessage(error)}`;
    logger.warn?.('[ScheduledTasks] abandoned run session archive', {
      projectID: pending.projectID,
      taskID: pending.taskID,
      sessionID,
      error: message,
    });
    await removePersistedPendingArchive(pending, { lastArchiveError: message });
    try {
      emitTaskRunEvent?.({
        projectID: pending.projectID,
        taskID: pending.taskID,
        ranAt: Date.now(),
        status: 'success',
        sessionID,
      });
    } catch {
    }
  };

  const cleanupMissingSession = async (pending) => {
    clearPendingArchiveTimer(pending.sessionID);
    pendingArchives.delete(pending.sessionID);
    await removePersistedPendingArchive(pending);
  };

  const markPendingRunFailed = async (sessionID) => {
    const pending = pendingArchives.get(sessionID);
    if (!pending || !pending.failure || !pending.statePersisted) {
      return;
    }
    pendingArchives.delete(sessionID);
    clearPendingArchiveTimer(sessionID);
    const currentTask = tasksByProject.get(pending.projectID)?.get(pending.taskID);
    await removePersistedPendingArchive(pending, currentTask?.state?.lastSessionId === sessionID
      ? { lastStatus: 'error', lastError: pending.failure }
      : {});
    try {
      emitTaskRunEvent?.({
        projectID: pending.projectID,
        taskID: pending.taskID,
        ranAt: Date.now(),
        status: 'error',
        sessionID,
      });
    } catch {
    }
  };

  const archivePendingSession = async (sessionID) => {
    const pending = pendingArchives.get(sessionID);
    if (!pending || pending.archiving) {
      return;
    }
    pending.archiving = true;
    const timer = archiveQuietTimers.get(sessionID);
    if (timer) {
      clearTimeout(timer);
      archiveQuietTimers.delete(sessionID);
    }

    try {
      const client = createClient({
        baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
        headers: getOpenCodeAuthHeaders(),
      });
      const response = await client.session.update({
        sessionID,
        directory: pending.directory,
        time: { archived: Date.now() },
      });
      if (!response?.data?.time?.archived) {
        throw wrapSdkFailure(response?.error, 'OpenCode did not confirm session archival');
      }
      await removePersistedPendingArchive(pending);
      pendingArchives.delete(sessionID);
    } catch (error) {
      if (isSessionMissing(error)) {
        await cleanupMissingSession(pending);
        return;
      }
      pending.archiving = false;
      pending.archiveAttempts += 1;
      markPendingStalled(pending);
      if (isArchiveWaitExpired(pending)) {
        await abandonPendingArchive(pending, error);
        return;
      }
      try {
        await updateArchiveError(pending, error);
      } catch (stateError) {
        logger.warn?.('[ScheduledTasks] failed to persist run session archive warning', {
          projectID: pending.projectID,
          taskID: pending.taskID,
          sessionID: pending.sessionID,
          error: safeErrorMessage(stateError),
        });
      }
      scheduleQuiescenceCheck(sessionID, computeRetryDelay(pending.archiveAttempts));
    }
  };

  const fetchPendingGoalStatus = async (client, pending) => {
    const sessionResponse = await client.session.get({
      sessionID: pending.sessionID,
      directory: pending.directory,
    });
    if (sessionResponse?.error || !sessionResponse?.data) {
      throw wrapSdkFailure(
        sessionResponse?.error,
        'OpenCode did not return the pending goal session',
      );
    }
    const status = sessionResponse.data.metadata?.openchamber?.goal?.status;
    return typeof status === 'string' ? status : '';
  };

  async function confirmPendingSessionQuiescent(sessionID) {
    archiveQuietTimers.delete(sessionID);
    const pending = pendingArchives.get(sessionID);
    if (!pending || pending.failure) {
      if (pending?.failure) {
        await markPendingRunFailed(sessionID);
      }
      return;
    }
    if (isArchiveWaitExpired(pending)) {
      await abandonPendingArchive(pending, new Error('run session did not become idle in time'));
      return;
    }
    const client = createClient({
      baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
      headers: getOpenCodeAuthHeaders(),
    });
    try {
      if (pending.goalEnabled) {
        pending.goalStatus = await fetchPendingGoalStatus(client, pending);
        if (pending.goalStatus !== 'active' && pending.goalStatus !== 'complete') {
          pendingArchives.delete(sessionID);
          await removePersistedPendingArchive(pending);
          return;
        }
        if (pending.goalStatus !== 'complete') {
          markPendingStillWorking(pending);
          scheduleQuiescenceCheck(sessionID);
          return;
        }
      }

      const statusResponse = await client.session.status({ directory: pending.directory });
      if (statusResponse?.error || !statusResponse?.data || typeof statusResponse.data !== 'object') {
        throw wrapSdkFailure(statusResponse?.error, 'OpenCode did not return session status');
      }
      const statuses = statusResponse.data;
      const parentStatus = statuses[sessionID]?.type ?? 'idle';
      if (parentStatus === 'busy' || parentStatus === 'retry') {
        markPendingStillWorking(pending);
        scheduleQuiescenceCheck(sessionID);
        return;
      }

      const childrenResponse = await client.session.children({
        sessionID,
        directory: pending.directory,
      });
      if (childrenResponse?.error || !Array.isArray(childrenResponse?.data)) {
        throw wrapSdkFailure(childrenResponse?.error, 'OpenCode did not return session children');
      }
      const hasWorkingChild = childrenResponse.data.some((child) => {
        const childStatus = typeof child?.id === 'string' ? statuses[child.id]?.type : null;
        return childStatus === 'busy' || childStatus === 'retry';
      });
      if (hasWorkingChild) {
        markPendingStillWorking(pending);
        scheduleQuiescenceCheck(sessionID);
        return;
      }

      const messagesResponse = await client.session.messages({
        sessionID,
        directory: pending.directory,
        limit: 20,
      });
      if (messagesResponse?.error || !Array.isArray(messagesResponse?.data)) {
        throw wrapSdkFailure(messagesResponse?.error, 'OpenCode did not return session messages');
      }
      const lastMessage = messagesResponse.data.at(-1);
      if (lastMessage?.info?.role !== 'assistant' || !lastMessage.info?.time?.completed) {
        markPendingStalled(pending);
        if (isArchiveWaitExpired(pending)) {
          await abandonPendingArchive(pending, new Error('run session did not become idle in time'));
          return;
        }
        scheduleQuiescenceCheck(sessionID);
        return;
      }
      if (lastMessage.info.error) {
        pending.failure = `Scheduled run session failed: ${lastMessage.info.error.name ?? 'AssistantError'}`;
        await markPendingRunFailed(sessionID);
        return;
      }

      const finalStatusResponse = await client.session.status({ directory: pending.directory });
      if (finalStatusResponse?.error
        || !finalStatusResponse?.data
        || typeof finalStatusResponse.data !== 'object') {
        throw wrapSdkFailure(
          finalStatusResponse?.error,
          'OpenCode did not return final session status',
        );
      }
      const finalStatuses = finalStatusResponse.data;
      const finalParentStatus = finalStatuses[sessionID]?.type ?? 'idle';
      const hasWorkingChildAfterMessages = childrenResponse.data.some((child) => {
        const childStatus = typeof child?.id === 'string' ? finalStatuses[child.id]?.type : null;
        return childStatus === 'busy' || childStatus === 'retry';
      });
      if (finalParentStatus === 'busy' || finalParentStatus === 'retry' || hasWorkingChildAfterMessages) {
        markPendingStillWorking(pending);
        scheduleQuiescenceCheck(sessionID);
        return;
      }

      if (pending.goalEnabled) {
        pending.goalStatus = await fetchPendingGoalStatus(client, pending);
        if (pending.goalStatus !== 'active' && pending.goalStatus !== 'complete') {
          pendingArchives.delete(sessionID);
          await removePersistedPendingArchive(pending);
          return;
        }
        if (pending.goalStatus !== 'complete') {
          markPendingStillWorking(pending);
          scheduleQuiescenceCheck(sessionID);
          return;
        }
      }

      pending.quietCheckAttempts = 0;
      if (pending.quietPasses < 1) {
        pending.quietPasses += 1;
        scheduleQuiescenceCheck(sessionID);
        return;
      }

      await archivePendingSession(sessionID);
    } catch (error) {
      if (isSessionMissing(error)) {
        await cleanupMissingSession(pending);
        return;
      }
      if (isArchiveWaitExpired(pending)) {
        await abandonPendingArchive(pending, error);
        return;
      }
      pending.quietCheckAttempts += 1;
      logger.warn?.('[ScheduledTasks] failed to verify run session completion', {
        projectID: pending.projectID,
        taskID: pending.taskID,
        sessionID,
        error: safeErrorMessage(error),
      });
      if (pending.quietCheckAttempts === 3) {
        try {
          await updateArchiveError(pending, error, 'Failed to verify run session completion');
        } catch (stateError) {
          logger.warn?.('[ScheduledTasks] failed to persist run session verification warning', {
            projectID: pending.projectID,
            taskID: pending.taskID,
            sessionID,
            error: safeErrorMessage(stateError),
          });
        }
      }
      scheduleQuiescenceCheck(sessionID, computeRetryDelay(pending.quietCheckAttempts));
    }
  }

  function scheduleQuiescenceCheck(sessionID, delay = archiveQuietMs) {
    if (archiveQuietTimers.has(sessionID)) {
      return;
    }
    const timer = setTimeout(() => {
      void confirmPendingSessionQuiescent(sessionID);
    }, delay);
    archiveQuietTimers.set(sessionID, timer);
  }

  const maybeArchivePendingSession = (sessionID) => {
    const pending = pendingArchives.get(sessionID);
    if (!pending?.armed || !pending.statePersisted) {
      return;
    }
    if (pending.failure) {
      void markPendingRunFailed(sessionID);
      return;
    }
    scheduleQuiescenceCheck(sessionID);
  };

  const registerPendingArchive = ({
    projectID,
    taskID,
    sessionID,
    directory,
    goalEnabled,
    armed = false,
    statePersisted = false,
    createdAt = Date.now(),
  }) => {
    pendingArchives.set(sessionID, {
      projectID,
      taskID,
      sessionID,
      directory,
      goalEnabled,
      armed,
      statePersisted,
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      stallStartedAt: 0,
      goalStatus: '',
      failure: '',
      quietCheckAttempts: 0,
      quietPasses: 0,
      archiveAttempts: 0,
      archiving: false,
    });
  };

  const resumePendingArchives = async (projectID, task) => {
    const client = createClient({
      baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
      headers: getOpenCodeAuthHeaders(),
    });
    for (const record of task?.state?.pendingArchives ?? []) {
      const sessionID = record.sessionId;
      let pending = pendingArchives.get(sessionID);
      if (pending) {
        pending.projectID = projectID;
        pending.taskID = task.id;
        pending.directory = record.directory;
        pending.goalEnabled = record.goalEnabled === true;
        pending.armed = true;
        pending.statePersisted = true;
      } else {
        registerPendingArchive({
          projectID,
          taskID: task.id,
          sessionID,
          directory: record.directory,
          goalEnabled: record.goalEnabled === true,
          armed: true,
          statePersisted: true,
          createdAt: record.createdAt,
        });
        pending = pendingArchives.get(sessionID);
      }
      try {
        const sessionResponse = await client.session.get({ sessionID, directory: record.directory });
        if (sessionResponse?.error || !sessionResponse?.data) {
          throw wrapSdkFailure(sessionResponse?.error, 'OpenCode did not return the pending session');
        }
        if (sessionResponse.data.time?.archived) {
          pendingArchives.delete(sessionID);
          await removePersistedPendingArchive({
            projectID,
            taskID: task.id,
            sessionID,
          });
          continue;
        }

        const goalStatus = sessionResponse.data.metadata?.openchamber?.goal?.status;
        if (pending?.goalEnabled) {
          pending.goalStatus = typeof goalStatus === 'string' ? goalStatus : '';
          if (pending.goalStatus !== 'active' && pending.goalStatus !== 'complete') {
            pendingArchives.delete(sessionID);
            await removePersistedPendingArchive(pending);
            continue;
          }
          maybeArchivePendingSession(sessionID);
          continue;
        }

        const statusResponse = await client.session.status({ directory: record.directory });
        if (statusResponse?.error || !statusResponse?.data || typeof statusResponse.data !== 'object') {
          throw wrapSdkFailure(statusResponse?.error, 'OpenCode did not return session status');
        }
        maybeArchivePendingSession(sessionID);
      } catch (error) {
        if (isSessionMissing(error)) {
          await cleanupMissingSession(pending);
          continue;
        }
        logger.warn?.('[ScheduledTasks] failed to resume pending session archive', {
          projectID,
          taskID: task.id,
          sessionID,
          error: safeErrorMessage(error),
        });
        maybeArchivePendingSession(sessionID);
      }
    }
  };

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
    for (const [sessionID, pending] of pendingArchives) {
      const task = pending.projectID === projectID ? taskMap.get(pending.taskID) : null;
      const stillPending = task?.state?.pendingArchives?.some((entry) => entry.sessionId === sessionID);
      if (pending.projectID === projectID && pending.statePersisted && !stillPending) {
        pendingArchives.delete(sessionID);
      }
    }
  };

  const scheduleTask = (projectID, taskID, nextRunAt) => {
    const taskKey = buildTaskKey(projectID, taskID);
    clearTimerForKey(taskKey);

    if (!started) {
      return;
    }

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
      queueTaskRun(projectID, taskID, 'scheduled', nextRunAt);
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
    const projectPath = projectPathByID.get(projectID) || null;

    let tasks;
    if (projectPath) {
      // Reconcile `.agents/loops` definitions with the persisted task list:
      // loop files are authoritative while present, removed files unschedule
      // their task, and runtime state is preserved (see loops.js).
      const loops = await discoverLoops(projectPath);
      tasks = await projectConfigRuntime.reconcileLoopTasks(projectID, loops);
    } else {
      tasks = await projectConfigRuntime.listScheduledTasks(projectID);
    }

    setProjectTasks(projectID, tasks);

    for (const task of tasks) {
      await syncTaskSchedule(projectID, task);
      await resumePendingArchives(projectID, task);
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

  const queueTaskRun = (projectID, taskID, reason, scheduledFor) => {
    const taskKey = buildTaskKey(projectID, taskID);
    if (queuedTaskKeys.has(taskKey) || runningTaskKeys.has(taskKey)) {
      return;
    }
    queuedTaskKeys.add(taskKey);
    queue.push({
      projectID,
      taskID,
      reason,
      ...(Number.isFinite(scheduledFor) ? { scheduledFor } : {}),
    });
  };

  const canRunTask = (projectID) => {
    if (runningGlobalCount >= maxGlobalConcurrency) {
      return false;
    }
    const projectRunning = runningCountByProject.get(projectID) || 0;
    return projectRunning < maxProjectConcurrency;
  };

  const buildPromptAsyncPayload = (task, projectPath) => ({
    model: {
      providerID: task.execution.providerID,
      modelID: task.execution.modelID,
    },
    ...(task.execution.agent ? { agent: task.execution.agent } : {}),
    ...(task.execution.variant ? { variant: task.execution.variant } : {}),
    parts: [
      {
        type: 'text',
        text: expandSnippets(task.execution.prompt, projectPath),
      },
      ...(task.execution.goalEnabled
        ? [{ type: 'text', text: buildGoalIntroText(task.execution.goalTokenBudget), synthetic: true }]
        : []),
    ],
  });

  const runPromptAsync = async ({ baseUrl, authHeaders, sessionID, projectPath, task }) => {
    const promptUrl = new URL(`${baseUrl}/session/${encodeURIComponent(sessionID)}/prompt_async`);
    promptUrl.searchParams.set('directory', projectPath);
    const response = await fetch(promptUrl.toString(), {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(buildPromptAsyncPayload(task, projectPath)),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`prompt_async failed (${response.status})${body ? `: ${body}` : ''}`);
    }
  };

  const resolveScheduledCommand = async ({ client, projectPath, task }) => {
    const parsed = parseScheduledCommandPrompt(task?.execution?.prompt);
    if (!parsed) {
      return null;
    }

    let commands = [];
    try {
      const response = await client.command.list({ directory: projectPath });
      commands = Array.isArray(response?.data) ? response.data : [];
    } catch {
      return null;
    }

    const command = commands.find((candidate) => candidate?.name === parsed.command);
    return command ? { ...parsed, template: command.template } : null;
  };

  const runScheduledCommand = async ({ client, projectPath, sessionID, task, command }) => {
    await client.session.command({
      sessionID,
      directory: projectPath,
      command: command.command,
      arguments: command.arguments,
      ...(task.execution.agent ? { agent: task.execution.agent } : {}),
      model: `${task.execution.providerID}/${task.execution.modelID}`,
      ...(task.execution.variant ? { variant: task.execution.variant } : {}),
    });

  };

  const runTaskWithWatchdog = async (projectID, task, reason) => {
    const startedAt = Date.now();
    const title = formatScheduledSessionTitle(task, startedAt);
    const projectPath = projectPathByID.get(projectID);
    if (!projectPath) {
      throw new Error('project path is unavailable');
    }

    if (typeof waitForOpenCodeReady === 'function') {
      await waitForOpenCodeReady(10_000, 250);
    }

    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    const authHeaders = getOpenCodeAuthHeaders();
    const client = createClient({
      baseUrl,
      headers: authHeaders,
    });

    const sessionResponse = await client.session.create({
      directory: projectPath,
      title,
    });
    const sessionID = sessionResponse?.data?.id;
    if (!sessionID) {
      throw new Error('failed to create session');
    }

    if (task.execution.archiveOnSuccess) {
      registerPendingArchive({
        projectID,
        taskID: task.id,
        sessionID,
        directory: projectPath,
        goalEnabled: task.execution.goalEnabled === true,
      });
    }

    try {
      emitTaskRunEvent?.({
        projectID,
        taskID: task.id,
        ranAt: startedAt,
        status: 'running',
        sessionID,
      });
    } catch {
    }

    try {
      if (task.execution.permissionAutoAccept && typeof setSessionAutoAccept === 'function') {
        // Enroll before the prompt goes out so the very first permission request
        // is already auto-approved. Enrollment failure must not kill the run —
        // the task still executes, permissions just wait for the user.
        try {
          await setSessionAutoAccept(sessionID, true, projectPath);
        } catch (error) {
          logger.warn?.('[scheduled-tasks] failed to enable permission auto-accept for session', sessionID, error?.message ?? error);
        }
      }

      const scheduledCommand = await resolveScheduledCommand({ client, projectPath, task });

      if (task.execution.goalEnabled) {
        const commandObjective = scheduledCommand
          ? expandCommandGoalObjective(scheduledCommand.template, scheduledCommand.arguments)
          : null;
        await createGoal({
          baseUrl,
          authHeaders,
          sessionID,
          directory: projectPath,
          objective: commandObjective ?? expandSnippets(task.execution.prompt, projectPath),
          tokenBudget: task.execution.goalTokenBudget,
          providerID: task.execution.providerID,
          modelID: task.execution.modelID,
          onWarning: (message, error) => console.warn(`[scheduled-tasks] ${message}:`, error?.message || error),
        });
      }

      if (scheduledCommand) {
        await runScheduledCommand({ client, projectPath, sessionID, task, command: scheduledCommand });
      } else {
        await runPromptAsync({
          baseUrl,
          authHeaders,
          sessionID,
          projectPath,
          task,
        });
      }

      const pendingArchive = pendingArchives.get(sessionID);
      if (pendingArchive) {
        pendingArchive.armed = true;
        maybeArchivePendingSession(sessionID);
      }
    } catch (error) {
      pendingArchives.delete(sessionID);
      throw error;
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

  const releaseRunningSlot = (projectID, taskKey) => {
    runningTaskKeys.delete(taskKey);
    runningGlobalCount = Math.max(0, runningGlobalCount - 1);
    const nextProjectCount = Math.max(0, (runningCountByProject.get(projectID) || 1) - 1);
    if (nextProjectCount === 0) {
      runningCountByProject.delete(projectID);
    } else {
      runningCountByProject.set(projectID, nextProjectCount);
    }
  };

  /**
   * Arm a timer only for a future occurrence. Scheduling a past nextRunAt
   * (delay 0 + jitter) re-enters the claim path immediately and can spin —
   * especially for once tasks where the claim cannot advance nextRunAt.
   */
  const scheduleFutureRun = (projectID, taskID, nextRunAt, fromMs = Date.now()) => {
    if (!Number.isFinite(nextRunAt)) {
      return false;
    }
    const base = Number.isFinite(fromMs) ? fromMs : Date.now();
    if (nextRunAt <= base) {
      return false;
    }
    scheduleTask(projectID, taskID, nextRunAt);
    return true;
  };

  const rearmFromTaskOrCompute = (projectID, taskID, fallbackTask, fromMs) => {
    const latest = (tasksByProject.get(projectID)?.get(taskID)) || fallbackTask;
    if (!latest?.enabled) {
      return;
    }
    const base = Number.isFinite(fromMs) ? fromMs : Date.now();
    const persistedNext = latest.state?.nextRunAt;
    // Prefer a still-future persisted slot; never re-arm a past occurrence
    // (that created silent once-task loser loops and claim-failed retry spam).
    if (scheduleFutureRun(projectID, taskID, persistedNext, base)) {
      return;
    }
    const computedNext = computeNextRunAt(latest, base);
    scheduleFutureRun(projectID, taskID, computedNext, base);
  };

  const runTask = async (projectID, taskID, reason, scheduledFor) => {
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

    // Every path that holds the running slot must exit through this finally so
    // lock timeouts / fs errors on claim, manual-start, or completion writes
    // cannot permanently stuck-run the task in this process.
    try {
      const runStartedAt = Date.now();

      // Scheduled dispatches must claim the occurrence in shared project config
      // before creating a session. Two server instances (e.g. CLI serve + desktop)
      // each arm their own timer; without this claim both would run (#2710).
      if (reason === 'scheduled') {
        if (!Number.isFinite(scheduledFor)) {
          return { ok: false, skipped: true, reason: 'missing-scheduled-for' };
        }

        const nextAfterClaim = computeNextRunAt(task, Math.max(runStartedAt, scheduledFor + 1));
        const claimPatch = {
          lastScheduledFor: Math.round(scheduledFor),
          lastRunAt: runStartedAt,
          lastStatus: 'running',
          lastError: undefined,
          ...(task.state?.pendingArchives?.length ? {} : { lastArchiveError: undefined }),
          updatedAt: runStartedAt,
          // Always set nextRunAt so a past once-slot is cleared when there is
          // no following occurrence (omitting the key would leave the past value).
          nextRunAt: Number.isFinite(nextAfterClaim) ? nextAfterClaim : undefined,
        };

        // Duplicate protection is solely lastScheduledFor within slack of this
        // occurrence. Do not reject on advanced disk nextRunAt: lastScheduledFor
        // persists across days, so a second-instance sync inside TASK_DUE_SLACK_MS
        // would otherwise suppress every armed occurrence after the first.
        const canClaimOccurrence = (candidate) => {
          if (!candidate?.enabled) {
            return false;
          }
          const lastScheduledFor = candidate.state?.lastScheduledFor;
          if (
            Number.isFinite(lastScheduledFor)
            && Math.abs(lastScheduledFor - scheduledFor) <= TASK_DUE_SLACK_MS
          ) {
            return false;
          }
          return true;
        };

        let claimResult;
        try {
          if (typeof projectConfigRuntime.updateScheduledTaskStateIf === 'function') {
            claimResult = await projectConfigRuntime.updateScheduledTaskStateIf(
              projectID,
              taskID,
              canClaimOccurrence,
              claimPatch,
            );
          } else {
            // Fallback for older test doubles: unconditional update (single-instance only).
            claimResult = await projectConfigRuntime.updateScheduledTaskState(projectID, taskID, claimPatch);
            claimResult = { ...claimResult, updated: Boolean(claimResult?.task) };
          }
        } catch (claimError) {
          const message = safeErrorMessage(claimError);
          logger.warn?.('[ScheduledTasks] occurrence claim failed', {
            projectID,
            taskID,
            error: message,
          });
          rearmFromTaskOrCompute(projectID, taskID, task, Math.max(runStartedAt, scheduledFor + 1));

          // Best-effort record so once tasks are not left enabled-but-inert with
          // no UI signal. Do not clobber a winner that claimed this occurrence.
          const claimFailurePatch = {
            lastStatus: 'error',
            lastError: `Scheduled claim failed: ${message}`,
            updatedAt: Date.now(),
          };
          try {
            if (typeof projectConfigRuntime.updateScheduledTaskStateIf === 'function') {
              const recorded = await projectConfigRuntime.updateScheduledTaskStateIf(
                projectID,
                taskID,
                (candidate) => {
                  const lastScheduledFor = candidate.state?.lastScheduledFor;
                  if (
                    Number.isFinite(lastScheduledFor)
                    && Math.abs(lastScheduledFor - scheduledFor) <= TASK_DUE_SLACK_MS
                  ) {
                    return false;
                  }
                  return true;
                },
                claimFailurePatch,
              );
              if (recorded.task) {
                updateInMemoryTask(projectID, recorded.task);
              }
            } else {
              const recorded = await projectConfigRuntime.updateScheduledTaskState(
                projectID,
                taskID,
                claimFailurePatch,
              );
              if (recorded.task) {
                updateInMemoryTask(projectID, recorded.task);
              }
            }
          } catch {
            updateInMemoryTask(projectID, {
              ...task,
              state: {
                ...(task.state || {}),
                ...claimFailurePatch,
              },
            });
          }

          return { ok: false, skipped: true, reason: 'claim-failed', error: message };
        }

        if (!claimResult?.updated) {
          if (claimResult?.task) {
            updateInMemoryTask(projectID, claimResult.task);
            // Loser must not schedule a past nextRunAt (once-task spin).
            rearmFromTaskOrCompute(
              projectID,
              taskID,
              claimResult.task,
              Math.max(Date.now(), scheduledFor + 1),
            );
          }
          return { ok: false, skipped: true, reason: 'occurrence-claimed' };
        }

        if (claimResult.task) {
          updateInMemoryTask(projectID, claimResult.task);
        }
      } else {
        try {
          const startResult = await projectConfigRuntime.updateScheduledTaskState(projectID, taskID, {
            lastRunAt: runStartedAt,
            lastStatus: 'running',
            lastError: undefined,
            ...(task.state?.pendingArchives?.length ? {} : { lastArchiveError: undefined }),
            updatedAt: runStartedAt,
          });
          if (startResult.task) {
            updateInMemoryTask(projectID, startResult.task);
          }
        } catch (startError) {
          const message = safeErrorMessage(startError);
          logger.warn?.('[ScheduledTasks] manual start state write failed', {
            projectID,
            taskID,
            error: message,
          });
          return { ok: false, error: message, reason: 'start-state-failed' };
        }
      }

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
      const runDirectory = projectPathByID.get(projectID);
      const pendingArchive = sessionID ? pendingArchives.get(sessionID) : null;
      const addedPendingArchive = status === 'success'
        && sessionID
        && task.execution.archiveOnSuccess
        && typeof runDirectory === 'string'
        && runDirectory.length > 0
        ? {
            sessionId: sessionID,
            directory: runDirectory,
            goalEnabled: task.execution.goalEnabled === true,
            createdAt: pendingArchive?.createdAt ?? Date.now(),
          }
        : null;

      const statePatch = {
        lastStatus: status,
        lastDurationMs: durationMs,
        lastError: status === 'error' ? errorMessage : undefined,
        lastSessionId: status === 'success' ? sessionID : undefined,
        ...(addedPendingArchive ? { pendingArchives: [addedPendingArchive] } : {}),
        nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : undefined,
        updatedAt: finishedAt,
      };

      let stateResult = { task: null };
      try {
        stateResult = await projectConfigRuntime.updateScheduledTaskState(projectID, taskID, statePatch);
        if (stateResult.task) {
          updateInMemoryTask(projectID, stateResult.task);
          if (stateResult.task.enabled) {
            scheduleFutureRun(
              projectID,
              taskID,
              stateResult.task.state?.nextRunAt,
              finishedAt,
            );
          }
        }
      } catch (persistError) {
        const message = safeErrorMessage(persistError);
        logger.warn?.('[ScheduledTasks] run completion state write failed', {
          projectID,
          taskID,
          reason,
          error: message,
        });

        // Keep in-memory status terminal so this process does not advertise
        // a stuck "running" task after the session already finished.
        const recoveredTask = {
          ...latestTask,
          state: {
            ...(latestTask.state || {}),
            lastStatus: status,
            lastDurationMs: durationMs,
            lastError: status === 'error' ? errorMessage : undefined,
            lastSessionId: status === 'success' ? sessionID : undefined,
            ...(addedPendingArchive
              ? {
                  pendingArchives: [
                    ...(latestTask?.state?.pendingArchives ?? []).filter(
                      (entry) => entry.sessionId !== addedPendingArchive.sessionId,
                    ),
                    addedPendingArchive,
                  ],
                }
              : {}),
            nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : undefined,
            updatedAt: finishedAt,
          },
        };
        updateInMemoryTask(projectID, recoveredTask);

        // Best-effort single retry so persisted lastStatus does not stay 'running'.
        try {
          const retry = await projectConfigRuntime.updateScheduledTaskState(projectID, taskID, statePatch);
          if (retry.task) {
            updateInMemoryTask(projectID, retry.task);
            stateResult = retry;
            if (retry.task.enabled) {
              scheduleFutureRun(projectID, taskID, retry.task.state?.nextRunAt, finishedAt);
            }
          }
        } catch (retryError) {
          logger.warn?.('[ScheduledTasks] run completion state retry failed', {
            projectID,
            taskID,
            reason,
            error: safeErrorMessage(retryError),
          });
          stateResult = { task: recoveredTask };
          rearmFromTaskOrCompute(projectID, taskID, recoveredTask, finishedAt);
        }

        // The session already ran — surface persist failure without treating a
        // successful dispatch as a hard run failure (manual runNow would 500).
        if (pendingArchive && stateResult.task) {
          pendingArchive.statePersisted = true;
          maybeArchivePendingSession(sessionID);
        }
        return {
          ok: status === 'success',
          status,
          sessionID,
          task: stateResult.task || recoveredTask,
          error: status === 'error' ? errorMessage : undefined,
          persistError: message,
          reason: 'completion-state-failed',
        };
      }

      if (pendingArchive) {
        if (stateResult.task) {
          pendingArchive.statePersisted = true;
          maybeArchivePendingSession(sessionID);
        } else {
          pendingArchives.delete(sessionID);
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

      return {
        ok: status === 'success',
        status,
        sessionID,
        task: stateResult.task || null,
        error: errorMessage,
      };
    } finally {
      releaseRunningSlot(projectID, taskKey);
    }
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

      void runTask(item.projectID, item.taskID, item.reason, item.scheduledFor)
        .catch((error) => {
          logger.warn?.('[ScheduledTasks] queued run rejected', {
            projectID: item.projectID,
            taskID: item.taskID,
            reason: item.reason,
            error: safeErrorMessage(error),
          });
        })
        .finally(() => {
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

  const processPayload = (payload) => {
    const failure = readSessionFailure(payload);
    if (failure) {
      const pending = pendingArchives.get(failure.sessionID);
      if (pending) {
        pending.failure = failure.message;
        maybeArchivePendingSession(failure.sessionID);
      }
      return;
    }

    if (payload?.type === 'session.updated') {
      const info = payload.properties?.info;
      const sessionID = typeof info?.id === 'string' ? info.id : '';
      const goalStatus = info?.metadata?.openchamber?.goal?.status;
      const pending = sessionID ? pendingArchives.get(sessionID) : null;
      if (pending?.goalEnabled && typeof goalStatus === 'string') {
        processGoalSettled({ sessionId: sessionID, status: goalStatus });
      }
      return;
    }

    const status = readSessionStatus(payload);
    if (!status) {
      return;
    }
    const pending = pendingArchives.get(status.sessionID);
    if (!pending || pending.goalEnabled) {
      return;
    }
    if (status.type === 'busy' || status.type === 'retry') {
      pending.quietPasses = 0;
    }
    maybeArchivePendingSession(status.sessionID);
  };

  const processGoalSettled = ({ sessionId, status }) => {
    const pending = pendingArchives.get(sessionId);
    if (!pending?.goalEnabled) {
      return;
    }
    pending.goalStatus = status;
    if (status === 'active') {
      pending.quietPasses = 0;
    }
    if (status !== 'active' && status !== 'complete') {
      pendingArchives.delete(sessionId);
      void removePersistedPendingArchive(pending);
      return;
    }
    maybeArchivePendingSession(sessionId);
  };

  const start = async () => {
    if (started) {
      return;
    }
    started = true;
    await syncAllProjects();
  };

  const stop = () => {
    pendingArchives.clear();
    for (const timer of archiveQuietTimers.values()) {
      clearTimeout(timer);
    }
    archiveQuietTimers.clear();
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

  const getStatus = () => {
    let enabledCount = 0;
    for (const taskMap of tasksByProject.values()) {
      for (const task of taskMap.values()) {
        if (task?.enabled) {
          enabledCount += 1;
        }
      }
    }

    const runningCount = runningTaskKeys.size;
    return {
      hasEnabledScheduledTasks: enabledCount > 0,
      hasRunningScheduledTasks: runningCount > 0,
      enabledScheduledTasksCount: enabledCount,
      runningScheduledTasksCount: runningCount,
    };
  };

  return {
    start,
    stop,
    syncAllProjects,
    syncProject,
    runNow,
    processPayload,
    processGoalSettled,
    getStatus,
  };
};

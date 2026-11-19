import { OpenCode } from '@opencode/client';
import { DateTime } from 'luxon';
import { CronExpressionParser } from 'cron-parser';
import { expandSnippets } from '../snippets/snippets.js';
import { buildGoalIntroText, createSessionGoal } from '../session-goal/create.js';
import { discoverLoops } from './loops.js';
import { assertOpenCodeApiResponse } from '../opencode/prompt-response.js';
import { createExistingSessionTasks } from './existing-session.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { setTimeout as delay } from 'node:timers/promises';
import { stat } from 'node:fs/promises';
import { readProcessInstance as readProcessInstanceDefault } from './process-instance.js';
import { AUTO_MODEL_REF, isAutoModel } from '../routing/defaults.js';
import { controlErrorFields } from '../openchamber-control/error.js';
import type { ExistingSessionDependencies, ExistingSessionTaskRunEvent } from './existing-session.js';
import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskStore, ScheduledWorktreeCleanup, ScheduledTaskStateResult } from '../projects/contracts.js';
import type { ScheduledWorktree, ScheduledWorktreeBridge, RemoveScheduledWorktreeInput } from './worktree-bridge.js';
import type { resolveSessionDefaults } from './session-defaults.js';
import type { createRoutingRuntime } from '../routing/runtime.js';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';
import { isString } from '../shared/object-guards.js';
import type { createOpenCodeLifecycleRuntime } from '../opencode/lifecycle.js';
import type { createPermissionAutoAcceptRuntime } from '../permission-auto-accept/runtime.js';

export interface ScheduledTasksDependencies extends Omit<ExistingSessionDependencies, 'createClient' | 'messageQueueRuntime' | 'projectConfigRuntime'> {
  projectConfigRuntime: ScheduledTaskStore;
  messageQueueRuntime?: ExistingSessionDependencies['messageQueueRuntime'];
  buildOpenCodeUrl: (route: string, query: string) => string | URL;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  waitForOpenCodeReady?: ReturnType<typeof createOpenCodeLifecycleRuntime>['waitForOpenCodeReady'] | null;
  emitTaskRunEvent?: (event: ScheduledTaskRunEvent) => void;
  setSessionAutoAccept?: ReturnType<typeof createPermissionAutoAcceptRuntime>['setSessionPolicy'] | null;
  sessionKnowledgeRuntime?: { sync: (sessionID: string, directory: string, prompt: string) => Promise<boolean> } | null;
  persistSessionGoal?: Parameters<typeof createSessionGoal>[0]['persistSessionGoal'];
  readSessionDefaults?: ((projectID: string) => Promise<ReturnType<typeof resolveSessionDefaults> | null>) | null;
  resolveAutoSelection?: ReturnType<typeof createRoutingRuntime>['resolveAutoSelection'] | null;
  readSessionMetadata: (sessionID: string, options: { signal: AbortSignal }) => Promise<SessionMetadata | null | undefined>;
  readProcessInstance?: typeof readProcessInstanceDefault;
  readWorktreeIdentity?: (directory: string) => Promise<string | null>;
  cleanupPause?: (signal: AbortSignal) => Promise<void>;
  createTaskWorktree?: ScheduledWorktreeBridge['create'];
  removeTaskWorktree?: ScheduledWorktreeBridge['remove'] | null;
  isGitRepository?: ScheduledWorktreeBridge['isGitRepository'] | null;
  logger?: Pick<Console, 'warn' | 'info'>;
  maxGlobalConcurrency?: number;
  maxProjectConcurrency?: number;
  maxRunDurationMs?: number;
}

export interface ScheduledTaskRunEvent extends ExistingSessionTaskRunEvent {
  isolated?: boolean;
  branch?: string | null;
}

interface RunContext {
  client: ReturnType<typeof OpenCode.make>;
  projectPath: string;
  task: ScheduledTask;
}

interface RunIsolation {
  directory: string;
  branch: string | null;
}

interface DispatchResult {
  sessionID: string;
  directory: string;
  durationMs: number;
  reason: RunReason;
  startedAt: number;
  finishedAt: number;
  isolation?: RunIsolation;
}

export interface ScheduledTaskRunResult {
  ok: boolean;
  skipped?: boolean;
  running?: boolean;
  queued?: boolean;
  error?: unknown;
  statusCode?: unknown;
  status?: 'sent' | 'error';
  task?: ScheduledTask | null;
  sessionID?: string | undefined;
  directory?: string | undefined;
  persistError?: string;
  reason?: string;
  isolation?: RunIsolation;
}

type RunReason = 'manual' | 'scheduled';
type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };
type ScheduledSessionInput = Mutable<NonNullable<Parameters<ReturnType<typeof OpenCode.make>['session']['create']>[0]>>;
type ScheduledSessionModel = Mutable<NonNullable<ScheduledSessionInput['model']>>;
const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);
const hasGoal = (value: unknown): value is { goal?: unknown } => value !== null && value !== undefined;
const hasStatus = (value: unknown): value is { status?: unknown } => value !== null && value !== undefined;
const isScheduleObject = (value: unknown): value is object => value !== null && typeof value === 'object';

export type ScheduleInput = { timezone?: string } & (
  | { kind: 'daily'; times?: string[]; time?: string }
  | { kind: 'weekly'; times?: string[]; time?: string; weekdays?: number[] }
  | { kind: 'once'; date: string; time: string }
  | { kind: 'cron'; cron: string }
);

const DEFAULT_GLOBAL_CONCURRENCY = 4;
const DEFAULT_PROJECT_CONCURRENCY = 2;
const DEFAULT_MAX_RUN_MS = 30 * 60 * 1000;
const JITTER_MAX_MS = 2_000;
const TASK_TITLE_MAX_LENGTH = 120;
const TASK_DUE_SLACK_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const readDirectoryIdentity = async (directory: string) => {
  try {
    const info = await stat(directory, { bigint: true });
    return info.isDirectory() ? `${info.dev}:${info.ino}` : null;
  } catch (error) {
    if (controlErrorFields(error)?.code === 'ENOENT' || controlErrorFields(error)?.code === 'ENOTDIR') return null;
    throw error;
  }
};

const buildTaskKey = (projectID: string, taskID: string) => `${projectID}:${taskID}`;

const parseTimeParts = (time: string | undefined) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time ?? '');
  if (!match) {
    return null;
  }
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
};

const applyTimeToDate = (baseDateTime: DateTime, time: string | undefined) => {
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

const resolveScheduleTimes = (schedule: { times?: string[]; time?: string }) => {
  const times: string[] = [];
  if (Array.isArray(schedule?.times)) {
    for (const candidate of schedule.times) {
      if (isString(candidate) && /^([01]\d|2[0-3]):([0-5]\d)$/.test(candidate)) {
        times.push(candidate);
      }
    }
  }
  if (times.length === 0 && isString(schedule?.time) && /^([01]\d|2[0-3]):([0-5]\d)$/.test(schedule.time)) {
    times.push(schedule.time);
  }
  return Array.from(new Set(times)).sort((a, b) => a.localeCompare(b));
};

const weekdayAsZeroBased = (dateTime: DateTime | null) => {
  if (!dateTime) {
    return null;
  }
  return dateTime.weekday % 7;
};

const safeErrorMessage = (cause: unknown, maxLength = 2_000) => {
  const raw = cause instanceof Error
    ? (cause.message || String(cause))
    : String(cause ?? 'Unknown error');
  const trimmed = raw.trim();
  if (!trimmed) {
    return 'Unknown error';
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

export const parseScheduledCommandPrompt = (prompt: string | undefined) => {
  if (!isString(prompt)) {
    return null;
  }

  const trimmed = prompt.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const commandToken = trimmed.match(/^\/(\S+)/);
  const commandName = commandToken?.[1];
  if (!commandName) {
    return null;
  }

  return {
    command: commandName,
    arguments: trimmed.slice(commandToken[0].length).replace(/^[ \t]*(?:\r?\n)?/, ''),
  };
};

export const expandCommandGoalObjective = (template: string | undefined, argumentsText: string | undefined) => {
  if (!isString(template) || !template.trim()) {
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

export const computeNextRunAt = (task: { enabled: boolean; schedule?: ScheduleInput } | null | undefined, nowMs = Date.now()) => {
  if (!task?.enabled) {
    return null;
  }

  const schedule = task.schedule;
  if (!schedule || !isScheduleObject(schedule)) {
    return null;
  }

  const zone = isString(schedule.timezone) && schedule.timezone.trim().length > 0
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
    if (!isString(schedule.date) || !isString(schedule.time)) {
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
      const iterator = CronExpressionParser.parse(schedule.cron, {
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

export const formatScheduledSessionTitle = (task: { name?: string; schedule?: { timezone?: string } } | null | undefined, nowMs = Date.now()) => {
  const timezone = isString(task?.schedule?.timezone) && task.schedule.timezone.trim().length > 0
    ? task.schedule.timezone.trim()
    : DateTime.local().zoneName;
  const stamp = DateTime.fromMillis(nowMs, { zone: timezone }).toFormat('yyyy-LL-dd HH:mm');
  const taskName = isString(task?.name) && task.name.trim().length > 0
    ? task.name.trim()
    : 'Scheduled task';
  const suffix = ` ${stamp}`;
  const maxTaskNameLength = Math.max(1, TASK_TITLE_MAX_LENGTH - suffix.length);
  const trimmedName = taskName.length > maxTaskNameLength
    ? taskName.slice(0, maxTaskNameLength)
    : taskName;
  return `${trimmedName}${suffix}`;
};

export const createScheduledTasksRuntime = (deps: ScheduledTasksDependencies) => {
  const {
    projectConfigRuntime,
    listProjects,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    waitForOpenCodeReady,
    emitTaskRunEvent,
    setSessionAutoAccept,
    sessionKnowledgeRuntime = null,
    persistSessionGoal = null,
    chatsScope = null,
    readSessionDefaults = null,
    resolveAutoSelection = null,
    readSessionMetadata,
    readProcessInstance = readProcessInstanceDefault,
    readWorktreeIdentity = readDirectoryIdentity,
    cleanupPause = (signal: AbortSignal) => delay(5_000, undefined, { signal, ref: false }),
    createTaskWorktree = null,
    removeTaskWorktree = null,
    isGitRepository = null,
    messageQueueRuntime,
    resolvePrimaryWorktreeRoot,
    isSessionArchived,
    logger = console,
    maxGlobalConcurrency = DEFAULT_GLOBAL_CONCURRENCY,
    maxProjectConcurrency = DEFAULT_PROJECT_CONCURRENCY,
    maxRunDurationMs = DEFAULT_MAX_RUN_MS,
  } = deps;

  const openCodeOrigin = () => new URL(buildOpenCodeUrl('/api/info', '')).origin;
  const createScopedClient = (directory: string) => {
    const baseUrl = openCodeOrigin();
    const headers = { ...getOpenCodeAuthHeaders() };
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    return OpenCode.make({
      baseUrl,
      headers,
      fetch: async (...args) => {
        const response = await fetch(...args);
        assertOpenCodeApiResponse(response);
        return response;
      },
    });
  };

  let existingSessionTasks: ReturnType<typeof createExistingSessionTasks> | null = null;
  if (messageQueueRuntime) {
    const existingDependencies: ExistingSessionDependencies = {
      projectConfigRuntime, messageQueueRuntime,
      createClient: createScopedClient, listProjects, chatsScope,
    };
    if (resolvePrimaryWorktreeRoot !== undefined) existingDependencies.resolvePrimaryWorktreeRoot = resolvePrimaryWorktreeRoot;
    if (isSessionArchived !== undefined) existingDependencies.isSessionArchived = isSessionArchived;
    if (emitTaskRunEvent !== undefined) existingDependencies.emitTaskRunEvent = emitTaskRunEvent;
    existingSessionTasks = createExistingSessionTasks(existingDependencies);
  }

  const resolveRunSelection = async (projectID: string, task: ScheduledTask) => {
    const execution = task.execution;
    if (!execution.useDefaults) {
      return {
        providerID: execution.providerID ?? null,
        modelID: execution.modelID ?? null,
        variant: execution.variant ?? null,
        agent: execution.agent ?? null,
      };
    }
    try {
      const defaults = readSessionDefaults ? await readSessionDefaults(projectID) : null;
      return {
        providerID: defaults?.providerID ?? null,
        modelID: defaults?.modelID ?? null,
        variant: defaults?.variant ?? null,
        agent: defaults?.agent ?? null,
      };
    } catch (error) {
      logger.warn?.('[scheduled-tasks] session defaults unavailable, using OpenCode defaults:', controlErrorFields(error)?.message ?? error);
      return { providerID: null, modelID: null, variant: null, agent: null };
    }
  };

  let started = false;
  const pendingCleanups = new Map<string, AbortController>();
  const tasksByProject = new Map<string, Map<string, ScheduledTask>>();
  const projectPathByID = new Map<string, string>();
  const timersByTaskKey = new Map<string, ReturnType<typeof setTimeout>>();
  const queuedTaskKeys = new Set<string>();
  const runningTaskKeys = new Set<string>();
  const runningCountByProject = new Map<string, number>();
  let runningGlobalCount = 0;
  const queue: { projectID: string; taskID: string; reason: RunReason; scheduledFor?: number }[] = [];

  const clearTimerForKey = (taskKey: string) => {
    const timer = timersByTaskKey.get(taskKey);
    if (timer) {
      clearTimeout(timer);
      timersByTaskKey.delete(taskKey);
    }
  };

  const clearProjectTimers = (projectID: string) => {
    const tasks = tasksByProject.get(projectID);
    if (!tasks) {
      return;
    }
    for (const task of tasks.values()) {
      clearTimerForKey(buildTaskKey(projectID, task.id));
      queuedTaskKeys.delete(buildTaskKey(projectID, task.id));
    }
  };

  const setProjectTasks = (projectID: string, tasks: ScheduledTask[]) => {
    clearProjectTimers(projectID);
    const taskMap = new Map<string, ScheduledTask>();
    for (const task of tasks) {
      taskMap.set(task.id, task);
    }
    tasksByProject.set(projectID, taskMap);
  };

  const scheduleTask = (projectID: string, taskID: string, nextRunAt: number | null | undefined) => {
    const taskKey = buildTaskKey(projectID, taskID);
    clearTimerForKey(taskKey);

    if (!started) {
      return;
    }

    if (!isFiniteNumber(nextRunAt) || nextRunAt <= 0) {
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

  const updateInMemoryTask = (projectID: string, nextTask: ScheduledTask | null) => {
    if (!nextTask) {
      return;
    }
    const taskMap = tasksByProject.get(projectID);
    if (!taskMap) {
      return;
    }
    taskMap.set(nextTask.id, nextTask);
  };

  const syncTaskSchedule = async (projectID: string, task: ScheduledTask) => {
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

  const isChatsScope = (projectID: string) => Boolean(chatsScope) && projectID === chatsScope?.id;

  const listScopes = async () => {
    const projects = await listProjects();
    if (!chatsScope || projects.some((project) => project?.id === chatsScope.id)) {
      return projects;
    }
    return [...projects, { id: chatsScope.id, path: chatsScope.root }];
  };

  const ensureProjectPath = async (projectID: string) => {
    if (projectPathByID.has(projectID)) {
      return projectPathByID.get(projectID) || null;
    }

    try {
      const projects = await listScopes();
      const project = projects.find((item) => item?.id === projectID && item?.path);
      if (project?.path) {
        projectPathByID.set(projectID, project.path);
        return project.path;
      }
    } catch {
      void undefined;
    }

    return null;
  };

  const syncProject = async (projectID: string) => {
    await ensureProjectPath(projectID);
    const projectPath = projectPathByID.get(projectID) || null;

    let tasks;
    if (projectPath && !isChatsScope(projectID)) {
      const loops = await discoverLoops(projectPath);
      tasks = await projectConfigRuntime.reconcileLoopTasks(projectID, loops);
    } else {
      tasks = await projectConfigRuntime.listScheduledTasks(projectID);
    }

    setProjectTasks(projectID, tasks);

    for (const task of tasks) {
      await syncTaskSchedule(projectID, task);
    }

    return tasks;
  };

  const syncAllProjects = async () => {
    const projects = await listScopes();
    const activeProjectIDs = new Set<string>();
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
      try {
        await syncProject(projectID);
      } catch (error) {
        logger.warn?.('[ScheduledTasks] failed to sync project', {
          projectID,
          error: controlErrorFields(error)?.message ?? String(error),
        });
      }
    }
  };

  const queueTaskRun = (projectID: string, taskID: string, reason: RunReason, scheduledFor?: number) => {
    const taskKey = buildTaskKey(projectID, taskID);
    if (queuedTaskKeys.has(taskKey) || runningTaskKeys.has(taskKey)) {
      return;
    }
    queuedTaskKeys.add(taskKey);
    const item: typeof queue[number] = {
      projectID,
      taskID,
      reason,
    };
    if (isFiniteNumber(scheduledFor)) item.scheduledFor = scheduledFor;
    queue.push(item);
  };

  const canRunTask = (projectID: string) => {
    if (runningGlobalCount >= maxGlobalConcurrency) {
      return false;
    }
    const projectRunning = runningCountByProject.get(projectID) || 0;
    return projectRunning < maxProjectConcurrency;
  };

  const syncKnowledge = (sessionID: string, projectPath: string) => (sessionKnowledgeRuntime
    ? sessionKnowledgeRuntime.sync(sessionID, projectPath, '')
    : Promise.resolve(false));

  const runPrompt = async ({ client, sessionID, projectPath, task }: RunContext & { sessionID: string }) => {
    await syncKnowledge(sessionID, projectPath);

    if (task.execution.goalEnabled) {
      await client.session.synthetic({ sessionID, text: buildGoalIntroText(task.execution.goalTokenBudget), resume: false });
    }

    await client.session.prompt({
      sessionID,
      text: expandSnippets(task.execution.prompt, projectPath),
    });
  };

  const resolveScheduledCommand = async ({ client, projectPath, task }: RunContext) => {
    const parsed = parseScheduledCommandPrompt(task?.execution?.prompt);
    if (!parsed) {
      return null;
    }

    let commands: Awaited<ReturnType<typeof client.command.list>>['data'] = [];
    try {
      const response = await client.command.list({ location: { directory: projectPath } });
      commands = Array.isArray(response?.data) ? response.data : [];
    } catch {
      return null;
    }

    const command = commands.find((candidate) => candidate?.name === parsed.command);
    const template = command && 'template' in command ? command.template : undefined;
    return command ? { ...parsed, template: isString(template) ? template : undefined } : null;
  };

  const runScheduledCommand = async ({ client, sessionID, projectPath, command }: {
    client: RunContext['client']; sessionID: string; projectPath: string;
    command: { command: string; arguments: string };
  }) => {
    await syncKnowledge(sessionID, projectPath);
    await client.session.command({
      sessionID,
      name: command.command,
      text: command.arguments,
    });
  };

  const waitForSessionRun = async ({ client, record, baseUrl, authHeaders, signal }: {
    client: RunContext['client']; record: ScheduledWorktreeCleanup; baseUrl: string;
    authHeaders: Record<string, string>; signal: AbortSignal;
  }) => {
    const { sessionID, worktreeDirectory, startedAt } = record;
    const activityProbe = createSessionActivityProbe({
      buildOpenCodeUrl: (pathname) => new URL(pathname, baseUrl).toString(),
      getOpenCodeAuthHeaders: () => authHeaders,
      signal,
    });
    for (;;) {
      signal.throwIfAborted();
      if (await readWorktreeIdentity(worktreeDirectory) !== record.directoryIdentity) return false;
      await client.experimental.session.wait({ sessionID }, { signal });
      const statuses = await activityProbe.fetchActiveSessionStatuses();
      if (!statuses) throw new Error('Cannot confirm session execution has settled');
      if (!statuses[sessionID]) {
        const descendantsWorking = await activityProbe.hasWorkingDescendants(sessionID, statuses);
        if (descendantsWorking === null) throw new Error('Cannot confirm subagent execution has settled');
        if (!descendantsWorking) {
          const metadata = await readSessionMetadata(sessionID, { signal });
          const openchamber = metadata?.openchamber;
          const goal = hasGoal(openchamber) ? openchamber.goal : undefined;
          if (!hasStatus(goal) || goal.status !== 'active') {
            const shells = await activityProbe.fetchRunningShells(worktreeDirectory);
            if (!shells) throw new Error('Cannot confirm background commands have settled');
            let shellsWorking = false;
            const owners = new Set(shells.filter((shell) => shell.startedAt >= startedAt).map((shell) => shell.sessionID));
            for (const owner of owners) {
              if (owner === sessionID) { shellsWorking = true; break; }
              const descendant = await activityProbe.hasWorkingDescendants(sessionID, { [owner]: { type: 'running' } });
              if (descendant === null) throw new Error('Cannot confirm background command ownership');
              if (descendant) { shellsWorking = true; break; }
            }
            if (!shellsWorking) {
              signal.throwIfAborted();
              return await readWorktreeIdentity(worktreeDirectory) === record.directoryIdentity;
            }
          }
        }
      }
      await cleanupPause(signal);
    }
  };

  const launchCleanup = (record: ScheduledWorktreeCleanup) => {
    if (pendingCleanups.has(record.sessionID)) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(maxRunDurationMs)]);
    pendingCleanups.set(record.sessionID, controller);
    void (async () => {
      try {
        const exists = await readWorktreeIdentity(record.worktreeDirectory) === record.directoryIdentity;
        let remove = record.phase === 'removing';
        if (exists) {
          if (waitForOpenCodeReady) await waitForOpenCodeReady(10_000, 250);
          const baseUrl = openCodeOrigin();
          remove = await waitForSessionRun({
            client: createScopedClient(record.worktreeDirectory), record, baseUrl,
            authHeaders: getOpenCodeAuthHeaders(), signal,
          });
        }
        signal.throwIfAborted();
        await projectConfigRuntime.finishScheduledWorktreeCleanup(record.projectID, record.sessionID,
          remove ? async (current, resumingRemoval) => {
            const matching = await readWorktreeIdentity(current.worktreeDirectory) === current.directoryIdentity;
            signal.throwIfAborted();
            if (!matching && !resumingRemoval) return;
            const input: RemoveScheduledWorktreeInput = {
              projectDirectory: current.projectDirectory, worktreeDirectory: current.worktreeDirectory,
              branch: current.branch, deleteLocalBranch: true,
            };
            if (!matching) input.removeDirectory = false;
            if (!removeTaskWorktree) throw new TypeError('removeTaskWorktree is not a function');
            return removeTaskWorktree(input);
          } : null, { signal });
      } catch (error) {
        if (controller.signal.aborted) return;
        try {
          if (await readWorktreeIdentity(record.worktreeDirectory) !== record.directoryIdentity) {
            const discarded = await projectConfigRuntime.finishScheduledWorktreeCleanup(record.projectID, record.sessionID, null, { signal });
            if (discarded) return;
          }
        } catch { void undefined; }
        logger.warn?.('[ScheduledTasks] failed to clean up the isolated worktree', {
          projectID: record.projectID, sessionID: record.sessionID,
          worktree: record.worktreeDirectory,
          reason: signal.aborted ? 'cleanup-wait-budget-exceeded' : 'cleanup-failed',
          error: signal.aborted ? controlErrorFields(signal.reason)?.message ?? 'Cleanup wait timed out' : controlErrorFields(error)?.message ?? error,
        });
      } finally {
        if (pendingCleanups.get(record.sessionID) === controller) pendingCleanups.delete(record.sessionID);
      }
    })();
  };

  const runTaskWithWatchdog = async (projectID: string, task: ScheduledTask, reason: RunReason, onSessionCreated?: (sessionID: string, isolation: ScheduledWorktree | null) => Promise<void>) => {
    const startedAt = Date.now();
    const title = formatScheduledSessionTitle(task, startedAt);
    const projectPath = projectPathByID.get(projectID);
    if (!projectPath) {
      throw new Error('project path is unavailable');
    }

    if (waitForOpenCodeReady) {
      await waitForOpenCodeReady(10_000, 250);
    }

    const chatsRun = isChatsScope(projectID) && chatsScope;
    const directory = chatsRun
      ? await chatsRun.createChatDirectory(new Date(startedAt))
      : projectPath;

    let isolation: ScheduledWorktree | null = null;
    if (!chatsRun && task.runInWorktree === true) {
      if (task.cleanupWorktree !== false && !projectConfigRuntime.saveScheduledWorktreeCleanup) {
        throw new Error('Durable worktree cleanup is unavailable');
      }
      const create = createTaskWorktree;
      let gitLike = null;
      if (isGitRepository) {
        try {
          gitLike = await isGitRepository(projectPath);
        } catch (error) {
          throw new Error(`failed to check whether the project is a git repository: ${controlErrorFields(error)?.message || error}`);
        }
      }
      if (!create) {
        throw new Error('failed to create isolated worktree: worktree creation is unavailable');
      }
      if (gitLike !== false) {
        try {
          isolation = await create({
            projectDirectory: projectPath,
            baseBranch: task.baseBranch || undefined,
          });
        } catch (error) {
          throw new Error(`failed to create isolated worktree: ${controlErrorFields(error)?.message || error}`);
        }
      }
      if (!isolation) {
        logger.warn?.('[ScheduledTasks] isolated run fell back to the project directory', {
          projectID,
          taskID: task.id,
          reason: gitLike === false
            ? 'project is not a git repository'
            : 'worktree creation returned no worktree',
        });
      }
    }

    const runDirectory = isolation?.directory ?? directory;

    const baseUrl = openCodeOrigin();
    const authHeaders = getOpenCodeAuthHeaders();
    const client = createScopedClient(runDirectory);
    let selection = await resolveRunSelection(projectID, task);
    const autoRun = isAutoModel(selection);

    let sessionID;
    let cleanupRecord;
    try {
      if (autoRun && !resolveAutoSelection) {
        throw new Error('Auto routing is not available on this server. Choose a model.');
      }
      const sessionInput: ScheduledSessionInput = {
        title,
        location: { directory: runDirectory },
        metadata: { openchamber: { kind: 'scheduled' } },
      };
      if (selection.providerID && selection.modelID && !autoRun) {
        const model: ScheduledSessionModel = {
          providerID: selection.providerID,
          id: selection.modelID,
        };
        if (selection.variant) model.variant = selection.variant;
        sessionInput.model = model;
      }
      if (selection.agent) sessionInput.agent = selection.agent;
      const session = await client.session.create(sessionInput);
      sessionID = session?.id;
      if (!sessionID) {
        throw new Error('failed to create session');
      }
      if (isolation && task.cleanupWorktree !== false) {
        const directoryIdentity = await readWorktreeIdentity(isolation.directory);
        if (!directoryIdentity) throw new Error('Run worktree no longer exists');
        const ownerInstance = await readProcessInstance(process.pid);
        if (!ownerInstance) throw new Error('Cannot identify the worktree cleanup owner');
        cleanupRecord = await projectConfigRuntime.saveScheduledWorktreeCleanup(projectID, {
          projectDirectory: projectPath, worktreeDirectory: isolation.directory,
          sessionID, branch: isolation.branch ?? null, startedAt, directoryIdentity,
          ownerPID: process.pid, ownerInstance, phase: 'waiting',
        });
      }
    } catch (error) {
      if (chatsRun) {
        await chatsRun.discardChatDirectory(directory);
      }
      if (isolation) {
        await removeTaskWorktree?.({ projectDirectory: projectPath, worktreeDirectory: isolation.directory, branch: isolation.branch, deleteLocalBranch: true })
          .catch((removeError) => {
            logger.warn?.("[ScheduledTasks] failed to clean up the failed run's worktree", {
              projectID,
              taskID: task.id,
              worktree: isolation.directory,
              error: controlErrorFields(removeError)?.message ?? removeError,
            });
          });
      }
      throw error;
    }

    try {
      await onSessionCreated?.(sessionID, isolation ?? null);

      try {
        emitTaskRunEvent?.({
          projectID,
          taskID: task.id,
          ranAt: startedAt,
          status: 'running',
          sessionID,
        });
      } catch {
        void undefined;
      }

      if (task.execution.permissionAutoAccept && setSessionAutoAccept) {
        try {
          await setSessionAutoAccept(sessionID, true, runDirectory);
        } catch (error) {
          logger.warn?.('[scheduled-tasks] failed to enable permission auto-accept for session', sessionID, controlErrorFields(error)?.message ?? error);
        }
      }

      if (autoRun && resolveAutoSelection) {
        const routed = await resolveAutoSelection({
          sessionId: sessionID,
          directory: runDirectory,
          model: AUTO_MODEL_REF,
          agent: selection.agent,
          requestText: expandSnippets(task.execution.prompt, runDirectory),
        });
        if (!routed) throw new TypeError("Cannot read properties of null (reading 'model')");
        await client.session.switchModel({ sessionID, model: routed.model });
        if (routed.agent && routed.agent !== selection.agent) {
          await client.session.switchAgent({ sessionID, agent: routed.agent });
        }
        selection = { ...selection, providerID: routed.model.providerID, modelID: routed.model.id };
      }

      const scheduledCommand = await resolveScheduledCommand({ client, projectPath: runDirectory, task });

      if (task.execution.goalEnabled) {
        const commandObjective = scheduledCommand
          ? expandCommandGoalObjective(scheduledCommand.template, scheduledCommand.arguments)
          : null;
        await createSessionGoal({
          baseUrl,
          authHeaders,
          persistSessionGoal,
          sessionID,
          directory: runDirectory,
          objective: commandObjective ?? expandSnippets(task.execution.prompt, runDirectory),
          tokenBudget: task.execution.goalTokenBudget,
          providerID: selection.providerID ?? undefined,
          modelID: selection.modelID ?? undefined,
          onWarning: (message: string, cause: unknown) => console.warn(`[scheduled-tasks] ${message}:`, controlErrorFields(cause)?.message || cause),
        });
      }

      if (scheduledCommand) {
        await runScheduledCommand({ client, sessionID, projectPath: runDirectory, command: scheduledCommand });
      } else {
        await runPrompt({ client, sessionID, projectPath: runDirectory, task });
      }

      const finishedAt = Date.now();
      const result: DispatchResult = {
        sessionID,
        directory: runDirectory,
        durationMs: Math.max(0, finishedAt - startedAt),
        reason,
        startedAt,
        finishedAt,
      };
      if (isolation) result.isolation = { directory: isolation.directory, branch: isolation.branch ?? null };
      return result;
    } finally {
      if (cleanupRecord && started) launchCleanup(cleanupRecord);
    }
  };

  const releaseRunningSlot = (projectID: string, taskKey: string) => {
    runningTaskKeys.delete(taskKey);
    runningGlobalCount = Math.max(0, runningGlobalCount - 1);
    const nextProjectCount = Math.max(0, (runningCountByProject.get(projectID) || 1) - 1);
    if (nextProjectCount === 0) {
      runningCountByProject.delete(projectID);
    } else {
      runningCountByProject.set(projectID, nextProjectCount);
    }
  };

  const scheduleFutureRun = (projectID: string, taskID: string, nextRunAt: number | null | undefined, fromMs = Date.now()) => {
    if (!isFiniteNumber(nextRunAt)) {
      return false;
    }
    const base = Number.isFinite(fromMs) ? fromMs : Date.now();
    if (nextRunAt <= base) {
      return false;
    }
    scheduleTask(projectID, taskID, nextRunAt);
    return true;
  };

  const rearmFromTaskOrCompute = (projectID: string, taskID: string, fallbackTask: ScheduledTask, fromMs: number) => {
    const latest = (tasksByProject.get(projectID)?.get(taskID)) || fallbackTask;
    if (!latest?.enabled) {
      return;
    }
    const base = Number.isFinite(fromMs) ? fromMs : Date.now();
    const persistedNext = latest.state?.nextRunAt;
    if (scheduleFutureRun(projectID, taskID, persistedNext, base)) {
      return;
    }
    const computedNext = computeNextRunAt(latest, base);
    scheduleFutureRun(projectID, taskID, computedNext, base);
  };

  const runTask = async (projectID: string, taskID: string, reason: RunReason, scheduledFor?: number): Promise<ScheduledTaskRunResult> => {
    const taskMap = tasksByProject.get(projectID);
    const task = taskMap?.get(taskID);
    if (!task || (reason !== 'manual' && !task.enabled)) {
      return { ok: false, skipped: true };
    }

    if (task.targetSessionId) {
      if (!existingSessionTasks) return { ok: false, error: 'Existing-session scheduling is unavailable', statusCode: 503 };
      const nextRunAt = computeNextRunAt(task, Math.max(Date.now(), (scheduledFor ?? 0) + 1));
      const result = await existingSessionTasks.run(projectID, task, reason, scheduledFor, nextRunAt);
      if (reason === 'scheduled') {
        if (task.schedule.kind === 'once' && result.task && !result.skipped) {
          try {
            const consumed = await projectConfigRuntime.upsertScheduledTask(projectID, { ...result.task, enabled: false });
            updateInMemoryTask(projectID, consumed.task);
          } catch (consumeError) {
            logger.warn?.('[ScheduledTasks] failed to consume one-time task', {
              projectID,
              taskID,
              error: safeErrorMessage(consumeError),
            });
          }
        } else scheduleFutureRun(projectID, taskID, nextRunAt);
      }
      return result;
    }

    const taskKey = buildTaskKey(projectID, taskID);
    if (runningTaskKeys.has(taskKey)) {
      return { ok: false, running: true };
    }

    runningTaskKeys.add(taskKey);
    runningGlobalCount += 1;
    runningCountByProject.set(projectID, (runningCountByProject.get(projectID) || 0) + 1);

    try {
      const runStartedAt = Date.now();

      if (reason === 'scheduled') {
        if (!isFiniteNumber(scheduledFor)) {
          return { ok: false, skipped: true, reason: 'missing-scheduled-for' };
        }

        const nextAfterClaim = computeNextRunAt(task, Math.max(runStartedAt, scheduledFor + 1));
        const claimPatch = {
          lastScheduledFor: Math.round(scheduledFor),
          lastRunAt: runStartedAt,
          lastStatus: 'running',
          lastError: undefined,
          lastSessionId: undefined,
          updatedAt: runStartedAt,
          nextRunAt: Number.isFinite(nextAfterClaim) ? nextAfterClaim : undefined,
        };

        const canClaimOccurrence = (candidate: ScheduledTask) => {
          if (!candidate?.enabled) {
            return false;
          }
          const lastScheduledFor = candidate.state?.lastScheduledFor;
          if (
            isFiniteNumber(lastScheduledFor)
            && Math.abs(lastScheduledFor - scheduledFor) <= TASK_DUE_SLACK_MS
          ) {
            return false;
          }
          return true;
        };

        let claimResult;
        try {
          if (projectConfigRuntime.updateScheduledTaskStateIf) {
            claimResult = await projectConfigRuntime.updateScheduledTaskStateIf(
              projectID,
              taskID,
              canClaimOccurrence,
              claimPatch,
            );
          } else {
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

          const claimFailurePatch: Pick<ScheduledTask['state'], 'lastStatus' | 'lastError' | 'updatedAt'> = {
            lastStatus: 'error',
            lastError: `Scheduled claim failed: ${message}`,
            updatedAt: Date.now(),
          };
          try {
            if (projectConfigRuntime.updateScheduledTaskStateIf) {
              const recorded = await projectConfigRuntime.updateScheduledTaskStateIf(
                projectID,
                taskID,
                (candidate) => {
                  const lastScheduledFor = candidate.state?.lastScheduledFor;
                  if (
                    isFiniteNumber(lastScheduledFor)
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
            lastSessionId: undefined,
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

      let status: 'sent' | 'error' = 'sent';
      let sessionID;
      let sessionDirectory;
      let durationMs = 0;
      let errorMessage;
      let runIsolation: RunIsolation | null = null;
      let createdSessionID;
      const recordCreatedSession = async (id: string, isolation: RunIsolation | null = null) => {
        createdSessionID = id;
        runIsolation = isolation;
        try {
          const recorded = await projectConfigRuntime.updateScheduledTaskState(projectID, taskID, {
            lastSessionId: id,
            lastRunIsolated: isolation ? true : undefined,
            lastRunBranch: isolation && task.cleanupWorktree === false && isolation.branch
              ? String(isolation.branch)
              : undefined,
          });
          if (recorded.task) {
            updateInMemoryTask(projectID, recorded.task);
          }
        } catch (error) {
          logger.warn?.('[ScheduledTasks] failed to record the run session', {
            projectID,
            taskID,
            error: safeErrorMessage(error),
          });
        }
      };

      try {
        const runPromise = runTaskWithWatchdog(projectID, task, reason, recordCreatedSession);
        let timeoutID: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
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
        sessionDirectory = result.directory;
        durationMs = result.durationMs;
        runIsolation = result.isolation ?? null;
        logger.info?.(
          '[ScheduledTasks] run dispatched',
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
        lastSessionId: sessionID ?? createdSessionID,
        lastRunIsolated: runIsolation ? true : undefined,
        lastRunBranch: runIsolation && task.cleanupWorktree === false && runIsolation.branch
          ? String(runIsolation.branch)
          : undefined,
        nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : undefined,
        updatedAt: finishedAt,
      };

      let stateResult: Pick<ScheduledTaskStateResult, 'task'> = { task: null };
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

        const recoveredTask = {
          ...latestTask,
          state: {
            ...(latestTask.state || {}),
            lastStatus: status,
            lastDurationMs: durationMs,
            lastError: status === 'error' ? errorMessage : undefined,
            lastSessionId: sessionID ?? createdSessionID,
            nextRunAt: isFiniteNumber(nextRunAt) ? nextRunAt : undefined,
            updatedAt: finishedAt,
          },
        };
        updateInMemoryTask(projectID, recoveredTask);

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

        return {
          ok: status === 'sent',
          status,
          sessionID,
          directory: sessionDirectory,
          task: stateResult.task || recoveredTask,
          error: status === 'error' ? errorMessage : undefined,
          persistError: message,
          reason: 'completion-state-failed',
        };
      }

      try {
        const event: ScheduledTaskRunEvent = {
          projectID,
          taskID,
          ranAt: finishedAt,
          status,
        };
        if (sessionID) event.sessionID = sessionID;
        if (runIsolation) {
          event.isolated = true;
          event.branch = runIsolation.branch ?? null;
        }
        emitTaskRunEvent?.(event);
      } catch {
        void undefined;
      }

      const result: ScheduledTaskRunResult = {
        ok: status === 'sent',
        status,
        sessionID,
        directory: sessionDirectory,
        task: stateResult.task || null,
        error: errorMessage,
      };
      if (runIsolation) result.isolation = runIsolation;
      return result;
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
      if (!item) continue;
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

  const runNow = async (projectID: string, taskID: string): Promise<ScheduledTaskRunResult> => {
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
    let cleanups: ScheduledWorktreeCleanup[] = [];
    try {
      cleanups = await projectConfigRuntime.listScheduledWorktreeCleanups?.() ?? [];
    } catch (error) {
      logger.warn?.('[ScheduledTasks] failed to resume worktree cleanup', controlErrorFields(error)?.message ?? error);
    }
    await syncAllProjects();
    const owners = new Map<number, Promise<string | null>>();
    for (const record of cleanups) {
      if (record.ownerPID > 0 && record.ownerPID !== process.pid && record.ownerInstance) {
        try {
          if (!owners.has(record.ownerPID)) owners.set(record.ownerPID, readProcessInstance(record.ownerPID));
          if (await owners.get(record.ownerPID) === record.ownerInstance) {
            logger.info?.('[ScheduledTasks] cleanup owned by another server instance; skipping', {
              sessionID: record.sessionID, ownerPID: record.ownerPID, worktree: record.worktreeDirectory,
            });
            continue;
          }
        } catch (error) {
          logger.warn?.('[ScheduledTasks] cannot verify cleanup owner; skipping', {
            sessionID: record.sessionID, ownerPID: record.ownerPID, error: controlErrorFields(error)?.message ?? error,
          });
          continue;
        }
      }
      launchCleanup(record);
    }
  };

  const stop = () => {
    if (!started) {
      return;
    }
    started = false;
    for (const controller of pendingCleanups.values()) controller.abort();
    pendingCleanups.clear();
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
    getStatus,
    validateTarget: (...args: Parameters<ReturnType<typeof createExistingSessionTasks>['validateTarget']>) => {
      if (!existingSessionTasks) throw new TypeError("Cannot read properties of null (reading 'validateTarget')");
      return existingSessionTasks.validateTarget(...args);
    },
    listEligibleTargets: (...args: Parameters<ReturnType<typeof createExistingSessionTasks>['listEligibleTargets']>) => {
      if (!existingSessionTasks) throw new TypeError("Cannot read properties of null (reading 'listEligibleTargets')");
      return existingSessionTasks.listEligibleTargets(...args);
    },
    beforeScheduledTaskSend: (...args: Parameters<ReturnType<typeof createExistingSessionTasks>['beforeSend']>) => {
      if (!existingSessionTasks) throw new TypeError("Cannot read properties of null (reading 'beforeSend')");
      return existingSessionTasks.beforeSend(...args);
    },
    onScheduledTaskResult: (...args: Parameters<ReturnType<typeof createExistingSessionTasks>['result']>) => {
      if (!existingSessionTasks) throw new TypeError("Cannot read properties of null (reading 'result')");
      return existingSessionTasks.result(...args);
    },
    cancelWaitingPrompt: (projectID: string, taskID: ScheduledTaskInput['id']) => existingSessionTasks?.cancel(projectID, taskID),
  };
};

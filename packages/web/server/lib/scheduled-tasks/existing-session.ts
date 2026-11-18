import path from 'node:path';
import { z } from 'zod';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import { asNonEmptyString } from '../shared/guards.js';
import { expandSnippets } from '../snippets/snippets.js';
import type { OpenCode } from '@opencode/client';
import type { ScheduledTask, ScheduledTaskConfig, ScheduledTaskStatePatch, ScheduledTaskStatus, SessionProject } from '../projects/contracts.js';
import type { createMessageQueueRuntime } from '../message-queue/runtime.js';
import type { createChatsScope } from './chats-scope.js';
import type { resolvePrimaryWorktreeRoot } from '../git/service.js';

export interface ExistingSessionDependencies {
  projectConfigRuntime: ScheduledTaskConfig;
  messageQueueRuntime: Pick<ReturnType<typeof createMessageQueueRuntime>, 'enqueue' | 'cancelScheduledTask'>;
  createClient: (directory: string) => Pick<ReturnType<typeof OpenCode.make>, 'session'>;
  listProjects: () => Promise<SessionProject[]>;
  chatsScope?: ReturnType<typeof createChatsScope> | null;
  resolvePrimaryWorktreeRoot?: typeof resolvePrimaryWorktreeRoot | null;
  isSessionArchived?: (sessionID: string) => boolean | Promise<boolean>;
  emitTaskRunEvent?: (event: ExistingSessionTaskRunEvent) => void;
}

export interface ExistingSessionTaskRunEvent {
  projectID: string;
  taskID: string;
  status: ScheduledTaskStatus;
  ranAt: number;
  sessionID?: string | undefined;
}

export interface ScheduledTaskProvenance {
  projectId: string;
  taskId: string;
}

export interface EligibleScheduledTarget {
  sessionId: string;
  directory: string;
}

const hasReadableError = (value: unknown): value is {
  name?: unknown;
  status?: unknown;
  statusCode?: unknown;
  message?: unknown;
} => value !== null && value !== undefined;

const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);
const isTargetCandidate = (value: unknown): value is { sessionId?: unknown; directory?: unknown } => value !== null && value !== undefined;

export const createExistingSessionTasks = ({ projectConfigRuntime, messageQueueRuntime, createClient, listProjects, chatsScope, resolvePrimaryWorktreeRoot, isSessionArchived, emitTaskRunEvent }: ExistingSessionDependencies) => {
  const admissions = new Set<string>();

  const ownsDirectory = async (project: SessionProject | undefined, directory: string) => {
    if (!project || !directory) return false;
    if (path.resolve(directory) === path.resolve(project.path)) return true;
    if (!resolvePrimaryWorktreeRoot) return false;
    const owner = await resolvePrimaryWorktreeRoot(directory);
    return Boolean(owner?.root) && path.resolve(owner.root) === path.resolve(project.path);
  };

  const validateTarget = async (projectId: string, targetSessionId: string | undefined) => {
    const parsed = z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).safeParse(targetSessionId);
    if (!parsed.success) {
      throw new OpenChamberControlError('targetSessionId is invalid', 400);
    }
    if (await isSessionArchived?.(parsed.data)) throw new OpenChamberControlError('Scheduled target is archived', 409);
    let session;
    try {
      session = await createClient('').session.get({ sessionID: parsed.data });
    } catch (error) {
      if (hasReadableError(error) && (error.name === 'NotFoundError' || error.status === 404 || error.statusCode === 404)) throw new OpenChamberControlError('Scheduled target not found', 404);
      throw error;
    }
    if (!session?.id) throw new OpenChamberControlError('Scheduled target not found', 404);
    if (session.id !== targetSessionId) throw new OpenChamberControlError('Scheduled target identity mismatch', 409);
    if (session.time?.archived) throw new OpenChamberControlError('Scheduled target is archived', 409);
    const projects = await listProjects();
    const project = projects.find((entry) => entry.id === projectId);
    const directory = session.location?.directory;
    if (!directory) throw new OpenChamberControlError('Scheduled target has no directory', 409);
    if (projects.some((entry) => entry.id !== projectId && path.resolve(entry.path) === path.resolve(directory))) {
      throw new OpenChamberControlError('Scheduled target belongs to another project', 409);
    }
    let belongs = false;
    if (chatsScope && projectId === chatsScope.id) belongs = chatsScope.contains(directory);
    else if (project && directory) belongs = await ownsDirectory(project, directory);
    if (!belongs) throw new OpenChamberControlError('Scheduled target is outside the task project', 409);
    return { session, directory };
  };

  const listEligibleTargets = async (projectId: string, candidates: unknown[]) => {
    const projects = await listProjects();
    const scopeId = chatsScope ? chatsScope.toStorageID(projectId) : projectId;
    const project = projects.find((entry) => entry.id === scopeId);
    const membership = new Map<string, Promise<boolean>>();
    const belongsToTask = (directory: string) => {
      const key = path.resolve(directory);
      if (!membership.has(key)) {
        membership.set(key, (async () => {
          if (projects.some((entry) => entry.id !== scopeId && path.resolve(entry.path) === key)) return false;
          if (chatsScope && scopeId === chatsScope.id) return chatsScope.contains(directory);
          return project ? ownsDirectory(project, directory) : false;
        })());
      }
      return membership.get(key);
    };
    const eligible: EligibleScheduledTarget[] = [];
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const sessionId = asNonEmptyString(isTargetCandidate(candidate) ? candidate.sessionId : undefined);
      const directory = asNonEmptyString(isTargetCandidate(candidate) ? candidate.directory : undefined);
      if (!sessionId || !directory) continue;
      if (await isSessionArchived?.(sessionId)) continue;
      if (await belongsToTask(directory)) eligible.push({ sessionId, directory });
    }
    return eligible;
  };

  const record = async (projectId: string, taskId: string, status: ScheduledTaskStatus, cause?: unknown, lastRunAt?: number) => {
    const patch: ScheduledTaskStatePatch = {
      lastStatus: status, lastError: cause || undefined, updatedAt: Date.now(),
    };
    if (lastRunAt !== undefined) patch.lastRunAt = lastRunAt;
    const result = await projectConfigRuntime.updateScheduledTaskState(projectId, taskId, patch);
    emitTaskRunEvent?.({ projectID: projectId, taskID: taskId, status, ranAt: Date.now(), sessionID: result.task?.state?.lastSessionId });
    return result.task;
  };

  const run = async (projectId: string, task: ScheduledTask, reason: 'manual' | 'scheduled', scheduledFor?: number, nextRunAt?: number | null) => {
    const triggeredAt = Date.now();
    const key = `${projectId}:${task.id}`;
    if (admissions.has(key)) {
      try {
        await record(projectId, task.id, 'skipped', 'task is already queued');
      } catch (persistError) {
        console.warn('[scheduled-tasks] admission failure state write failed:', hasReadableError(persistError) ? persistError.message : undefined);
      }
      return { ok: false, queued: true, error: 'task is already queued' };
    }
    admissions.add(key);
    let admitted = false;
    try {
      if (reason === 'scheduled') {
        const claim = await projectConfigRuntime.updateScheduledTaskStateIf(projectId, task.id,
          (candidate) => candidate.enabled && (!isFiniteNumber(candidate.state?.lastScheduledFor) || Math.abs(candidate.state.lastScheduledFor - (scheduledFor === undefined ? Number.NaN : scheduledFor)) > 5_000),
          { lastScheduledFor: scheduledFor, nextRunAt: nextRunAt ?? undefined });
        if (!claim.updated) return { ok: false, skipped: true };
      }
      const { directory } = await validateTarget(projectId, task.targetSessionId);
      const sendConfig = task.execution.useDefaults ? {} : {
        providerID: task.execution.providerID, modelID: task.execution.modelID,
        agent: task.execution.agent, variant: task.execution.variant,
      };
      const scheduledTask = { projectId, taskId: task.id };
      await messageQueueRuntime.enqueue(task.targetSessionId, directory, {
        content: task.execution.prompt,
        text: expandSnippets(task.execution.prompt, directory),
        sendConfig, scheduledTask,
      });
      admitted = true;
      const result = await projectConfigRuntime.updateScheduledTaskState(projectId, task.id, {
        lastRunAt: triggeredAt, lastStatus: 'queued', lastError: undefined,
        lastSessionId: task.targetSessionId, updatedAt: Date.now(),
      });
      emitTaskRunEvent?.({ projectID: projectId, taskID: task.id, status: 'queued', ranAt: Date.now(), sessionID: task.targetSessionId });
      return { ok: true, task: result.task, sessionID: task.targetSessionId, directory };
    } catch (error) {
      if (admitted) await messageQueueRuntime.cancelScheduledTask(projectId, task.id);
      const queued = hasReadableError(error) && error.status === 409 && error.message === 'task is already queued';
      let updated: ScheduledTask | null = task;
      try {
        if (!hasReadableError(error)) throw new TypeError(`Cannot read properties of ${error} (reading 'message')`);
        updated = await record(projectId, task.id, queued ? 'skipped' : 'failed', error.message, triggeredAt);
      } catch (persistError) {
        console.warn('[scheduled-tasks] admission failure state write failed:', hasReadableError(persistError) ? persistError.message : undefined);
      }
      if (!hasReadableError(error)) throw new TypeError(`Cannot read properties of ${error} (reading 'message')`);
      return { ok: false, queued, error: error.message, statusCode: error.statusCode ?? error.status, task: updated };
    } finally {
      admissions.delete(key);
    }
  };

  const beforeSend = async (sessionId: string, directory: string, item: { scheduledTask: ScheduledTaskProvenance }) => {
    const { projectId, taskId } = item.scheduledTask;
    const task = (await projectConfigRuntime.listScheduledTasks(projectId)).find((entry) => entry.id === taskId);
    if (!task || task.targetSessionId !== sessionId) throw new OpenChamberControlError('Scheduled task target changed or was removed', 409);
    const target = await validateTarget(projectId, sessionId);
    if (target.directory !== directory) throw new OpenChamberControlError('Scheduled target moved', 409);
  };

  return {
    validateTarget, listEligibleTargets, run, beforeSend,
    result: ({ projectId, taskId }: ScheduledTaskProvenance, status: ScheduledTaskStatus, cause?: unknown) => record(projectId, taskId, status, cause),
    cancel: (projectId: string, taskId: string) => messageQueueRuntime.cancelScheduledTask(projectId, taskId),
  };
};

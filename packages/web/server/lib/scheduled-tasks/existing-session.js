import path from 'node:path';
import { z } from 'zod';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import { asNonEmptyString } from '../shared/guards.js';
import { expandSnippets } from '../opencode/snippets.js';

export const createExistingSessionTasks = ({ projectConfigRuntime, messageQueueRuntime, createClient, listProjects, chatsScope, resolvePrimaryWorktreeRoot, isSessionArchived, emitTaskRunEvent }) => {
  const admissions = new Set();

  // The membership rule, in one place: a save or run and the picker's
  // discovery both ask this, so the two can never disagree about whether a
  // directory belongs to a project. Ownership comes from Git through
  // `resolvePrimaryWorktreeRoot`, never from the renderer's worktree topology.
  const ownsDirectory = async (project, directory) => {
    if (!project || !directory) return false;
    if (path.resolve(directory) === path.resolve(project.path)) return true;
    if (!resolvePrimaryWorktreeRoot) return false;
    const owner = await resolvePrimaryWorktreeRoot(directory);
    return Boolean(owner?.root) && path.resolve(owner.root) === path.resolve(project.path);
  };

  const validateTarget = async (projectId, targetSessionId) => {
    if (!z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).safeParse(targetSessionId).success) {
      throw new OpenChamberControlError('targetSessionId is invalid', 400);
    }
    if (await isSessionArchived?.(targetSessionId)) throw new OpenChamberControlError('Scheduled target is archived', 409);
    let session;
    try {
      session = await createClient('').session.get({ sessionID: targetSessionId });
    } catch (error) {
      if (error?.name === 'NotFoundError' || error?.status === 404 || error?.statusCode === 404) throw new OpenChamberControlError('Scheduled target not found', 404);
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

  /**
   * The discovery half of the same rule: which candidates a save or run would
   * accept by their directory. Candidates arrive with the directory the client
   * already knows; ownership is resolved here, and a session offered without a
   * directory, or one that is archived or foreign, is never eligible. Whether
   * the session still exists is left to `validateTarget` on save.
   */
  const listEligibleTargets = async (projectId, candidates) => {
    const projects = await listProjects();
    const scopeId = chatsScope ? chatsScope.toStorageID(projectId) : projectId;
    const project = projects.find((entry) => entry.id === scopeId);
    // Many sessions share a few directories, so membership is resolved once
    // per directory: a Git lookup per session would run hundreds of processes.
    const membership = new Map();
    const belongsToTask = (directory) => {
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
    const eligible = [];
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const sessionId = asNonEmptyString(candidate?.sessionId);
      const directory = asNonEmptyString(candidate?.directory);
      if (!sessionId || !directory) continue;
      if (await isSessionArchived?.(sessionId)) continue;
      if (await belongsToTask(directory)) eligible.push({ sessionId, directory });
    }
    return eligible;
  };

  const record = async (projectId, taskId, status, error, lastRunAt) => {
    const patch = {
      lastStatus: status, lastError: error || undefined, updatedAt: Date.now(),
    };
    if (lastRunAt !== undefined) patch.lastRunAt = lastRunAt;
    const result = await projectConfigRuntime.updateScheduledTaskState(projectId, taskId, patch);
    emitTaskRunEvent?.({ projectID: projectId, taskID: taskId, status, ranAt: Date.now(), sessionID: result.task?.state?.lastSessionId });
    return result.task;
  };

  const run = async (projectId, task, reason, scheduledFor, nextRunAt) => {
    const triggeredAt = Date.now();
    const key = `${projectId}:${task.id}`;
    if (admissions.has(key)) {
      try {
        await record(projectId, task.id, 'skipped', 'task is already queued');
      } catch (persistError) {
        console.warn('[scheduled-tasks] admission failure state write failed:', persistError?.message);
      }
      return { ok: false, queued: true, error: 'task is already queued' };
    }
    admissions.add(key);
    let admitted = false;
    try {
      if (reason === 'scheduled') {
        const claim = await projectConfigRuntime.updateScheduledTaskStateIf(projectId, task.id,
          (candidate) => candidate.enabled && (!Number.isFinite(candidate.state?.lastScheduledFor) || Math.abs(candidate.state.lastScheduledFor - scheduledFor) > 5_000),
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
      const queued = error?.status === 409 && error.message === 'task is already queued';
      let updated = task;
      try {
        updated = await record(projectId, task.id, queued ? 'skipped' : 'failed', error.message, triggeredAt);
      } catch (persistError) {
        console.warn('[scheduled-tasks] admission failure state write failed:', persistError?.message);
      }
      return { ok: false, queued, error: error.message, statusCode: error.statusCode ?? error.status, task: updated };
    } finally {
      admissions.delete(key);
    }
  };

  const beforeSend = async (sessionId, directory, item) => {
    const { projectId, taskId } = item.scheduledTask;
    const task = (await projectConfigRuntime.listScheduledTasks(projectId)).find((entry) => entry.id === taskId);
    if (!task || task.targetSessionId !== sessionId) throw new OpenChamberControlError('Scheduled task target changed or was removed', 409);
    const target = await validateTarget(projectId, sessionId);
    if (target.directory !== directory) throw new OpenChamberControlError('Scheduled target moved', 409);
  };

  return {
    validateTarget, listEligibleTargets, run, beforeSend,
    result: ({ projectId, taskId }, status, error) => record(projectId, taskId, status, error),
    cancel: (projectId, taskId) => messageQueueRuntime.cancelScheduledTask(projectId, taskId),
  };
};

import fs from 'node:fs';
import path from 'node:path';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import { loopFingerprint, parseLoopDefinition, setLoopFileEnabled } from './loops.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const createScheduledTaskService = (dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    sanitizeProjects,
    projectConfigRuntime,
    scheduledTasksRuntime,
    chatsScope = null,
  } = dependencies;

  const listProjects = async () => {
    const settings = await readSettingsFromDiskMigrated();
    return sanitizeProjects(settings?.projects || []);
  };

  // Resolves a project or the chats scope; every method below keys the
  // runtime and config by the returned id, never by the raw request value.
  const findProjectByID = async (projectID) => {
    const requested = asNonEmptyString(projectID);
    if (!requested) throw new OpenChamberControlError('projectId is required', 400);
    const normalized = chatsScope ? chatsScope.toStorageID(requested) : requested;
    const projects = await listProjects();
    const project = projects.find((entry) => entry.id === normalized) || null;
    if (project) return project;
    if (chatsScope && normalized === chatsScope.id) return { id: chatsScope.id, path: chatsScope.root };
    throw new OpenChamberControlError('Project not found', 404);
  };

  const resolveProjectID = async ({ projectId, directory } = {}) => {
    const requestedProjectID = asNonEmptyString(projectId);
    const requestedDirectory = asNonEmptyString(directory);
    if (requestedProjectID && requestedDirectory) {
      throw new OpenChamberControlError('Provide only one of projectId or directory', 400);
    }
    if (requestedProjectID) {
      return (await findProjectByID(requestedProjectID)).id;
    }
    if (!requestedDirectory) throw new OpenChamberControlError('projectId or directory is required', 400);
    const resolvedDirectory = path.resolve(requestedDirectory);
    const projects = await listProjects();
    const project = projects.find((entry) => path.resolve(entry.path) === resolvedDirectory);
    if (project) return project.id;
    // An agent working in a chat schedules into the chats scope.
    if (chatsScope?.contains(resolvedDirectory)) return chatsScope.id;
    throw new OpenChamberControlError(`Project not found for directory: ${resolvedDirectory}`, 404);
  };

  const list = async (projectID) => {
    const { id } = await findProjectByID(projectID);
    return scheduledTasksRuntime.syncProject(id);
  };

  const findLoopTask = async (projectID, taskID) => {
    const { id } = await findProjectByID(projectID);
    const normalizedTaskID = asNonEmptyString(taskID);
    if (!normalizedTaskID) throw new OpenChamberControlError('taskId is required', 400);
    const tasks = await scheduledTasksRuntime.syncProject(id);
    const task = tasks.find((entry) => entry?.id === normalizedTaskID) || null;
    if (!task) throw new OpenChamberControlError('Task not found', 404);
    if (!task.loopFile) throw new OpenChamberControlError('Task is not managed by a loop file', 400);
    if (!fs.existsSync(task.loopFile)) throw new OpenChamberControlError('Loop file not found', 404);
    return { id, task };
  };

  const setLoopEnabled = async (projectID, taskID, enabled) => {
    if (typeof enabled !== 'boolean') {
      throw new OpenChamberControlError('enabled must be a boolean', 400);
    }
    const { id, task } = await findLoopTask(projectID, taskID);
    try {
      if (!setLoopFileEnabled(task.loopFile, enabled)) {
        throw new OpenChamberControlError('Loop file must be valid before changing its enabled state', 400);
      }
    } catch (error) {
      if (error instanceof OpenChamberControlError) throw error;
      const message = error instanceof Error ? error.message : 'Failed to update loop file';
      throw new OpenChamberControlError(message, 500);
    }
    // Enabling here is the user's approval of this version of the loop on
    // this machine; a repository loop does not run on its file's word alone.
    const definition = enabled ? parseLoopDefinition(task.loopFile) : null;
    await projectConfigRuntime.setLoopApproval(id, task.loopFile, definition ? loopFingerprint(definition) : null);
    const tasks = await scheduledTasksRuntime.syncProject(id);
    return tasks.find((entry) => entry.id === taskID) || null;
  };

  const removeLoopFile = async (projectID, taskID) => {
    const { id, task } = await findLoopTask(projectID, taskID);
    try {
      fs.unlinkSync(task.loopFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete loop file';
      throw new OpenChamberControlError(message, 500);
    }
    return scheduledTasksRuntime.syncProject(id);
  };

  const upsert = async (projectID, taskInput) => {
    const { id } = await findProjectByID(projectID);
    if (!taskInput || typeof taskInput !== 'object') {
      throw new OpenChamberControlError('task payload is required', 400);
    }
    let upserted;
    try {
      upserted = await projectConfigRuntime.upsertScheduledTask(id, taskInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save scheduled task';
      const invalid = message.toLowerCase().includes('required') || message.toLowerCase().includes('invalid');
      throw new OpenChamberControlError(message, invalid ? 400 : 500);
    }
    await scheduledTasksRuntime.syncProject(id);
    const tasks = await projectConfigRuntime.listScheduledTasks(id);
    return {
      tasks,
      task: tasks.find((task) => task.id === upserted.task.id) || upserted.task,
      created: upserted.created,
    };
  };

  const remove = async (projectID, taskID) => {
    const { id } = await findProjectByID(projectID);
    const normalizedTaskID = asNonEmptyString(taskID);
    if (!normalizedTaskID) throw new OpenChamberControlError('taskId is required', 400);
    const current = await projectConfigRuntime.listScheduledTasks(id);
    const existing = current.find((task) => task.id === normalizedTaskID) || null;
    if (existing?.loopFile && fs.existsSync(existing.loopFile)) {
      // Loop tasks are owned by their `.agents/loops` markdown file: deleting
      // the JSON row would be silently undone by the next reconcile while the
      // file exists. The file itself is the removal surface. Once the file is
      // gone (the task is an orphan that the next sync would remove anyway),
      // deleting the row is safe and allowed.
      throw new OpenChamberControlError(
        'Loop task is managed by its .agents/loops markdown file; delete the file to remove the task',
        400,
      );
    }
    const result = await projectConfigRuntime.deleteScheduledTask(id, normalizedTaskID);
    if (!result.deleted) throw new OpenChamberControlError('Task not found', 404);
    await scheduledTasksRuntime.syncProject(id);
    return projectConfigRuntime.listScheduledTasks(id);
  };

  const run = async (projectID, taskID) => {
    const { id } = await findProjectByID(projectID);
    const normalizedTaskID = asNonEmptyString(taskID);
    if (!normalizedTaskID) throw new OpenChamberControlError('taskId is required', 400);
    const result = await scheduledTasksRuntime.runNow(id, normalizedTaskID);
    if (result.running || result.queued) {
      throw new OpenChamberControlError(result.error || 'Task already running', 409);
    }
    if (result.skipped) throw new OpenChamberControlError('Task not found or disabled', 404);
    if (!result.ok) {
      throw new OpenChamberControlError(result.error || 'Task run failed', 500, { task: result.task });
    }
    const response = {
      task: result.task,
      sessionId: result.sessionID,
      ...(typeof result.persistError === 'string' && result.persistError.trim()
        ? { persistError: result.persistError.trim() }
        : {}),
    };
    if (result.directory) response.directory = result.directory;
    return response;
  };

  const setEnabled = async (projectID, taskID, enabled) => {
    const tasks = await list(projectID);
    const task = tasks.find((entry) => entry?.id === taskID);
    if (!task) throw new OpenChamberControlError('Task not found', 404);
    const result = await upsert(projectID, { ...task, enabled });
    return result.task;
  };

  const status = async () => {
    if (typeof scheduledTasksRuntime.getStatus === 'function') {
      return scheduledTasksRuntime.getStatus();
    }
    const projects = await listProjects();
    let enabledCount = 0;
    let runningCount = 0;
    for (const project of projects) {
      try {
        const tasks = await projectConfigRuntime.listScheduledTasks(project.id);
        for (const task of tasks) {
          if (task?.enabled) enabledCount += 1;
          if (task?.state?.lastStatus === 'running') runningCount += 1;
        }
      } catch {
      }
    }
    return {
      hasEnabledScheduledTasks: enabledCount > 0,
      hasRunningScheduledTasks: runningCount > 0,
      enabledScheduledTasksCount: enabledCount,
      runningScheduledTasksCount: runningCount,
    };
  };

  return {
    listProjects,
    resolveProjectID,
    list,
    upsert,
    remove,
    run,
    setEnabled,
    setLoopEnabled,
    removeLoopFile,
    status,
  };
};

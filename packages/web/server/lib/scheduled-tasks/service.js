import fs from 'node:fs';
import path from 'node:path';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import { setLoopFileEnabled } from './loops.js';

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
  } = dependencies;

  const listProjects = async () => {
    const settings = await readSettingsFromDiskMigrated();
    return sanitizeProjects(settings?.projects || []);
  };

  const findProjectByID = async (projectID) => {
    const normalized = asNonEmptyString(projectID);
    if (!normalized) throw new OpenChamberControlError('projectId is required', 400);
    const projects = await listProjects();
    const project = projects.find((entry) => entry.id === normalized) || null;
    if (!project) throw new OpenChamberControlError('Project not found', 404);
    return project;
  };

  const resolveProjectID = async ({ projectId, directory } = {}) => {
    const requestedProjectID = asNonEmptyString(projectId);
    const requestedDirectory = asNonEmptyString(directory);
    if (requestedProjectID && requestedDirectory) {
      throw new OpenChamberControlError('Provide only one of projectId or directory', 400);
    }
    if (requestedProjectID) {
      await findProjectByID(requestedProjectID);
      return requestedProjectID;
    }
    if (!requestedDirectory) throw new OpenChamberControlError('projectId or directory is required', 400);
    const resolvedDirectory = path.resolve(requestedDirectory);
    const projects = await listProjects();
    const project = projects.find((entry) => path.resolve(entry.path) === resolvedDirectory);
    if (!project) throw new OpenChamberControlError(`Project not found for directory: ${resolvedDirectory}`, 404);
    return project.id;
  };

  const list = async (projectID) => {
    await findProjectByID(projectID);
    return scheduledTasksRuntime.syncProject(projectID);
  };

  const findLoopTask = async (projectID, taskID) => {
    await findProjectByID(projectID);
    const normalizedTaskID = asNonEmptyString(taskID);
    if (!normalizedTaskID) throw new OpenChamberControlError('taskId is required', 400);
    const tasks = await scheduledTasksRuntime.syncProject(projectID);
    const task = tasks.find((entry) => entry?.id === normalizedTaskID) || null;
    if (!task) throw new OpenChamberControlError('Task not found', 404);
    if (!task.loopFile) throw new OpenChamberControlError('Task is not managed by a loop file', 400);
    if (!fs.existsSync(task.loopFile)) throw new OpenChamberControlError('Loop file not found', 404);
    return task;
  };

  const setLoopEnabled = async (projectID, taskID, enabled) => {
    if (typeof enabled !== 'boolean') {
      throw new OpenChamberControlError('enabled must be a boolean', 400);
    }
    const task = await findLoopTask(projectID, taskID);
    try {
      if (!setLoopFileEnabled(task.loopFile, enabled)) {
        throw new OpenChamberControlError('Loop file must be valid before changing its enabled state', 400);
      }
    } catch (error) {
      if (error instanceof OpenChamberControlError) throw error;
      const message = error instanceof Error ? error.message : 'Failed to update loop file';
      throw new OpenChamberControlError(message, 500);
    }
    const tasks = await scheduledTasksRuntime.syncProject(projectID);
    return tasks.find((entry) => entry.id === taskID) || null;
  };

  const removeLoopFile = async (projectID, taskID) => {
    const task = await findLoopTask(projectID, taskID);
    try {
      fs.unlinkSync(task.loopFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete loop file';
      throw new OpenChamberControlError(message, 500);
    }
    return scheduledTasksRuntime.syncProject(projectID);
  };

  const upsert = async (projectID, taskInput) => {
    await findProjectByID(projectID);
    if (!taskInput || typeof taskInput !== 'object') {
      throw new OpenChamberControlError('task payload is required', 400);
    }
    let upserted;
    try {
      upserted = await projectConfigRuntime.upsertScheduledTask(projectID, taskInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save scheduled task';
      const invalid = message.toLowerCase().includes('required') || message.toLowerCase().includes('invalid');
      throw new OpenChamberControlError(message, invalid ? 400 : 500);
    }
    await scheduledTasksRuntime.syncProject(projectID);
    const tasks = await projectConfigRuntime.listScheduledTasks(projectID);
    return {
      tasks,
      task: tasks.find((task) => task.id === upserted.task.id) || upserted.task,
      created: upserted.created,
    };
  };

  const remove = async (projectID, taskID) => {
    await findProjectByID(projectID);
    const normalizedTaskID = asNonEmptyString(taskID);
    if (!normalizedTaskID) throw new OpenChamberControlError('taskId is required', 400);
    const current = await projectConfigRuntime.listScheduledTasks(projectID);
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
    const result = await projectConfigRuntime.deleteScheduledTask(projectID, normalizedTaskID);
    if (!result.deleted) throw new OpenChamberControlError('Task not found', 404);
    await scheduledTasksRuntime.syncProject(projectID);
    return projectConfigRuntime.listScheduledTasks(projectID);
  };

  const run = async (projectID, taskID) => {
    await findProjectByID(projectID);
    const normalizedTaskID = asNonEmptyString(taskID);
    if (!normalizedTaskID) throw new OpenChamberControlError('taskId is required', 400);
    const result = await scheduledTasksRuntime.runNow(projectID, normalizedTaskID);
    if (result.running || result.queued) {
      throw new OpenChamberControlError(result.error || 'Task already running', 409);
    }
    if (result.skipped) throw new OpenChamberControlError('Task not found or disabled', 404);
    if (!result.ok) {
      throw new OpenChamberControlError(result.error || 'Task run failed', 500, { task: result.task });
    }
    return {
      task: result.task,
      sessionId: result.sessionID,
      ...(typeof result.persistError === 'string' && result.persistError.trim()
        ? { persistError: result.persistError.trim() }
        : {}),
    };
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

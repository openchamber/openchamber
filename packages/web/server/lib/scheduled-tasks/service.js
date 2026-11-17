import { asNonEmptyString } from '../shared/guards.js';
import fs from 'node:fs';
import path from 'node:path';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import { discoverLoopFiles, loopFingerprint, parseLoopDefinition, setLoopFileEnabled } from './loops.js';

const samePath = (a, b) => a && b && path.resolve(a) === path.resolve(b);

const isRepositoryLoop = (projectPath, loopFile) => discoverLoopFiles(projectPath)
  .some((entry) => entry.scope === 'project' && entry.filePath === loopFile);

export const createScheduledTaskService = (dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    sanitizeProjects,
    projectConfigRuntime,
    scheduledTasksRuntime,
    chatsScope = null,
    resolvePrimaryWorktreeRoot = null,
    readModelCatalog = null,
  } = dependencies;

  const listProjects = async () => {
    const settings = await readSettingsFromDiskMigrated();
    return sanitizeProjects(settings?.projects || []);
  };

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
    const project = projects.find((entry) => samePath(entry.path, resolvedDirectory));
    if (project) return project.id;
    if (chatsScope?.contains(resolvedDirectory)) return chatsScope.id;
    if (resolvePrimaryWorktreeRoot) {
      try {
        const primaryRoot = asNonEmptyString((await resolvePrimaryWorktreeRoot(resolvedDirectory))?.root);
        if (primaryRoot && !samePath(primaryRoot, resolvedDirectory)) {
          const owner = projects.find((entry) => samePath(entry.path, primaryRoot));
          if (owner) return owner.id;
        }
      } catch {
        // A throwing resolver call: fall through to the unchanged 404.
        // resolvePrimaryWorktreeRoot itself reports the directory for a
        // non-checkout or unavailable git, and the samePath guard above
        // skips those, so only an unexpected throw reaches this catch.
      }
    }
    throw new OpenChamberControlError(`Project not found for directory: ${resolvedDirectory}`, 404);
  };

  const resolveExecutionDirectory = async (projectID, targetSessionId, { tolerateMissingTarget = false } = {}) => {
    const project = await findProjectByID(projectID);
    if (targetSessionId) {
      try {
        return (await scheduledTasksRuntime.validateTarget(project.id, targetSessionId)).directory;
      } catch (error) {
        if (!tolerateMissingTarget) throw error;
        return null;
      }
    }
    return project.path;
  };

  const assertNamedModelKnown = async (projectID, task, previous, resolvedDirectory) => {
    const providerID = asNonEmptyString(task?.execution?.providerID);
    const modelID = asNonEmptyString(task?.execution?.modelID);
    if (!providerID || !modelID) return;
    if (task?.execution?.useDefaults === true) return;
    const stored = previous?.execution;
    const unchanged = stored?.providerID === providerID && stored?.modelID === modelID;
    if (unchanged && stored?.useDefaults !== true) return;
    if (!readModelCatalog) return;
    const directory = resolvedDirectory !== undefined
      ? resolvedDirectory
      : await resolveExecutionDirectory(projectID, task.targetSessionId, { tolerateMissingTarget: true });
    if (directory === null) return;
    const entries = await readModelCatalog(directory);
    if (!Array.isArray(entries) || entries.length === 0) return;
    const known = entries.some((model) => model?.providerID === providerID
      && (model.id === modelID || model.modelID === modelID));
    if (!known) {
      throw new OpenChamberControlError(`unknown model: ${providerID}/${modelID}`, 400);
    }
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
    const definition = enabled ? parseLoopDefinition(task.loopFile) : null;
    if (definition) await assertNamedModelKnown(id, { execution: definition.execution });
    try {
      if (!setLoopFileEnabled(task.loopFile, enabled)) {
        throw new OpenChamberControlError('Loop file must be valid before changing its enabled state', 400);
      }
    } catch (error) {
      if (error instanceof OpenChamberControlError) throw error;
      const message = error instanceof Error ? error.message : 'Failed to update loop file';
      throw new OpenChamberControlError(message, 500);
    }
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
    const previous = taskInput.id ? (await projectConfigRuntime.listScheduledTasks(id)).find((task) => task.id === taskInput.id) : null;
    let targetDirectory;
    if (taskInput.targetSessionId && (taskInput.enabled !== false || previous?.targetSessionId !== taskInput.targetSessionId)) {
      targetDirectory = (await scheduledTasksRuntime.validateTarget(id, taskInput.targetSessionId)).directory;
    }
    await assertNamedModelKnown(id, taskInput, previous, targetDirectory);
    try {
      upserted = await projectConfigRuntime.upsertScheduledTask(id, taskInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save scheduled task';
      const invalid = message.toLowerCase().includes('required') || message.toLowerCase().includes('invalid');
      throw new OpenChamberControlError(message, invalid ? 400 : 500);
    }
    if (previous?.targetSessionId && ((previous.enabled && upserted.task.enabled === false) || previous.targetSessionId !== upserted.task.targetSessionId)) {
      await scheduledTasksRuntime.cancelWaitingPrompt(id, taskInput.id);
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
      throw new OpenChamberControlError(
        'Loop task is managed by its .agents/loops markdown file; delete the file to remove the task',
        400,
      );
    }
    const result = await projectConfigRuntime.deleteScheduledTask(id, normalizedTaskID);
    if (!result.deleted) throw new OpenChamberControlError('Task not found', 404);
    await scheduledTasksRuntime.cancelWaitingPrompt?.(id, normalizedTaskID);
    await scheduledTasksRuntime.syncProject(id);
    return projectConfigRuntime.listScheduledTasks(id);
  };

  const run = async (projectID, taskID) => {
    const { id } = await findProjectByID(projectID);
    const normalizedTaskID = asNonEmptyString(taskID);
    if (!normalizedTaskID) throw new OpenChamberControlError('taskId is required', 400);
    const result = await scheduledTasksRuntime.runNow(id, normalizedTaskID);
    if (result.running || result.queued) {
      throw new OpenChamberControlError(result.error || 'Task already running', 409, { busy: result.queued ? 'queued' : 'running' });
    }
    if (result.skipped) throw new OpenChamberControlError('Task not found or disabled', 404);
    if (!result.ok) {
      throw new OpenChamberControlError(result.error || 'Task run failed', result.statusCode || 500, { task: result.task });
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
    const project = await findProjectByID(projectID);
    const tasks = await scheduledTasksRuntime.syncProject(project.id);
    const task = tasks.find((entry) => entry?.id === taskID);
    if (!task) throw new OpenChamberControlError('Task not found', 404);
    if (!task.loopFile) {
      const result = await upsert(project.id, { ...task, enabled });
      return result.task;
    }
    if (enabled === task.enabled) return task;
    if (enabled && isRepositoryLoop(project.path, task.loopFile)) {
      throw new OpenChamberControlError(`"${task.name}" comes from this repository. Enable it in Scheduled tasks.`, 409);
    }
    return setLoopEnabled(project.id, task.id, enabled);
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
    resolveExecutionDirectory,
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

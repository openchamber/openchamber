import { asNonEmptyString } from '../shared/guards.js';
import fs from 'node:fs';
import path from 'node:path';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import { discoverLoopFiles, loopFingerprint, parseLoopDefinition, setLoopFileEnabled } from './loops.js';

const samePath = (a, b) => a && b && path.resolve(a) === path.resolve(b);

// Same scope rule the scheduler applies: a file under the project's own
// `.agents/loops` is a repository loop, even where it is also the user folder.
const isRepositoryLoop = (projectPath, loopFile) => discoverLoopFiles(projectPath)
  .some((entry) => entry.scope === 'project' && entry.filePath === loopFile);

export const createScheduledTaskService = (dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    sanitizeProjects,
    projectConfigRuntime,
    scheduledTasksRuntime,
    chatsScope = null,
    // Git helper that maps a linked worktree back to the checkout it came from;
    // see resolveProjectID.
    resolvePrimaryWorktreeRoot = null,
    // Reads the model catalog a fire resolves against; see model-catalog.js.
    // Absent leaves stored models unchecked, which is what the tests that do
    // not exercise the catalog want.
    readModelCatalog = null,
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
    const project = projects.find((entry) => samePath(entry.path, resolvedDirectory));
    if (project) return project.id;
    // A session in a linked worktree of a registered project schedules for
    // that project: the worktree itself is almost never registered, and the
    // project root checkout is what its record stores. A directory inside the
    // chats scope wins first, so chats paths are never run through git.
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
        // A paused task may keep a target that no longer resolves — `upsert`
        // tolerates exactly that so the task stays editable. Without a session
        // there is no worktree to read a catalog from, so the caller stands down
        // rather than failing a save the guard just allowed.
        if (!tolerateMissingTarget) throw error;
        return null;
      }
    }
    return project.path;
  };

  // A stored model that nothing serves fails at fire time, in a session nobody
  // is watching, and reads as accepted until then. Rejecting it where it is
  // written is the only place the user is still present.
  //
  // Only a model this call actually changes is checked: a task whose stored id
  // has since disappeared must stay retimeable, disableable and deletable, and
  // that is the task a user needs to reach to remove the dead id.
  //
  // A task that follows session defaults stores a pair it never runs — the
  // editor prefills it from the composer pick even while the picker is hidden —
  // so the pair is only judged once it is what the fire path would dispatch.
  // That happens when defaults are off, including on the save that turns them
  // off, where the pair itself has not changed but starts to matter.
  const assertNamedModelKnown = async (projectID, task, previous, resolvedDirectory) => {
    const providerID = asNonEmptyString(task?.execution?.providerID);
    const modelID = asNonEmptyString(task?.execution?.modelID);
    if (!providerID || !modelID) return;
    if (task?.execution?.useDefaults === true) return;
    const stored = previous?.execution;
    const unchanged = stored?.providerID === providerID && stored?.modelID === modelID;
    if (unchanged && stored?.useDefaults !== true) return;
    if (!readModelCatalog) return;
    // `upsert` resolves the target once for its own guard and hands the result
    // here, so an enabled targeted save reads the session a single time.
    const directory = resolvedDirectory !== undefined
      ? resolvedDirectory
      : await resolveExecutionDirectory(projectID, task.targetSessionId, { tolerateMissingTarget: true });
    if (directory === null) return;
    const entries = await readModelCatalog(directory);
    // A location OpenCode has not started in answers empty before its catalog
    // fills in; that is not evidence a model is gone, the same stand-down the
    // session routes apply to their own selection check.
    if (!Array.isArray(entries) || entries.length === 0) return;
    // Same matcher as the session routes' `findCatalogModel`: a catalog entry
    // may carry a display override in `id`, and `modelID` is the upstream name
    // the fire path dispatches, so either form names a model that will run.
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
    // A loop file is hand-written, so enabling it is the only point where a
    // person is present to be told its model does not exist. Checked before the
    // file is rewritten, so a rejected enable leaves the loop off.
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
    // Enabling here is the user's approval of this version of the loop on
    // this machine; a repository loop does not run on its file's word alone.
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

  // The agent tool and the CLI. A loop task follows its file, so it changes
  // the way the Scheduled tasks checkbox does. A repository loop is the
  // exception for enabling: that is the user's own decision on this machine,
  // made in Scheduled tasks, never by an agent or a script on their behalf.
  const setEnabled = async (projectID, taskID, enabled) => {
    const project = await findProjectByID(projectID);
    const tasks = await scheduledTasksRuntime.syncProject(project.id);
    const task = tasks.find((entry) => entry?.id === taskID);
    if (!task) throw new OpenChamberControlError('Task not found', 404);
    if (!task.loopFile) {
      const result = await upsert(project.id, { ...task, enabled });
      return result.task;
    }
    // Nothing to change: the loop file, which may be tracked in the
    // repository, and the approval stay untouched.
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

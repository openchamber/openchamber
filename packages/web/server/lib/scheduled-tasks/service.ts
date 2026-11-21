import { asNonEmptyString, isBoolean, isString } from '../shared/guards.js';
import fs from 'node:fs';
import path from 'node:path';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import { discoverLoopFiles, loopFingerprint, parseLoopDefinition, setLoopFileEnabled } from './loops.js';
import type { resolvePrimaryWorktreeRoot as resolveGitWorktreeRoot } from '../git/service.js';
import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskStore, SessionProject } from '../projects/contracts.js';
import type { createProjectConfigRuntime } from '../projects/project-config.js';
import { assertTaskTextWithinLimits } from '../projects/task-text-limits.js';
import type { createChatsScope } from './chats-scope.js';
import type { createScheduledTasksRuntime, ScheduledTaskRunResult } from './runtime.js';

interface ScheduledTaskSettings {
  projects?: unknown;
}

type Scheduler = ReturnType<typeof createScheduledTasksRuntime>;
type ProjectConfig = ReturnType<typeof createProjectConfigRuntime>;

export interface ScheduledTaskServiceDependencies {
  readSettingsFromDiskMigrated: () => Promise<ScheduledTaskSettings | null>;
  sanitizeProjects: (projects: ScheduledTaskSettings['projects']) => SessionProject[];
  projectConfigRuntime: Pick<ScheduledTaskStore, 'listScheduledTasks' | 'upsertScheduledTask'> & Pick<ProjectConfig, 'deleteScheduledTask' | 'setLoopApproval'>;
  scheduledTasksRuntime: Pick<Scheduler, 'syncProject' | 'validateTarget' | 'cancelWaitingPrompt' | 'runNow'> & Partial<Pick<Scheduler, 'getStatus'>>;
  chatsScope?: ReturnType<typeof createChatsScope> | null;
  resolvePrimaryWorktreeRoot?: typeof resolveGitWorktreeRoot | null;
  readModelCatalog?: ((directory: string) => Promise<(ModelCatalogEntry | null | undefined)[]>) | null;
}

interface ModelCatalogEntry {
  providerID?: unknown;
  id?: unknown;
  modelID?: unknown;
}

export interface ScheduledTaskRunResponse {
  task: ScheduledTaskRunResult['task'];
  sessionId: ScheduledTaskRunResult['sessionID'];
  persistError?: string;
  directory?: string;
}

interface ProjectSelector {
  projectId?: SessionProject['id'] | undefined;
  directory?: SessionProject['path'] | undefined;
}

interface NamedExecution {
  providerID?: unknown;
  modelID?: unknown;
  useDefaults?: unknown;
}

const isTaskInput = (value: unknown): value is ScheduledTaskInput => Boolean(value) && typeof value === 'object';
const hasReadableExecution = (value: unknown): value is NamedExecution => value !== null && value !== undefined;
const readExecutionField = (value: ScheduledTaskInput['execution'], key: keyof NamedExecution) => (
  hasReadableExecution(value) ? value[key] : undefined
);
const hasStatusReader = (value: Scheduler['getStatus'] | undefined): value is Scheduler['getStatus'] => typeof value === 'function';
const hasLoopFile = (task: ScheduledTask): task is ScheduledTask & { loopFile: string } => Boolean(task.loopFile);

const samePath = (a: string, b: string) => a && b && path.resolve(a) === path.resolve(b);

const isRepositoryLoop = (projectPath: string, loopFile: string) => discoverLoopFiles(projectPath)
  .some((entry) => entry.scope === 'project' && entry.filePath === loopFile);

export const createScheduledTaskService = (dependencies: ScheduledTaskServiceDependencies) => {
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

  const findProjectByID = async (projectID: string | null) => {
    const requested = asNonEmptyString(projectID);
    if (!requested) throw new OpenChamberControlError('projectId is required', 400);
    const normalized = chatsScope ? chatsScope.toStorageID(requested) : requested;
    const projects = await listProjects();
    const project = projects.find((entry) => entry.id === normalized) || null;
    if (project) return project;
    if (chatsScope && normalized === chatsScope.id) return { id: chatsScope.id, path: chatsScope.root };
    throw new OpenChamberControlError('Project not found', 404);
  };

  const resolveProjectID = async ({ projectId, directory }: ProjectSelector = {}) => {
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
        void 0;
      }
    }
    throw new OpenChamberControlError(`Project not found for directory: ${resolvedDirectory}`, 404);
  };

  const resolveExecutionDirectory = async (projectID: string | null, targetSessionId: ScheduledTaskInput['targetSessionId'], { tolerateMissingTarget = false } = {}) => {
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

  const assertNamedModelKnown = async (projectID: string, task: Pick<ScheduledTaskInput, 'execution' | 'targetSessionId'>, previous?: ScheduledTask | null, resolvedDirectory?: string) => {
    const providerID = asNonEmptyString(readExecutionField(task?.execution, 'providerID'));
    const modelID = asNonEmptyString(readExecutionField(task?.execution, 'modelID'));
    if (!providerID || !modelID) return;
    if (readExecutionField(task?.execution, 'useDefaults') === true) return;
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

  const list = async (projectID: string | null) => {
    const { id } = await findProjectByID(projectID);
    return scheduledTasksRuntime.syncProject(id);
  };

  const findLoopTask = async (projectID: string | null, taskID: string | null) => {
    const { id } = await findProjectByID(projectID);
    const normalizedTaskID = asNonEmptyString(taskID);
    if (!normalizedTaskID) throw new OpenChamberControlError('taskId is required', 400);
    const tasks = await scheduledTasksRuntime.syncProject(id);
    const task = tasks.find((entry) => entry?.id === normalizedTaskID) || null;
    if (!task) throw new OpenChamberControlError('Task not found', 404);
    if (!hasLoopFile(task)) throw new OpenChamberControlError('Task is not managed by a loop file', 400);
    if (!fs.existsSync(task.loopFile)) throw new OpenChamberControlError('Loop file not found', 404);
    return { id, task };
  };

  const setLoopEnabled = async (projectID: string | null, taskID: string | null, enabled: ScheduledTaskInput['enabled']) => {
    if (!isBoolean(enabled)) {
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

  const removeLoopFile = async (projectID: string | null, taskID: string | null) => {
    const { id, task } = await findLoopTask(projectID, taskID);
    try {
      fs.unlinkSync(task.loopFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete loop file';
      throw new OpenChamberControlError(message, 500);
    }
    return scheduledTasksRuntime.syncProject(id);
  };

  const upsert = async (projectID: string | null, taskInput: ScheduledTaskInput | null | undefined) => {
    const { id } = await findProjectByID(projectID);
    if (!isTaskInput(taskInput)) {
      throw new OpenChamberControlError('task payload is required', 400);
    }
    try {
      assertTaskTextWithinLimits(taskInput);
    } catch (error) {
      throw new OpenChamberControlError(error instanceof Error ? error.message : 'Task text is too long', 400);
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

  const remove = async (projectID: string | null, taskID: string | null) => {
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

  const run = async (projectID: string | null, taskID: string | null) => {
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
    const response: ScheduledTaskRunResponse = {
      task: result.task,
      sessionId: result.sessionID,
    };
    if (isString(result.persistError) && result.persistError.trim()) response.persistError = result.persistError.trim();
    if (result.directory) response.directory = result.directory;
    return response;
  };

  const setEnabled = async (projectID: string | null, taskID: string | null, enabled: boolean) => {
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
    if (hasStatusReader(scheduledTasksRuntime.getStatus)) {
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
        void 0;
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

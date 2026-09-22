import { runtimeFetch } from './runtime-fetch';
import { z } from 'zod';

export type ScheduledTaskStatus = 'idle' | 'running' | 'success' | 'error' | 'denied';

export type ScheduledTask = {
  id: string;
  name: string;
  enabled: boolean;
  /** Absolute path of the `.agents/loops/*.md` file driving this task, when
   *  any. Present only for loop-sourced tasks; unknown to older clients. */
  loopFile?: string;
  schedule: {
    kind: 'daily' | 'weekly' | 'once' | 'cron';
    times?: string[];
    time?: string;
    date?: string;
    weekdays?: number[];
    cron?: string;
    timezone?: string;
  };
  execution: {
    prompt: string;
    providerID: string;
    modelID: string;
    variant?: string;
    agent?: string;
    goalEnabled?: boolean;
    goalTokenBudget?: number;
    permissionAutoAccept?: boolean;
  };
  state: {
    createdAt: number;
    updatedAt: number;
    lastRunAt?: number;
    lastStatus?: ScheduledTaskStatus;
    lastError?: string;
    lastDurationMs?: number;
    lastSessionId?: string;
    nextRunAt?: number;
  };
};

export class ScheduledTaskRunError extends Error {
  readonly persistError?: string;
  readonly task?: Pick<ScheduledTask, 'id' | 'state'>;

  constructor(message: string, persistError?: string, task?: Pick<ScheduledTask, 'id' | 'state'>) {
    super(message);
    this.name = 'ScheduledTaskRunError';
    this.persistError = persistError;
    this.task = task;
  }
}

const scheduledTaskRunTaskSchema = z.object({
  id: z.string().min(1),
  state: z.object({
    createdAt: z.number(),
    updatedAt: z.number(),
    lastRunAt: z.number().optional(),
    lastStatus: z.enum(['idle', 'running', 'success', 'error', 'denied']).optional(),
    lastError: z.string().optional(),
    lastDurationMs: z.number().optional(),
    lastSessionId: z.string().optional(),
    nextRunAt: z.number().optional(),
  }),
});

const scheduledTaskRunResponseSchema = z.object({
  error: z.string().trim().min(1).optional(),
  persistError: z.string().trim().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  task: scheduledTaskRunTaskSchema.optional(),
});

const parseScheduledTaskRunResponse = async (response: Response) => {
  const parsed = await response.json().catch(() => null);
  const result = scheduledTaskRunResponseSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
};

const parseErrorMessage = async (response: Response, fallback: string) => {
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
      return parsed.error;
    }
  } catch {
    return fallback;
  }
  return fallback;
};

const ensureProjectID = (projectID: string): string => {
  const trimmed = typeof projectID === 'string' ? projectID.trim() : '';
  if (!trimmed) {
    throw new Error('projectId is required');
  }
  return trimmed;
};

export const fetchScheduledTasks = async (projectID: string): Promise<ScheduledTask[]> => {
  const safeProjectID = ensureProjectID(projectID);
  const response = await runtimeFetch(`/api/projects/${encodeURIComponent(safeProjectID)}/scheduled-tasks`);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to load scheduled tasks'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    return [];
  }
  return parsed.tasks as ScheduledTask[];
};

export const upsertScheduledTask = async (projectID: string, task: Partial<ScheduledTask>): Promise<ScheduledTask[]> => {
  const safeProjectID = ensureProjectID(projectID);
  const response = await runtimeFetch(`/api/projects/${encodeURIComponent(safeProjectID)}/scheduled-tasks`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ task }),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to save scheduled task'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    return [];
  }
  return parsed.tasks as ScheduledTask[];
};

export const deleteScheduledTask = async (projectID: string, taskID: string): Promise<ScheduledTask[]> => {
  const safeProjectID = ensureProjectID(projectID);
  const safeTaskID = ensureProjectID(taskID);
  const response = await runtimeFetch(`/api/projects/${encodeURIComponent(safeProjectID)}/scheduled-tasks/${encodeURIComponent(safeTaskID)}`, {
    method: 'DELETE',
    headers: {
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to delete scheduled task'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    return [];
  }
  return parsed.tasks as ScheduledTask[];
};

const getLoopFileEndpoint = (projectID: string, taskID: string): string => {
  const safeProjectID = ensureProjectID(projectID);
  const safeTaskID = ensureProjectID(taskID);
  return `/api/projects/${encodeURIComponent(safeProjectID)}/scheduled-tasks/${encodeURIComponent(safeTaskID)}/loop-file`;
};

export const setLoopScheduledTaskEnabled = async (projectID: string, taskID: string, enabled: boolean): Promise<void> => {
  const response = await runtimeFetch(getLoopFileEndpoint(projectID, taskID), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to update loop task'));
  }
};

export const deleteScheduledTaskLoopFile = async (projectID: string, taskID: string): Promise<void> => {
  const response = await runtimeFetch(getLoopFileEndpoint(projectID, taskID), {
    method: 'DELETE',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to delete loop file'));
  }
};

export const syncScheduledTaskLoops = async (projectID: string): Promise<void> => {
  await fetchScheduledTasks(projectID);
};

export const runScheduledTaskNow = async (
  projectID: string,
  taskID: string,
): Promise<{ sessionId?: string; persistError?: string }> => {
  const safeProjectID = ensureProjectID(projectID);
  const safeTaskID = ensureProjectID(taskID);
  const response = await runtimeFetch(`/api/projects/${encodeURIComponent(safeProjectID)}/scheduled-tasks/${encodeURIComponent(safeTaskID)}/run`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    const parsed = await parseScheduledTaskRunResponse(response);
    throw new ScheduledTaskRunError(parsed?.error ?? 'Failed to run scheduled task', parsed?.persistError, parsed?.task);
  }
  const parsed = await parseScheduledTaskRunResponse(response);
  return {
    sessionId: parsed?.sessionId,
    persistError: parsed?.persistError,
  };
};

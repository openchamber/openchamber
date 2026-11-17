import { z } from 'zod';
import { runtimeFetch } from './runtime-fetch';

export type ScheduledTaskStatus = 'idle' | 'running' | 'success' | 'error' | 'queued' | 'sent' | 'skipped' | 'failed' | 'cancelled';

export type ScheduledTask = {
  id: string;
  name: string;
  enabled: boolean;
  targetSessionId?: string;
  loopFile?: string;
  loopApproval?: 'required' | 'outdated';
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
    providerID?: string;
    modelID?: string;
    useDefaults?: boolean;
    variant?: string;
    agent?: string;
    goalEnabled?: boolean;
    goalTokenBudget?: number;
    permissionAutoAccept?: boolean;
  };
  runInWorktree?: boolean;
  cleanupWorktree?: boolean;
  baseBranch?: string;
  state: {
    createdAt: number;
    updatedAt: number;
    lastRunAt?: number;
    lastStatus?: ScheduledTaskStatus;
    lastError?: string;
    lastDurationMs?: number;
    lastSessionId?: string;
    lastRunIsolated?: boolean;
    lastRunBranch?: string;
    nextRunAt?: number;
  };
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

const ELIGIBLE_TARGETS_BATCH = 500;
const eligibleTargetsResponseSchema = z.object({
  eligible: z.array(z.object({ sessionId: z.string().min(1) })),
});

export const fetchEligibleScheduledTaskTargets = async (
  projectID: string,
  candidates: Array<{ sessionId: string; directory: string }>,
  signal?: AbortSignal,
): Promise<Set<string>> => {
  const safeProjectID = ensureProjectID(projectID);
  const eligible = new Set<string>();
  for (let start = 0; start < candidates.length; start += ELIGIBLE_TARGETS_BATCH) {
    const response = await runtimeFetch(`/api/projects/${encodeURIComponent(safeProjectID)}/scheduled-tasks/targets/eligible`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ candidates: candidates.slice(start, start + ELIGIBLE_TARGETS_BATCH) }),
      signal,
    });
    if (!response.ok) {
      throw new Error(await parseErrorMessage(response, 'Failed to resolve eligible targets'));
    }
    const parsed = eligibleTargetsResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new Error('Unexpected eligible targets response');
    for (const entry of parsed.data.eligible) eligible.add(entry.sessionId);
  }
  return eligible;
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

const RunNowResponseSchema = z.object({
  sessionId: z.string().min(1).optional().catch(undefined),
  directory: z.string().min(1).optional().catch(undefined),
  persistError: z.string().trim().min(1).optional().catch(undefined),
});

const BusyResponseSchema = z.object({ busy: z.enum(['running', 'queued']) });

export class ScheduledTaskBusyError extends Error {
  constructor(readonly busy: 'running' | 'queued', message: string) {
    super(message);
    this.name = 'ScheduledTaskBusyError';
  }
}

export const runScheduledTaskNow = async (
  projectID: string,
  taskID: string,
): Promise<{ sessionId?: string; directory?: string; persistError?: string }> => {
  const safeProjectID = ensureProjectID(projectID);
  const safeTaskID = ensureProjectID(taskID);
  const response = await runtimeFetch(`/api/projects/${encodeURIComponent(safeProjectID)}/scheduled-tasks/${encodeURIComponent(safeTaskID)}/run`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
    },
  });
  if (response.status === 409) {
    const body = await response.json().catch(() => null);
    const busy = BusyResponseSchema.safeParse(body);
    if (busy.success) throw new ScheduledTaskBusyError(busy.data.busy, 'Scheduled task is already running');
    const refusal = z.object({ error: z.string().min(1) }).safeParse(body);
    throw new Error(refusal.success ? refusal.data.error : 'Failed to run scheduled task');
  }
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to run scheduled task'));
  }
  const parsed = RunNowResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : {};
};

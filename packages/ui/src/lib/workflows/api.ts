import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  workflowAgentDetailSchema,
  workflowRunDetailSchema,
  workflowRunListSchema,
  type WorkflowAgentDetail,
  type WorkflowRun,
  type WorkflowRunDetail,
} from './model';

const errorSchema = z.object({ error: z.string().min(1) }).catch({ error: '' });

export type WorkflowRunAction = 'approve' | 'decline' | 'stop' | 'resume';

const failure = async (response: Response, fallback: string): Promise<Error> => {
  const payload = errorSchema.parse(await response.json().catch(() => null));
  return new Error(payload.error || `${fallback} (${response.status})`);
};

/** The workflow runs a session proposed, oldest first. Throws when the server cannot answer. */
export async function fetchWorkflowRuns(sessionId: string): Promise<WorkflowRun[]> {
  const response = await runtimeFetch('/api/openchamber/workflows', { query: { sessionId } });
  if (!response.ok) throw await failure(response, 'Could not read workflow runs');
  return workflowRunListSchema.parse(await response.json()).runs;
}

/** The runs of every session in these folders (a project and its worktrees), oldest first. */
export async function fetchProjectWorkflowRuns(directories: readonly string[]): Promise<WorkflowRun[]> {
  const query = new URLSearchParams();
  for (const directory of directories) query.append('directory', directory);
  const response = await runtimeFetch(`/api/openchamber/workflows?${query.toString()}`);
  if (!response.ok) throw await failure(response, 'Could not read workflow runs');
  return workflowRunListSchema.parse(await response.json()).runs;
}

const savedWorkflowListSchema = z.object({
  workflows: z.array(z.object({ name: z.string().min(1), description: z.string().optional(), error: z.string().optional() })),
});

export type SavedWorkflow = z.infer<typeof savedWorkflowListSchema>['workflows'][number];

/** The workflows saved in a project's .openchamber/workflows/. */
export async function fetchSavedWorkflows(directory: string): Promise<SavedWorkflow[]> {
  const response = await runtimeFetch('/api/openchamber/workflows/saved', { query: { directory } });
  if (!response.ok) throw await failure(response, 'Could not read saved workflows');
  return savedWorkflowListSchema.parse(await response.json()).workflows;
}

const startedSchema = z.object({ runId: z.string().min(1), sessionId: z.string().min(1) });

/**
 * Runs the project's saved workflow `name` (read from `scriptDirectory`) now in
 * `sessionId`, or in a new session in `directory` when null; answers both ids.
 */
export async function startSavedWorkflow(input: { directory: string; scriptDirectory: string; sessionId: string | null; name: string }): Promise<z.infer<typeof startedSchema>> {
  const response = await runtimeFetch('/api/openchamber/workflows/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await failure(response, 'Could not start the workflow');
  return startedSchema.parse(await response.json());
}

/** One run's every log line, script and result. */
export async function fetchWorkflowRunDetail(runId: string): Promise<WorkflowRunDetail> {
  const response = await runtimeFetch(`/api/openchamber/workflows/${encodeURIComponent(runId)}`);
  if (!response.ok) throw await failure(response, 'Could not read the workflow run');
  return workflowRunDetailSchema.parse(await response.json());
}

/** One agent's prompt and full answer. */
export async function fetchWorkflowAgentDetail(runId: string, key: string): Promise<WorkflowAgentDetail> {
  const response = await runtimeFetch(`/api/openchamber/workflows/${encodeURIComponent(runId)}/agents/${encodeURIComponent(key)}`);
  if (!response.ok) throw await failure(response, 'Could not read the workflow agent');
  return workflowAgentDetailSchema.parse(await response.json());
}

/** Deletes a finished run; the server announces the removal to every client. */
export async function deleteWorkflowRun(runId: string): Promise<void> {
  const response = await runtimeFetch(`/api/openchamber/workflows/${encodeURIComponent(runId)}`, { method: 'DELETE' });
  if (!response.ok) throw await failure(response, 'Could not delete the workflow run');
}

/** The user's approve, decline, stop or resume; the run's new state arrives as an event. */
export async function sendWorkflowRunAction(runId: string, action: WorkflowRunAction): Promise<void> {
  const response = await runtimeFetch(`/api/openchamber/workflows/${encodeURIComponent(runId)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw await failure(response, 'The workflow did not accept the action');
}

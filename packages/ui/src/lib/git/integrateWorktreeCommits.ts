import { runtimeFetch } from '@/lib/runtime-fetch';

export type IntegratePlan = {
  repoRoot: string;
  sourceBranch: string;
  targetBranch: string;
  commits: string[];
};

type IntegrateConflictDetails = {
  statusPorcelain: string;
  unmergedFiles: string[];
  diff: string;
  currentPatchMeta: string;
  currentPatch: string;
};

export type IntegrateInProgress = {
  repoRoot: string;
  tempWorktreePath: string;
  revision: number;
  sourceBranch: string;
  targetBranch: string;
  targetSha: string;
  pickBase: string;
  commits: string[];
  skippedCommits: string[];
  remainingCommits: string[];
  currentCommit: string;
  finish?: { outcome: 'aborted' | 'publishing' | 'published'; moved: number };
};

export type IntegrateConflict = {
  kind: 'conflict';
  state: IntegrateInProgress;
  details: IntegrateConflictDetails;
  message?: string;
  reason?: 'changed' | 'alreadyOpen' | 'sessionsHeld';
};

type IntegrateSessionsMoved = { sessionsMoved?: number; sessionsDirectory?: string | null };

export type IntegrateResult =
  | { kind: 'noop'; reason: string }
  | ({ kind: 'success'; moved: number; kept?: boolean } & IntegrateSessionsMoved)
  | { kind: 'gone' }
  | { kind: 'busy' }
  | IntegrateConflict;

export type IntegrateAbortResult =
  | ({ kind: 'aborted' | 'kept' | 'success'; kept?: boolean } & IntegrateSessionsMoved)
  | { kind: 'gone' }
  | { kind: 'busy' }
  | IntegrateConflict;

const postIntegrate = async <T>(action: string, body: unknown): Promise<T> => {
  const response = await runtimeFetch(`/api/git/integrate/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `Git integrate request failed: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
};

export async function computeIntegratePlan(args: {
  repoRoot: string;
  sourceBranch: string;
  targetBranch: string;
}): Promise<IntegratePlan> {
  return postIntegrate<IntegratePlan>('plan', args);
}

export async function listIntegrateConflicts(directory: string): Promise<IntegrateConflict[]> {
  return postIntegrate<IntegrateConflict[]>('conflicts', { directory });
}

export async function integrateWorktreeCommits(plan: IntegratePlan): Promise<IntegrateResult> {
  return postIntegrate<IntegrateResult>('run', { plan });
}

export async function abortIntegrate(state: IntegrateInProgress): Promise<IntegrateAbortResult> {
  return postIntegrate<IntegrateAbortResult>('abort', { state });
}

export async function continueIntegrate(state: IntegrateInProgress): Promise<IntegrateResult> {
  return postIntegrate<IntegrateResult>('continue', { state });
}

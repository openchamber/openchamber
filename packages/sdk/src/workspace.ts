import type { JsonValue } from './contract.ts';

export type GuestLoadState = 'loading' | 'ready' | 'error';
export type GuestProject = { id: string; name: string; directory: string };
export type GuestWorktree = {
  directory: string;
  name: string;
  branch: string;
  status: 'ready' | 'pending' | 'invalid' | 'missing';
};
export type GuestSessionActivity = 'unknown' | 'idle' | 'running' | 'retrying' | 'waiting-permission' | 'waiting-question';
export type GuestSessionRecord = {
  id: string;
  title: string;
  projectId: string;
  directory: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  worktree: GuestWorktree | null;
  activity: GuestSessionActivity;
  /** Observed turn outcome, never a task status. Unknown history stays null. */
  outcome: 'completed' | 'failed' | null;
  items: { id: string; data?: JsonValue }[];
};
export type GuestDirectoryCoverage = { directory: string; state: GuestLoadState };
export type GuestProjectsSnapshot = { kind: 'projects'; state: GuestLoadState; projects: GuestProject[] };
export type GuestWorktreesSnapshot = { kind: 'worktrees'; projectId: string; state: GuestLoadState; worktrees: GuestWorktree[] };
export type GuestSessionsSnapshot = {
  kind: 'sessions'; projectId: string; state: GuestLoadState;
  coverage: GuestDirectoryCoverage[];
  sessions: GuestSessionRecord[];
};
export type GuestWorkspaceSnapshot = GuestProjectsSnapshot | GuestWorktreesSnapshot | GuestSessionsSnapshot;
export type GuestWorkspaceQuery = { kind: 'projects' } | { kind: 'worktrees'; projectId: string } | { kind: 'sessions'; projectId: string };
export type GuestWorkspaceSubscription = { subscriptionId: string; query: GuestWorkspaceQuery };
export type GuestWorkspaceUpdate = { subscriptionId: string; snapshot: GuestWorkspaceSnapshot };

export const GUEST_STORAGE_KEY_MAX = 128;
export const GUEST_STORAGE_VALUE_BYTES = 65_536;
export const GUEST_STORAGE_TOTAL_BYTES = 2_097_152;
export const GUEST_STORAGE_KEYS_MAX = 2_000;
export type GuestStorageRequest =
  | { op: 'get' | 'delete'; key: string }
  | { op: 'set'; key: string; value: JsonValue }
  | { op: 'keys' };
export type GuestStorageResult = { storage: true } & (
  | { op: 'get'; found: false }
  | { op: 'get'; found: true; value: JsonValue }
  | { op: 'set' | 'delete' }
  | { op: 'keys'; keys: string[] }
);

export type GuestSessionWorktree = boolean | { kind: 'existing'; directory: string } | { kind: 'new'; name?: string; baseBranch?: string };

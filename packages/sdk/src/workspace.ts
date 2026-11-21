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
export type GuestSessionLink = { title: string; url: string; kind: 'issue' | 'change'; linkedAt: number };
export type GuestSessionContext = { tokens: number; limit: number | null };
export type GuestSessionTokenTotals = {
  prompt: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitPercent: number | null;
};
export type SessionSnapshot = {
  id: string;
  title: string;
  busy: boolean;
  model?: string;
  agent?: string;
  context?: GuestSessionContext | null;
  tokens?: GuestSessionTokenTotals | null;
};

export type GuestSessionRecord = {
  id: string;
  title: string;
  projectId: string;
  directory: string;
  agent?: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  worktree: GuestWorktree | null;
  activity: GuestSessionActivity;
  outcome: 'completed' | 'failed' | null;
  items: { id: string; data?: JsonValue }[];
  links?: GuestSessionLink[];
  inWork?: boolean;
  unread?: boolean;
  tool?: { name: string; target: string | null } | null;
  context?: GuestSessionContext | null;
  tokens?: GuestSessionTokenTotals | null;
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
export const GUEST_DEVICE_STORAGE_TOTAL_BYTES = 16_777_216;
export const GUEST_STORAGE_KEYS_MAX = 2_000;
export type GuestStorageScope = 'instance' | 'device';
export type GuestStorageOptions = { scope?: GuestStorageScope };
export type GuestStorageRequest =
  | ({ op: 'get' | 'delete'; key: string } & GuestStorageOptions)
  | ({ op: 'set'; key: string; value: JsonValue } & GuestStorageOptions)
  | ({ op: 'keys' } & GuestStorageOptions);
export type GuestStorageResult = { storage: true } & (
  | { op: 'get'; found: false }
  | { op: 'get'; found: true; value: JsonValue }
  | { op: 'set' | 'delete' }
  | { op: 'keys'; keys: string[] }
);

export type GuestSessionWorktree = boolean | { kind: 'existing'; directory: string } | { kind: 'new'; name?: string; baseBranch?: string };

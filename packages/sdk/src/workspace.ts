import type { JsonValue } from './contract.ts';

export type GuestLoadState = 'loading' | 'ready' | 'error';
export type GuestProject = { id: string; name: string; directory: string };
export type GuestWorktree = {
  directory: string;
  name: string;
  branch: string;
  status: 'ready' | 'pending' | 'invalid' | 'missing';
};
/** `waiting-question` means the agent is waiting on an answer — a form it put to the user. */
export type GuestSessionActivity = 'unknown' | 'idle' | 'running' | 'retrying' | 'waiting-permission' | 'waiting-question';
/**
 * A thread linked to a session, by whoever linked it: the user, the agent
 * (`session.link`), this extension or another. `change` is a code change
 * under review (a pull, merge or change request).
 */
export type GuestSessionLink = { title: string; url: string; kind: 'issue' | 'change'; linkedAt: number };
export type GuestSessionRecord = {
  id: string;
  title: string;
  projectId: string;
  directory: string;
  /** The agent the session runs as. Absent from hosts older than this field. */
  agent?: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  worktree: GuestWorktree | null;
  activity: GuestSessionActivity;
  /** Observed turn outcome, never a task status. Unknown history stays null. */
  outcome: 'completed' | 'failed' | null;
  items: { id: string; data?: JsonValue }[];
  /** Every link on the session, read-only. Absent from hosts older than this field. */
  links?: GuestSessionLink[];
  /**
   * The session sits in the sidebar's In work block. Always false while the
   * user has In work turned off. Absent from hosts older than this field.
   */
  inWork?: boolean;
  /**
   * The last turn ended and nobody has opened the session since, as the
   * sidebar marks it. Kept by OpenCode, so it survives restarts and clears on
   * every device. Absent from hosts older than this field.
   */
  unread?: boolean;
  /**
   * What the session works with while `activity` is `running`: the tool call
   * running now, or the one that ended last while the agent thinks about its
   * result. `name` as OpenCode calls it (`read`, `edit`, `bash`), and
   * `target`, the file or folder the call names, relative to `directory` (the
   * bare name for one outside it), or null when it names none. A shell
   * command's text never appears here. Null whenever the session does not
   * run. Absent from hosts older than this field.
   */
  tool?: { name: string; target: string | null } | null;
  /**
   * How full the context window was after the session's latest step:
   * `tokens` it held, and `limit`, the model's window, or null when the host
   * does not know it. Null before the host has seen a step of the session, and
   * after a compaction until the next step measures the window again. Absent
   * from hosts older than this field.
   */
  context?: { tokens: number; limit: number | null } | null;
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
/** Maximum bytes retained across all device-scoped guest storage namespaces. */
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

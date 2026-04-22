export interface WorktreeMetadata {

  /**
   * Worktree origin.
   * - sdk: created/managed by OpenCode SDK worktrees
   */
  source?: 'sdk';

  path: string;

  projectDirectory: string;

  branch: string;

  label: string;

  /** SDK worktree name (slug), if available. */
  name?: string;

  kind?: 'pr' | 'standard';

  /**
   * Branch/ref this worktree was created from (intended integration target).
   * For SDK worktrees this is typically the user-selected base branch.
   */
  createdFromBranch?: string;

  relativePath?: string;

  status?: {
    isDirty: boolean;
    ahead?: number;
    behind?: number;
    upstream?: string | null;
  };

  // --- Phase 1: canonical worktree attachment fields ---

  /** Canonical root path for the worktree (same as path for secondary worktrees). */
  worktreeRoot?: string;

  /** Operational status of this worktree. */
  worktreeStatus?: 'ready' | 'missing' | 'invalid' | 'not-a-repo';

  /** Git HEAD state classification. */
  headState?: 'branch' | 'detached' | 'unborn';

  /** How this worktree was attached to a session. */
  worktreeSource?: 'existing' | 'created-for-session';
}

export type WorktreeMap = Map<string, WorktreeMetadata>;

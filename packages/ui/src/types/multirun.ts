import type { WorktreeStartFrom } from '@/lib/worktrees/worktreeStartSource';

interface MultiRunModelSelection {
  providerID: string;
  modelID: string;
  displayName?: string;
  variant?: string;
}

export interface MultiRunFileAttachment {
  mime: string;
  filename: string;
  url: string;
}

export interface MultiRunGroup {
  prompt: string;
  models: MultiRunModelSelection[];
  /** Files that belong to this prompt variant only (for example resolved @mentions). */
  files?: MultiRunFileAttachment[];
}

export interface MultiRunAutoFusion {
  providerID: string;
  modelID: string;
  variant?: string;
  agent?: string;
}

export interface CreateMultiRunParams {
  /** Seed for the group slug, worktree and branch names. */
  name: string;
  /** Human title shown in the sidebar and overview; defaults to `name`. */
  title?: string;
  groups: MultiRunGroup[];
  agent?: string;
  /** The branch every lane starts from; absent means `worktreeStartFrom`. */
  worktreeBaseBranch?: string;
  /** The Settings start for parallel runs, used when no base branch was picked; absent means the project root. */
  worktreeStartFrom?: WorktreeStartFrom;
  /** Separate worktrees per lane; off, or a project that is not a git repository, shares `sharedDirectory`. */
  isolateRuns?: boolean;
  /** Where lanes work when they share a directory: the draft's checkout. The project directory when absent. */
  sharedDirectory?: string;
  /** Files sent with every variant. */
  files?: MultiRunFileAttachment[];
  setupCommands?: string[];
  /** Fuse the lanes automatically once all of them finish. */
  autoFusion?: MultiRunAutoFusion;
}

export interface CreateMultiRunResult {
  groupSlug: string;
  groupKey: string;
  sessionIds: string[];
  firstSessionId: string | null;
  failedCount: number;
}

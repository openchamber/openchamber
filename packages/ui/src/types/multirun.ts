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

export interface MultiRunGoal {
  /** Applies to each lane separately. */
  tokenBudget: number | null;
}

export interface CreateMultiRunParams {
  /** Seed for the group slug, worktree and branch names. */
  name: string;
  /** Human title shown in the sidebar and overview; defaults to `name`. */
  title?: string;
  groups: MultiRunGroup[];
  agent?: string;
  worktreeBaseBranch?: string;
  isolateRuns?: boolean;
  /** Files sent with every variant. */
  files?: MultiRunFileAttachment[];
  setupCommands?: string[];
  /** Fuse the lanes automatically once all of them finish. */
  autoFusion?: MultiRunAutoFusion;
  /** Every lane starts a goal of its own, with its prompt as the objective. */
  goal?: MultiRunGoal;
}

export interface CreateMultiRunResult {
  groupSlug: string;
  groupKey: string;
  sessionIds: string[];
  firstSessionId: string | null;
  failedCount: number;
}

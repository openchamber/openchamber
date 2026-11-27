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
  files?: MultiRunFileAttachment[];
}

export interface MultiRunAutoFusion {
  providerID: string;
  modelID: string;
  variant?: string;
  agent?: string;
}

export interface MultiRunGoal {
  tokenBudget: number | null;
}

export interface CreateMultiRunParams {
  name: string;
  title?: string;
  groups: MultiRunGroup[];
  agent?: string;
  worktreeBaseBranch?: string;
  isolateRuns?: boolean;
  spaceDirectory?: string;
  files?: MultiRunFileAttachment[];
  setupCommands?: string[];
  autoFusion?: MultiRunAutoFusion;
  goal?: MultiRunGoal;
}

export interface CreateMultiRunResult {
  groupSlug: string;
  groupKey: string;
  sessionIds: string[];
  firstSessionId: string | null;
  failedCount: number;
}

export interface MultiRunModelSelection {
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
  templateId?: string;
}

export interface CreateMultiRunParams {
  name: string;
  groups: MultiRunGroup[];
  agent?: string;
  worktreeBaseBranch?: string;
  isolateRuns?: boolean;
  files?: MultiRunFileAttachment[];
  setupCommands?: string[];
}

export interface CreateMultiRunResult {
  groupSlug: string;
  sessionIds: string[];
  firstSessionId: string | null;
}

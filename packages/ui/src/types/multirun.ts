import type { WorktreeStartFrom } from '@/lib/worktrees/worktreeStartSource';
import type { PromptGenerationSession } from '@/lib/multirun/identity';

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
  /** The branch every lane starts from; absent means `worktreeStartFrom`. */
  worktreeBaseBranch?: string;
  /** The Settings start for parallel runs, used when no base branch was picked; absent means the project root. */
  worktreeStartFrom?: WorktreeStartFrom;
  /** Separate worktrees require Git; false explicitly chooses shared files. */
  isolateRuns?: boolean;
  /** Where lanes work when they share a directory: the draft's checkout. The project directory when absent. */
  sharedDirectory?: string;
  files?: MultiRunFileAttachment[];
  setupCommands?: string[];
  autoFusion?: MultiRunAutoFusion;
  goal?: MultiRunGoal;
  /** Archived generation sessions whose prompts informed this run. */
  generationSessions?: readonly PromptGenerationSession[];
}

export interface CreateMultiRunResult {
  groupSlug: string;
  groupKey: string;
  sessionIds: string[];
  firstSessionId: string | null;
  failedCount: number;
}

/**
 * Multi-Run Types
 *
 * Multi-Run starts the same prompt against multiple models in parallel,
 * each in its own git worktree and OpenCode session.
 */

export interface MultiRunModelSelection {
  providerID: string;
  modelID: string;
  displayName?: string;
  variant?: string;
  backendId?: string;
}

export interface MultiRunFileAttachment {
  /** MIME type of the file */
  mime: string;
  /** Original filename */
  filename: string;
  /** Data URL (base64 encoded) */
  url: string;
}

export interface CreateMultiRunParams {
  /** Default backend to use when a selected model does not specify one. */
  backendId?: string;
  /** Group name used for worktree directory and branch naming */
  name: string;
  /** Prompt sent to all sessions */
  prompt: string;
  /** Models to run against (must have at least 2) */
  models: MultiRunModelSelection[];
  /** Optional agent to use for all runs */
  agent?: string;
  /** Base branch for new branches (defaults to `HEAD`). */
  worktreeBaseBranch?: string;
  /** Files to attach to all runs */
  files?: MultiRunFileAttachment[];
  /** Setup commands to run in each new worktree after creation */
  setupCommands?: string[];
}

export interface CreateMultiRunResult {
  /** Canonical group slug used in session titles */
  groupSlug: string;
  /** Session IDs created successfully (in selection order) */
  sessionIds: string[];
  /** First successfully created session ID, if any */
  firstSessionId: string | null;
}

/**
 * Agent Loop Types
 *
 * An agent loop sequentially processes a list of workpackages,
 * spinning up a new OpenCode session for each task.
 */

/** Status of an individual workpackage task */
export type WorkpackageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** A single workpackage task in the loop */
export interface Workpackage {
  /** Unique identifier for this task */
  id: string;
  /** Short title describing the task */
  title: string;
  /** Detailed description / prompt sent to the agent */
  description: string;
  /** Current status */
  status: WorkpackageStatus;
  /** Session ID once the agent starts working on it */
  sessionId?: string;
  /** Error message if the task failed */
  error?: string;
  /** Number of times this workpackage has been retried due to stalling */
  retryCount?: number;
  /** Timestamp when the task started executing */
  startedAt?: number;
  /** Timestamp when the task finished (completed, failed, or skipped) */
  completedAt?: number;
}

/** Persisted model configuration stored in the workpackage file */
export interface WorkpackageModelConfig {
  /** Provider ID (e.g. "anthropic", "openai") */
  providerID?: string;
  /** Model ID (e.g. "claude-opus-4-6") */
  modelID?: string;
  /** Model variant (e.g. "thinking") */
  variant?: string;
}

/** The JSON schema for a workpackage file */
export interface WorkpackageFile {
  /** Human-readable name for this agent loop */
  name: string;
  /** List of tasks to process sequentially */
  workpackages: Workpackage[];
  /** Persisted model configuration — saved when a loop is started */
  modelConfig?: WorkpackageModelConfig;
  /**
   * Absolute path to the file on disk (set at runtime, not stored in JSON).
   * Used by implementation sessions to track and update task statuses.
   */
  filePath?: string;
}

/** Status of the overall agent loop */
export type AgentLoopStatus = 'idle' | 'running' | 'paused' | 'completed' | 'stopped' | 'error';

/** Parameters for starting an agent loop */
export interface StartAgentLoopParams {
  /** Path to the workpackage file on disk */
  filePath: string;
  /** Provider ID for the model */
  providerID: string;
  /** Model ID */
  modelID: string;
  /** Optional agent to use */
  agent?: string;
  /** Optional model variant (e.g. thinking mode) */
  variant?: string;
  /** Optional system prompt prepended to each task */
  systemPrompt?: string;
  /** Optional directory context */
  directory?: string;
}

/** Represents an active agent loop instance */
export interface AgentLoopInstance {
  /** Unique ID for this agent loop run */
  id: string;
  /** Name from the workpackage file */
  name: string;
  /** Current loop status */
  status: AgentLoopStatus;
  /** The workpackages with their current statuses */
  workpackages: Workpackage[];
  /** The originating workpackage file (carries filePath for progress tracking) */
  workpackageFile?: WorkpackageFile;
  /** Model configuration */
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
  systemPrompt?: string;
  /** Parent session ID (the "root" session shown in sidebar) */
  parentSessionId?: string;
  /** Index of the currently executing workpackage */
  currentIndex: number;
  /** Timestamp when the loop was started */
  startedAt: number;
  /** Error message if the loop errored */
  error?: string;
  /** Timestamp of the last observed activity (message part or status change) for the current workpackage */
  lastActivityAt?: number;
  /** Project directory this loop runs in */
  directory?: string;
  /** All session IDs owned by this loop (root + task + subagent) for sidebar identification */
  trackedSessionIds?: string[];
}

/**
 * Validate that a parsed JSON object matches the workpackage file schema.
 */
export function validateWorkpackageFile(data: unknown): data is WorkpackageFile {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;

  if (typeof obj.name !== 'string' || obj.name.trim().length === 0) return false;
  if (!Array.isArray(obj.workpackages)) return false;
  if (obj.workpackages.length === 0) return false;

  for (const wp of obj.workpackages) {
    if (!wp || typeof wp !== 'object') return false;
    const task = wp as Record<string, unknown>;
    if (typeof task.id !== 'string' || task.id.trim().length === 0) return false;
    if (typeof task.title !== 'string' || task.title.trim().length === 0) return false;
    if (typeof task.description !== 'string' || task.description.trim().length === 0) return false;
  }

  return true;
}

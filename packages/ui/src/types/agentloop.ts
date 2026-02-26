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
}

/** The JSON schema for a workpackage file */
export interface WorkpackageFile {
  /** Human-readable name for this agent loop */
  name: string;
  /** List of tasks to process sequentially */
  workpackages: Workpackage[];
}

/** Status of the overall agent loop */
export type AgentLoopStatus = 'idle' | 'running' | 'paused' | 'completed' | 'error';

/** Parameters for starting an agent loop */
export interface StartAgentLoopParams {
  /** The workpackage file contents */
  workpackageFile: WorkpackageFile;
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

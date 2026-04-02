/**
 * resolveFallbackTaskSessionId — pure helper that resolves a pending task tool
 * to a child session from the directory session store when explicit taskSessionId
 * metadata is delayed.
 *
 * Conservative: only returns a session id when the match is unambiguous.
 */

import type { Session, SessionStatus } from '@opencode-ai/sdk/v2/client';

/**
 * Fallback is intentionally narrow: only sessions created shortly after the
 * task started are eligible. This avoids binding to earlier or later sibling
 * subagent sessions when explicit task metadata is delayed.
 */
const TASK_SESSION_MATCH_WINDOW_MS = 3000;

const LIVE_STATUSES = new Set<string>(['busy', 'retry']);

export interface ResolveFallbackParams {
  /** True when this tool is a task tool */
  isTaskTool: boolean;
  /** The parent session id (current session) */
  parentSessionId: string | undefined;
  /** When the task tool started (ms timestamp) */
  taskStartTime: number | undefined;
  /** True when the task tool is finalized (completed/error/etc.) */
  isTaskFinalized?: boolean;
  /** Sessions from the directory store */
  sessions: Session[];
  /** Session status map from the sync store */
  sessionStatusMap?: Record<string, SessionStatus>;
}

/**
 * Attempts to resolve a child session id for a pending task tool by matching
 * against sessions in the directory store.
 *
 * Returns `undefined` when:
 * - Not a task tool
 * - Task is finalized
 * - Parent session is unknown
 * - No unambiguous match found
 */
export function resolveFallbackTaskSessionId(params: ResolveFallbackParams): string | undefined {
  const {
    isTaskTool,
    parentSessionId,
    taskStartTime,
    isTaskFinalized = false,
    sessions,
    sessionStatusMap,
  } = params;

  if (!isTaskTool || isTaskFinalized || !parentSessionId || typeof taskStartTime !== 'number') {
    return undefined;
  }

  const latestAllowed = taskStartTime + TASK_SESSION_MATCH_WINDOW_MS;

  // Filter candidate sessions: parentID matches and created shortly after task start.
  const candidates = sessions.filter((session) => {
    if (!session?.id || session.parentID !== parentSessionId) {
      return false;
    }
    const created = session.time?.created;
    if (typeof created !== 'number') {
      return false;
    }
    return created >= taskStartTime && created <= latestAllowed;
  });

  if (candidates.length === 0) {
    return undefined;
  }

  // If exactly one candidate, return it regardless of status
  if (candidates.length === 1) {
    return candidates[0].id;
  }

  // Multiple candidates: try to disambiguate by finding exactly one live (busy/retry)
  const liveCandidates = candidates.filter((session) => {
    const status = sessionStatusMap?.[session.id];
    return status != null && LIVE_STATUSES.has(status.type);
  });

  if (liveCandidates.length === 1) {
    return liveCandidates[0].id;
  }

  // Ambiguous — do not guess
  return undefined;
}

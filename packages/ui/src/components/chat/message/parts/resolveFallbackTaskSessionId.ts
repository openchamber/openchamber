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
/**
 * Narrow initial window avoids binding to wrong sessions on first attempt.
 * Wide window on retry handles late-appearing child sessions under load.
 */
const TASK_SESSION_MATCH_WINDOW_MS = 3000;
const TASK_SESSION_MATCH_WINDOW_WIDE_MS = 8000;

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
  /** True when a previous resolution attempt has already failed (enables wider window) */
  hasRetried?: boolean;
}

/**
 * Attempts to resolve a child session id for a pending task tool by matching
 * against sessions in the directory store.
 *
 * Returns `undefined` when:
 * - Not a task tool
 * - Parent session is unknown
 * - Task start time is unknown
 * - No unambiguous match found
 */
export function resolveFallbackTaskSessionId(params: ResolveFallbackParams): string | undefined {
  const {
    isTaskTool,
    parentSessionId,
    taskStartTime,
    sessions,
    sessionStatusMap,
    hasRetried = false,
  } = params;

  if (!isTaskTool || !parentSessionId) {
    return undefined;
  }

  if (typeof taskStartTime !== 'number') {
    return undefined;
  }

  // Filter candidate sessions: parentID matches the current session.
  let candidates = sessions.filter((session) => {
    if (!session?.id || session.parentID !== parentSessionId) {
      return false;
    }
    return true;
  });

  // Apply the time window even while running. Without it, a newly rendered task
  // can briefly bind to the previous child session before its own child exists.
  const windowMs = hasRetried ? TASK_SESSION_MATCH_WINDOW_WIDE_MS : TASK_SESSION_MATCH_WINDOW_MS;
  const latestAllowed = taskStartTime + windowMs;
  candidates = candidates.filter((session) => {
    const created = session.time?.created;
    return typeof created === 'number' && created >= taskStartTime && created <= latestAllowed;
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

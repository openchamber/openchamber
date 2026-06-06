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
    hasRetried = false,
  } = params;

  if (!isTaskTool || !parentSessionId) {
    return undefined;
  }

  // Filter candidate sessions: parentID matches the current session.
  let candidates = sessions.filter((session) => {
    if (!session?.id || session.parentID !== parentSessionId) {
      return false;
    }
    return true;
  });

  // When the task is still running, apply no time window — late-appearing
  // child sessions should still match. Once finalized, restrict to sessions
  // created within a generous window around the task start to avoid binding
  // to stale siblings. If taskStartTime is unavailable (cross-OpenCode
  // sessions), skip the time filter entirely.
  if (typeof taskStartTime === 'number' && isTaskFinalized) {
    const windowMs = hasRetried ? TASK_SESSION_MATCH_WINDOW_WIDE_MS : TASK_SESSION_MATCH_WINDOW_MS;
    const latestAllowed = taskStartTime + windowMs;
    candidates = candidates.filter((session) => {
      const created = session.time?.created;
      return typeof created === 'number' && created >= taskStartTime - 2_000 && created <= latestAllowed;
    });
  }

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

  // All idle: pick the most recently created child session.
  // This handles the common case where a delegation completed and the
  // user is viewing the task tool result inline.
  if (liveCandidates.length === 0 && candidates.length > 1) {
    const sorted = [...candidates].sort((a, b) => {
      const aCreated = typeof a.time?.created === 'number' ? a.time.created : 0;
      const bCreated = typeof b.time?.created === 'number' ? b.time.created : 0;
      return bCreated - aCreated;
    });
    return sorted[0].id;
  }

  // Ambiguous — do not guess
  return undefined;
}

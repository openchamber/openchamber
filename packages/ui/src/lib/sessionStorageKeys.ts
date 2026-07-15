/**
 * Shared localStorage key constants for session-related persistence.
 *
 * Extracted so the sync action layer and the sidebar component tree share a
 * single source of truth — previously the key string was duplicated between
 * {@link SessionSidebar} and {@link session-actions}, risking silent cleanup
 * failure if one side changed it without the other (issue #2105 OCR review).
 */

/** Maps `projectId → sessionId` for restoring the active session per project. */
export const PROJECT_ACTIVE_SESSION_STORAGE_KEY = "oc.sessions.activeSessionByProject"

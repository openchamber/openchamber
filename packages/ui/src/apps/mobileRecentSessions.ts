import type { Session } from '@opencode-ai/sdk/v2';
import { deriveRecentSessions } from '@/components/session/sidebar/recent/activitySections';
import { orderSessionsByLifecycleScopes } from '@/sync/session-ordering';

/**
 * Mobile's Recent section mirrors the desktop sidebar's recent collection:
 * non-archived root sessions that are active now or were updated inside the
 * shared retention window, then run through the same lifecycle ordering so
 * pinning and activity rank identically on both surfaces.
 *
 * Chats are excluded by the caller (pass project sessions), matching the
 * desktop projection, which seeds Recent from project root sessions only.
 */
export const selectRecentMobileSessions = (
  sessions: readonly Session[],
  activeSessionIds: ReadonlySet<string>,
  pinnedSessionIds: Set<string>,
  rankById: ReadonlyMap<string, number>,
  now = Date.now(),
): Session[] => orderSessionsByLifecycleScopes(
  deriveRecentSessions([...sessions], activeSessionIds, now),
  pinnedSessionIds,
  rankById,
);
/**
 * "Needs you" in the notification center: the entries that still wait for
 * the user, whether read or not. Each kind is decided by the state that owns
 * it, never by the entry itself:
 *
 * - question / permission: the cross-directory blocking-request index.
 * - restart: the restart record on each listed session (global session list).
 * - fix-loop: the loop waiting for push approval (fix loop projection).
 * - restack: the run paused on a conflict.
 * - update: the server still reports that version as available.
 *
 * Until a source has answered on this runtime, the entry counts while it is
 * unread, the rule the center had before. Kinds with nothing pending (errors,
 * browser help, a failed scheduled run, the OpenCode update) count while
 * unread. Everything else never counts.
 */
import type { NotificationCenterEntry } from '@/lib/notificationCenter';
import type { PendingBlockingRequests } from '@/sync/global-blocking-requests';

/** One source's answer: null while it has not loaded (or its read failed). */
export type AttentionSources = {
  blocking: { hostSeeded: boolean; bySession: ReadonlyMap<string, PendingBlockingRequests> };
  /** Restart records still waiting on the user, by session id; null until the global session list loaded. */
  restartPendingSessionIds: ReadonlySet<string> | null;
  /** Fix loop ids waiting for push approval; null until the projection loaded. */
  fixLoopsAwaitingApproval: ReadonlySet<string> | null;
  /**
   * Restack runs this client knows, by id, and the repository directories
   * whose current run it read. A directory has at most one unfinished run, so
   * a run missing from a directory that was read is finished.
   */
  restack: { statusByRunId: ReadonlyMap<string, string>; readDirectories: ReadonlySet<string> };
  /** The version the server reports as available, `''` when none; null before a check answered. */
  availableUpdateVersion: string | null;
};

const UNREAD_ONLY_KINDS = new Set<NotificationCenterEntry['kind']>([
  'error', 'browser-help', 'scheduled-task', 'opencode-update',
]);

const waitsOnBlockingRequest = (entry: NotificationCenterEntry, blocking: AttentionSources['blocking']): boolean | null => {
  if (!entry.sessionId) return null;
  const pending = blocking.bySession.get(entry.sessionId);
  const candidates = entry.kind === 'permission'
    ? pending?.permissions ?? []
    : [...(pending?.forms ?? []), ...(pending?.pages ?? [])];
  const matches = entry.requestId
    ? candidates.some((request) => request.id === entry.requestId)
    : candidates.length > 0;
  if (matches) return true;
  // A session this client never saw a request for may still have one the host knows.
  return blocking.hostSeeded ? false : null;
};

const restartStillWaits = (entry: NotificationCenterEntry, pending: ReadonlySet<string> | null): boolean | null => {
  if (!pending) return null;
  const sessionIds = entry.action?.type === 'sessions'
    ? entry.action.sessions.map((session) => session.sessionId)
    : entry.sessionId ? [entry.sessionId] : [];
  return sessionIds.some((sessionId) => pending.has(sessionId));
};

const memberOf = (id: string | null, set: ReadonlySet<string> | null): boolean | null => {
  if (!set) return null;
  return id !== null && set.has(id);
};

/** Whether the entry belongs in "Needs you". */
export const needsAttention = (entry: NotificationCenterEntry, sources: AttentionSources): boolean => {
  const unread = entry.readAt === null;
  if (UNREAD_ONLY_KINDS.has(entry.kind)) return unread;

  let pending: boolean | null;
  switch (entry.kind) {
    case 'bot':
      return entry.resolvedAt === null;
    case 'question':
    case 'permission':
      pending = waitsOnBlockingRequest(entry, sources.blocking);
      break;
    case 'restart':
      pending = restartStillWaits(entry, sources.restartPendingSessionIds);
      break;
    case 'fix-loop':
      // A finished loop's entry names no loop to wait on: it counts while unread.
      if (!entry.requestId) return unread;
      pending = memberOf(entry.requestId, sources.fixLoopsAwaitingApproval);
      break;
    case 'restack': {
      const status = entry.requestId ? sources.restack.statusByRunId.get(entry.requestId) : undefined;
      if (status !== undefined) pending = status === 'paused';
      else pending = entry.directory && sources.restack.readDirectories.has(entry.directory) ? false : null;
      break;
    }
    case 'update':
      // "Updated to X" names no version to install and never waits.
      if (!entry.requestId) return false;
      pending = sources.availableUpdateVersion === null ? null : sources.availableUpdateVersion === entry.requestId;
      break;
    default:
      return false;
  }
  return pending ?? unread;
};

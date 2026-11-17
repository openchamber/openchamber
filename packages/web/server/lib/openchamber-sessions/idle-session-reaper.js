/**
 * Idle finished-session reaper for the live session set.
 *
 * Finished OpenCode sessions stay in the live set until something archives
 * them, and dispatch counts live sessions against its cap — so residue from
 * long-finished work can saturate dispatch while nothing is actually running
 * (#791: 33 live / 33 idle observed). This module owns the bounded cleanup:
 * on each sweep it archives, through the existing archive store, the sessions
 * that are provably finished and have been inactive past the idle threshold.
 *
 * The judgements stay conservative on purpose:
 * - Only a session whose OpenCode status is exactly `idle` is a candidate.
 *   `busy`/`retry` mean work in progress or pending, and a session with no
 *   known status is skipped — an unreadable status is not evidence a session
 *   is finished.
 * - Last activity is the session record's `time.updated` (falling back to
 *   `time.created`); a session with no usable timestamp is skipped.
 * - Archiving only, never deletion: a reaped session stays restorable through
 *   the archive store's unarchive path, and a failed archive write leaves the
 *   session live (the store applies a batch only when its persist succeeds).
 * - A session the user pinned (`metadata.openchamber.pinned`) or marked
 *   In work (`metadata.openchamber.work.state === 'open'`) is never reaped:
 *   the same persisted protections the UI's own retention applies.
 * - A btw/review fork with an original-session link, or a parent with an active
 *   btw/review fork link, is never reaped. The reaper cannot unlink its partner,
 *   so linked sessions stay on the UI-owned per-session archive path.
 * - A session an enabled scheduled task targets is never reaped: the task's
 *   next run validates its target and refuses an archived session, so
 *   reaping one would silently break the schedule. When the protected set
 *   cannot be read, the sweep reaps nothing — unknown is not unprotected.
 * - Candidates are revalidated against a fresh read before the batch is
 *   committed: a session resumed while the sweep probed other candidates
 *   (new activity, a busy status, an archive by someone else) is dropped.
 */

import { asNonEmptyString, isRecord } from '../shared/guards.js';

/** Default idle age after which a finished session is reaped: 2 hours. */
export const IDLE_SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Default interval between reaper sweeps: 15 minutes. */
export const IDLE_SESSION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

const asTimestamp = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

const statusTypeOf = (status) => asNonEmptyString(status) ?? asNonEmptyString(status?.type);

const lastActivityAt = (session) => asTimestamp(session?.time?.updated) ?? asTimestamp(session?.time?.created);

/**
 * The persisted keep protections: a pin stamped in the session metadata, work
 * the user has open and not closed, or a linked btw/review session. A fork's
 * `kind` and non-empty `originalSessionID` identify its parent; a parent's
 * non-empty `btwSessionID` or `reviewSessionID` identifies its fork. The reaper
 * cannot unlink either side, so linked sessions stay on the UI-owned path.
 */
const isKeptByUser = (session) => {
  const openchamber = session?.metadata?.openchamber;
  if (!isRecord(openchamber)) return false;
  const kind = openchamber.kind;
  if ((kind === 'btw' || kind === 'review') && asNonEmptyString(openchamber.originalSessionID) !== null) return true;
  if (asNonEmptyString(openchamber.btwSessionID) !== null || asNonEmptyString(openchamber.reviewSessionID) !== null) return true;
  if (asTimestamp(openchamber.pinned?.at) !== null) return true;
  return openchamber.work?.state === 'open';
};

/**
 * @param {object} options
 * @param {{ archive: (ids: string[]) => Promise<{ archived: Array<{ id: string }>, failedIds: string[] }> }} options.archiveStore
 *   The archive store from `./archive-store.js`; the only write path.
 * @param {(options?: { revalidate?: boolean }) => Promise<Array<object>>} options.listSessions
 *   Resolves the current live session records (`{ id, time: { updated, created }, time.archived? }`).
 *   The pre-commit revalidation calls it with `{ revalidate: true }`: a provider whose
 *   reads are stateful (a rotating window over a large history) must then re-read the
 *   same batch the candidates came from, not the next one.
 * @param {(sessions: Array<object>) => Promise<Map<string, unknown> | Record<string, unknown> | null>} [options.getSessionStatuses]
 *   Resolves the OpenCode status per session id (`{ type: 'idle' | 'busy' | 'retry', ... }`
 *   or the type string itself). When absent, a record's own `status` field is used;
 *   a session with no status from either source is never reaped. Resolving `null`
 *   means the statuses could not be read: only record-carried statuses are used.
 * @param {(session: object) => Promise<boolean | null>} [options.hasPendingWork]
 *   Extra pending-work guard for an otherwise reapable session (e.g. a working
 *   subagent descendant). Only an explicit `false` lets the reap proceed:
 *   `true` and `null` (unknown) both keep the session live.
 * @param {() => Promise<Set<string> | null>} [options.getProtectedSessionIds]
 *   Resolves the ids that must never be reaped (the targets of enabled
 *   scheduled tasks). Resolving `null` — or rejecting — means the set could
 *   not be read, and the sweep then reaps nothing at all.
 * @param {(archived: Array<{ id: string, archivedAt: number }>) => void} [options.onArchived]
 *   Called with the entries a sweep actually archived, so the caller can
 *   publish the same archive transition the interactive archive path emits.
 * @param {number} [options.maxIdleAgeMs] Idle threshold; defaults to IDLE_SESSION_MAX_AGE_MS.
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.log] Receives exactly one line per sweep.
 */
export const createIdleSessionReaper = ({
  archiveStore,
  listSessions,
  getSessionStatuses = null,
  hasPendingWork = null,
  getProtectedSessionIds = null,
  onArchived = null,
  maxIdleAgeMs = IDLE_SESSION_MAX_AGE_MS,
  now = Date.now,
  log = (line) => console.log(line),
}) => {
  if (!archiveStore?.archive) {
    throw new Error('idle session reaper needs an archive store');
  }
  if (!listSessions) {
    throw new Error('idle session reaper needs a listSessions provider');
  }
  const thresholdMs = asTimestamp(maxIdleAgeMs) ?? IDLE_SESSION_MAX_AGE_MS;

  let sweeping = false;
  let timer = null;

  const sweep = async () => {
    if (sweeping) return { skipped: 'sweep-in-progress', liveIdle: 0, reaped: [], failedIds: [] };
    sweeping = true;
    try {
      // The protected set gates the whole sweep: if it cannot be read, a
      // scheduled task's target might be in the candidate list unseen, so
      // nothing is reaped this sweep.
      let protectedIds = null;
      if (getProtectedSessionIds) {
        protectedIds = await getProtectedSessionIds().catch(() => null);
        if (!protectedIds) {
          log('[openchamber-sessions] idle-session sweep: skipped, the scheduled-task target set could not be read');
          return { skipped: 'protected-unknown', liveIdle: 0, reaped: [], failedIds: [] };
        }
      }

      const selectCandidates = async (sessions, statusMap, currentTime) => {
        const statusFor = (session) => {
          if (statusMap) {
            const fromMap = statusMap instanceof Map ? statusMap.get(session.id) : statusMap[session.id];
            if (fromMap !== undefined) return statusTypeOf(fromMap);
          }
          return statusTypeOf(session?.status);
        };
        let liveIdleCount = 0;
        const selected = [];
        for (const session of Array.isArray(sessions) ? sessions : []) {
          const id = asNonEmptyString(session?.id);
          if (!id) continue;
          if (statusFor(session) !== 'idle') continue;
          liveIdleCount += 1;
          // Already archived (by a person or an earlier sweep) is not live residue.
          if (asTimestamp(session?.time?.archived)) continue;
          const lastActivity = lastActivityAt(session);
          if (lastActivity === null) continue;
          if (currentTime - lastActivity < thresholdMs) continue;
          if (isKeptByUser(session)) continue;
          if (protectedIds?.has(id)) continue;
          // The archive store's own state is authoritative for OpenChamber
          // archives: a session it already holds is not live residue, whatever
          // the OpenCode record still says.
          if (await archiveStore.isArchived?.(id)) continue;
          if (hasPendingWork && (await hasPendingWork(session)) !== false) continue;
          selected.push(id);
        }
        return { liveIdleCount, selected };
      };

      const sessions = await listSessions();
      const statusMap = getSessionStatuses ? await getSessionStatuses(sessions) : null;
      const currentTime = now();
      const first = await selectCandidates(sessions, statusMap, currentTime);
      const liveIdle = first.liveIdleCount;
      let candidates = first.selected;

      if (candidates.length > 0) {
        // Revalidate against a fresh read before committing the batch: the
        // probes above await per candidate, and a session resumed while
        // later candidates were checked must not be archived out from
        // under its user. A candidate survives only if a fresh selection
        // still picks it; an unreadable fresh read drops the whole batch.
        const freshSessions = await listSessions({ revalidate: true }).catch(() => null);
        const freshStatusMap = freshSessions && getSessionStatuses
          ? await getSessionStatuses(freshSessions).catch(() => undefined)
          : null;
        if (!freshSessions || freshStatusMap === undefined) {
          candidates = [];
        } else {
          const fresh = await selectCandidates(freshSessions, freshStatusMap, currentTime);
          const stillEligible = new Set(fresh.selected);
          candidates = candidates.filter((id) => stillEligible.has(id));
        }
      }

      let reaped = [];
      let failedIds = [];
      if (candidates.length > 0) {
        const result = await archiveStore.archive(candidates);
        reaped = (result?.archived ?? []).map((entry) => entry.id);
        failedIds = result?.failedIds ?? [];
        if (onArchived && result?.archived?.length) {
          try {
            onArchived(result.archived);
          } catch {
            // A failed notification must not fail the sweep: the archive
            // itself already landed, and clients reconcile on next fetch.
          }
        }
      }

      log(
        `[openchamber-sessions] idle-session sweep: live-idle=${liveIdle} reaped=${reaped.length} failed=${failedIds.length} threshold-ms=${thresholdMs}`,
      );
      return { skipped: null, liveIdle, reaped, failedIds };
    } finally {
      sweeping = false;
    }
  };

  /** Starts the periodic sweep. Returns false when already running. */
  const start = (intervalMs = IDLE_SESSION_SWEEP_INTERVAL_MS) => {
    if (timer) return false;
    const interval = asTimestamp(intervalMs) ?? IDLE_SESSION_SWEEP_INTERVAL_MS;
    timer = setInterval(() => {
      sweep().catch((error) => {
        log(`[openchamber-sessions] idle-session sweep failed: ${error?.message ?? error}`);
      });
    }, interval);
    timer.unref?.();
    return true;
  };

  const stop = () => {
    if (!timer) return false;
    clearInterval(timer);
    timer = null;
    return true;
  };

  return { sweep, start, stop, maxIdleAgeMs: thresholdMs };
};

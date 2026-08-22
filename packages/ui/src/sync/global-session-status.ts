import { useCallback } from 'react';
import { create } from 'zustand';
import type { Event, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { normalizeProjectPath } from '@/lib/projectResolution';
import {
  observeSessionActivityEvent,
  reconcileSessionActivitySnapshot,
  removeSessionOrdering,
} from './session-ordering';
import {
  observeSessionActivityTiming,
  reconcileSessionActivityTiming,
  removeSessionActivityTiming,
} from './session-activity-timing';

// Shared live busy/retry index for every directory. Global events update it
// incrementally and authoritative directory snapshots reconcile it, so each
// sidebar row can subscribe to one leaf instead of every child store.
//
// Only non-idle entries are kept; absence means idle. Entries carry their
// directory so a polled per-directory snapshot can authoritatively replace
// that directory's slice (the server omits idle sessions from snapshots).

type ActiveStatusType = 'busy' | 'retry';

type GlobalSessionStatusEntry = {
  status: SessionStatus;
  directory: string;
  /**
   * Present only when this entry exists because a background child keeps the
   * parent logically working. The parent's own raw status remains untouched in
   * the per-session stores; this flag marks the synthetic busy entry so raw
   * status semantics are never corrupted and the entry is dropped as soon as
   * no child is active.
   */
  derived?: boolean;
};

type GlobalSessionStatusState = {
  statusById: Map<string, GlobalSessionStatusEntry>;
};

export const useGlobalSessionStatusStore = create<GlobalSessionStatusState>(() => ({
  statusById: new Map(),
}));

// Authoritative parent-child relations learned from session records
// (`session.updated` / `session.created` carry `info.parentID`, and the
// snapshot applier receives the session records for a directory). Child
// `session.status` is the liveness signal; these maps only answer "which
// parent should surface derived activity" and are cleared with the index on a
// runtime switch.
const parentIdByChild = new Map<string, string>();
const childrenByParent = new Map<string, Set<string>>();

// Directory that owns each relation, derived from the complete session record
// that established/refreshed it (the routed directory of the session record
// event, or the snapshot directory whose authoritative list carried it). This
// is independent of live status, so an idle child without a status entry still
// has a scoped relation that an authoritative omission can prune.
const relationDirectoryByChild = new Map<string, string>();

const EMPTY_ANCESTOR_SET = new Set<string>();

// Recency (`time.updated ?? time.created`) of the last applied complete session
// record per session. The relation index must never apply a stale complete
// session update that the directory reducer would reject, so a delayed older
// event cannot move a busy child away from its newer parent. Snapshots are
// authoritative reconciliation and replace this baseline with their record.
const relationRecencyBySession = new Map<string, number>();

// Deletion tombstones keyed by the deleted session id with the deletion-time
// recency baseline (the newest record recency related to that session: the
// deletion event's record time where available, the session's own last applied
// record, and any child-side records referencing it). A record that is not
// strictly newer than the baseline cannot reconnect the deleted id as a child
// or parent — even when the proposing child has no prior relation recency —
// while an authoritative strictly-newer record admits re-creation normally.
const relationTombstones = new Map<string, number>();

const getSessionRecencyTimestamp = (session: { time?: { updated?: number; created?: number } }): number => {
  const updatedAt = session.time?.updated;
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) return updatedAt;
  const createdAt = session.time?.created;
  return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0;
};

type SessionListSource = "empty" | "persisted" | "live" | "authoritative" | "roots-only";

/**
 * A session list is proven complete for relation omission pruning only when it
 * came from an explicit full authoritative fetch/commit. "live" means events
 * updated an otherwise-loaded list and is not a completeness proof; "roots-only"
 * is a failed-children-fetch fallback; "empty" and "persisted" are
 * pre-authoritative. Absence from a non-proven list never deletes a relation.
 */
export const isCompleteSessionListForPruning = (source: SessionListSource | undefined): boolean => source === "authoritative";

/**
 * Learn or update a parent-child relation. Returns the former parent id when
 * the relation changed (including a detach), so callers can recompute that
 * parent's derived activity before it becomes unreachable.
 *
 * `parentID` semantics match the session record:
 * - non-empty string: set/update the relation;
 * - explicit `null`: detach — clear the existing relation;
 * - omitted (`undefined`): detach — a complete session record omits `parentID`
 *   exactly for root sessions, so an authoritative record without a parent is
 *   a root (partial payloads guard on the presence of record `info`/records
 *   before reaching this function and never mutate here);
 * - empty string: no relation mutation.
 *
 * A proposed relation that would form an indirect cycle (the proposed parent
 * is already a descendant of the child) is rejected without mutating the maps:
 * a malformed cycle would otherwise let derived entries self-sustain with no
 * raw active descendant.
 */
const learnChildRelation = (childId: string, parentId: string | null | undefined): string | null => {
  if (!childId) return null;
  const existing = parentIdByChild.get(childId);
  if (parentId === null || parentId === undefined) {
    if (!existing) return null;
    childrenByParent.get(existing)?.delete(childId);
    parentIdByChild.delete(childId);
    return existing;
  }
  if (typeof parentId !== 'string' || !parentId || parentId === childId) return null;
  if (existing === parentId) return null;
  // Reject an indirect cycle: walking from the proposed parent up the existing
  // chain must not reach the child. The visited set also terminates safely if
  // malformed cycle data already exists.
  let cursor: string | undefined = parentId;
  const cycleSeen = new Set<string>();
  while (cursor) {
    if (cursor === childId) return null;
    if (cycleSeen.has(cursor)) break;
    cycleSeen.add(cursor);
    cursor = parentIdByChild.get(cursor);
  }
  if (existing) {
    childrenByParent.get(existing)?.delete(childId);
  }
  parentIdByChild.set(childId, parentId);
  let siblings = childrenByParent.get(parentId);
  if (!siblings) {
    siblings = new Set();
    childrenByParent.set(parentId, siblings);
  }
  siblings.add(childId);
  return existing ?? null;
};

const forgetChildRelation = (childId: string): void => {
  const parentId = parentIdByChild.get(childId);
  if (!parentId) return;
  parentIdByChild.delete(childId);
  relationDirectoryByChild.delete(childId);
  const siblings = childrenByParent.get(parentId);
  if (!siblings) return;
  siblings.delete(childId);
  if (siblings.size === 0) {
    childrenByParent.delete(parentId);
  }
};

/**
 * Re-derive the synthetic busy entries for parents with active children after
 * an event or snapshot changed raw state. Activity is transitive: a busy
 * grandchild keeps the child and every ancestor derived-active, so the scan
 * covers the affected sessions plus their whole ancestor chains and iterates
 * to a fixpoint (parents must observe their children's updated derived
 * entries). A parent with no active descendant and no raw busy status loses
 * its derived entry; an existing RAW busy entry always wins and is never
 * replaced by a derived one. Returns `state` unchanged when nothing moved, so
 * callers can feed this into `setState` as a zero-cost no-op.
 */
const recomputeDerivedActivity = (
  state: GlobalSessionStatusState,
  affectedSessionIds: Iterable<string>,
): GlobalSessionStatusState => {
  const affected = new Set<string>();
  for (const id of affectedSessionIds) {
    if (!id) continue;
    affected.add(id);
    // Every ancestor's derived entry depends on this session (transitively):
    // include the whole chain so a busy grandchild keeps the root active
    // without waiting for another event on a middle session. The visited set
    // terminates malformed relation cycles safely.
    let cursor = parentIdByChild.get(id);
    const seen = new Set<string>([id]);
    while (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      affected.add(cursor);
      cursor = parentIdByChild.get(cursor);
    }
  }
  if (affected.size === 0) return state;

  // Fast path: a recompute can only change the index by creating or removing a
  // derived entry. An entry is created only when an affected session has a
  // currently-active child, and removed only when an affected session currently
  // holds one — derived entries never appear without such a raw/derived
  // descendant (the fixpoint only propagates activity upward), so when neither
  // holds (the common uncomplicated status event with no tracked relations),
  // the scan below is provably a no-op. Skip the full statusById clone. The
  // ancestor-skip of malformed back-edges is deliberately not mirrored here:
  // such a child conservatively forces the full recompute, which skips it.
  let canChangeDerived = false;
  const statusById = state.statusById;
  for (const sessionId of affected) {
    if (statusById.get(sessionId)?.derived === true) {
      canChangeDerived = true;
      break;
    }
    const children = childrenByParent.get(sessionId);
    if (children) {
      for (const childId of children) {
        const child = statusById.get(childId);
        if (child && child.status.type !== 'idle') {
          canChangeDerived = true;
          break;
        }
      }
    }
    if (canChangeDerived) break;
  }
  if (!canChangeDerived) return state;

  // Precompute each affected session's ancestor set from the (stable) relation
  // maps. A child that is an ancestor of its own parent can only exist in a
  // malformed relation cycle; skipping such back-edges stops derived entries
  // from self-sustaining without a raw active descendant, as a defense in
  // depth beyond the cycle rejection in `learnChildRelation`.
  const ancestorsBySession = new Map<string, Set<string>>();
  for (const sessionId of affected) {
    const ancestors = new Set<string>();
    let cursor = parentIdByChild.get(sessionId);
    const seen = new Set<string>([sessionId]);
    while (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      ancestors.add(cursor);
      cursor = parentIdByChild.get(cursor);
    }
    ancestorsBySession.set(sessionId, ancestors);
  }

  let changed = false;
  const next = new Map(state.statusById);
  // Iterate to a fixpoint: a parent's derived entry depends on its child's
  // (possibly derived) entry, so parents must observe the latest pass results.
  // The pass bound is the affected size; propagation is monotone (a derived
  // entry only appears while some descendant is raw-active) so this converges.
  for (let pass = 0; pass < affected.size; pass++) {
    let passChanged = false;
    for (const sessionId of affected) {
      const entry = next.get(sessionId);
      const ownActive = Boolean(entry && !entry.derived && entry.status.type !== 'idle');
      const ancestors = ancestorsBySession.get(sessionId) ?? EMPTY_ANCESTOR_SET;
      const children = childrenByParent.get(sessionId);
      let childActive = false;
      let childDirectory = '';
      if (children) {
        for (const childId of children) {
          if (ancestors.has(childId)) continue;
          const child = next.get(childId);
          if (child && child.status.type !== 'idle') {
            childActive = true;
            childDirectory = child.directory;
            break;
          }
        }
      }
      if (!ownActive && childActive) {
        if (entry?.derived !== true) {
          next.set(sessionId, { status: { type: 'busy' }, directory: childDirectory, derived: true });
          passChanged = true;
        }
      } else if (entry?.derived === true) {
        next.delete(sessionId);
        passChanged = true;
      }
    }
    if (!passChanged) break;
    changed = true;
  }
  return changed ? { statusById: next } : state;
};

/** Read-only derived status for a session that only exists while a background
 * child of it is active (raw parent status stays authoritative elsewhere). */
export function useGlobalSessionDerivedStatus(sessionId: string): SessionStatus | undefined {
  return useGlobalSessionStatusStore(
    useCallback((state) => {
      const entry = state.statusById.get(sessionId);
      return entry?.derived === true ? entry.status : undefined;
    }, [sessionId]),
  );
}

/** Clears the index and the parent-child relation maps (runtime switch). */
export const resetGlobalSessionStatus = (): void => {
  parentIdByChild.clear();
  childrenByParent.clear();
  relationDirectoryByChild.clear();
  relationRecencyBySession.clear();
  relationTombstones.clear();
  useGlobalSessionStatusStore.setState({ statusById: new Map() });
};

const normalizeStatusType = (type: unknown): ActiveStatusType | 'idle' => {
  if (type === 'busy') return 'busy';
  if (type === 'retry') return 'retry';
  return 'idle';
};

const statusesEqual = (left: SessionStatus, right: SessionStatus): boolean => (
  left.type === right.type && JSON.stringify(left) === JSON.stringify(right)
);

// Both write paths normalize the directory key, so a polled snapshot can
// authoritatively replace entries written by events (and vice versa) even when
// the two sources format the same path differently (trailing slash, …).
const normalizeDirectory = (directory: string): string =>
  normalizeProjectPath(directory) ?? directory;

const setStatus = (sessionId: string, directory: string, status: SessionStatus | { type: 'idle' }): void => {
  useGlobalSessionStatusStore.setState((state) => {
    const current = state.statusById.get(sessionId);
    if (status.type === 'idle') {
      if (!current) return state;
      const next = new Map(state.statusById);
      next.delete(sessionId);
      return { statusById: next };
    }
    // An authoritative raw busy/retry always replaces a matching synthetic
    // entry (derived:true), so child settlement cannot later delete a parent
    // whose own raw status is active. A raw entry with the same status is a
    // real no-op.
    if (current && !current.derived && current.directory === directory && statusesEqual(current.status, status)) return state;
    const next = new Map(state.statusById);
    next.set(sessionId, { status, directory });
    return { statusById: next };
  });
};

// A terminal event (`session.deleted` or a complete archived `session.updated`)
// is stale when it cannot be newer than what the index already accepted: a
// versioned terminal not strictly newer than the session's deletion tombstone
// baseline, or not strictly newer than the newest accepted relation/session
// record recency (the session's own record or a child record referencing it as
// parent — equality counts as stale), must not clean up a session that a newer
// child edge just restored. A terminal without a record recency is an
// authoritative unversioned event: it is honored unless the session is already
// tombstoned (where the baseline comparison still applies).
const isStaleTerminalRecord = (sessionId: string, info?: { time?: { updated?: number; created?: number } }): boolean => {
  const terminalRecency = info ? getSessionRecencyTimestamp(info) : 0;
  const tombstoneBaseline = relationTombstones.get(sessionId);
  if (tombstoneBaseline !== undefined && terminalRecency <= tombstoneBaseline) return true;
  if (terminalRecency === 0) return false;
  let newestAccepted = relationRecencyBySession.get(sessionId) ?? 0;
  for (const childId of childrenByParent.get(sessionId) ?? []) {
    newestAccepted = Math.max(newestAccepted, relationRecencyBySession.get(childId) ?? 0);
  }
  return newestAccepted > 0 && terminalRecency <= newestAccepted;
};

// Terminal deletion pathway shared by `session.deleted` and a complete
// `session.updated` record with `info.time.archived` (matching the directory
// reducer's archive semantics): clear the raw status entry, tombstone the id
// with the newest related record recency (the deletion/archive record's time
// where available), orphan outbound child relations, and recompute the former
// ancestors so no derived activity survives and a same-recency delayed
// status/relation cannot restore it.
const handleTerminalDeletion = (
  sessionId: string,
  directory: string,
  baselineSource?: { time?: { updated?: number; created?: number } },
): void => {
  // A delayed terminal record (older than the deletion tombstone baseline or
  // the newest accepted relation/session record) must not clean up a session
  // that a newer child edge restored: only a strictly-newer terminal record
  // terminates it, preserving the restored relation and derived activity.
  if (isStaleTerminalRecord(sessionId, baselineSource)) return;
  removeSessionOrdering(sessionId);
  removeSessionActivityTiming(sessionId);
  setStatus(sessionId, normalizeDirectory(directory), { type: 'idle' });
  let tombstoneBaseline = baselineSource ? getSessionRecencyTimestamp(baselineSource) : 0;
  tombstoneBaseline = Math.max(tombstoneBaseline, relationRecencyBySession.get(sessionId) ?? 0);
  for (const childId of childrenByParent.get(sessionId) ?? []) {
    tombstoneBaseline = Math.max(tombstoneBaseline, relationRecencyBySession.get(childId) ?? 0);
  }
  // Never downgrade an existing tombstone baseline (a delayed archive/deletion
  // echo must not reopen the same-recency window).
  relationTombstones.set(sessionId, Math.max(relationTombstones.get(sessionId) ?? 0, tombstoneBaseline));
  // A deleted parent must never be re-derived from its former children:
  // orphan all outbound relations and the reverse map before recomputing, so
  // later child status events cannot recreate the ghost parent.
  const orphanedChildIds = [...(childrenByParent.get(sessionId) ?? [])];
  childrenByParent.delete(sessionId);
  for (const childId of orphanedChildIds) {
    parentIdByChild.delete(childId);
    relationDirectoryByChild.delete(childId);
  }
  const formerParentId = parentIdByChild.get(sessionId);
  forgetChildRelation(sessionId);
  // Recompute the deleted session (drops its own derived entry), its former
  // parent (drops its derived entry), and the orphaned children (their
  // ancestors changed), before the relation is unreachable.
  useGlobalSessionStatusStore.setState((state) => recomputeDerivedActivity(state, [sessionId, formerParentId ?? '', ...orphanedChildIds]));
};

// Unversioned `session.status` / `session.idle` / `session.error` updates carry
// no recency and are presumed stale while the session id is tombstoned: they
// are ignored until a strictly-newer complete record is admitted (which moves
// the session's relation recency above the deletion baseline), so a delayed
// busy status cannot resurrect a deleted/archived session's raw or derived
// state.
const isStatusBlockedByTombstone = (sessionId: string): boolean => {
  const baseline = relationTombstones.get(sessionId);
  if (baseline === undefined) return false;
  return (relationRecencyBySession.get(sessionId) ?? 0) <= baseline;
};

// Event-driven path: called by the sync dispatcher for status-bearing events
// whose directory has no child store. Mirrors the child reducer's semantics
// (`session.idle` / `session.error` both resolve to idle).
export const applyGlobalSessionStatusEvent = (directory: string, payload: Event): void => {
  switch (payload.type) {
    case 'session.updated':
    case 'session.created': {
      // Session records carry the authoritative parent-child relation. Learn
      // it here so a later child status event can derive parent activity; a
      // relation is never a liveness claim by itself. Recompute both the new
      // parent and the former parent so a reparent/detach clears immediately.
      const sessionInfo = (payload.properties as { info?: { id?: string; parentID?: string | null; time?: { updated?: number; created?: number; archived?: number | null } } } | undefined)?.info;
      if (!sessionInfo || typeof sessionInfo.id !== 'string' || !sessionInfo.id) return;
      const sessionId = sessionInfo.id;
      // A delayed/stale complete session record must not move an already newer
      // parent relation: skip it exactly like the directory reducer rejects
      // stale session.updated/created events.
      const recency = getSessionRecencyTimestamp(sessionInfo);
      const tracked = relationRecencyBySession.get(sessionId);
      if (tracked !== undefined && recency < tracked) return;
      // A complete record with `info.time.archived` is terminal like a
      // deletion (the directory reducer removes archived sessions): run the
      // shared deletion pathway with the archived record time as baseline.
      if (sessionInfo.time?.archived) {
        handleTerminalDeletion(sessionId, directory, sessionInfo);
        return;
      }
      // A delayed same-recency record must not reconnect this session (or a
      // busy child) to a deleted session id; only a record strictly newer than
      // the deletion-time tombstone baseline may re-create the relation.
      const parentId = sessionInfo.parentID;
      const childTombstone = relationTombstones.get(sessionId);
      const parentTombstone = typeof parentId === 'string' ? relationTombstones.get(parentId) : undefined;
      if (childTombstone !== undefined || parentTombstone !== undefined) {
        const tombstoneBaseline = Math.max(childTombstone ?? 0, parentTombstone ?? 0);
        if (recency <= tombstoneBaseline) return;
        // A newer child→parent EDGE record restores the edge relation but must
        // NOT clear the parent's tombstone/status block: the baseline stays so
        // the parent's own unversioned status remains blocked until the parent
        // itself has a strictly-newer complete record.
      }
      relationRecencyBySession.set(sessionId, recency);
      const formerParentId = learnChildRelation(sessionId, parentId);
      // Record which directory owns the relation from the complete session
      // record's routed directory, independent of live status; a detached or
      // rejected relation has no ownership entry.
      if (parentIdByChild.get(sessionId)) {
        relationDirectoryByChild.set(sessionId, normalizeDirectory(directory));
      } else {
        relationDirectoryByChild.delete(sessionId);
      }
      useGlobalSessionStatusStore.setState((state) => recomputeDerivedActivity(state, [sessionId, sessionInfo.parentID ?? '', formerParentId ?? '']));
      return;
    }
    case 'session.status': {
      const props = payload.properties as { sessionID?: string; status?: { type?: string } } | undefined;
      const sessionId = typeof props?.sessionID === 'string' ? props.sessionID : '';
      if (!props || !sessionId) return;
      if (isStatusBlockedByTombstone(sessionId)) return;
      const type = normalizeStatusType(props.status?.type);
      setStatus(
        sessionId,
        normalizeDirectory(directory),
        type === 'idle' ? { type: 'idle' } : { ...(props.status ?? {}), type } as SessionStatus,
      );
      observeSessionActivityEvent(sessionId, type === 'idle' ? 'settled' : 'active');
      // `retry` is still a running turn, so the elapsed counter keeps going.
      observeSessionActivityTiming(sessionId, type === 'idle' ? 'settled' : 'active');
      useGlobalSessionStatusStore.setState((state) => recomputeDerivedActivity(state, [sessionId, parentIdByChild.get(sessionId) ?? '']));
      return;
    }
    case 'session.idle':
    case 'session.error': {
      const props = payload.properties as { sessionID?: string } | undefined;
      const sessionId = typeof props?.sessionID === 'string' ? props.sessionID : '';
      if (sessionId && !isStatusBlockedByTombstone(sessionId)) {
        setStatus(sessionId, normalizeDirectory(directory), { type: 'idle' });
        observeSessionActivityEvent(sessionId, 'settled');
        observeSessionActivityTiming(sessionId, 'settled');
        useGlobalSessionStatusStore.setState((state) => recomputeDerivedActivity(state, [sessionId, parentIdByChild.get(sessionId) ?? '']));
      }
      return;
    }
    case 'session.deleted': {
      const props = payload.properties as { sessionID?: string; info?: { id?: string; time?: { updated?: number; created?: number } } } | undefined;
      const sessionId = props?.sessionID ?? props?.info?.id;
      if (sessionId) {
        handleTerminalDeletion(sessionId, directory, props?.info);
      }
      return;
    }
    default:
      return;
  }
};

// Polled path: an authoritative `/session/status?directory=X` snapshot. Entries
// missing from the snapshot are idle now — cleared both by directory key and by
// the caller's session-id list (the server may report a canonicalized directory
// that differs from the key an event wrote, e.g. via symlinks). Seeds the
// initial state (events only deliver changes) and reconciles missed events.
// `knownSessions` are the directory's session records; they teach parent-child
// relations for children whose `session.updated` was missed (cold start), so a
// busy child in the snapshot can still derive its idle parent's activity.
// Relation OMISSION pruning (removing relations for tracked children absent
// from `knownSessions`) runs only when `knownSessionsComplete` proves the list
// is authoritative and complete for this directory: absence from a partial or
// unavailable list never deletes a relation, while a full list omission does.
// The snapshot also resets each session's relation-freshness baseline to the
// record recency (mirroring how the directory store replaces its session list).
export const applyGlobalSessionStatusSnapshot = (
  rawDirectory: string,
  raw: Record<string, { type?: string }>,
  knownSessionIds?: Iterable<string>,
  knownSessions?: Iterable<{ id: string; parentID?: string | null; time?: { updated?: number; created?: number } }>,
  knownSessionsComplete = false,
): void => {
  const directory = normalizeDirectory(rawDirectory);
  const known = new Set(knownSessionIds ?? []);
  const formerParentIds = new Set<string>();
  if (knownSessions) {
    // Authoritative complete list: a tracked child omitted from the list is
    // gone for this scope. Prune its relation before recomputation so a
    // delayed busy status cannot recreate the old parent. Only when the caller
    // proves the list is complete — a partial/unavailable list never deletes
    // relations. Every relation owned by this snapshot directory is pruned
    // whether the child is currently busy or idle (ownership is tracked from
    // the complete session records), so another directory's snapshot never
    // prunes cross-directory relations.
    if (knownSessionsComplete) {
      const knownIds = new Set<string>();
      for (const session of knownSessions) {
        if (session && typeof session.id === 'string' && session.id) knownIds.add(session.id);
      }
      for (const [childId, parentId] of [...parentIdByChild.entries()]) {
        if (knownIds.has(childId)) continue;
        if (relationDirectoryByChild.get(childId) !== directory) continue;
        childrenByParent.get(parentId)?.delete(childId);
        parentIdByChild.delete(childId);
        relationDirectoryByChild.delete(childId);
        if (parentId) formerParentIds.add(parentId);
      }
    }
    // Freeze the deletion tombstones at snapshot start: every record in this
    // snapshot validates against the same start baselines, so a strictly-newer
    // root record that recreates a parent cannot authorize an older
    // child->parent relation elsewhere in the same snapshot (order-independent).
    const snapshotTombstones = new Map(relationTombstones);
    for (const session of knownSessions) {
      if (session && typeof session.id === 'string' && session.id) {
        // Align with the event path: a record referencing a tombstoned child
        // or parent is rejected unless strictly newer than the deletion-time
        // baseline, so an unrelated snapshot cannot bypass lifecycle ordering.
        // A strictly-newer record clears the LIVE tombstone and recreates;
        // the frozen start baseline still gates this snapshot's other records.
        const sessionRecency = getSessionRecencyTimestamp(session);
        const sessionChildTombstone = snapshotTombstones.get(session.id);
        const sessionParentTombstone = typeof session.parentID === 'string' ? snapshotTombstones.get(session.parentID) : undefined;
        if (sessionChildTombstone !== undefined || sessionParentTombstone !== undefined) {
          const tombstoneBaseline = Math.max(sessionChildTombstone ?? 0, sessionParentTombstone ?? 0);
          if (sessionRecency <= tombstoneBaseline) continue;
          // A newer child→parent EDGE record restores the edge relation but
          // must NOT clear the parent's tombstone/status block: the tombstone
          // baseline is comparison-based, so strictly-newer records pass while
          // the parent's own unversioned status stays blocked until the parent
          // itself has a newer complete record.
        }
        const formerParentId = learnChildRelation(session.id, session.parentID);
        if (formerParentId) formerParentIds.add(formerParentId);
        relationRecencyBySession.set(session.id, sessionRecency);
        // The snapshot is the authoritative source for this directory's
        // relations: (re)assign ownership to it.
        if (parentIdByChild.get(session.id)) {
          relationDirectoryByChild.set(session.id, directory);
        } else {
          relationDirectoryByChild.delete(session.id);
        }
      }
    }
  }
  // Built once as a set and shared by both consumers below; only non-idle
  // sessions land here, so it stays small however long the directory's list is.
  // A status snapshot cannot re-enable a tombstoned id absent a strictly-newer
  // complete record for that same id, so blocked ids are excluded from the
  // active set (ordering/timing) and from the raw status upsert below.
  const activeSessionIds = new Set<string>();
  for (const [sessionId, status] of Object.entries(raw)) {
    if (normalizeStatusType(status?.type) !== 'idle' && !isStatusBlockedByTombstone(sessionId)) activeSessionIds.add(sessionId);
  }
  reconcileSessionActivitySnapshot(activeSessionIds, known);
  // Timing asks the coverage question instead of being handed a list: a snapshot
  // authoritatively covers the caller's session list plus every id it reports
  // itself, and only the handful of sessions actually being timed need an
  // answer. Reuses the sets already built above, so this allocates nothing.
  reconcileSessionActivityTiming(
    activeSessionIds,
    (sessionId) => known.has(sessionId) || sessionId in raw,
  );
  const affectedSessionIds = new Set<string>([...known, ...Object.keys(raw), ...formerParentIds]);
  for (const [sessionId, entry] of useGlobalSessionStatusStore.getState().statusById) {
    if (entry.directory === directory) affectedSessionIds.add(sessionId);
  }
  useGlobalSessionStatusStore.setState((state) => {
    let changed = false;
    const next = new Map(state.statusById);

    for (const [sessionId, entry] of state.statusById) {
      if ((entry.directory === directory || known.has(sessionId)) && !(sessionId in raw)) {
        next.delete(sessionId);
        changed = true;
      }
    }

    for (const [sessionId, status] of Object.entries(raw)) {
      const type = normalizeStatusType(status?.type);
      const current = next.get(sessionId);
      if (type === 'idle') {
        if (current && (current.directory === directory || known.has(sessionId))) {
          next.delete(sessionId);
          changed = true;
        }
        continue;
      }
      // A status snapshot cannot re-enable a tombstoned id absent a
      // strictly-newer complete record for that same id.
      if (isStatusBlockedByTombstone(sessionId)) continue;
      const normalizedStatus = { ...status, type } as SessionStatus;
      // A snapshot is authoritative raw state: it always replaces a synthetic
      // entry (even with a matching type), so a raw-active parent written by
      // the snapshot survives later child settlement.
      if (!current || current.directory !== directory || current.derived === true || !statusesEqual(current.status, normalizedStatus)) {
        next.set(sessionId, { status: normalizedStatus, directory });
        changed = true;
      }
    }

    const rawState = changed ? { statusById: next } : state;
    // Re-derive parents after clearing: a parent omitted by the snapshot (idle)
    // is re-added as derived busy exactly when one of its children is active in
    // this snapshot, so an authoritative resync never overwrites child-derived
    // parent activity with a false idle.
    return recomputeDerivedActivity(rawState, affectedSessionIds);
  });
};

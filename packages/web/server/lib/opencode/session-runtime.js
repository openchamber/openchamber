const SESSION_COOLDOWN_DURATION_MS = 2000;
const SESSION_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_ATTENTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_ACTIVITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_STATE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
// Deliberate retention window for stale-event ordering metadata: deletion/
// archive tombstones and relation-recency baselines are both kept while stale
// events for their session id could still be in flight, then the hourly
// cleanup forgets the id entirely once it is unreferenced and this window has
// passed (the same 24h horizon used for every other runtime-owned map).
const SESSION_TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;

const extractSessionStatusUpdate = (payload) => {
  if (!payload) {
    return null;
  }

  // `session.idle` / `session.error` are terminal events that settle the
  // session to idle; normalize them before lifecycle settlement so a busy
  // child settled by these events cools its parent and drops the operational
  // count (mirrors the shared UI reducer semantics).
  if (payload.type === 'session.idle' || payload.type === 'session.error') {
    const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
    const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID.trim() : '';
    if (!sessionId) {
      return null;
    }
    return {
      sessionId,
      type: 'idle',
      eventId: typeof payload.id === 'string' ? payload.id : '',
      attempt: undefined,
      message: undefined,
      next: undefined,
    };
  }

  if (payload.type !== 'session.status') {
    return null;
  }

  const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const status = properties.status && typeof properties.status === 'object' ? properties.status : {};
  const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
  const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID.trim() : '';
  // Canonical OpenCode schema uses properties.status.type. Keep legacy info.type fallback for compatibility.
  const type = typeof status.type === 'string'
    ? status.type.trim()
    : (typeof info.type === 'string' ? info.type.trim() : '');

  if (!sessionId || !type) {
    return null;
  }

  return {
    sessionId,
    type,
    eventId: typeof payload.id === 'string' ? payload.id : '',
    attempt: typeof status.attempt === 'number'
      ? status.attempt
      : (typeof info.attempt === 'number' ? info.attempt : undefined),
    message: typeof status.message === 'string'
      ? status.message
      : (typeof info.message === 'string' ? info.message : undefined),
    next: typeof status.next === 'number'
      ? status.next
      : (typeof info.next === 'number' ? info.next : undefined),
  };
};

// Task tool creates a child session whose record carries `parentID`. The child
// session's own `session.status` is the authoritative liveness signal; the
// parent relation only decides which parent surfaces derived activity when the
// parent itself is idle. A complete session record (`properties.info` with a
// session id) omits `parentID` exactly for root sessions, so an omitted parent
// detaches any existing relation; an explicit `parentID: null` detaches the
// same way. Partial payloads without record `info` never mutate relations, and
// an empty-string parentID is not a relation mutation.
const extractChildRelation = (payload) => {
  if (!payload || (payload.type !== 'session.updated' && payload.type !== 'session.created')) {
    return null;
  }
  const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
  const childId = typeof info.id === 'string' ? info.id.trim() : '';
  if (!childId) return null;
  const recency = getRecordRecency(info);
  if (info.parentID === null || info.parentID === undefined) {
    return { childId, parentId: null, recency };
  }
  const parentId = typeof info.parentID === 'string' ? info.parentID.trim() : '';
  if (!parentId || parentId === childId) {
    return null;
  }
  return { childId, parentId, recency };
};

// A complete `session.updated` / `session.created` record with
// `info.time.archived` is terminal like a deletion (the shared directory
// reducer removes archived sessions): reuse the deletion pathway with the
// archived record as the tombstone baseline source.
const extractArchivedSession = (payload) => {
  if (!payload || (payload.type !== 'session.updated' && payload.type !== 'session.created')) {
    return null;
  }
  const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
  const sessionId = typeof info.id === 'string' ? info.id.trim() : '';
  if (!sessionId) return null;
  const archived = info.time && typeof info.time === 'object' ? info.time.archived : undefined;
  if (!archived) return null;
  return { sessionId, info };
};

// Recency uses the local record semantics `time.updated ?? time.created` (the
// same rule the UI relation index applies), so a delayed older complete
// session record can be rejected before it overwrites a newer relation.
const getRecordRecency = (info) => {
  const updatedAt = info && typeof info.time?.updated === 'number' ? info.time.updated : undefined;
  if (updatedAt !== undefined && Number.isFinite(updatedAt)) return updatedAt;
  const createdAt = info && typeof info.time?.created === 'number' ? info.time.created : undefined;
  return createdAt !== undefined && Number.isFinite(createdAt) ? createdAt : 0;
};

// `session.deleted` is terminal for a session and its parent-child relation:
// a busy child can be deleted before ever emitting an idle event, so any
// aggregation it participated in must clear immediately. The deleted session
// record (`properties.info`) or `properties.sessionID` identifies the session.
const extractDeletedSessionId = (payload) => {
  if (!payload || payload.type !== 'session.deleted') {
    return null;
  }
  const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
  const sessionId = typeof info.id === 'string'
    ? info.id.trim()
    : (typeof properties.sessionID === 'string' ? properties.sessionID.trim() : '');
  return sessionId || null;
};

export const createSessionRuntime = ({ writeSseEvent, getNotificationClients, broadcastEvent }) => {
  const sessionActivityPhases = new Map();
  const sessionActivityCooldowns = new Map();
  const sessionStates = new Map();
  const sessionAttentionStates = new Map();
  let activeSessionCount = 0;

  // Background subagent liveness aggregation: child session records expose the
  // parent (extractChildRelation); a child `session.status` busy/retry keeps
  // the parent logically active even while the parent itself is idle. The raw
  // per-session state in `sessionStates` stays untouched.
  const childParents = new Map();
  const activeChildrenByParent = new Map();
  // Recency of the last applied complete session record per child session, so
  // a delayed older record cannot overwrite a newer reparent/detach relation
  // or re-adopt a busy child to a stale ancestor (mirrors the UI relation
  // index). Each entry stores the accepted record recency plus the wall-clock
  // time it was established, and the hourly cleanup retains an unreferenced
  // entry for the same deliberate retention window as tombstones
  // (SESSION_TOMBSTONE_RETENTION_MS): a root/detach ordering baseline must
  // survive cleanup even when the session has no active raw state, or a
  // delayed older child relation event could be admitted as fresh and
  // reparent the session before the window expires. Cleared with the relation
  // maps on deletion/reset/dispose.
  const relationRecencyBySession = new Map();
  // Deletion tombstones keyed by the deleted session id with the deletion-time
  // recency baseline (the newest record recency related to that session: the
  // deletion event's record time where available, the session's own last
  // applied record, and any child-side records referencing it) plus the
  // wall-clock creation time. A record that is not strictly newer than the
  // baseline cannot reconnect the deleted id as a child or parent — even when
  // the proposing child has no prior relation recency — while an
  // authoritative strictly-newer record admits re-creation. The hourly cleanup
  // reclaims a tombstone only once its id is no longer referenced anywhere and
  // the deliberate retention window (SESSION_TOMBSTONE_RETENTION_MS) has
  // passed, so stale session ids cannot grow permanently while stale-event
  // rejection stays correct inside the window. Cleared on reset/dispose.
  const relationTombstones = new Map();

  const learnChildRelation = (childId, parentId) => {
    const formerParentId = childParents.get(childId);
    if (parentId === null) {
      // A detach (`parentId: null` from an explicit `parentID: null` or an
      // omitted parent on a complete record) settles the former parent's
      // aggregation and drops the relation. The child's own raw status stays
      // untouched.
      if (formerParentId) {
        markChildSettled(childId, formerParentId, true);
        childParents.delete(childId);
      }
      return;
    }
    if (formerParentId === parentId) return;
    // Reject an indirect cycle before mutating the maps: walking from the
    // proposed parent up the existing chain must not reach the child. The
    // visited set terminates safely even if malformed cycle data already
    // exists, so synthetic activity can never self-sustain after the only raw
    // active session settles.
    let cursor = parentId;
    const cycleSeen = new Set();
    while (cursor) {
      if (cursor === childId) return;
      if (cycleSeen.has(cursor)) break;
      cycleSeen.add(cursor);
      cursor = childParents.get(cursor);
    }
    if (formerParentId) {
      // Reassignment: the child leaves the former parent's aggregation before
      // joining the new one (even while its own descendants stay active), so
      // the former parent cannot stay derived-active with a child that no
      // longer belongs to it.
      markChildSettled(childId, formerParentId, true);
    }
    childParents.set(childId, parentId);
  };

  const forgetChildRelation = (childId) => {
    const parentId = childParents.get(childId);
    childParents.delete(childId);
    if (!parentId) return;
    const children = activeChildrenByParent.get(parentId);
    if (!children) return;
    children.delete(childId);
    if (children.size === 0) {
      activeChildrenByParent.delete(parentId);
    }
  };

  const hasActiveChildren = (parentId) => {
    const children = activeChildrenByParent.get(parentId);
    return Boolean(children && children.size > 0);
  };

  // Propagate presentation activity up every ancestor edge: the activated
  // session's parent, grandparent, ... become synthetic-busy and are added to
  // THEIR parent's active set (a raw-busy ancestor stays operational-busy but
  // is still active for its own parent). The visited set terminates malformed
  // relation cycles safely. Synthetic busy never touches the operational count.
  const propagateActiveAncestors = (childId) => {
    const seen = new Set([childId]);
    let cursor = childParents.get(childId);
    while (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const parentOfCursor = childParents.get(cursor);
      if (parentOfCursor) {
        let siblings = activeChildrenByParent.get(parentOfCursor);
        if (!siblings) {
          siblings = new Set();
          activeChildrenByParent.set(parentOfCursor, siblings);
        }
        if (!siblings.has(cursor)) siblings.add(cursor);
      }
      const currentPhase = sessionActivityPhases.get(cursor);
      if (!(currentPhase?.phase === 'busy' && !currentPhase.synthetic)) {
        setSessionActivityPhase(cursor, 'busy', true);
      }
      cursor = parentOfCursor;
    }
  };

  const markChildActive = (childId, parentId) => {
    learnChildRelation(childId, parentId);
    // Aggregation may only use the accepted stored relation: a rejected
    // cycle-forming proposal must never populate the active-edge set or
    // synthesize parent activity, even if the candidate parent is already
    // presentation-busy from an accepted edge elsewhere.
    if (childParents.get(childId) !== parentId) return;
    let children = activeChildrenByParent.get(parentId);
    if (!children) {
      children = new Set();
      activeChildrenByParent.set(parentId, children);
    }
    children.add(childId);
    propagateActiveAncestors(childId);
  };

  // Recompute `sessionId` and every ancestor after one of them lost its last
  // active child. An ancestor stays busy while its own raw status is busy or
  // it still has an active child; otherwise it settles (cooldown) and is
  // removed from ITS parent's aggregation before the walk continues up.
  const settleActiveAncestor = (sessionId) => {
    let cursor = sessionId;
    const seen = new Set();
    while (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const parentStatus = sessionStates.get(cursor)?.status;
      if (parentStatus === 'busy' || parentStatus === 'retry' || hasActiveChildren(cursor)) {
        return;
      }
      setSessionActivityPhase(cursor, 'cooldown');
      const grandParentId = childParents.get(cursor);
      if (!grandParentId) return;
      const grandChildren = activeChildrenByParent.get(grandParentId);
      if (!grandChildren || !grandChildren.has(cursor)) return;
      grandChildren.delete(cursor);
      if (grandChildren.size > 0) return;
      activeChildrenByParent.delete(grandParentId);
      cursor = grandParentId;
    }
  };

  // A child leaves its parent's aggregation on a real relation change
  // (reparent/detach/delete/stale prune, `force` true) or when its own raw
  // status settles and it has no active descendants. A raw-idle child that
  // still runs an active grandchild stays active under the same parent.
  const markChildSettled = (childId, parentId, force = false) => {
    if (!force && hasActiveChildren(childId)) return;
    const children = activeChildrenByParent.get(parentId);
    if (!children || !children.has(childId)) return;
    children.delete(childId);
    if (children.size > 0) return;
    activeChildrenByParent.delete(parentId);
    settleActiveAncestor(parentId);
  };

  // A terminal event (`session.deleted` or a complete archived
  // `session.updated`) is stale when it cannot be newer than what the runtime
  // already accepted: a versioned terminal not strictly newer than the
  // session's deletion tombstone baseline, or not strictly newer than the
  // newest accepted relation/session record recency (the session's own record
  // or a child record referencing it as parent — an equal-recency terminal is
  // stale too), must not clean up a session that a newer child edge just
  // restored. A terminal without a record recency is an authoritative
  // unversioned event: it is honored unless the session is already tombstoned
  // (where the baseline comparison still applies).
  const isStaleTerminalRecord = (sessionId, info) => {
    const terminalRecency = getRecordRecency(info);
    const tombstoneBaseline = relationTombstones.get(sessionId)?.baseline;
    if (tombstoneBaseline !== undefined && terminalRecency <= tombstoneBaseline) return true;
    if (terminalRecency === 0) return false;
    let newestAccepted = relationRecencyBySession.get(sessionId)?.recency ?? 0;
    for (const [childId, parentId] of childParents.entries()) {
      if (parentId === sessionId) {
        newestAccepted = Math.max(newestAccepted, relationRecencyBySession.get(childId)?.recency ?? 0);
      }
    }
    return newestAccepted > 0 && terminalRecency <= newestAccepted;
  };

  const handleSessionDeleted = (sessionId, deletionInfo) => {
    // A delayed terminal event (older than the deletion tombstone baseline or
    // the newest accepted relation/session record) must not clean up a session
    // that a newer child edge restored: only a strictly-newer terminal record
    // terminates it, preserving the restored relation and derived activity.
    if (isStaleTerminalRecord(sessionId, deletionInfo)) return;
    // Tombstone the deleted id with a deletion-time recency baseline (the
    // deletion event's record time where available, else the newest record
    // recency related to the session): only a strictly-newer authoritative
    // record may reconnect it as a parent or child later.
    let tombstoneBaseline = deletionInfo ? getRecordRecency(deletionInfo) : 0;
    tombstoneBaseline = Math.max(tombstoneBaseline, relationRecencyBySession.get(sessionId)?.recency ?? 0);
    for (const [childId, parentId] of childParents.entries()) {
      if (parentId === sessionId) {
        tombstoneBaseline = Math.max(tombstoneBaseline, relationRecencyBySession.get(childId)?.recency ?? 0);
      }
    }
    relationTombstones.set(sessionId, {
      // A fresh strictly-newer terminal restarts the deliberate retention
      // window so an id that was re-created and then deleted again stays
      // protected for the full window.
      baseline: Math.max(relationTombstones.get(sessionId)?.baseline ?? 0, tombstoneBaseline),
      createdAt: Date.now(),
    });
    // As a parent: orphan outbound children FIRST so the deleted session can
    // no longer be treated as active (its own descendants must not keep it or
    // its former parent derived-active). Their own liveness continues, but
    // there is no parent to derive to.
    activeChildrenByParent.delete(sessionId);
    for (const [childId, parentId] of [...childParents.entries()]) {
      if (parentId === sessionId) {
        childParents.delete(childId);
      }
    }
    // As a child: clear the former parent's aggregation and the relation. The
    // child may never emit the idle event that would normally settle it, so
    // deletion is the terminal transition.
    const formerParentId = childParents.get(sessionId);
    if (formerParentId) {
      markChildSettled(sessionId, formerParentId, true);
      forgetChildRelation(sessionId);
    }
    // Terminal cleanup: remove raw state, attention state, activity phase, and
    // any pending cooldown timer, and drop the operational count contribution
    // of a raw-busy deleted session. Every snapshot must omit the deleted id,
    // and a pending cooldown must never recreate a phase entry for it.
    const currentPhase = sessionActivityPhases.get(sessionId);
    const cooldownTimer = sessionActivityCooldowns.get(sessionId);
    if (cooldownTimer) {
      clearTimeout(cooldownTimer);
    }
    sessionActivityCooldowns.delete(sessionId);
    sessionActivityPhases.delete(sessionId);
    if (currentPhase?.phase === 'busy' && !currentPhase.synthetic) {
      activeSessionCount = Math.max(0, activeSessionCount - 1);
    }
    sessionStates.delete(sessionId);
    sessionAttentionStates.delete(sessionId);
    relationRecencyBySession.delete(sessionId);
  };

  const getOrCreateAttentionState = (sessionId) => {
    if (!sessionId || typeof sessionId !== 'string') return null;

    let state = sessionAttentionStates.get(sessionId);
    if (!state) {
      state = {
        needsAttention: false,
        lastUserMessageAt: null,
        lastStatusChangeAt: Date.now(),
        viewedByClients: new Set(),
        status: 'idle',
      };
      sessionAttentionStates.set(sessionId, state);
    }
    return state;
  };

  // `synthetic` marks a busy phase derived solely from an active background
  // child: it keeps the parent visibly active in snapshots/SSE but never
  // increments the operational active count that drives upstream stall-timeout
  // selection. A raw busy phase (`synthetic` false) counts exactly once.
  const setSessionActivityPhase = (sessionId, phase, synthetic = false) => {
    if (!sessionId || typeof sessionId !== 'string') return false;

    const current = sessionActivityPhases.get(sessionId);
    if (current?.phase === phase && Boolean(current?.synthetic) === Boolean(synthetic)) return false;
    if (phase === 'cooldown' && current?.phase !== 'busy') {
      return false;
    }

    const existingTimer = sessionActivityCooldowns.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      sessionActivityCooldowns.delete(sessionId);
    }

    const wasActive = current?.phase === 'busy' && !current?.synthetic;
    const isActive = phase === 'busy' && !synthetic;
    if (wasActive !== isActive) {
      activeSessionCount = Math.max(0, activeSessionCount + (isActive ? 1 : -1));
    }
    sessionActivityPhases.set(sessionId, {
      phase,
      updatedAt: Date.now(),
      ...(synthetic ? { synthetic: true } : {}),
    });

    if (phase === 'cooldown') {
      const timer = setTimeout(() => {
        const now = sessionActivityPhases.get(sessionId);
        if (now?.phase === 'cooldown') {
          setSessionActivityPhase(sessionId, 'idle');
          return;
        }
        sessionActivityCooldowns.delete(sessionId);
      }, SESSION_COOLDOWN_DURATION_MS);
      sessionActivityCooldowns.set(sessionId, timer);
    }

    if (typeof broadcastEvent === 'function') {
      broadcastEvent({
        type: 'openchamber:session-activity',
        properties: {
          sessionId,
          phase,
        },
      });
    }

    return true;
  };

  const updateSessionAttentionStatus = (sessionId, status) => {
    const state = getOrCreateAttentionState(sessionId);
    if (!state) return;

    const prevStatus = state.status;
    state.status = status;
    state.lastStatusChangeAt = Date.now();

    if ((prevStatus === 'busy' || prevStatus === 'retry') && status === 'idle') {
      if (state.lastUserMessageAt && state.viewedByClients.size === 0) {
        state.needsAttention = true;
      }
    }
  };

  const updateSessionState = (sessionId, status, eventId, metadata = {}) => {
    if (!sessionId || typeof sessionId !== 'string') return;

    const now = Date.now();
    const existing = sessionStates.get(sessionId);
    const existingAttentionState = sessionAttentionStates.get(sessionId);
    const isRestartInterruption = metadata.reason === 'opencode-restart';
    if (existing && existing.lastUpdateAt > now - 5000 && status === existing.status && !isRestartInterruption) {
      return;
    }

    sessionStates.set(sessionId, {
      status,
      lastUpdateAt: now,
      lastEventId: eventId || `server-${now}`,
      metadata: { ...existing?.metadata, ...metadata },
    });

    updateSessionAttentionStatus(sessionId, status);
    const attentionState = sessionAttentionStates.get(sessionId);
    const attentionChanged = !!attentionState && existingAttentionState?.needsAttention !== attentionState.needsAttention;
    const clients = getNotificationClients();
    if (!existing || existing.status !== status || attentionChanged || isRestartInterruption) {
      const state = sessionStates.get(sessionId);
      const syntheticPayload = {
        type: 'openchamber:session-status',
        properties: {
          sessionID: sessionId,
          status: state.status,
          timestamp: state.lastUpdateAt,
          metadata: state.metadata,
          needsAttention: attentionState?.needsAttention ?? false,
        },
      };

      if (typeof broadcastEvent === 'function') {
        broadcastEvent(syntheticPayload);
      } else if (clients.size > 0) {
        for (const res of clients) {
          try {
            writeSseEvent(res, syntheticPayload);
          } catch {
          }
        }
      }
    }

    const phase = status === 'busy' || status === 'retry' ? 'busy' : 'idle';
    if (phase !== 'idle' || sessionActivityPhases.get(sessionId)?.phase !== 'cooldown') {
      // Parent idle does not complete a background child: keep the parent
      // presentation-busy while any child is still active, even though the raw
      // status is idle. Synthetic busy never counts operationally.
      if (phase === 'idle' && hasActiveChildren(sessionId)) {
        setSessionActivityPhase(sessionId, 'busy', true);
      } else {
        setSessionActivityPhase(sessionId, phase);
      }
    }
  };

  const getSessionStateSnapshot = () => {
    const result = {};
    const now = Date.now();
    for (const [sessionId, data] of sessionStates) {
      if (now - data.lastUpdateAt > SESSION_STATE_MAX_AGE_MS) continue;
      result[sessionId] = {
        status: data.status,
        lastUpdateAt: data.lastUpdateAt,
        metadata: data.metadata,
      };
    }
    return result;
  };

  const getSessionState = (sessionId) => {
    if (!sessionId) return null;
    return sessionStates.get(sessionId) || null;
  };

  const markSessionViewed = (sessionId, clientId) => {
    const state = getOrCreateAttentionState(sessionId);
    if (!state) return;

    const wasNeedsAttention = state.needsAttention;
    state.viewedByClients.add(clientId);

    if (wasNeedsAttention) {
      state.needsAttention = false;

      const syntheticPayload = {
        type: 'openchamber:session-status',
        properties: {
          sessionID: sessionId,
          status: state.status,
          timestamp: Date.now(),
          metadata: {},
          needsAttention: false,
        },
      };

      if (typeof broadcastEvent === 'function') {
        broadcastEvent(syntheticPayload);
      } else {
        const clients = getNotificationClients();
        for (const res of clients) {
          try {
            writeSseEvent(res, syntheticPayload);
          } catch {
          }
        }
      }
    }
  };

  const markSessionUnviewed = (sessionId, clientId) => {
    const state = sessionAttentionStates.get(sessionId);
    if (!state) return;
    state.viewedByClients.delete(clientId);
  };

  const markUserMessageSent = (sessionId) => {
    const state = getOrCreateAttentionState(sessionId);
    if (!state) return;
    state.lastUserMessageAt = Date.now();
  };

  const getSessionAttentionSnapshot = () => {
    const result = {};
    const now = Date.now();
    for (const [sessionId, state] of sessionAttentionStates) {
      if (now - state.lastStatusChangeAt > SESSION_ATTENTION_MAX_AGE_MS) continue;
      result[sessionId] = {
        needsAttention: state.needsAttention,
        lastUserMessageAt: state.lastUserMessageAt,
        lastStatusChangeAt: state.lastStatusChangeAt,
        status: state.status,
        isViewed: state.viewedByClients.size > 0,
      };
    }
    return result;
  };

  const getSessionAttentionState = (sessionId) => {
    if (!sessionId) return null;
    const state = sessionAttentionStates.get(sessionId);
    if (!state) return null;
    return {
      needsAttention: state.needsAttention,
      lastUserMessageAt: state.lastUserMessageAt,
      lastStatusChangeAt: state.lastStatusChangeAt,
      status: state.status,
      isViewed: state.viewedByClients.size > 0,
    };
  };

  const getSessionActivitySnapshot = () => {
    const result = {};
    for (const [sessionId, data] of sessionActivityPhases) {
      result[sessionId] = { type: data.phase };
    }
    return result;
  };

  const getActiveSessionCount = () => activeSessionCount;

  const resetAllSessionActivityToIdle = () => {
    for (const timer of sessionActivityCooldowns.values()) {
      clearTimeout(timer);
    }
    sessionActivityCooldowns.clear();
    activeSessionCount = 0;
    activeChildrenByParent.clear();
    childParents.clear();
    relationRecencyBySession.clear();
    relationTombstones.clear();
    const now = Date.now();
    for (const [sessionId] of sessionActivityPhases) {
      sessionActivityPhases.set(sessionId, { phase: 'idle', updatedAt: now });
    }
  };

  const interruptBusySessionsAfterRestart = () => {
    const interruptedSessionIds = new Set();
    for (const [sessionId, state] of sessionStates) {
      if (state.status === 'busy' || state.status === 'retry') {
        interruptedSessionIds.add(sessionId);
      }
    }
    for (const [sessionId, activity] of sessionActivityPhases) {
      if (activity.phase === 'busy') {
        interruptedSessionIds.add(sessionId);
      }
    }

    const eventId = `opencode-restart-${Date.now()}`;
    for (const sessionId of interruptedSessionIds) {
      updateSessionState(sessionId, 'idle', eventId, {
        message: 'Interrupted by OpenCode restart',
        reason: 'opencode-restart',
      });
      broadcastEvent?.({
        type: 'session.error',
        properties: {
          sessionID: sessionId,
          error: {
            name: 'MessageAbortedError',
            message: 'The running turn was interrupted when OpenCode restarted.',
          },
        },
      });
    }

    resetAllSessionActivityToIdle();
    return { sessionIds: [...interruptedSessionIds] };
  };

  const cleanupOldSessionStates = () => {
    const now = Date.now();
    for (const [sessionId, data] of sessionStates) {
      if (now - data.lastUpdateAt > SESSION_STATE_MAX_AGE_MS) {
        sessionStates.delete(sessionId);
      }
    }
    for (const [sessionId, state] of sessionAttentionStates) {
      if (now - state.lastStatusChangeAt > SESSION_ATTENTION_MAX_AGE_MS) {
        sessionAttentionStates.delete(sessionId);
      }
    }
    for (const [sessionId, data] of sessionActivityPhases) {
      if (now - data.updatedAt <= SESSION_ACTIVITY_MAX_AGE_MS) continue;
      const timer = sessionActivityCooldowns.get(sessionId);
      if (timer) clearTimeout(timer);
      sessionActivityCooldowns.delete(sessionId);
      sessionActivityPhases.delete(sessionId);
      // Synthetic busy never incremented the operational count, so it must not
      // decrement it either.
      if (data.phase === 'busy' && !data.synthetic) activeSessionCount = Math.max(0, activeSessionCount - 1);
    }
    // Drop parent-child relations whose child state is stale: a relation is
    // only meaningful while the child is alive, and the 24h state/activity
    // cleanup above already retired the corresponding phases. Settle the
    // former parent (and its ancestors) in this same cycle so a synthetic-busy
    // phase derived from the evicted child cannot persist until its own TTL.
    for (const [childId, parentId] of [...childParents.entries()]) {
      const childState = sessionStates.get(childId);
      if (!childState || now - childState.lastUpdateAt > SESSION_STATE_MAX_AGE_MS) {
        markChildSettled(childId, parentId, true);
        forgetChildRelation(childId);
      }
    }
    // Bound the relation metadata lifecycle: after the state/phase/relation
    // pruning above, reclaim recency baselines and deletion tombstones for
    // session ids the runtime no longer references, so forgotten session ids
    // cannot grow permanently. A recency entry is meaningful while the id
    // still participates in a retained relation/state/phase or is still gated
    // by a tombstone, and an unreferenced entry is retained for the same
    // deliberate stale-event window as a tombstone (SESSION_TOMBSTONE_
    // RETENTION_MS): a root/detach ordering baseline with no active raw state
    // must keep rejecting delayed older child relation records instead of
    // being pruned by the very first hourly cleanup. A tombstone is reclaimed
    // only once the id is fully unreferenced AND its deliberate retention
    // window has passed — inside the window a stale reconnection stays
    // blocked (no reanimation of a deleted/archived session), and after the
    // window the id is forgotten like any id pruned by the state TTL, so a
    // later record is a fresh session.
    const referencedSessionIds = new Set();
    for (const [childId, parentId] of childParents) {
      referencedSessionIds.add(childId);
      referencedSessionIds.add(parentId);
    }
    for (const [sessionId] of sessionStates) referencedSessionIds.add(sessionId);
    for (const [sessionId] of sessionAttentionStates) referencedSessionIds.add(sessionId);
    for (const [sessionId] of sessionActivityPhases) referencedSessionIds.add(sessionId);
    for (const [sessionId, tombstone] of relationTombstones) {
      if (referencedSessionIds.has(sessionId)) continue;
      if (now - tombstone.createdAt <= SESSION_TOMBSTONE_RETENTION_MS) continue;
      relationTombstones.delete(sessionId);
    }
    for (const [sessionId, recencyEntry] of relationRecencyBySession) {
      if (referencedSessionIds.has(sessionId) || relationTombstones.has(sessionId)) continue;
      if (now - recencyEntry.createdAt <= SESSION_TOMBSTONE_RETENTION_MS) continue;
      relationRecencyBySession.delete(sessionId);
    }
  };

  const cleanupInterval = setInterval(cleanupOldSessionStates, SESSION_STATE_CLEANUP_INTERVAL_MS);

  const processOpenCodeSsePayload = (payload) => {
    const deletedSessionId = extractDeletedSessionId(payload);
    if (deletedSessionId) {
      const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
      const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
      handleSessionDeleted(deletedSessionId, info);
      return;
    }

    const archived = extractArchivedSession(payload);
    if (archived) {
      // Treat a complete archived record as terminal deletion (matching the
      // directory reducer), reusing the deletion pathway with the archived
      // record time as the tombstone baseline. A stale archive echo older than
      // the session's last applied relation record is skipped; the shared
      // terminal staleness gate inside handleSessionDeleted also rejects a
      // delayed archive that is not strictly newer than the deletion tombstone
      // baseline or the newest accepted relation/session recency.
      const tracked = relationRecencyBySession.get(archived.sessionId)?.recency;
      if (tracked === undefined || getRecordRecency(archived.info) >= tracked) {
        handleSessionDeleted(archived.sessionId, archived.info);
      }
      return;
    }

    const relation = extractChildRelation(payload);
    if (relation) {
      // A stale complete session record (older than the last applied one) must
      // not overwrite a newer reparent/detach relation or re-adopt a busy
      // child to a stale ancestor: skip it entirely (no mutation, no adoption).
      const tracked = relationRecencyBySession.get(relation.childId)?.recency;
      if (tracked !== undefined && relation.recency < tracked) return;
      // A delayed same-recency record must not reconnect this session (or a
      // busy child) to a deleted session id; only a record strictly newer than
      // the deletion-time tombstone baseline may re-create the relation.
      const childTombstone = relationTombstones.get(relation.childId)?.baseline;
      const parentTombstone = typeof relation.parentId === 'string' ? relationTombstones.get(relation.parentId)?.baseline : undefined;
      if (childTombstone !== undefined || parentTombstone !== undefined) {
        const tombstoneBaseline = Math.max(childTombstone ?? 0, parentTombstone ?? 0);
        if (relation.recency <= tombstoneBaseline) return;
        // Session recreation is split from edge admission: a newer child→parent
        // EDGE record restores the edge relation but must NOT clear the
        // parent's tombstone/status block. The comparison-based baseline stays,
        // so the parent's own unversioned status remains blocked until the
        // parent itself has a strictly-newer complete record (which moves the
        // parent's relation recency above the baseline).
      }
      relationRecencyBySession.set(relation.childId, {
        recency: relation.recency,
        // Each accepted record restarts the deliberate retention window for
        // this baseline (matching how a fresh terminal restarts a tombstone),
        // so protection always covers the most recently accepted ordering
        // point instead of expiring from an older write.
        createdAt: Date.now(),
      });
      learnChildRelation(relation.childId, relation.parentId);
      // A busy status may have arrived before the child record: adopt the
      // already-running child so the parent surfaces active immediately.
      // A detach (parentId null) never adopts.
      if (relation.parentId && sessionActivityPhases.get(relation.childId)?.phase === 'busy') {
        markChildActive(relation.childId, relation.parentId);
      }
      return;
    }

    const update = extractSessionStatusUpdate(payload);
    if (!update) return;
    // Unversioned status updates carry no recency and are presumed stale while
    // the session id is tombstoned: ignore them until a strictly-newer
    // complete record moves the session's relation recency above the deletion
    // baseline, so a delayed busy status cannot resurrect a deleted/archived
    // session's raw state, phase, or operational count.
    const statusTombstoneBaseline = relationTombstones.get(update.sessionId)?.baseline;
    if (statusTombstoneBaseline !== undefined && (relationRecencyBySession.get(update.sessionId)?.recency ?? 0) <= statusTombstoneBaseline) return;

    const parentId = childParents.get(update.sessionId);
    if (parentId) {
      if (update.type === 'busy' || update.type === 'retry') {
        markChildActive(update.sessionId, parentId);
      } else if (update.type === 'idle') {
        markChildSettled(update.sessionId, parentId);
      }
    }

    if (update.type === 'busy' || update.type === 'retry') {
      setSessionActivityPhase(update.sessionId, 'busy');
    } else if (update.type === 'idle') {
      // Parent idle does not complete a background child: while any child is
      // still active the parent stays presentation-busy instead of entering
      // cooldown. Synthetic busy never counts toward the operational count.
      if (hasActiveChildren(update.sessionId)) {
        setSessionActivityPhase(update.sessionId, 'busy', true);
      } else {
        setSessionActivityPhase(update.sessionId, 'cooldown');
      }
    }

    updateSessionState(update.sessionId, update.type, update.eventId || `sse-${Date.now()}`, {
      attempt: update.attempt,
      message: update.message,
      next: update.next,
    });
  };

  const dispose = () => {
    clearInterval(cleanupInterval);
    for (const timer of sessionActivityCooldowns.values()) {
      clearTimeout(timer);
    }
    sessionActivityCooldowns.clear();
    sessionActivityPhases.clear();
    sessionStates.clear();
    sessionAttentionStates.clear();
    childParents.clear();
    activeChildrenByParent.clear();
    relationRecencyBySession.clear();
    relationTombstones.clear();
    activeSessionCount = 0;
  };

  return {
    processOpenCodeSsePayload,
    getSessionActivitySnapshot,
    getActiveSessionCount,
    getSessionStateSnapshot,
    getSessionAttentionSnapshot,
    getSessionState,
    getSessionAttentionState,
    markSessionViewed,
    markSessionUnviewed,
    markUserMessageSent,
    resetAllSessionActivityToIdle,
    interruptBusySessionsAfterRestart,
    dispose,
  };
};

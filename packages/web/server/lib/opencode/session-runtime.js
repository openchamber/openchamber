import { asNonEmptyString, isRecord } from '../shared/guards.js';

const SESSION_COOLDOWN_DURATION_MS = 2000;
const SESSION_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_ATTENTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_ACTIVITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_STATE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const extractSessionStatusUpdate = (payload) => {
  if (!payload || payload.type !== 'session.status') {
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

const readRequestId = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

// Allowlist projection for a session's queue binding (observability
// contract v1, #1473): only the four binding components can reach the
// snapshot, each an explicit null when the source cannot verify it, and
// a non-object source value means no known binding at all.
const normalizeQueueBinding = (binding) => {
  if (!isRecord(binding)) return null;
  const numberOrNull = (value) => (Number.isFinite(value) ? value : null);
  return {
    taskId: numberOrNull(binding.taskId),
    issueNumber: numberOrNull(binding.issueNumber),
    queue: asNonEmptyString(binding.queue),
    lane: asNonEmptyString(binding.lane),
  };
};

export const createSessionRuntime = ({ writeSseEvent, getNotificationClients, broadcastEvent, getSessionModelProvider, getSessionQueueBinding }) => {
  const sessionActivityPhases = new Map();
  const sessionActivityCooldowns = new Map();
  const sessionStates = new Map();
  const sessionAttentionStates = new Map();
  // Pending permission requests and forms per session, kept from the same
  // upstream stream. Clients that do not initialize a directory cannot read
  // its pending list from OpenCode (that read creates a location), so this map
  // is their seed. Entries live until the matching reply, the session's
  // deletion, or an OpenCode restart, which drops every pending request.
  // Pages an agent shows that wait for the user's answer sit beside them; they
  // come from this server's own render.page calls, not from OpenCode, and
  // leave when the call stops waiting (`trackWaitingPage`).
  const pendingRequestsBySession = new Map();
  let activeSessionCount = 0;
  // Readiness for the session-activity v1 contract (design #612) is owned
  // by BOTH signals together (follow-up #1441, decided 2026-11-13/16):
  // the watcher stream's connection state, fed by the watcher runtime via
  // setWatcherConnected, AND the first-event-received mark below. Either
  // one alone is not readiness, so an empty read stays distinguishable
  // from a watcher that has not started or has dropped.
  let watcherConnected = false;
  // False until the watcher stream delivers its first payload in this
  // process.
  let watcherSawPayload = false;

  const getOrCreatePendingRequests = (sessionId) => {
    let entry = pendingRequestsBySession.get(sessionId);
    if (!entry) {
      entry = { permissions: new Map(), forms: new Map(), pages: new Map() };
      pendingRequestsBySession.set(sessionId, entry);
    }
    return entry;
  };

  const settlePendingRequest = (kind, sessionId, requestId) => {
    const entry = pendingRequestsBySession.get(sessionId);
    if (!entry) return;
    // OpenCode may omit the request ID on a reply; the session then has no
    // pending request of that kind we can still vouch for.
    if (requestId) entry[kind].delete(requestId);
    else entry[kind].clear();
    if (entry.permissions.size === 0 && entry.forms.size === 0 && entry.pages.size === 0) pendingRequestsBySession.delete(sessionId);
  };

  /** A page that started (`waiting`) or stopped (`settled`) waiting for the user's answer. */
  const trackWaitingPage = (change) => {
    const sessionId = readRequestId(change?.sessionId);
    const callId = readRequestId(change?.callId);
    if (!sessionId || !callId) return;
    if (change.type === 'waiting') {
      const title = typeof change.title === 'string' ? change.title : '';
      getOrCreatePendingRequests(sessionId).pages.set(callId, { id: callId, sessionID: sessionId, title });
      return;
    }
    if (change.type === 'settled') settlePendingRequest('pages', sessionId, callId);
  };

  const processBlockingRequestPayload = (payload) => {
    if (!payload || typeof payload.type !== 'string') return;
    const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
    if (payload.type === 'permission.asked') {
      const sessionId = readRequestId(properties.sessionID);
      const requestId = readRequestId(properties.id);
      if (!sessionId || !requestId) return;
      getOrCreatePendingRequests(sessionId).permissions.set(requestId, properties);
      return;
    }
    // v2 replaced the question tool with forms; the request itself rides in
    // `properties.form`, so that object is what clients receive.
    if (payload.type === 'form.created') {
      const form = properties.form && typeof properties.form === 'object' ? properties.form : null;
      if (!form) return;
      const sessionId = readRequestId(form.sessionID) || readRequestId(properties.sessionID);
      const requestId = readRequestId(form.id);
      if (!sessionId || !requestId) return;
      getOrCreatePendingRequests(sessionId).forms.set(requestId, form);
      return;
    }
    if (payload.type === 'permission.replied') {
      settlePendingRequest('permissions', readRequestId(properties.sessionID), readRequestId(properties.requestID));
      return;
    }
    if (payload.type === 'form.settled') {
      settlePendingRequest('forms', readRequestId(properties.sessionID), readRequestId(properties.formID));
      return;
    }
    if (payload.type === 'session.deleted') {
      const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
      const sessionId = readRequestId(properties.sessionID) || readRequestId(info.id);
      if (sessionId) pendingRequestsBySession.delete(sessionId);
    }
  };

  const getPendingBlockingRequestsSnapshot = () => {
    const result = {};
    for (const [sessionId, entry] of pendingRequestsBySession) {
      result[sessionId] = {
        permissions: [...entry.permissions.values()],
        forms: [...entry.forms.values()],
        pages: [...entry.pages.values()],
      };
    }
    return result;
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

  const setSessionActivityPhase = (sessionId, phase, spaceId = undefined) => {
    if (!sessionId || typeof sessionId !== 'string') return false;

    const current = sessionActivityPhases.get(sessionId);
    // A caller that knows the session's space (the SSE payload path) passes
    // it explicitly, including null for a host session; internal callers
    // that do not pass it must not erase a tag an earlier payload set.
    const nextSpaceId = spaceId === undefined ? (current?.spaceId ?? null) : spaceId;
    if (current?.phase === phase) {
      if (current && current.spaceId !== nextSpaceId) {
        sessionActivityPhases.set(sessionId, { ...current, spaceId: nextSpaceId });
      }
      return false;
    }
    if (phase === 'cooldown' && current?.phase !== 'busy') {
      return false;
    }

    const existingTimer = sessionActivityCooldowns.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      sessionActivityCooldowns.delete(sessionId);
    }

    const wasActive = current?.phase === 'busy';
    const isActive = phase === 'busy';
    if (wasActive !== isActive) {
      activeSessionCount = Math.max(0, activeSessionCount + (isActive ? 1 : -1));
    }
    sessionActivityPhases.set(sessionId, { phase, updatedAt: Date.now(), spaceId: nextSpaceId });

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
      setSessionActivityPhase(sessionId, phase);
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

  // External observability contract v1 (design #612, phase 1 - #524): the
  // per-session { type } phase is frozen; every other field is additive and
  // an unknown is an explicit null, never a fabricated value. toolInFlight
  // has no in-process per-session source, and null is its settled contract
  // (follow-up #1441, decided 2026-11-13/16): it stays null until the
  // upstream event model changes; real tracking is not in scope before
  // then. queue is
  // the session's queue binding from the source the launch side registered
  // (the task ledger row bound to the session id, code#1656 step 3), or
  // null when no binding is known for the session (#1473).
  const getSessionActivitySnapshot = () => {
    const sessions = {};
    for (const [sessionId, data] of sessionActivityPhases) {
      const modelProvider = getSessionModelProvider ? getSessionModelProvider(sessionId) : null;
      sessions[sessionId] = {
        type: data.phase,
        lastActivityAt: data.updatedAt,
        status: sessionStates.get(sessionId)?.status ?? null,
        model: modelProvider
          ? { modelID: modelProvider.modelID ?? null, providerID: modelProvider.providerID ?? null }
          : null,
        toolInFlight: null,
        queue: normalizeQueueBinding(getSessionQueueBinding ? getSessionQueueBinding(sessionId) : null),
      };
    }
    return {
      version: 1,
      serverTime: Date.now(),
      watcherReady: watcherConnected && watcherSawPayload,
      sessions,
    };
  };

  const getActiveSessionCount = () => activeSessionCount;

  // Host-only counterpart for the managed-servers read: busy sessions that
  // belong to an isolated space run on the same OpenCode process but are not
  // sessions of the host server itself. Derived from the phase records so
  // cooldown, cleanup, and reset paths cannot drift from the tags.
  const getActiveHostSessionCount = () => {
    let count = 0;
    for (const data of sessionActivityPhases.values()) {
      if (data.phase === 'busy' && !data.spaceId) count += 1;
    }
    return count;
  };

  const resetAllSessionActivityToIdle = () => {
    for (const timer of sessionActivityCooldowns.values()) {
      clearTimeout(timer);
    }
    sessionActivityCooldowns.clear();
    activeSessionCount = 0;
    const now = Date.now();
    for (const [sessionId, data] of sessionActivityPhases) {
      sessionActivityPhases.set(sessionId, { phase: 'idle', updatedAt: now, spaceId: data.spaceId ?? null });
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

    // A restarted OpenCode forgot every pending request with the turns.
    pendingRequestsBySession.clear();
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
      if (data.phase === 'busy') activeSessionCount = Math.max(0, activeSessionCount - 1);
    }
  };

  const cleanupInterval = setInterval(cleanupOldSessionStates, SESSION_STATE_CLEANUP_INTERVAL_MS);

  const processOpenCodeSsePayload = (payload, { spaceId = null } = {}) => {
    watcherSawPayload = true;
    processBlockingRequestPayload(payload);
    const update = extractSessionStatusUpdate(payload);
    if (!update) return;

    const activitySpaceId = spaceId || null;
    if (update.type === 'busy' || update.type === 'retry') {
      setSessionActivityPhase(update.sessionId, 'busy', activitySpaceId);
    } else if (update.type === 'idle') {
      setSessionActivityPhase(update.sessionId, 'cooldown', activitySpaceId);
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
    pendingRequestsBySession.clear();
    activeSessionCount = 0;
    watcherConnected = false;
    watcherSawPayload = false;
  };

  // The watcher runtime owns the upstream stream and reports its
  // connection state here; readiness in the snapshot is this state AND
  // the first-payload mark, never either one alone (#1441).
  const setWatcherConnected = (connected) => {
    watcherConnected = connected === true;
  };

  return {
    processOpenCodeSsePayload,
    setWatcherConnected,
    getSessionActivitySnapshot,
    getActiveSessionCount,
    getActiveHostSessionCount,
    getSessionStateSnapshot,
    getPendingBlockingRequestsSnapshot,
    trackWaitingPage,
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

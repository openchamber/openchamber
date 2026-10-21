const SESSION_COOLDOWN_DURATION_MS = 2000;
const SESSION_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_ATTENTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_ACTIVITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_STATE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * After a managed restart, OpenCode's own boot sweep usually resumes orphaned
 * turns, but it only runs once the session's location has booted - in the
 * field that can lag the restart by several minutes, and it does not run at
 * all if the location never comes up. Until the grace deadline passes the
 * restart is expected to take care of itself; after it, a still-idle session
 * gets OpenChamber's own continuation.
 */
export const RESTART_RESUME_GRACE_MS = 60 * 1000;
const RESTART_RESUME_RETRY_MS = 15 * 1000;
const RESTART_RESUME_ATTEMPTS = 3;
const RESTART_RESUME_TIMEOUT_MS = 15 * 1000;
const RESTART_RESUME_TEXT =
  'OpenChamber restarted OpenCode while a response was still running. Continue from where you left off without repeating completed work.';

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

export const createSessionRuntime = ({
  writeSseEvent,
  getNotificationClients,
  broadcastEvent,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
}) => {
  const sessionActivityPhases = new Map();
  const sessionActivityCooldowns = new Map();
  const sessionStates = new Map();
  const sessionAttentionStates = new Map();
  // One pending continuation per session interrupted by a managed restart.
  const restartResumeTimers = new Map(); // sessionId -> { timer, attempt, id }
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

  const setSessionActivityPhase = (sessionId, phase) => {
    if (!sessionId || typeof sessionId !== 'string') return false;

    const current = sessionActivityPhases.get(sessionId);
    if (current?.phase === phase) return false;
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
    sessionActivityPhases.set(sessionId, { phase, updatedAt: Date.now() });

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

    if (status === 'busy' || status === 'retry') cancelRestartResume(sessionId);
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
    const now = Date.now();
    for (const [sessionId] of sessionActivityPhases) {
      sessionActivityPhases.set(sessionId, { phase: 'idle', updatedAt: now });
    }
  };

  const cancelRestartResume = (sessionId) => {
    const check = restartResumeTimers.get(sessionId);
    if (!check) return;
    clearTimeout(check.timer);
    restartResumeTimers.delete(sessionId);
  };

  const postRestartContinuation = async (sessionId, id) => {
    const fetchPath = `/api/session/${encodeURIComponent(sessionId)}/synthetic`;
    const response = await fetchImpl(buildOpenCodeUrl(fetchPath, ''), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      body: JSON.stringify({
        // Stable for every attempt of one restart: a retry after a lost
        // response lands as a 409, not a second continuation.
        id,
        text: RESTART_RESUME_TEXT,
        resume: true,
        metadata: { notice: 'opencode-restart' },
      }),
      signal: AbortSignal.timeout(RESTART_RESUME_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const error = new Error(`OpenCode POST ${fetchPath} failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      error.status = response.status;
      throw error;
    }
    await response.body?.cancel().catch(() => undefined);
  };

  const checkRestartResume = (sessionId, check) => {
    if (restartResumeTimers.get(sessionId) !== check) return; // A newer interrupt superseded it.
    const state = sessionStates.get(sessionId);
    // OpenCode's own boot sweep (or the user) already resumed the turn.
    if (!state || state.status === 'busy' || state.status === 'retry') {
      restartResumeTimers.delete(sessionId);
      return;
    }
    void (async () => {
      try {
        await postRestartContinuation(sessionId, check.id);
        restartResumeTimers.delete(sessionId);
        console.log(`[session-runtime] resumed interrupted session ${sessionId} after OpenCode restart`);
      } catch (error) {
        if (error?.status === 404) {
          // Deleted in the meantime; nobody is left to resume.
          restartResumeTimers.delete(sessionId);
          return;
        }
        if (error?.status === 409) {
          // A previous attempt's message was admitted after all.
          restartResumeTimers.delete(sessionId);
          return;
        }
        check.attempt += 1;
        if (check.attempt >= RESTART_RESUME_ATTEMPTS) {
          restartResumeTimers.delete(sessionId);
          console.warn(`[session-runtime] could not resume interrupted session ${sessionId}:`, error?.message ?? error);
          return;
        }
        check.timer = setTimeout(() => checkRestartResume(sessionId, check), RESTART_RESUME_RETRY_MS);
      }
    })();
  };

  const scheduleRestartResume = (sessionId) => {
    if (typeof buildOpenCodeUrl !== 'function' || typeof getOpenCodeAuthHeaders !== 'function') return;
    const existing = restartResumeTimers.get(sessionId);
    if (existing) clearTimeout(existing.timer);
    const check = { timer: null, attempt: 0, id: `opencode-restart-resume-${Date.now()}` };
    restartResumeTimers.set(sessionId, check);
    check.timer = setTimeout(() => checkRestartResume(sessionId, check), RESTART_RESUME_GRACE_MS);
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
      scheduleRestartResume(sessionId);
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

  const processOpenCodeSsePayload = (payload) => {
    processBlockingRequestPayload(payload);
    const update = extractSessionStatusUpdate(payload);
    if (!update) return;

    if (update.type === 'busy' || update.type === 'retry') {
      setSessionActivityPhase(update.sessionId, 'busy');
    } else if (update.type === 'idle') {
      setSessionActivityPhase(update.sessionId, 'cooldown');
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
    for (const check of restartResumeTimers.values()) {
      clearTimeout(check.timer);
    }
    restartResumeTimers.clear();
    sessionActivityCooldowns.clear();
    sessionActivityPhases.clear();
    sessionStates.clear();
    sessionAttentionStates.clear();
    pendingRequestsBySession.clear();
    activeSessionCount = 0;
  };

  return {
    processOpenCodeSsePayload,
    getSessionActivitySnapshot,
    getActiveSessionCount,
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

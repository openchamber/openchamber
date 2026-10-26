const SESSION_COOLDOWN_DURATION_MS = 2000;
const SESSION_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
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
    turnStartedAt: Number.isFinite(properties.turnStartedAt) ? properties.turnStartedAt : null,
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

export const createSessionRuntime = ({ writeSseEvent, getNotificationClients, broadcastEvent, readTurnStart = null }) => {
  const sessionActivityPhases = new Map();
  const sessionActivityCooldowns = new Map();
  const sessionStates = new Map();
  // When each session's latest turn began (OpenCode's clock), so every client
  // counts "Active for" from the same moment instead of from when it first
  // looked. Set from `session.execution.started`; a turn this server joined
  // already running is read back from the session's history (`readTurnStart`).
  // The start outlives its turn with `running: false`: a parent idling while a
  // background subagent works is still in that turn for display, and clients
  // ask for it then. A start that is not running is never reported as the
  // start of a busy session.
  const turnStarts = new Map();
  // One history read per session per turn; the token tells a read that
  // outlived its turn from the current one.
  const turnStartReads = new Map();
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
      if (sessionId) {
        pendingRequestsBySession.delete(sessionId);
        turnStarts.delete(sessionId);
        turnStartReads.delete(sessionId);
      }
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

  /** The start of the session's running turn, or null while none is known. */
  const getRunningTurnStart = (sessionId) => {
    const entry = turnStarts.get(sessionId);
    return entry?.running ? entry.startedAt : null;
  };

  /**
   * The start clients get beside a status: a running session's own start, an
   * idle one's last start (for a parent its subagents keep in the turn), and
   * nothing for a running session whose start is not known yet.
   */
  const reportedTurnStart = (sessionId, status) => {
    if (status === 'busy' || status === 'retry') return getRunningTurnStart(sessionId) ?? undefined;
    return turnStarts.get(sessionId)?.startedAt;
  };

  const endTurn = (sessionId) => {
    const entry = turnStarts.get(sessionId);
    if (entry?.running) turnStarts.set(sessionId, { startedAt: entry.startedAt, running: false });
    turnStartReads.delete(sessionId);
  };

  const broadcastSessionStatus = (properties) => {
    const payload = { type: 'openchamber:session-status', properties };
    if (broadcastEvent) {
      broadcastEvent(payload);
      return;
    }
    for (const res of getNotificationClients()) {
      try {
        writeSseEvent(res, payload);
      } catch {
      }
    }
  };

  /**
   * A busy session this server did not see start: read its start back from
   * the history once per turn, and announce it when it arrives while the same
   * turn still runs.
   */
  const readBackTurnStart = (sessionId) => {
    if (!readTurnStart || turnStartReads.has(sessionId)) return;
    const token = {};
    turnStartReads.set(sessionId, token);
    void Promise.resolve()
      .then(() => readTurnStart(sessionId))
      .catch(() => null)
      .then((startedAt) => {
        if (turnStartReads.get(sessionId) !== token || !Number.isFinite(startedAt)) return;
        if (turnStarts.get(sessionId)?.running) return;
        const state = sessionStates.get(sessionId);
        if (state?.status !== 'busy' && state?.status !== 'retry') return;
        turnStarts.set(sessionId, { startedAt, running: true });
        broadcastSessionStatus({
          sessionID: sessionId,
          status: state.status,
          timestamp: Date.now(),
          metadata: state.metadata,
          turnStartedAt: startedAt,
        });
      });
  };

  const updateSessionState = (sessionId, status, eventId, metadata = {}) => {
    if (!sessionId || typeof sessionId !== 'string') return;

    const now = Date.now();
    const existing = sessionStates.get(sessionId);
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

    if (!existing || existing.status !== status || isRestartInterruption) {
      const state = sessionStates.get(sessionId);
      broadcastSessionStatus({
        sessionID: sessionId,
        status: state.status,
        timestamp: state.lastUpdateAt,
        metadata: state.metadata,
        turnStartedAt: status === 'busy' || status === 'retry' ? getRunningTurnStart(sessionId) ?? undefined : undefined,
      });
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
        turnStartedAt: reportedTurnStart(sessionId, data.status),
      };
    }
    return result;
  };

  const getSessionState = (sessionId) => {
    if (!sessionId) return null;
    return sessionStates.get(sessionId) || null;
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
    turnStarts.clear();
    turnStartReads.clear();
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
    // A start lives as long as its session's status does.
    for (const sessionId of turnStarts.keys()) {
      if (!sessionStates.has(sessionId)) turnStarts.delete(sessionId);
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
      // Recorded before the status update, so its broadcast carries the start.
      if (update.turnStartedAt !== null) {
        turnStarts.set(update.sessionId, { startedAt: update.turnStartedAt, running: true });
        turnStartReads.delete(update.sessionId);
      }
      setSessionActivityPhase(update.sessionId, 'busy');
    } else if (update.type === 'idle') {
      endTurn(update.sessionId);
      setSessionActivityPhase(update.sessionId, 'cooldown');
    }

    updateSessionState(update.sessionId, update.type, update.eventId || `sse-${Date.now()}`, {
      attempt: update.attempt,
      message: update.message,
      next: update.next,
    });

    // A later step of a turn that started before this server was listening.
    if ((update.type === 'busy' || update.type === 'retry') && !turnStarts.get(update.sessionId)?.running) {
      readBackTurnStart(update.sessionId);
    }
  };

  /**
   * Sessions OpenCode reports running when this server connects to its event
   * stream, as read from `readAt` on. Turns that started before then sent no
   * event this server saw, so they are marked busy here and their starts are
   * read back from history. A session whose status changed while the list was
   * read is left to that newer status: its turn may have ended meanwhile.
   */
  const adoptRunningSessions = (sessionIds, readAt) => {
    for (const sessionId of sessionIds) {
      if (!sessionId || typeof sessionId !== 'string') continue;
      if ((sessionStates.get(sessionId)?.lastUpdateAt ?? 0) >= readAt) continue;
      const status = sessionStates.get(sessionId)?.status;
      if (status !== 'busy' && status !== 'retry') updateSessionState(sessionId, 'busy', `server-adopted-${Date.now()}`);
      if (!turnStarts.get(sessionId)?.running) readBackTurnStart(sessionId);
    }
  };

  const dispose = () => {
    clearInterval(cleanupInterval);
    for (const timer of sessionActivityCooldowns.values()) {
      clearTimeout(timer);
    }
    sessionActivityCooldowns.clear();
    sessionActivityPhases.clear();
    sessionStates.clear();
    pendingRequestsBySession.clear();
    turnStarts.clear();
    turnStartReads.clear();
    activeSessionCount = 0;
  };

  return {
    processOpenCodeSsePayload,
    adoptRunningSessions,
    getRunningTurnStart,
    getSessionActivitySnapshot,
    getActiveSessionCount,
    getSessionStateSnapshot,
    getPendingBlockingRequestsSnapshot,
    trackWaitingPage,
    getSessionState,
    resetAllSessionActivityToIdle,
    interruptBusySessionsAfterRestart,
    dispose,
  };
};

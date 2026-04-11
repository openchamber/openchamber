const SESSION_COOLDOWN_DURATION_MS = 2000;
const SESSION_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_ATTENTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_STATE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const extractSessionStatusUpdate = (payload) => {
  if (!payload || payload.type !== 'session.status') {
    return null;
  }

  const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
  const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID.trim() : '';
  const type = typeof info.type === 'string' ? info.type.trim() : '';

  if (!sessionId || !type) {
    return null;
  }

  return {
    sessionId,
    type,
    eventId: typeof payload.id === 'string' ? payload.id : '',
    attempt: typeof info.attempt === 'number' ? info.attempt : undefined,
    message: typeof info.message === 'string' ? info.message : undefined,
    next: typeof info.next === 'number' ? info.next : undefined,
  };
};

const deriveSessionActivityTransitions = (payload) => {
  const update = extractSessionStatusUpdate(payload);
  if (!update) {
    return [];
  }

  if (update.type === 'busy' || update.type === 'retry') {
    return [{ sessionId: update.sessionId, phase: 'busy' }];
  }
  if (update.type === 'idle') {
    return [{ sessionId: update.sessionId, phase: 'cooldown' }];
  }
  return [];
};

export const createSessionRuntime = ({ writeSseEvent, getNotificationClients }) => {
  const sessionActivityPhases = new Map();
  const sessionActivityCooldowns = new Map();
  const sessionStates = new Map();
  const sessionAttentionStates = new Map();

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

    sessionActivityPhases.set(sessionId, { phase, updatedAt: Date.now() });

    if (phase === 'cooldown') {
      const timer = setTimeout(() => {
        const now = sessionActivityPhases.get(sessionId);
        if (now?.phase === 'cooldown') {
          sessionActivityPhases.set(sessionId, { phase: 'idle', updatedAt: Date.now() });
        }
        sessionActivityCooldowns.delete(sessionId);
      }, SESSION_COOLDOWN_DURATION_MS);
      sessionActivityCooldowns.set(sessionId, timer);
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
    if (existing && existing.lastUpdateAt > now - 5000 && status === existing.status) {
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
    if (clients.size > 0 && (!existing || existing.status !== status || attentionChanged)) {
      const state = sessionStates.get(sessionId);
      for (const res of clients) {
        try {
          writeSseEvent(res, {
            type: 'openchamber:session-status',
            properties: {
              sessionId,
              status: state.status,
              timestamp: state.lastUpdateAt,
              metadata: state.metadata,
              needsAttention: attentionState?.needsAttention ?? false,
            },
          });
        } catch {
        }
      }
    }

    const phase = status === 'busy' || status === 'retry' ? 'busy' : 'idle';
    setSessionActivityPhase(sessionId, phase);
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
      const clients = getNotificationClients();
      for (const res of clients) {
        try {
          writeSseEvent(res, {
            type: 'openchamber:session-status',
            properties: {
              sessionId,
              status: state.status,
              timestamp: Date.now(),
              metadata: {},
              needsAttention: false,
            },
          });
        } catch {
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

  const resetAllSessionActivityToIdle = () => {
    for (const timer of sessionActivityCooldowns.values()) {
      clearTimeout(timer);
    }
    sessionActivityCooldowns.clear();
    const now = Date.now();
    for (const [sessionId] of sessionActivityPhases) {
      sessionActivityPhases.set(sessionId, { phase: 'idle', updatedAt: now });
    }
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
  };

  const cleanupInterval = setInterval(cleanupOldSessionStates, SESSION_STATE_CLEANUP_INTERVAL_MS);

  const processOpenCodeSsePayload = (payload) => {
    const transitions = deriveSessionActivityTransitions(payload);
    for (const activity of transitions) {
      setSessionActivityPhase(activity.sessionId, activity.phase);
    }

    if (payload && payload.type === 'session.status') {
      const update = extractSessionStatusUpdate(payload);
      if (update) {
        updateSessionState(update.sessionId, update.type, update.eventId || `sse-${Date.now()}`, {
          attempt: update.attempt,
          message: update.message,
          next: update.next,
        });
      }
    }
  };

  const dispose = () => {
    clearInterval(cleanupInterval);
    for (const timer of sessionActivityCooldowns.values()) {
      clearTimeout(timer);
    }
    sessionActivityCooldowns.clear();
  };

  return {
    processOpenCodeSsePayload,
    getSessionActivitySnapshot,
    getSessionStateSnapshot,
    getSessionAttentionSnapshot,
    getSessionState,
    getSessionAttentionState,
    markSessionViewed,
    markSessionUnviewed,
    markUserMessageSent,
    resetAllSessionActivityToIdle,
    dispose,
  };
};

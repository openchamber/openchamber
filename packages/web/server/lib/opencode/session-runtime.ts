import { createMessageId } from '../dispatch-results/runtime.js';
import { isString } from '../shared/object-guards.js';
import type { JsonValue } from '../shared/json-values.js';

interface EventFields {
  type?: JsonValue | undefined;
  id?: JsonValue | undefined;
  properties?: JsonValue | undefined;
  status?: JsonValue | undefined;
  info?: JsonValue | undefined;
  sessionID?: JsonValue | undefined;
  turnStartedAt?: JsonValue | undefined;
  attempt?: JsonValue | undefined;
  message?: JsonValue | undefined;
  next?: JsonValue | undefined;
  form?: JsonValue | undefined;
  requestID?: JsonValue | undefined;
  formID?: JsonValue | undefined;
  role?: JsonValue | undefined;
  tokens?: JsonValue | undefined;
  total?: JsonValue | undefined;
  cache?: JsonValue | undefined;
  input?: JsonValue | undefined;
  output?: JsonValue | undefined;
  reasoning?: JsonValue | undefined;
  read?: JsonValue | undefined;
  write?: JsonValue | undefined;
}
const isEventObject = (value: unknown): value is EventFields => Boolean(value && typeof value === 'object');
const hasEventFields = (value: unknown): value is EventFields => value != null;
const eventFields = <Value>(value: Value) => hasEventFields(value) ? value : undefined;
const isNumber = (value: unknown): value is number => typeof value === 'number';
const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);
const hasResumeErrorFields = (value: unknown): value is { status?: unknown; message?: unknown } => value != null;
const resumeErrorFields = <Value>(value: Value) => hasResumeErrorFields(value) ? value : undefined;

export interface SessionStateMetadata {
  attempt?: number | undefined;
  message?: string | undefined;
  next?: number | undefined;
  reason?: string;
}
export interface SessionState {
  status: string;
  lastUpdateAt: number;
  lastEventAt: number;
  lastEventId: string;
  metadata: SessionStateMetadata;
}
export interface SessionStateSnapshot {
  status: string;
  lastUpdateAt: number;
  metadata: SessionStateMetadata;
  turnStartedAt: number | undefined;
}
interface StatusBroadcast {
  sessionID: string;
  status: string;
  timestamp: number;
  metadata: SessionStateMetadata;
  turnStartedAt: number | undefined;
}
export type SessionRuntimeEvent =
  | { type: 'openchamber:session-status'; properties: StatusBroadcast }
  | { type: 'openchamber:session-activity'; properties: { sessionId: string; phase: ActivityPhase } }
  | { type: 'session.error'; properties: { sessionID: string; error: { name: string; message: string } } };
export interface SessionRuntimeDependencies<Client> {
  writeSseEvent: (client: Client, payload: SessionRuntimeEvent) => void;
  getNotificationClients: () => Iterable<Client>;
  broadcastEvent?: (payload: SessionRuntimeEvent) => void;
  readTurnStart?: ((sessionId: string) => Promise<number | null>) | null;
  buildOpenCodeUrl?: (route: string, prefix: string) => string;
  getOpenCodeAuthHeaders?: () => Record<string, string>;
  fetchImpl?: typeof fetch;
}
type ActivityPhase = 'busy' | 'idle' | 'cooldown';
interface Resume {
  id: string;
  attempted: boolean;
}
interface ResumeCheck {
  timer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  resume: Resume;
}
export interface PendingRequests {
  permissions: EventFields[];
  forms: EventFields[];
  pages: { id: string; sessionID: string; title: string }[];
}
export type SessionContextReading = { state: 'compacted' } | { state: 'measured'; tokens: number };
export interface WaitingPageChange {
  type: string;
  sessionId?: unknown;
  callId?: unknown;
  title?: unknown;
}

const SESSION_COOLDOWN_DURATION_MS = 2000;
const SESSION_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_ACTIVITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_STATE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export const RESTART_RESUME_GRACE_MS = 60 * 1000;
const RESTART_RESUME_RETRY_MS = 15 * 1000;
const RESTART_RESUME_ATTEMPTS = 3;
const RESTART_RESUME_TIMEOUT_MS = 15 * 1000;
const RESTART_RESUME_TEXT =
  'OpenChamber restarted OpenCode while a response was still running. Continue from where you left off without repeating completed work.';

const extractSessionStatusUpdate = (input: JsonValue | undefined) => {
  const payload = eventFields(input);
  if (!payload || payload.type !== 'session.status') {
    return null;
  }

  const properties = isEventObject(payload.properties) ? payload.properties : {};
  const status = isEventObject(properties.status) ? properties.status : {};
  const info = isEventObject(properties.info) ? properties.info : {};
  const sessionId = isString(properties.sessionID) ? properties.sessionID.trim() : '';
  const type = isString(status.type)
    ? status.type.trim()
    : (isString(info.type) ? info.type.trim() : '');

  if (!sessionId || !type) {
    return null;
  }

  return {
    sessionId,
    type,
    turnStartedAt: isFiniteNumber(properties.turnStartedAt) ? properties.turnStartedAt : null,
    eventId: isString(payload.id) ? payload.id : '',
    attempt: isNumber(status.attempt)
      ? status.attempt
      : (isNumber(info.attempt) ? info.attempt : undefined),
    message: isString(status.message)
      ? status.message
      : (isString(info.message) ? info.message : undefined),
    next: isNumber(status.next)
      ? status.next
      : (isNumber(info.next) ? info.next : undefined),
  };
};

const readRequestId = <Value>(value: Value) => (isString(value) && value.trim() ? value.trim() : '');

const CONTEXT_READINGS_MAX = 2000;

const finiteCount = <Value>(value: Value) => (isNumber(value) && Number.isFinite(value) && value > 0 ? value : 0);

const contextTokensOf = <Value>(tokens: Value) => {
  if (!isEventObject(tokens)) return 0;
  const total = finiteCount(tokens.total);
  if (total > 0) return total;
  const cache = isEventObject(tokens.cache) ? tokens.cache : {};
  return finiteCount(tokens.input) + finiteCount(tokens.output) + finiteCount(tokens.reasoning)
    + finiteCount(cache.read) + finiteCount(cache.write);
};

export const createSessionRuntime = <Client>({
  writeSseEvent,
  getNotificationClients,
  broadcastEvent,
  readTurnStart = null,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
}: SessionRuntimeDependencies<Client>) => {
  const sessionActivityPhases = new Map<string, { phase: ActivityPhase; updatedAt: number }>();
  const sessionActivityCooldowns = new Map<string, ReturnType<typeof setTimeout>>();
  const sessionStates = new Map<string, SessionState>();
  const turnStarts = new Map<string, { startedAt: number; running: boolean }>();
  const turnStartReads = new Map<string, object>();
  const restartResumeTimers = new Map<string, ResumeCheck>();
  const restartResumes = new Map<string, Resume>();
  const latestUserMessages = new Map<string, string>();
  const contextReadings = new Map<string, SessionContextReading>();
  const recordContext = (sessionId: string, reading: SessionContextReading) => {
    contextReadings.delete(sessionId);
    contextReadings.set(sessionId, reading);
    if (contextReadings.size > CONTEXT_READINGS_MAX) {
      const oldest = contextReadings.keys().next().value;
      if (oldest !== undefined) contextReadings.delete(oldest);
    }
  };
  const isolatedSessionIds = new Set<string>();
  const pendingRequestsBySession = new Map<string, {
    permissions: Map<string, EventFields>;
    forms: Map<string, EventFields>;
    pages: Map<string, { id: string; sessionID: string; title: string }>;
  }>();
  let activeSessionCount = 0;

  const getOrCreatePendingRequests = (sessionId: string) => {
    let entry = pendingRequestsBySession.get(sessionId);
    if (!entry) {
      entry = { permissions: new Map(), forms: new Map(), pages: new Map() };
      pendingRequestsBySession.set(sessionId, entry);
    }
    return entry;
  };

  const settlePendingRequest = (kind: 'permissions' | 'forms' | 'pages', sessionId: string, requestId: string) => {
    const entry = pendingRequestsBySession.get(sessionId);
    if (!entry) return;
    if (requestId) entry[kind].delete(requestId);
    else entry[kind].clear();
    if (entry.permissions.size === 0 && entry.forms.size === 0 && entry.pages.size === 0) pendingRequestsBySession.delete(sessionId);
  };

  const trackWaitingPage = (change: WaitingPageChange) => {
    const sessionId = readRequestId(change?.sessionId);
    const callId = readRequestId(change?.callId);
    if (!sessionId || !callId) return;
    if (change.type === 'waiting') {
      const title = isString(change.title) ? change.title : '';
      getOrCreatePendingRequests(sessionId).pages.set(callId, { id: callId, sessionID: sessionId, title });
      return;
    }
    if (change.type === 'settled') settlePendingRequest('pages', sessionId, callId);
  };

  const processBlockingRequestPayload = (input: JsonValue | undefined) => {
    const payload = eventFields(input);
    if (!payload || !isString(payload.type)) return;
    const properties = isEventObject(payload.properties) ? payload.properties : {};
    if (payload.type === 'permission.asked') {
      const sessionId = readRequestId(properties.sessionID);
      const requestId = readRequestId(properties.id);
      if (!sessionId || !requestId) return;
      getOrCreatePendingRequests(sessionId).permissions.set(requestId, properties);
      return;
    }
    if (payload.type === 'form.created') {
      const form = isEventObject(properties.form) ? properties.form : null;
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
      const info = isEventObject(properties.info) ? properties.info : {};
      const sessionId = readRequestId(properties.sessionID) || readRequestId(info.id);
      if (sessionId) {
        cancelRestartResume(sessionId);
        restartResumes.delete(sessionId);
        latestUserMessages.delete(sessionId);
        isolatedSessionIds.delete(sessionId);
        pendingRequestsBySession.delete(sessionId);
        turnStarts.delete(sessionId);
        turnStartReads.delete(sessionId);
      }
    }
  };

  const getPendingBlockingRequestsSnapshot = () => {
    const result: Record<string, PendingRequests> = {};
    for (const [sessionId, entry] of pendingRequestsBySession) {
      result[sessionId] = {
        permissions: [...entry.permissions.values()],
        forms: [...entry.forms.values()],
        pages: [...entry.pages.values()],
      };
    }
    return result;
  };

  const setSessionActivityPhase = (sessionId: string, phase: ActivityPhase) => {
    if (!sessionId) return false;

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

    if (broadcastEvent) {
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

  const getRunningTurnStart = (sessionId: string) => {
    const entry = turnStarts.get(sessionId);
    return entry?.running ? entry.startedAt : null;
  };

  const reportedTurnStart = (sessionId: string, status: string) => {
    if (status === 'busy' || status === 'retry') return getRunningTurnStart(sessionId) ?? undefined;
    return turnStarts.get(sessionId)?.startedAt;
  };

  const endTurn = (sessionId: string) => {
    const entry = turnStarts.get(sessionId);
    if (entry?.running) turnStarts.set(sessionId, { startedAt: entry.startedAt, running: false });
    turnStartReads.delete(sessionId);
  };

  const broadcastSessionStatus = (properties: StatusBroadcast) => {
    const payload: SessionRuntimeEvent = { type: 'openchamber:session-status', properties };
    if (broadcastEvent) {
      broadcastEvent(payload);
      return;
    }
    for (const res of getNotificationClients()) {
      try {
        writeSseEvent(res, payload);
      } catch {
        continue;
      }
    }
  };

  const readBackTurnStart = (sessionId: string) => {
    if (!readTurnStart || turnStartReads.has(sessionId)) return;
    const token = {};
    turnStartReads.set(sessionId, token);
    void Promise.resolve()
      .then(() => readTurnStart(sessionId))
      .catch(() => null)
      .then((startedAt) => {
        if (turnStartReads.get(sessionId) !== token || !isFiniteNumber(startedAt)) return;
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

  const updateSessionState = (sessionId: string, status: string, eventId: string, metadata: SessionStateMetadata = {}) => {
    if (!sessionId) return;

    const now = Date.now();
    const existing = sessionStates.get(sessionId);
    const isRestartInterruption = metadata.reason === 'opencode-restart';
    if (existing && existing.lastUpdateAt > now - 5000 && status === existing.status && !isRestartInterruption) {
      existing.lastEventAt = now;
      return;
    }

    sessionStates.set(sessionId, {
      status,
      lastUpdateAt: now,
      lastEventAt: now,
      lastEventId: eventId || `server-${now}`,
      metadata: { ...existing?.metadata, ...metadata },
    });

    if (status === 'busy' || status === 'retry') cancelRestartResume(sessionId);
    if (!existing || existing.status !== status || isRestartInterruption) {
      const state = sessionStates.get(sessionId);
      if (!state) throw new Error('Missing session state after update');
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
    const result: Record<string, SessionStateSnapshot> = {};
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

  const getSessionState = (sessionId: string) => {
    if (!sessionId) return null;
    return sessionStates.get(sessionId) || null;
  };

  const getSessionActivitySnapshot = () => {
    const result: Record<string, { type: ActivityPhase }> = {};
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

  const cancelRestartResume = (sessionId: string) => {
    const check = restartResumeTimers.get(sessionId);
    if (!check) return;
    clearTimeout(check.timer ?? undefined);
    restartResumeTimers.delete(sessionId);
  };

  const postRestartContinuation = async (sessionId: string, id: string) => {
    if (!buildOpenCodeUrl || !getOpenCodeAuthHeaders) throw new Error('Missing restart continuation connection');
    const fetchPath = `/api/session/${encodeURIComponent(sessionId)}/synthetic`;
    const response = await fetchImpl(buildOpenCodeUrl(fetchPath, ''), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      body: JSON.stringify({
        id,
        text: RESTART_RESUME_TEXT,
        resume: true,
        delivery: 'steer',
        metadata: { notice: 'opencode-restart' },
      }),
      signal: AbortSignal.timeout(RESTART_RESUME_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      const error: Error & { status?: number } = new Error(`OpenCode restart continuation failed with ${response.status}`);
      error.status = response.status;
      throw error;
    }
  };

  const checkRestartResume = (sessionId: string, check: ResumeCheck) => {
    if (restartResumeTimers.get(sessionId) !== check) return;
    const state = sessionStates.get(sessionId);
    if (!state || state.status === 'busy' || state.status === 'retry') {
      restartResumeTimers.delete(sessionId);
      return;
    }
    void (async () => {
      check.resume.attempted = true;
      try {
        await postRestartContinuation(sessionId, check.resume.id);
        if (restartResumeTimers.get(sessionId) !== check) return;
        restartResumeTimers.delete(sessionId);
      } catch (error) {
        if (restartResumeTimers.get(sessionId) !== check) return;
        if (resumeErrorFields(error)?.status === 404 || resumeErrorFields(error)?.status === 409) {
          restartResumeTimers.delete(sessionId);
          return;
        }
        check.attempt += 1;
        if (check.attempt >= RESTART_RESUME_ATTEMPTS) {
          restartResumeTimers.delete(sessionId);
          console.warn(`[session-runtime] could not resume interrupted session ${sessionId}:`, resumeErrorFields(error)?.message ?? error);
          return;
        }
        check.timer = setTimeout(() => checkRestartResume(sessionId, check), RESTART_RESUME_RETRY_MS);
      }
    })();
  };

  const scheduleRestartResume = (sessionId: string) => {
    cancelRestartResume(sessionId);
    if (isolatedSessionIds.has(sessionId)) return false;
    if (!buildOpenCodeUrl || !getOpenCodeAuthHeaders) return false;
    let resume = restartResumes.get(sessionId);
    if (resume?.attempted) return false;
    if (!resume) {
      resume = { id: createMessageId(Date.now()), attempted: false };
      restartResumes.set(sessionId, resume);
    }
    const check: ResumeCheck = { timer: null, attempt: 0, resume };
    restartResumeTimers.set(sessionId, check);
    check.timer = setTimeout(() => checkRestartResume(sessionId, check), RESTART_RESUME_GRACE_MS);
    return true;
  };

  const interruptBusySessionsAfterRestart = () => {
    const interruptedSessionIds = new Set<string>();
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

    pendingRequestsBySession.clear();
    turnStarts.clear();
    turnStartReads.clear();
    const eventId = `opencode-restart-${Date.now()}`;
    const autoResumeSessionIds = [];
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
      if (scheduleRestartResume(sessionId)) autoResumeSessionIds.push(sessionId);
    }

    resetAllSessionActivityToIdle();
    return { sessionIds: [...interruptedSessionIds], autoResumeSessionIds };
  };

  const cleanupOldSessionStates = () => {
    const now = Date.now();
    for (const [sessionId, data] of sessionStates) {
      if (now - data.lastUpdateAt > SESSION_STATE_MAX_AGE_MS) {
        sessionStates.delete(sessionId);
        cancelRestartResume(sessionId);
        if (!restartResumes.has(sessionId)) latestUserMessages.delete(sessionId);
      }
    }
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

  const processOpenCodeSsePayload = (input: JsonValue | undefined, { spaceId = null }: { spaceId?: string | null } = {}) => {
    const payload = eventFields(input);
    const properties = eventFields(payload?.properties);
    processBlockingRequestPayload(input);
    if (payload?.type === 'session.compacted') {
      const sessionId = readRequestId(properties?.sessionID);
      if (sessionId) recordContext(sessionId, { state: 'compacted' });
    } else if (payload?.type === 'session.deleted') {
      const sessionId = readRequestId(properties?.sessionID);
      if (sessionId) contextReadings.delete(sessionId);
    }
    if (payload?.type === 'message.updated') {
      const info = eventFields(properties?.info);
      const sessionId = readRequestId(info?.sessionID);
      const tokens = info?.role === 'assistant' ? contextTokensOf(info.tokens) : 0;
      if (sessionId && tokens > 0) recordContext(sessionId, { state: 'measured', tokens });
      const messageId = readRequestId(info?.id);
      if (info?.role === 'user' && sessionId && messageId && latestUserMessages.get(sessionId) !== messageId) {
        latestUserMessages.set(sessionId, messageId);
        cancelRestartResume(sessionId);
        restartResumes.delete(sessionId);
      }
    }
    const update = extractSessionStatusUpdate(input);
    if (!update) return;
    if (spaceId) isolatedSessionIds.add(update.sessionId);

    if (update.type === 'busy' || update.type === 'retry') {
      if (update.turnStartedAt !== null) {
        turnStarts.set(update.sessionId, { startedAt: update.turnStartedAt, running: true });
        turnStartReads.delete(update.sessionId);
      }
      setSessionActivityPhase(update.sessionId, 'busy');
    } else if (update.type === 'idle') {
      endTurn(update.sessionId);
      settlePendingRequest('permissions', update.sessionId, '');
      setSessionActivityPhase(update.sessionId, 'cooldown');
    }

    updateSessionState(update.sessionId, update.type, update.eventId || `sse-${Date.now()}`, {
      attempt: update.attempt,
      message: update.message,
      next: update.next,
    });

    if ((update.type === 'busy' || update.type === 'retry') && !turnStarts.get(update.sessionId)?.running) {
      readBackTurnStart(update.sessionId);
    }
  };

  const adoptRunningSessions = (sessionIds: string[], readAt: number) => {
    const running = new Set<string>();
    for (const sessionId of sessionIds) {
      if (!sessionId) continue;
      running.add(sessionId);
      if ((sessionStates.get(sessionId)?.lastEventAt ?? 0) >= readAt) continue;
      const status = sessionStates.get(sessionId)?.status;
      if (status !== 'busy' && status !== 'retry') updateSessionState(sessionId, 'busy', `server-adopted-${Date.now()}`);
      if (!turnStarts.get(sessionId)?.running) readBackTurnStart(sessionId);
    }
    for (const [sessionId, state] of [...sessionStates]) {
      if (state.status !== 'busy' && state.status !== 'retry') continue;
      if (isolatedSessionIds.has(sessionId) || running.has(sessionId) || state.lastEventAt >= readAt) continue;
      endTurn(sessionId);
      settlePendingRequest('permissions', sessionId, '');
      setSessionActivityPhase(sessionId, 'cooldown');
      updateSessionState(sessionId, 'idle', `server-settled-${Date.now()}`);
    }
  };

  const dispose = () => {
    clearInterval(cleanupInterval);
    for (const timer of sessionActivityCooldowns.values()) {
      clearTimeout(timer);
    }
    for (const check of restartResumeTimers.values()) {
      clearTimeout(check.timer ?? undefined);
    }
    restartResumeTimers.clear();
    restartResumes.clear();
    latestUserMessages.clear();
    isolatedSessionIds.clear();
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
    getSessionContextSnapshot: () => Object.fromEntries(contextReadings),
    trackWaitingPage,
    getSessionState,
    resetAllSessionActivityToIdle,
    interruptBusySessionsAfterRestart,
    dispose,
  };
};

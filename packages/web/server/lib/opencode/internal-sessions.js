export const OPENCHAMBER_INTERNAL_SESSION_KIND = 'walkthrough-inference';

const MAX_TRACKED_INTERNAL_SESSIONS = 10_000;
const EVENT_LOOKUP_TIMEOUT_MS = 300;
const LOOKUP_FAILURE_TTL_MS = 2_000;
const classifiedSessionIds = new Map();
const inFlightLookups = new Map();
const lookupFailedUntil = new Map();
let registryGeneration = 0;

const rememberClassification = (sessionId, internal) => {
  classifiedSessionIds.delete(sessionId);
  classifiedSessionIds.set(sessionId, internal);
  while (classifiedSessionIds.size > MAX_TRACKED_INTERNAL_SESSIONS) {
    classifiedSessionIds.delete(classifiedSessionIds.keys().next().value);
  }
};

export const internalSessionMetadata = () => ({
  openchamber: {
    internalSession: {
      kind: OPENCHAMBER_INTERNAL_SESSION_KIND,
      version: 1,
    },
  },
});

export const isOpenChamberInternalSession = (session) => (
  session?.metadata?.openchamber?.internalSession?.kind === OPENCHAMBER_INTERNAL_SESSION_KIND
);

export const trackOpenChamberInternalSession = (sessionId) => {
  if (sessionId?.constructor !== String || !sessionId) return;
  rememberClassification(sessionId, true);
};

const sessionIdFromEvent = (payload) => payload?.properties?.sessionID
  ?? payload?.properties?.info?.sessionID
  ?? payload?.properties?.info?.id;

export const isOpenChamberInternalSessionEvent = (payload) => {
  const info = payload?.properties?.info;
  const sessionId = sessionIdFromEvent(payload);
  if (payload?.type === 'session.deleted') {
    const internal = isOpenChamberInternalSession(info) || classifiedSessionIds.get(sessionId) === true;
    if (sessionId) classifiedSessionIds.delete(sessionId);
    return internal;
  }
  if (isOpenChamberInternalSession(info)) {
    trackOpenChamberInternalSession(info.id ?? sessionId);
    return true;
  }
  if (info?.id) {
    rememberClassification(info.id, false);
  }
  return classifiedSessionIds.get(sessionId) === true;
};

export const classifyOpenChamberInternalSessionEvent = async (payload, lookupSession) => {
  if (isOpenChamberInternalSessionEvent(payload)) return true;
  const sessionId = sessionIdFromEvent(payload);
  if (!sessionId || classifiedSessionIds.has(sessionId) || !(lookupSession instanceof Function)) return false;
  if ((lookupFailedUntil.get(sessionId) ?? 0) > Date.now()) return false;
  let lookup = inFlightLookups.get(sessionId);
  if (!lookup) {
    const generation = registryGeneration;
    const underlying = Promise.resolve().then(() => lookupSession(sessionId));
    lookup = { generation, underlying };
    inFlightLookups.set(sessionId, lookup);
    underlying.finally(() => {
      if (inFlightLookups.get(sessionId)?.underlying === underlying) inFlightLookups.delete(sessionId);
    }).catch(() => {});
  }
  try {
    const session = await Promise.race([
      lookup.underlying,
      new Promise((_, reject) => setTimeout(() => reject(new Error('session classification timed out')), EVENT_LOOKUP_TIMEOUT_MS)),
    ]);
    if (lookup.generation !== registryGeneration) return false;
    if (isOpenChamberInternalSession(session)) {
      trackOpenChamberInternalSession(sessionId);
      lookupFailedUntil.delete(sessionId);
      return true;
    }
    rememberClassification(sessionId, false);
    lookupFailedUntil.delete(sessionId);
  } catch {
    if (lookup.generation === registryGeneration) lookupFailedUntil.set(sessionId, Date.now() + LOOKUP_FAILURE_TTL_MS);
  }
  return false;
};

export const forgetOpenChamberInternalSession = (sessionId) => {
  classifiedSessionIds.delete(sessionId);
};

export const resetOpenChamberInternalSessions = () => {
  registryGeneration += 1;
  classifiedSessionIds.clear();
  inFlightLookups.clear();
  lookupFailedUntil.clear();
};

export const __testing = {
  clear: resetOpenChamberInternalSessions,
};

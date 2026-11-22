import { useCallback } from 'react';
import { create } from 'zustand';
import type { SessionTurnStart } from '@/lib/opencode/events';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { countSyncPerformance } from './performance-diagnostics';


type SessionActivityPhase = 'active' | 'settled';

export type SessionActivityTimingMutation =
  | { type: 'observe'; sessionId: string; phase: SessionActivityPhase; turnStart?: SessionTurnStart }
  | { type: 'hold'; sessionId: string }
  | { type: 'remove'; sessionId: string };

type ActivityTimingDraft = {
  startedAt: Map<string, number> | null;
  settledMs: Map<string, number> | null;
};

type SessionActivityTimingState = {
  startedAt: ReadonlyMap<string, number>;
  settledMs: ReadonlyMap<string, number>;
};

type PersistedStart = { start: number; seen: number };

const SETTLED_LIMIT = 200;
const MAX_TURN_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_AWAY_MS = 30_000;
const LIVENESS_PERSIST_INTERVAL_MS = 15_000;
const RESTORE_ADOPTION_WINDOW_MS = 90_000;
const HOST_START_SLACK_MS = 1_000;
const STORAGE_KEY = 'oc.session-activity.v1';

const EMPTY_RESTORED: ReadonlyMap<string, PersistedStart> = new Map();
const EMPTY_IDS: ReadonlySet<string> = new Set();

export const useSessionActivityTimingStore = create<SessionActivityTimingState>(() => ({
  startedAt: new Map(),
  settledMs: new Map(),
}));
useSessionActivityTimingStore.subscribe(() => countSyncPerformance('timingPublications'));

const liveSeen = new Map<string, number>();
let lastPersistAt = 0;


const hostStarted = new Set<string>();
const startUnknown = new Set<string>();
const askedHost = new Set<string>();
const heldTurns = new Set<string>();
const turnBeganAt = new Map<string, number>();
let hostTurnStartRequester: (() => void) | null = null;

export const setHostTurnStartRequester = (requester: (() => void) | null): void => {
  hostTurnStartRequester = requester;
};

export const needsHostTurnStarts = (): boolean => {
  if (startUnknown.size > 0) return true;
  for (const sessionId of useSessionActivityTimingStore.getState().startedAt.keys()) {
    if (!hostStarted.has(sessionId)) return true;
  }
  return false;
};

type TimingPass = {
  currentStarted: () => ReadonlyMap<string, number>;
  draftStarted: () => Map<string, number>;
  askHost: boolean;
};

const isInTurn = (pass: TimingPass, sessionId: string): boolean => (
  pass.currentStarted().has(sessionId) || startUnknown.has(sessionId)
);

const beginTurn = (
  pass: TimingPass,
  sessionId: string,
  turnStart: SessionTurnStart | undefined,
  restored: ReadonlyMap<string, PersistedStart>,
): void => {
  const at = turnStart?.at ?? restored.get(sessionId)?.start;
  if (turnStart) turnBeganAt.set(sessionId, Date.now());
  if (at === undefined) startUnknown.add(sessionId);
  else pass.draftStarted().set(sessionId, at);
  if (turnStart?.source === 'host') {
    hostStarted.add(sessionId);
  } else if (!askedHost.has(sessionId)) {
    askedHost.add(sessionId);
    pass.askHost = true;
  }
};

const offerHostStart = (pass: TimingPass, sessionId: string, turnStart: SessionTurnStart): void => {
  if (turnStart.source !== 'host') return;
  const current = pass.currentStarted().get(sessionId);
  if (current !== undefined && hostStarted.has(sessionId)) {
    const later = turnStart.at - current;
    if (Math.abs(later) < HOST_START_SLACK_MS) return;
    if (later > 0 && heldTurns.has(sessionId)) return;
  }
  pass.draftStarted().set(sessionId, turnStart.at);
  startUnknown.delete(sessionId);
  hostStarted.add(sessionId);
};

const forgetTurnStart = (sessionId: string): void => {
  hostStarted.delete(sessionId);
  startUnknown.delete(sessionId);
  askedHost.delete(sessionId);
  heldTurns.delete(sessionId);
  turnBeganAt.delete(sessionId);
};

const finishPass = (pass: TimingPass): void => {
  if (pass.askHost) hostTurnStartRequester?.();
};


let restoredStarts: Map<string, PersistedStart> | null = null;

const readPageLoadAt = (): number => {
  if (typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin)) {
    return performance.timeOrigin;
  }
  return Date.now();
};

let pageLoadAt = readPageLoadAt();

const isResumable = (entry: PersistedStart, now: number): boolean => (
  entry.start <= now
  && now - entry.start <= MAX_TURN_AGE_MS
  && entry.seen <= now
  && pageLoadAt - entry.seen <= MAX_AWAY_MS
);

const parseEntry = (value: unknown): PersistedStart | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { start, seen } = value as { start?: unknown; seen?: unknown };
  if (typeof start !== 'number' || !Number.isFinite(start)) return null;
  if (typeof seen !== 'number' || !Number.isFinite(seen)) return null;
  return { start, seen };
};

const readRestoredStarts = (): Map<string, PersistedStart> => {
  const restored = new Map<string, PersistedStart>();
  let raw: string | null = null;
  try {
    raw = getSafeStorage().getItem(STORAGE_KEY);
  } catch {
    return restored;
  }
  if (!raw) return restored;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return restored;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return restored;

  const now = Date.now();
  for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = parseEntry(value);
    if (entry && isResumable(entry, now)) restored.set(sessionId, entry);
  }
  return restored;
};

const getRestoredStarts = (): Map<string, PersistedStart> => {
  restoredStarts ??= readRestoredStarts();
  return restoredStarts;
};

const getAdoptableStarts = (now: number): ReadonlyMap<string, PersistedStart> => {
  if (now - pageLoadAt > RESTORE_ADOPTION_WINDOW_MS) {
    restoredStarts?.clear();
    return EMPTY_RESTORED;
  }
  return getRestoredStarts();
};

const persistStarts = (startedAt: ReadonlyMap<string, number>, now: number): void => {
  const payload: Record<string, PersistedStart> = {};
  for (const [sessionId, entry] of getRestoredStarts()) {
    if (isResumable(entry, now)) payload[sessionId] = entry;
  }
  for (const [sessionId, start] of startedAt) {
    payload[sessionId] = { start, seen: liveSeen.get(sessionId) ?? now };
  }

  lastPersistAt = now;
  try {
    const storage = getSafeStorage();
    if (Object.keys(payload).length === 0) {
      storage.removeItem(STORAGE_KEY);
      return;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage is unavailable or full; counters simply restart after a reload.
  }
};

const stampLiveness = (): void => {
  const { startedAt } = useSessionActivityTimingStore.getState();
  if (startedAt.size === 0) return;
  const now = Date.now();
  for (const sessionId of startedAt.keys()) liveSeen.set(sessionId, now);
  persistStarts(startedAt, now);
};

let lifecycleHooked = false;

const ensureLivenessStampOnHide = (): void => {
  if (lifecycleHooked || typeof window === 'undefined') return;
  lifecycleHooked = true;
  try {
    window.addEventListener('pagehide', stampLiveness, { capture: true });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') stampLiveness();
      });
      document.addEventListener('freeze', stampLiveness);
    }
  } catch {
    // Restricted environments can reject listeners; the periodic stamp refresh
    // still bounds how quiet a running turn's record can get.
  }
};


const trimSettled = (settled: Map<string, number>): void => {
  while (settled.size > SETTLED_LIMIT) {
    const oldest = settled.keys().next();
    if (oldest.done) return;
    settled.delete(oldest.value);
  }
};

type SettleInput =
  | { source: 'event'; sessionId: string }
  | { source: 'snapshot'; isCovered: (sessionId: string) => boolean };

const applyTransitions = (
  activeSessionIds: ReadonlySet<string>,
  settle: SettleInput | null,
  heldSessionIds: ReadonlySet<string>,
): void => {
  const now = Date.now();
  const restored = getAdoptableStarts(now);
  const state = useSessionActivityTimingStore.getState();

  const next: { started: Map<string, number> | null; settled: Map<string, number> | null } = {
    started: null,
    settled: null,
  };
  let sawActive = false;
  let restoredChanged = false;

  const draftStarted = (): Map<string, number> => (next.started ??= new Map(state.startedAt));
  const draftSettled = (): Map<string, number> => (next.settled ??= new Map(state.settledMs));
  const pass: TimingPass = { currentStarted: () => next.started ?? state.startedAt, draftStarted, askHost: false };

  for (const sessionId of activeSessionIds) {
    sawActive = true;
    liveSeen.set(sessionId, now);
    if (isInTurn(pass, sessionId)) continue;
    beginTurn(pass, sessionId, undefined, restored);
    if ((next.settled ?? state.settledMs).has(sessionId)) draftSettled().delete(sessionId);
  }
  for (const sessionId of heldSessionIds) heldTurns.add(sessionId);

  const settleTurn = (sessionId: string, start: number): void => {
    draftStarted().delete(sessionId);
    liveSeen.delete(sessionId);
    forgetTurnStart(sessionId);
    draftSettled().set(sessionId, Math.max(0, now - start));
  };

  if (settle === null) {
    // Nothing ends this pass.
  } else if (settle.source === 'event') {
    if (getRestoredStarts().delete(settle.sessionId)) restoredChanged = true;
    const start = state.startedAt.get(settle.sessionId);
    if (start !== undefined) settleTurn(settle.sessionId, start);
    else forgetTurnStart(settle.sessionId);
  } else {
    for (const [sessionId, start] of state.startedAt) {
      if (activeSessionIds.has(sessionId)) continue;
      if (!settle.isCovered(sessionId)) continue;
      settleTurn(sessionId, start);
    }
    for (const sessionId of startUnknown) {
      if (!activeSessionIds.has(sessionId) && settle.isCovered(sessionId)) forgetTurnStart(sessionId);
    }
  }

  if (next.settled) trimSettled(next.settled);

  if (next.started || next.settled) {
    useSessionActivityTimingStore.setState({
      startedAt: next.started ?? state.startedAt,
      settledMs: next.settled ?? state.settledMs,
    });
  }

  finishPass(pass);

  if (next.started) {
    if (next.started.size > 0) ensureLivenessStampOnHide();
    persistStarts(next.started, now);
    return;
  }
  if (restoredChanged) {
    persistStarts(state.startedAt, now);
    return;
  }
  if (sawActive && state.startedAt.size > 0 && now - lastPersistAt >= LIVENESS_PERSIST_INTERVAL_MS) {
    persistStarts(state.startedAt, now);
  }
};

export const observeSessionActivityTiming = (
  sessionId: string,
  phase: SessionActivityPhase,
  turnStart?: SessionTurnStart,
): void => {
  applySessionActivityTimingMutations([{ type: 'observe', sessionId, phase, turnStart }]);
};

export const applySessionActivityTimingMutations = (
  mutations: readonly SessionActivityTimingMutation[],
): void => {
  if (mutations.length === 0) return;
  const now = Date.now();
  const restored = getAdoptableStarts(now);
  const state = useSessionActivityTimingStore.getState();
  const next: ActivityTimingDraft = { startedAt: null, settledMs: null };
  let restoredChanged = false;
  let sawActive = false;
  const currentStarted = (): ReadonlyMap<string, number> => next.startedAt ?? state.startedAt;
  const currentSettled = (): ReadonlyMap<string, number> => next.settledMs ?? state.settledMs;
  const draftStarted = (): Map<string, number> => (next.startedAt ??= new Map(state.startedAt));
  const draftSettled = (): Map<string, number> => (next.settledMs ??= new Map(state.settledMs));
  const pass: TimingPass = { currentStarted, draftStarted, askHost: false };

  for (const mutation of mutations) {
    if (mutation.type === 'hold') {
      if (isInTurn(pass, mutation.sessionId)) heldTurns.add(mutation.sessionId);
      continue;
    }

    if (mutation.type === 'remove') {
      if (getRestoredStarts().delete(mutation.sessionId)) restoredChanged = true;
      liveSeen.delete(mutation.sessionId);
      forgetTurnStart(mutation.sessionId);
      if (currentStarted().has(mutation.sessionId)) draftStarted().delete(mutation.sessionId);
      if (currentSettled().has(mutation.sessionId)) draftSettled().delete(mutation.sessionId);
      continue;
    }

    if (mutation.phase === 'active') {
      sawActive = true;
      liveSeen.set(mutation.sessionId, now);
      if (!isInTurn(pass, mutation.sessionId)) beginTurn(pass, mutation.sessionId, mutation.turnStart, restored);
      else if (mutation.turnStart) offerHostStart(pass, mutation.sessionId, mutation.turnStart);
      if (currentSettled().has(mutation.sessionId)) draftSettled().delete(mutation.sessionId);
      continue;
    }

    if (getRestoredStarts().delete(mutation.sessionId)) restoredChanged = true;
    const start = currentStarted().get(mutation.sessionId);
    forgetTurnStart(mutation.sessionId);
    if (start === undefined) continue;
    draftStarted().delete(mutation.sessionId);
    liveSeen.delete(mutation.sessionId);
    draftSettled().set(mutation.sessionId, Math.max(0, now - start));
  }
  finishPass(pass);

  if (next.settledMs) trimSettled(next.settledMs);
  if (next.startedAt || next.settledMs) {
    useSessionActivityTimingStore.setState({
      startedAt: next.startedAt ?? state.startedAt,
      settledMs: next.settledMs ?? state.settledMs,
    });
  }
  if (next.startedAt) {
    if (next.startedAt.size > 0) ensureLivenessStampOnHide();
    persistStarts(next.startedAt, now);
  } else if (restoredChanged) {
    persistStarts(state.startedAt, now);
  } else if (sawActive && state.startedAt.size > 0 && now - lastPersistAt >= LIVENESS_PERSIST_INTERVAL_MS) {
    persistStarts(state.startedAt, now);
  }
};

export const reconcileSessionActivityTiming = (
  activeSessionIds: ReadonlySet<string>,
  isCoveredBySnapshot: (sessionId: string) => boolean,
  heldSessionIds: ReadonlySet<string> = EMPTY_IDS,
): void => {
  applyTransitions(activeSessionIds, { source: 'snapshot', isCovered: isCoveredBySnapshot }, heldSessionIds);
};

export const removeSessionActivityTiming = (sessionId: string): void => {
  applySessionActivityTimingMutations([{ type: 'remove', sessionId }]);
};

export const applyHostTurnStarts = (
  starts: ReadonlyMap<string, SessionTurnStart>,
  heldHere: ReadonlySet<string>,
  read: { requestedAt: number; answeredAt: number },
): void => {
  if (starts.size === 0) return;
  const state = useSessionActivityTimingStore.getState();
  let started: Map<string, number> | null = null;
  let settled: Map<string, number> | null = null;
  const pass: TimingPass = {
    currentStarted: () => started ?? state.startedAt,
    draftStarted: () => (started ??= new Map(state.startedAt)),
    askHost: false,
  };
  for (const [sessionId, turnStart] of starts) {
    const beganAt = turnBeganAt.get(sessionId);
    if (beganAt !== undefined && beganAt >= read.requestedAt && beganAt < read.answeredAt) continue;
    if (heldHere.has(sessionId)) heldTurns.add(sessionId);
    if (isInTurn(pass, sessionId)) {
      offerHostStart(pass, sessionId, turnStart);
    } else if (heldHere.has(sessionId)) {
      beginTurn(pass, sessionId, turnStart, EMPTY_RESTORED);
      if ((settled ?? state.settledMs).has(sessionId)) (settled ??= new Map(state.settledMs)).delete(sessionId);
    }
  }
  if (!started) return;
  useSessionActivityTimingStore.setState({ startedAt: started, settledMs: settled ?? state.settledMs });
  ensureLivenessStampOnHide();
  persistStarts(started, Date.now());
};

export const resetSessionActivityTiming = (options: { pageLoadAt?: number } = {}): void => {
  restoredStarts = null;
  liveSeen.clear();
  hostStarted.clear();
  startUnknown.clear();
  askedHost.clear();
  heldTurns.clear();
  turnBeganAt.clear();
  lastPersistAt = 0;
  pageLoadAt = options.pageLoadAt ?? Date.now();
  useSessionActivityTimingStore.setState({ startedAt: new Map(), settledMs: new Map() });
};


export const useSessionActivityStartedAt = (sessionId: string): number | undefined => (
  useSessionActivityTimingStore(useCallback((state) => state.startedAt.get(sessionId), [sessionId]))
);

export const useSessionSettledDurationMs = (sessionId: string): number | undefined => (
  useSessionActivityTimingStore(useCallback((state) => state.settledMs.get(sessionId), [sessionId]))
);

export const useHasSessionActivityDuration = (sessionId: string, running: boolean): boolean => (
  useSessionActivityTimingStore(useCallback((state) => (
    running ? state.startedAt.has(sessionId) : state.settledMs.has(sessionId)
  ), [running, sessionId]))
);

import { create } from 'zustand';
import { z } from 'zod';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import type { Session } from "@/lib/opencode/model"
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { getBtwSessionID } from '@/lib/sessionBtwMetadata';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { isSessionPinned, isSessionPinnedInMetadata } from '@/lib/sessionPins';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore, type SessionRetentionAction } from '@/stores/useUIStore';
import { useSessionUIStore } from './session-ui-store';
import { useGlobalSessionStatusStore } from './global-session-status';
import { archiveSession, deleteSession } from './session-actions';

const DAY_MS = 86_400_000;
export const RETENTION_KEEP_RECENT = 5;
export const RETENTION_INTERVAL_MS = DAY_MS;

export type RetentionAbsence = readonly [from: number, to: number];

const RETENTION_CLOCK_KEY = 'openchamber.sessionRetention.clock';
const timestampSchema = z.number().finite().positive();
const retentionClockSchema = z.object({
  lastRunAt: timestampSchema.nullable(),
  absences: z.array(z.tuple([timestampSchema, timestampSchema])),
});
type RetentionClock = { lastRunAt: number | null; absences: RetentionAbsence[] };

const readRetentionClock = (): RetentionClock | null => {
  try {
    const raw = getSafeStorage().getItem(RETENTION_CLOCK_KEY);
    if (!raw) return null;
    const parsed = retentionClockSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const writeRetentionClock = (clock: RetentionClock): void => {
  try {
    getSafeStorage().setItem(RETENTION_CLOCK_KEY, JSON.stringify(clock));
  } catch {
    return;
  }
};

const retentionCutoff = (now: number, cutoffDays: number, absences: readonly RetentionAbsence[]): number => {
  let cutoff = now - cutoffDays * DAY_MS;
  for (let index = absences.length - 1; index >= 0 && absences[index][1] >= cutoff; index -= 1) {
    cutoff -= absences[index][1] - absences[index][0];
  }
  return cutoff;
};

const normalizeAbsences = (spans: readonly RetentionAbsence[], cutoffDays: number, now: number): RetentionAbsence[] => {
  const sorted = spans.map(([from, to]): [number, number] => [from, Math.min(to, now)])
    .filter(([from, to]) => from < to)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push(span);
  }
  if (!Number.isFinite(cutoffDays) || cutoffDays < 1) return merged;
  const cutoff = retentionCutoff(now, cutoffDays, merged);
  return merged.filter(([, to]) => to >= cutoff);
};

export function lastRetentionRunAt(storedLastRunAt: number | null): number | null {
  const clock = readRetentionClock();
  return clock ? clock.lastRunAt : storedLastRunAt;
}

export function currentRetentionAbsences({ storedLastRunAt, cutoffDays, now }: {
  storedLastRunAt: number | null;
  cutoffDays: number;
  now: number;
}): RetentionAbsence[] {
  const clock = readRetentionClock();
  const lastRunAt = clock ? clock.lastRunAt : storedLastRunAt;
  const spans = [...clock?.absences ?? []];
  if (lastRunAt && Number.isFinite(lastRunAt) && now - lastRunAt > RETENTION_INTERVAL_MS) {
    spans.push([lastRunAt + RETENTION_INTERVAL_MS, now]);
  }
  return normalizeAbsences(spans, cutoffDays, now);
}

export function recordRetentionRun({ ranAt, absences, cutoffDays }: {
  ranAt: number;
  absences: readonly RetentionAbsence[];
  cutoffDays: number;
}): void {
  const clock = readRetentionClock();
  const lastRunAt = Math.max(ranAt, clock?.lastRunAt ?? 0);
  writeRetentionClock({
    lastRunAt,
    absences: normalizeAbsences([...clock?.absences ?? [], ...absences], cutoffDays, lastRunAt),
  });
}

export function resetRetentionClock(): void {
  writeRetentionClock({ lastRunAt: null, absences: [] });
}

const retentionTimestamp = (session: Session, onlyArchived: boolean): number => (
  onlyArchived ? session.time?.archived ?? 0 : session.time?.updated ?? session.time?.created ?? 0
);
const isArchived = (session: Session): boolean => Boolean(session.time?.archived);

const isOlderThanCutoff = (session: Session, cutoff: number, onlyArchived: boolean): boolean => {
  const timestamp = retentionTimestamp(session, onlyArchived);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp < cutoff;
};

export const inWorkKeepsSessions = (settings: { sessionWorkEnabled: boolean; sessionRetentionIncludeInWork: boolean }): boolean => (
  settings.sessionWorkEnabled && !settings.sessionRetentionIncludeInWork
);

export const isSessionKeptByUser = (
  session: Session,
  pinnedIds: Set<string> = useSessionPinnedStore.getState().ids,
  workKeeps: boolean = inWorkKeepsSessions(useUIStore.getState()),
): boolean => (
  (workKeeps && !isArchived(session) && isSessionInWork(session))
  || isSessionPinnedInMetadata(session) || isSessionPinned(pinnedIds, session.directory, session.id)
);

type CandidateOptions = {
  sessions: readonly Session[];
  currentSessionId: string | null;
  cutoffDays: number;
  action: SessionRetentionAction;
  onlyArchived?: boolean;
  activeSessionIds: ReadonlySet<string>;
  isKept?: (session: Session) => boolean;
  absences?: readonly RetentionAbsence[];
  now?: number;
};

export function buildSessionRetentionCandidates({
  sessions, currentSessionId, cutoffDays, action, onlyArchived = false, activeSessionIds, isKept, absences = [], now = Date.now(),
}: CandidateOptions): string[] {
  if (!Number.isFinite(cutoffDays) || cutoffDays < 1) return [];
  const cutoff = retentionCutoff(now, cutoffDays, absences);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const sorted = sessions.filter((session) => isArchived(session) === onlyArchived)
    .sort((a, b) => retentionTimestamp(b, onlyArchived) - retentionTimestamp(a, onlyArchived));
  const protectedIds = new Set(sorted.slice(0, RETENTION_KEEP_RECENT).map((session) => session.id));
  for (const session of sessions) {
    if (isArchived(session) !== onlyArchived || getBtwSessionID(session) || session.id === currentSessionId
      || activeSessionIds.has(session.id) || isKept?.(session) || !isOlderThanCutoff(session, cutoff, onlyArchived)) {
      protectedIds.add(session.id);
    }
  }
  if (action === 'delete' || onlyArchived) {
    for (const id of protectedIds) {
      const parentId = byId.get(id)?.parentID;
      if (parentId) protectedIds.add(parentId);
    }
  }
  const candidates = sorted.filter((session) => !protectedIds.has(session.id));
  if (action === 'archive' && !onlyArchived) return candidates.map((session) => session.id);

  const ids = new Set(candidates.map((session) => session.id));
  const childrenLeft = new Map<string, number>();
  for (const session of candidates) {
    if (session.parentID && ids.has(session.parentID)) {
      childrenLeft.set(session.parentID, (childrenLeft.get(session.parentID) ?? 0) + 1);
    }
  }
  const ordered = candidates.filter((session) => !childrenLeft.has(session.id)).map((session) => session.id);
  for (let index = 0; index < ordered.length; index += 1) {
    const parentId = byId.get(ordered[index])?.parentID;
    if (!parentId || !ids.has(parentId)) continue;
    const remaining = (childrenLeft.get(parentId) ?? 0) - 1;
    childrenLeft.set(parentId, remaining);
    if (remaining === 0) ordered.push(parentId);
  }
  return ordered;
}

type SessionRetentionResult = {
  completedIds: string[];
  failedIds: string[];
  action: SessionRetentionAction;
  skippedReason?: 'disabled' | 'loading' | 'cooldown' | 'no-history' | 'no-candidates' | 'running' | 'runtime-changed';
};

export const useSessionRetentionRunStore = create(() => ({ isRunning: false }));

export async function runSessionRetentionCleanup({ force = false } = {}): Promise<SessionRetentionResult> {
  const settings = useUIStore.getState();
  const onlyArchived = settings.sessionRetentionOnlyArchived;
  const action = onlyArchived ? 'delete' : settings.sessionRetentionAction;
  const result: SessionRetentionResult = { completedIds: [], failedIds: [], action };
  if (useSessionRetentionRunStore.getState().isRunning) return { ...result, skippedReason: 'running' };
  if (!Number.isFinite(settings.autoDeleteAfterDays) || settings.autoDeleteAfterDays < 1
    || (!force && !settings.autoDeleteEnabled)) return { ...result, skippedReason: 'disabled' };
  if (!force && useSessionUIStore.getState().isLoading) return { ...result, skippedReason: 'loading' };
  const now = Date.now();
  const lastRunAt = lastRetentionRunAt(settings.autoDeleteLastRunAt);
  if (!force && lastRunAt && now - lastRunAt < RETENTION_INTERVAL_MS) {
    return { ...result, skippedReason: 'cooldown' };
  }
  const hasHistory = readRetentionClock() !== null || (lastRunAt !== null && Number.isFinite(lastRunAt) && lastRunAt > 0);
  if (!force && !hasHistory) {
    recordRetentionRun({ ranAt: now, absences: [], cutoffDays: settings.autoDeleteAfterDays });
    settings.setAutoDeleteLastRunAt(now);
    return { ...result, skippedReason: 'no-history' };
  }
  const absences = settings.autoDeleteEnabled ? currentRetentionAbsences({
    storedLastRunAt: settings.autoDeleteLastRunAt, cutoffDays: settings.autoDeleteAfterDays, now,
  }) : [];
  const cutoff = retentionCutoff(now, settings.autoDeleteAfterDays, absences);

  const runtimeKey = getRuntimeKey();
  let runtimeChanged = false;
  const unsubscribe = subscribeRuntimeEndpointWillChange(() => { runtimeChanged = true; });
  const isCurrentRuntime = () => !runtimeChanged && getRuntimeKey() === runtimeKey;
  useSessionRetentionRunStore.setState({ isRunning: true });
  try {
    await useGlobalSessionsStore.getState().loadSessions();
    if (!isCurrentRuntime()) return { ...result, skippedReason: 'runtime-changed' };
    if (useGlobalSessionsStore.getState().status !== 'ready') {
      throw new Error('Session retention requires a complete session list');
    }
    const candidateIds = buildSessionRetentionCandidates({
      sessions: [...useGlobalSessionsStore.getState().entityById.values()],
      currentSessionId: useSessionUIStore.getState().currentSessionId,
      cutoffDays: settings.autoDeleteAfterDays,
      action,
      onlyArchived,
      activeSessionIds: useGlobalSessionStatusStore.getState().activeSessionIds,
      isKept: isSessionKeptByUser,
      absences,
      now,
    });
    if (candidateIds.length === 0) return { ...result, skippedReason: 'no-candidates' };

    const failedIds = new Set<string>();
    let archivedSnapshot: readonly Session[] | undefined;
    let archivedChildrenByParentId = new Map<string, string[]>();
    for (const [index, id] of candidateIds.entries()) {
      if (!isCurrentRuntime()) {
        result.failedIds.push(...candidateIds.slice(index));
        break;
      }
      const state = useGlobalSessionsStore.getState();
      const session = state.entityById.get(id);
      if (!session) continue;
      if (isArchived(session) !== onlyArchived || getBtwSessionID(session) || session.id === useSessionUIStore.getState().currentSessionId
        || useGlobalSessionStatusStore.getState().activeSessionIds.has(id) || isSessionKeptByUser(session)
        || !isOlderThanCutoff(session, cutoff, onlyArchived)) continue;
      if (action === 'delete') {
        if (archivedSnapshot !== state.archivedSessions) {
          archivedSnapshot = state.archivedSessions;
          archivedChildrenByParentId = new Map();
          for (const archived of archivedSnapshot) {
            if (!archived.parentID) continue;
            const children = archivedChildrenByParentId.get(archived.parentID);
            if (children) children.push(archived.id);
            else archivedChildrenByParentId.set(archived.parentID, [archived.id]);
          }
        }
        const children = [
          ...(state.structure.activeChildrenByParentId.get(id) ?? []),
          ...(archivedChildrenByParentId.get(id) ?? []),
        ];
        if (children.length > 0) {
          if (children.some((childId) => failedIds.has(childId))) {
            failedIds.add(id);
            result.failedIds.push(id);
          }
          continue;
        }
      }
      if (!resolveGlobalSessionDirectory(session)) {
        failedIds.add(id);
        result.failedIds.push(id);
        continue;
      }
      const completed = action === 'archive'
        ? await archiveSession(id, runtimeKey)
        : await deleteSession(id, { expectedRuntimeKey: runtimeKey });
      if (completed) result.completedIds.push(id);
      else {
        failedIds.add(id);
        result.failedIds.push(id);
      }
    }
    return result;
  } finally {
    if (isCurrentRuntime()) {
      const ranAt = Date.now();
      settings.setAutoDeleteLastRunAt(ranAt);
      if (settings.autoDeleteEnabled) recordRetentionRun({ ranAt, absences, cutoffDays: settings.autoDeleteAfterDays });
      else resetRetentionClock();
    }
    unsubscribe();
    useSessionRetentionRunStore.setState({ isRunning: false });
  }
}

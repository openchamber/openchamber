import type { Session } from '@/lib/opencode/model';
import { isBtwSession } from '@/lib/sessionBtwMetadata';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { EMPTY_SESSION_ORDER_RANKS, orderSessionsByLifecycleScopes, useSessionOrderingStore } from '@/sync/session-ordering';

export const orderVisibleRootSessions = (
  activeSessions: readonly Session[],
  pinnedIds: Set<string>,
  ranks: ReadonlyMap<string, number>,
): Session[] => orderSessionsByLifecycleScopes(
  activeSessions.filter((session) => !isBtwSession(session) && !session.parentID),
  pinnedIds,
  ranks,
);

export const readOrderedActiveSessions = (): Session[] => orderVisibleRootSessions(
  useGlobalSessionsStore.getState().activeSessions,
  useSessionPinnedStore.getState().ids,
  useSessionOrderingStore.getState().rankById ?? EMPTY_SESSION_ORDER_RANKS,
);

export const stepSession = (list: Session[], currentSessionId: string | null, direction: -1 | 1): Session | undefined => {
  if (list.length === 0) return undefined;
  const currentIndex = list.findIndex((session) => session.id === currentSessionId);
  let nextIndex = direction > 0 ? 0 : list.length - 1;
  if (currentIndex >= 0) {
    nextIndex = (currentIndex + direction + list.length) % list.length;
  }
  return list[nextIndex];
};

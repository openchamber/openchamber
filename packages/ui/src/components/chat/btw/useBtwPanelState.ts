import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { useSyncRuntime } from '@/sync/sync-context';
import { findLiveSession } from '@/sync/live-aggregate';
import { getBtwBoundaryMessageID, getBtwSessionID, wasPromotedBtwSession } from '@/lib/sessionBtwMetadata';
import { useBtwStore } from '@/stores/useBtwStore';

export type BtwPanelState = {
  parentPromoted: boolean;
  btwSessionId: string | null;
  btwDirectory: string | null;
  boundaryMessageID: string | null;
  collapsed: boolean;
  creating: boolean;
  pending: boolean;
};

export const btwHoldsDock = (panel: BtwPanelState, parentHasRequest: boolean): boolean => {
  const shown = Boolean((panel.btwSessionId && panel.btwDirectory) || panel.creating || panel.pending);
  return shown && !(panel.collapsed && parentHasRequest);
};

function useLiveSessionValue<T extends string | boolean | null>(
  sessionID: string | null | undefined,
  directory: string | undefined,
  read: (session: Session | undefined) => T,
): T {
  const { childStores } = useSyncRuntime();
  const getSnapshot = React.useCallback(() => {
    if (!sessionID) return read(undefined);
    if (directory) {
      const sessions = childStores.getChild(directory)?.getState().session;
      return read(sessions?.find((session) => session.id === sessionID));
    }
    const states = Array.from(childStores.children.values(), (store) => store.getState());
    return read(findLiveSession(states, sessionID));
  }, [childStores, directory, read, sessionID]);

  const subscribe = React.useCallback((notify: () => void) => {
    if (directory) {
      return childStores.ensureChild(directory, { bootstrap: false }).subscribe((state, previous) => {
        if (state.session !== previous.session) notify();
      });
    }
    return childStores.subscribeAllSelected((state) => state.session, notify);
  }, [childStores, directory]);

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const readBtwSessionID = (session: Session | undefined): string | null => getBtwSessionID(session);
const readPromoted = (session: Session | undefined): boolean => wasPromotedBtwSession(session);
const readExists = (session: Session | undefined): boolean => Boolean(session);
const readBoundaryMessageID = (session: Session | undefined): string | null => getBtwBoundaryMessageID(session);
// SAFETY: the SDK Session type omits the server's `directory` field; this
// widening only reads it, and a missing value falls back to the parent's.
const readServerDirectory = (session: Session | undefined): string | null =>
  (session as (Session & { directory?: string | null }) | undefined)?.directory ?? null;

export function useBtwPanelState(
  parentSessionId: string | null | undefined,
  directory: string | undefined,
): BtwPanelState {
  const linkedBtwSessionId = useLiveSessionValue(parentSessionId, directory, readBtwSessionID);
  const parentPromoted = useLiveSessionValue(parentSessionId, directory, readPromoted);
  const btwSessionExists = useLiveSessionValue(linkedBtwSessionId, directory, readExists);
  const btwServerDirectory = useLiveSessionValue(linkedBtwSessionId, directory, readServerDirectory);
  const btwBoundaryMessageID = useLiveSessionValue(linkedBtwSessionId, directory, readBoundaryMessageID);
  const uiState = useBtwStore(
    React.useCallback(
      (s) => (parentSessionId ? s.byParent[parentSessionId] : undefined),
      [parentSessionId],
    ),
  );

  const destroying = Boolean(uiState?.destroying);
  const collapsed = Boolean(uiState?.collapsed);
  const creating = Boolean(uiState?.creating);
  const pending = Boolean(uiState?.pending);
  const btwSessionId = btwSessionExists && !destroying ? linkedBtwSessionId : null;
  const btwDirectory = btwSessionId ? btwServerDirectory ?? directory ?? null : null;
  const boundaryMessageID = btwSessionId ? btwBoundaryMessageID : null;
  return React.useMemo(() => ({
    parentPromoted,
    btwSessionId,
    btwDirectory,
    boundaryMessageID,
    collapsed,
    creating,
    pending,
  }), [boundaryMessageID, btwDirectory, btwSessionId, collapsed, creating, parentPromoted, pending]);
}

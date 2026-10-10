import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { useSyncRuntime } from '@/sync/sync-context';
import { findLiveSession } from '@/sync/live-aggregate';
import { getBtwBoundaryMessageID, getBtwSessionID, wasPromotedBtwSession } from '@/lib/sessionBtwMetadata';
import { useBtwStore } from '@/stores/useBtwStore';

export type BtwPanelState = {
  /** The session the composer is in was promoted out of `/btw`. */
  parentPromoted: boolean;
  /** The active fork for this parent, or null when no panel should exist. */
  btwSessionId: string | null;
  /** The fork's directory identity (may be canonicalized by the server). */
  btwDirectory: string | null;
  /** Last message id inherited from the parent; the panel shows what's after it. */
  boundaryMessageID: string | null;
  collapsed: boolean;
  creating: boolean;
  pending: boolean;
};

/**
 * One value read from one live session, recomputed when the directory's
 * session list changes but published only when the value itself changes.
 *
 * The composer that owns this state must not re-render for every
 * `session.updated` of the session it sits in: during a turn that event
 * arrives with each status and timestamp change, and none of them moves a
 * btw link. `read` must return a primitive so equal values compare equal.
 */
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

/**
 * Derive the `/btw` panel identity for one parent session from authoritative
 * session metadata (`openchamber.btwSessionID`), plus the transient UI state
 * kept in `useBtwStore`. The panel exists only while the parent's link AND the
 * fork itself are present in the live stores, so a fork deleted anywhere
 * (sidebar, another client) makes the panel disappear without extra tracking.
 *
 * The returned object keeps its identity until one of its fields changes.
 */
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

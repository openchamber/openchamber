import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { useSession } from '@/sync/sync-context';
import { getBtwBoundaryMessageID, getBtwSessionID } from '@/lib/sessionBtwMetadata';
import { useBtwStore } from '@/stores/useBtwStore';

export type BtwPanelState = {
  /** The active fork for this parent, or null when no panel should exist. */
  btwSessionId: string | null;
  btwSession: Session | null;
  /** The fork's directory identity (may be canonicalized by the server). */
  btwDirectory: string | null;
  /** Last message id inherited from the parent; the panel shows what's after it. */
  boundaryMessageID: string | null;
  collapsed: boolean;
  creating: boolean;
};

/**
 * Derive the `/btw` panel identity for one parent session from authoritative
 * session metadata (`openchamber.btwSessionID`), plus the transient UI state
 * kept in `useBtwStore`. The panel exists only while the parent's link AND the
 * fork itself are present in the live stores, so a fork deleted anywhere
 * (sidebar, another client) makes the panel disappear without extra tracking.
 */
export function useBtwPanelState(
  parentSessionId: string | null | undefined,
  directory: string | undefined,
): BtwPanelState {
  const parentSession = useSession(parentSessionId, directory);
  const linkedBtwSessionId = getBtwSessionID(parentSession);
  const btwSession = useSession(linkedBtwSessionId, directory) ?? null;
  const uiState = useBtwStore(
    React.useCallback(
      (s) => (parentSessionId ? s.byParent[parentSessionId] : undefined),
      [parentSessionId],
    ),
  );

  const destroying = Boolean(uiState?.destroying);
  const btwSessionId = btwSession && !destroying ? linkedBtwSessionId : null;
  return {
    btwSessionId,
    btwSession: btwSessionId ? btwSession : null,
    // SAFETY: the SDK Session type omits the server's `directory` field; this
    // widening only reads it, with the parent's directory as the fallback.
    btwDirectory: btwSessionId
      ? ((btwSession as (Session & { directory?: string | null }) | null)?.directory ?? directory ?? null)
      : null,
    boundaryMessageID: btwSessionId ? getBtwBoundaryMessageID(btwSession) : null,
    collapsed: Boolean(uiState?.collapsed),
    creating: Boolean(uiState?.creating),
  };
}

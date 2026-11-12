import React from 'react';

import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useSessionBlockingRequests } from '@/sync/sync-context';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

export type PendingRequests = { hasPermission: boolean; hasForm: boolean };

// Stable snapshots: a fresh object per store read would re-render every row on
// every index write.
const NOTHING_PENDING = { hasPermission: false, hasForm: false } as const;
const PERMISSION_PENDING = { hasPermission: true, hasForm: false } as const;
const FORM_PENDING = { hasPermission: false, hasForm: true } as const;
const PERMISSION_AND_FORM_PENDING = { hasPermission: true, hasForm: true } as const;

/**
 * Whether a permission request or a form waits for a row. Where a session's
 * directory has bootstrapped, its store answers, so a request the
 * cross-directory index kept after a lost settlement stops showing; before
 * that, and for a session with no known directory, the index answers, so a
 * project the phone never opened still shows its waiting requests. `sessionIds`
 * is the row's own session plus any subsessions it hides: a subagent's request
 * blocks the whole family.
 */
export const usePendingRequests = (sessionIds: readonly string[]): PendingRequests => {
  // Where each session lives, as one serialized string: the subscription then
  // follows the resolved directories instead of the session map identity, so a
  // change to an unrelated session does not rebuild this row's scopes. JSON
  // keeps the encoding unambiguous for directories that contain a separator.
  const directorySignature = useGlobalSessionsStore(React.useCallback((state) => {
    const entries: [string, string][] = [];
    for (const sessionId of sessionIds) {
      const session = state.entityById.get(sessionId);
      entries.push([sessionId, session ? resolveGlobalSessionDirectory(session) ?? '' : '']);
    }
    return JSON.stringify(entries);
  }, [sessionIds]));
  const { scopes, unplacedSessionIds } = React.useMemo(() => {
    const sessionIDsByDirectory = new Map<string, string[]>();
    const unplaced: string[] = [];
    // SAFETY: `directorySignature` is only ever written by the selector above,
    // which serializes an array of `[sessionId, directory]` pairs.
    const entries = JSON.parse(directorySignature) as [string, string][];
    for (const [sessionId, directory] of entries) {
      if (!directory) {
        unplaced.push(sessionId);
        continue;
      }
      const sessionIDs = sessionIDsByDirectory.get(directory) ?? [];
      sessionIDs.push(sessionId);
      sessionIDsByDirectory.set(directory, sessionIDs);
    }
    return {
      scopes: [...sessionIDsByDirectory].map(([directory, sessionIDs]) => ({ directory, sessionIDs })),
      unplacedSessionIds: unplaced,
    };
  }, [directorySignature]);
  const scoped = useSessionBlockingRequests(scopes);
  const unplaced = useGlobalBlockingRequestsStore(React.useCallback((state) => {
    if (unplacedSessionIds.length === 0) return NOTHING_PENDING;
    let hasPermission = false;
    let hasForm = false;
    for (const sessionId of unplacedSessionIds) {
      const pending = state.bySession.get(sessionId);
      if (!pending) continue;
      hasPermission ||= pending.permissions.length > 0;
      // A page that waits for the user's answer counts as a form.
      hasForm ||= pending.forms.length > 0 || pending.pages.length > 0;
    }
    return hasPermission === true && hasForm === true
      ? PERMISSION_AND_FORM_PENDING
      : hasPermission ? PERMISSION_PENDING : hasForm ? FORM_PENDING : NOTHING_PENDING;
  }, [unplacedSessionIds]));
  return {
    hasPermission: scoped.hasPermission || unplaced.hasPermission,
    hasForm: scoped.hasForm || unplaced.hasForm,
  };
};

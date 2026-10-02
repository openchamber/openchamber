import React from 'react';
import type { LinearAPI } from '@/lib/api/types';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useLinearIssueStateStore } from '@/stores/useLinearIssueStateStore';

// The same cadence as GitHub's linked issues: every two minutes while the
// window is visible, and when the user comes back to it.
const INTERVAL_MS = 2 * 60_000;
const DUE_AGE_MS = INTERVAL_MS - 10_000;
const RETURN_MIN_AGE_MS = 15_000;

const isDocumentVisible = () => document.visibilityState === 'visible';

/**
 * Keeps the state of the Linear issues linked to the sessions on screen
 * current. Nothing is asked while none are shown, and only one auth check is
 * made before the first states request: a disconnected or absent Linear (VS
 * Code) asks nothing further.
 */
export function useLinearIssueStateSync(identifiers: readonly string[], linear: LinearAPI | undefined): void {
  const connected = useLinearAuthStore((state) => state.status?.connected === true);
  const identifiersRef = React.useRef(identifiers);
  const hasIdentifiers = identifiers.length > 0;

  // Whether Linear is connected is only worth knowing once there is a linked
  // issue to colour; the store asks once and caches the answer.
  React.useEffect(() => {
    if (linear && hasIdentifiers) void useLinearAuthStore.getState().refreshStatus(linear);
  }, [hasIdentifiers, linear]);

  const sync = React.useCallback((minAgeMs: number) => {
    if (!linear || !connected || identifiersRef.current.length === 0 || !isDocumentVisible()) return;
    void useLinearIssueStateStore.getState().sync(identifiersRef.current, linear, minAgeMs);
  }, [connected, linear]);

  // Newly shown issues are asked about right away; known ones wait their turn.
  React.useEffect(() => {
    identifiersRef.current = identifiers;
    sync(DUE_AGE_MS);
  }, [identifiers, sync]);

  React.useEffect(() => {
    if (!linear || !connected || !hasIdentifiers) return;
    const timer = window.setInterval(() => sync(DUE_AGE_MS), INTERVAL_MS);
    const onReturn = () => sync(RETURN_MIN_AGE_MS);
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [connected, hasIdentifiers, linear, sync]);
}

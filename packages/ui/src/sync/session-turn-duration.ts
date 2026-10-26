// What a session row shows as the length of a turn: the live count while it
// runs, then the length of the turn that finished.
//
// A finished turn has two sources. The server records the length on the
// session (`lib/sessionTurnMetadata.ts`), measured from the turn's real start,
// and the record outlives this page. This page's own measurement
// (`session-activity-timing.ts`) covers the moment before that record arrives
// and a server that could not write one. Kept apart from the timing store so
// that store does not depend on the global sessions list.

import { useCallback } from 'react';
import { getRecordedTurnDurationMs } from '@/lib/sessionTurnMetadata';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useHasSessionActivityDuration, useSessionSettledDurationMs } from './session-activity-timing';

const useRecordedTurnDurationMs = (sessionId: string): number | undefined => (
  useGlobalSessionsStore(useCallback((state) => getRecordedTurnDurationMs(state.entityById.get(sessionId)), [sessionId]))
);

/** How long the turn that just finished took; the server's record wins. */
export const useSessionFinishedTurnDurationMs = (sessionId: string): number | undefined => {
  const measured = useSessionSettledDurationMs(sessionId);
  return useRecordedTurnDurationMs(sessionId) ?? measured;
};

/**
 * Whether a duration exists to render, without subscribing the caller to the
 * value itself — a row uses this to decide between the counter and its normal
 * metadata, and must not re-render every tick to do so.
 */
export const useHasSessionTurnDuration = (sessionId: string, running: boolean): boolean => {
  const hasMeasured = useHasSessionActivityDuration(sessionId, running);
  const hasRecorded = useGlobalSessionsStore(useCallback((state) => (
    !running && getRecordedTurnDurationMs(state.entityById.get(sessionId)) !== undefined
  ), [running, sessionId]));
  return hasMeasured || hasRecorded;
};

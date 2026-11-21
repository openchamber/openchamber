
import { useCallback } from 'react';
import { getRecordedTurnDurationMs } from '@/lib/sessionTurnMetadata';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useHasSessionActivityDuration, useSessionSettledDurationMs } from './session-activity-timing';

const useRecordedTurnDurationMs = (sessionId: string): number | undefined => (
  useGlobalSessionsStore(useCallback((state) => getRecordedTurnDurationMs(state.entityById.get(sessionId)), [sessionId]))
);

export const useSessionFinishedTurnDurationMs = (sessionId: string): number | undefined => {
  const measured = useSessionSettledDurationMs(sessionId);
  return useRecordedTurnDurationMs(sessionId) ?? measured;
};

export const useHasSessionTurnDuration = (sessionId: string, running: boolean): boolean => {
  const hasMeasured = useHasSessionActivityDuration(sessionId, running);
  const hasRecorded = useGlobalSessionsStore(useCallback((state) => (
    !running && getRecordedTurnDurationMs(state.entityById.get(sessionId)) !== undefined
  ), [running, sessionId]));
  return hasMeasured || hasRecorded;
};

import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { useSessions } from '@/sync/sync-context';
import { useChatSessionSelection } from './chatColumnSession';

export const isRequestFromSubagent = (
  sessions: readonly Pick<Session, 'id' | 'parentID'>[],
  sourceSessionId: string,
  currentSessionId: string | null,
): boolean => {
  if (!currentSessionId || sourceSessionId === currentSessionId) return false;
  return Boolean(sessions.find((session) => session.id === sourceSessionId)?.parentID);
};

export const useIsRequestFromSubagent = (sourceSessionId: string): boolean => {
  const { sessionId: currentSessionId, directory: currentSessionDirectory } = useChatSessionSelection();
  const sessions = useSessions(currentSessionDirectory ?? undefined);
  return React.useMemo(
    () => isRequestFromSubagent(sessions, sourceSessionId, currentSessionId),
    [currentSessionId, sessions, sourceSessionId],
  );
};

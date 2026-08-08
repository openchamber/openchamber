import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionStatus, useSessionMessages, useSessionPermissions, useSessionQuestions } from '@/sync/sync-context';
import { deriveSessionActivity, type SessionActivityResult } from './sessionActivity';

/**
 * Determines if a session is actively working.
 * Checks session_status and clears stale busy state once the trailing assistant
 * message is complete, so delayed idle events do not keep the composer in
 * follow-up/stop mode.
 * Returns idle when permissions or questions are pending (the permission /
 * question indicator takes priority, and the send button must stay available so
 * the user can supersede the prompt with a new message).
 */
function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
  const status = useSessionStatus(sessionId ?? '', directory);
  const messages = useSessionMessages(sessionId ?? '', directory);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const questions = useSessionQuestions(sessionId ?? '', directory);

  return React.useMemo<SessionActivityResult>(() => deriveSessionActivity({
    sessionId,
    status,
    messages,
    permissions,
    questions,
  }), [sessionId, status, messages, permissions, questions]);
}

export function useCurrentSessionActivity(): SessionActivityResult {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  return useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);
}

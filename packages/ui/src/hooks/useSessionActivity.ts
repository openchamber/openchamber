import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionStatus, useSessionMessages, useSessionPermissions, useSessionQuestions } from '@/sync/sync-context';

// Mirrors OpenCode SessionStatus: busy|retry|idle.
type SessionActivityPhase = 'idle' | 'busy' | 'retry';

export interface SessionActivityResult {
  phase: SessionActivityPhase;
  isWorking: boolean;
  isBusy: boolean;
  isCooldown: boolean;
  /**
   * Whether Stop should be available. Unlike `phase`, this stays true while a
   * turn is busy even if a permission/question card is open (so abort remains
   * reachable for Claude harness turns bridged through canUseTool).
   */
  canAbort: boolean;
}

const IDLE_RESULT: SessionActivityResult = {
  phase: 'idle',
  isWorking: false,
  isBusy: false,
  isCooldown: false,
  canAbort: false,
};

/**
 * Determines if a session is actively working.
 * Checks session_status and, only when status is missing, falls back to the
 * trailing assistant message when its completion update has not landed yet.
 * Returns idle when permissions or questions are pending (the permission /
 * question indicator takes priority, and the send button must stay available so
 * the user can supersede the prompt with a new message).
 */
function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
  const status = useSessionStatus(sessionId ?? '', directory);
  const messages = useSessionMessages(sessionId ?? '', directory);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const questions = useSessionQuestions(sessionId ?? '', directory);

  return React.useMemo<SessionActivityResult>(() => {
    if (!sessionId) return IDLE_RESULT;

    const phase: SessionActivityPhase = (status?.type ?? 'idle') as SessionActivityPhase;

    // Only trust the trailing assistant message as a transient fallback while
    // waiting for session.status/message.updated to settle.
    const lastMessage = messages[messages.length - 1];
    const hasPendingAssistant = Boolean(
      lastMessage
      && lastMessage.role === 'assistant'
      && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== 'number',
    );

    const hasAuthoritativeStatus = status !== undefined;
    const statusWorking = hasAuthoritativeStatus && phase !== 'idle';
    const canAbort = statusWorking || (!hasAuthoritativeStatus && hasPendingAssistant);

    // Permissions or questions pending → idle for send UX (the blocking
    // indicator takes priority and the send button must remain a send), but
    // keep canAbort when the turn is still authoritatively busy.
    if (permissions.length > 0 || questions.length > 0) {
      return {
        ...IDLE_RESULT,
        canAbort,
      };
    }

    const isWorking = statusWorking || hasPendingAssistant;

    if (hasAuthoritativeStatus && !statusWorking) return IDLE_RESULT;

    if (!isWorking) return IDLE_RESULT;

    return {
      phase: statusWorking ? phase : 'busy',
      isWorking: true,
      isBusy: phase === 'busy' || (!statusWorking && hasPendingAssistant),
      isCooldown: false,
      canAbort: true,
    };
  }, [sessionId, status, messages, permissions, questions]);
}

export function useCurrentSessionActivity(): SessionActivityResult {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  return useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);
}

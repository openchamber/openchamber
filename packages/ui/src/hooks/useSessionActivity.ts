import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionStatus, useSessionMessages, useSessionPermissions } from '@/sync/sync-context';

// Mirrors OpenCode SessionStatus: busy|retry|idle.
export type SessionActivityPhase = 'idle' | 'busy' | 'retry';

export interface SessionActivityResult {
  phase: SessionActivityPhase;
  isWorking: boolean;
  isBusy: boolean;
  isCooldown: boolean;
}

const IDLE_RESULT: SessionActivityResult = {
  phase: 'idle',
  isWorking: false,
  isBusy: false,
  isCooldown: false,
};

/**
 * Determines if a session is actively working.
 * Checks session_status and, only when status is missing, falls back to the
 * trailing assistant message when its completion update has not landed yet.
 * Returns idle when permissions are pending (permission indicator takes priority).
 */
export function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
  const status = useSessionStatus(sessionId ?? '', directory);
  const messages = useSessionMessages(sessionId ?? '', directory);
  const permissions = useSessionPermissions(sessionId ?? '', directory);

  return React.useMemo<SessionActivityResult>(() => {
    if (!sessionId) return IDLE_RESULT;

    // Permissions pending → idle (permission indicator takes priority)
    if (permissions.length > 0) return IDLE_RESULT;

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
    const isWorking = statusWorking || hasPendingAssistant;

    if (hasAuthoritativeStatus && !statusWorking) return IDLE_RESULT;

    if (!isWorking) return IDLE_RESULT;

    return {
      phase: statusWorking ? phase : 'busy',
      isWorking: true,
      isBusy: phase === 'busy' || (!statusWorking && hasPendingAssistant),
      isCooldown: false,
    };
  }, [sessionId, status, messages, permissions]);
}

export function useCurrentSessionActivity(): SessionActivityResult {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  return useSessionActivity(currentSessionId);
}

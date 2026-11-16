import React from 'react';
import { getLastConversationMessage, isIncompleteAssistantTurn, type Message } from '@/lib/opencode/model';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { formTurnHold, useRecoverableQuestionsStore } from '@/sync/recoverable-questions';
import { readUnloadedFormToolLinks } from '@/sync/session-actions';
import { useDirectorySync, useSessionStatus, useSessionStatusSnapshotReady, useSessionMessagesSelector, useSessionPermissions } from '@/sync/sync-context';

// Mirrors OpenCode SessionStatus: busy|retry|idle.
type SessionActivityPhase = 'idle' | 'busy' | 'retry';

export interface SessionActivityResult {
  phase: SessionActivityPhase;
  isWorking: boolean;
  isBusy: boolean;
  isCooldown: boolean;
}

// Only the trailing turn matters, so the subscription re-renders the caller
// when that flag flips rather than on every streamed message update.
// Plumbing roles are transparent here: a synthetic or switch message landing
// after the streaming assistant must not read as the turn ending.
const selectHasPendingAssistant = (messages: Message[]): boolean => (
  isIncompleteAssistantTurn(getLastConversationMessage(messages))
);

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
 * Returns idle when a permission or a form that holds the turn is pending (the
 * permission / form indicator takes priority, and the send button must stay
 * available so the user can supersede the prompt with a new message). A form
 * whose tool call has ended holds nothing, so a running turn keeps Stop and
 * Queue (#5391).
 */
export function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
  const status = useSessionStatus(sessionId ?? '', directory);
  const statusSnapshotReady = useSessionStatusSnapshotReady(directory, sessionId ?? '');
  const hasPendingAssistant = useSessionMessagesSelector(sessionId ?? '', directory, selectHasPendingAssistant);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const releasedForms = useRecoverableQuestionsStore((state) => state.releasedForms);
  const formHoldsTurn = useDirectorySync(React.useCallback((state) => (
    state.form[sessionId ?? '']?.some((form) => formTurnHold(form, state.part, releasedForms) !== 'released') ?? false
  ), [sessionId, releasedForms]), directory);
  // Forms linked into history not loaded here: read them now, so the phase is right before the user sends.
  const unloadedForms = useDirectorySync(React.useCallback((state) => (
    (state.form[sessionId ?? ''] ?? [])
      .filter((form) => formTurnHold(form, state.part, releasedForms) === 'unknown')
      .map((form) => form.id)
      .join('\n')
  ), [sessionId, releasedForms]), directory);
  // A refresh of the forms (reconnect, materialization) is a new array: a read that failed is retried then, not in a loop.
  const sessionForms = useDirectorySync(React.useCallback((state) => state.form[sessionId ?? ''], [sessionId]), directory);
  React.useEffect(() => {
    if (sessionId && unloadedForms) readUnloadedFormToolLinks(sessionId);
  }, [sessionId, unloadedForms, sessionForms]);

  return React.useMemo<SessionActivityResult>(() => {
    if (!sessionId) return IDLE_RESULT;

    // A pending permission or turn-holding form → idle (the blocking indicator
    // takes priority and the send button must remain a send, not a stop).
    if (permissions.length > 0 || formHoldsTurn) return IDLE_RESULT;

    const phase: SessionActivityPhase = (status?.type ?? 'idle') as SessionActivityPhase;

    // Only trust the trailing assistant message as a transient fallback while
    // waiting for session.status/message.updated to settle. OpenCode lists
    // only running sessions, so once the directory's status snapshot has landed
    // an omitted status is idle: a turn OpenCode was stopped under (the app
    // restarted) keeps its assistant message incomplete for good.
    const hasAuthoritativeStatus = status !== undefined || statusSnapshotReady;
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
  }, [sessionId, status, statusSnapshotReady, hasPendingAssistant, permissions, formHoldsTurn]);
}

export function useCurrentSessionActivity(): SessionActivityResult {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  return useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);
}

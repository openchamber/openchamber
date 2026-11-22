import React from 'react';
import { getLastConversationMessage, isIncompleteAssistantTurn, type Message } from '@/lib/opencode/model';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { formTurnHold, useRecoverableQuestionsStore } from '@/sync/recoverable-questions';
import { readUnloadedFormToolLinks } from '@/sync/session-actions';
import { useDirectorySync, useSessionStatus, useSessionStatusSnapshotReady, useSessionMessagesSelector, useSessionPermissions } from '@/sync/sync-context';

type SessionActivityPhase = 'idle' | 'busy' | 'retry';

export interface SessionActivityResult {
  phase: SessionActivityPhase;
  isWorking: boolean;
  isBusy: boolean;
  isCooldown: boolean;
}

const selectHasPendingAssistant = (messages: Message[]): boolean => (
  isIncompleteAssistantTurn(getLastConversationMessage(messages))
);

const IDLE_RESULT: SessionActivityResult = {
  phase: 'idle',
  isWorking: false,
  isBusy: false,
  isCooldown: false,
};

export function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
  const status = useSessionStatus(sessionId ?? '', directory);
  const statusSnapshotReady = useSessionStatusSnapshotReady(directory, sessionId ?? '');
  const hasPendingAssistant = useSessionMessagesSelector(sessionId ?? '', directory, selectHasPendingAssistant);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const releasedForms = useRecoverableQuestionsStore((state) => state.releasedForms);
  const formHoldsTurn = useDirectorySync(React.useCallback((state) => (
    state.form[sessionId ?? '']?.some((form) => formTurnHold(form, state.part, releasedForms) !== 'released') ?? false
  ), [sessionId, releasedForms]), directory);
  const unloadedForms = useDirectorySync(React.useCallback((state) => (
    (state.form[sessionId ?? ''] ?? [])
      .filter((form) => formTurnHold(form, state.part, releasedForms) === 'unknown')
      .map((form) => form.id)
      .join('\n')
  ), [sessionId, releasedForms]), directory);
  const sessionForms = useDirectorySync(React.useCallback((state) => state.form[sessionId ?? ''], [sessionId]), directory);
  React.useEffect(() => {
    if (sessionId && unloadedForms) readUnloadedFormToolLinks(sessionId);
  }, [sessionId, unloadedForms, sessionForms]);

  return React.useMemo<SessionActivityResult>(() => {
    if (!sessionId) return IDLE_RESULT;

    if (permissions.length > 0 || formHoldsTurn) return IDLE_RESULT;

    const phase: SessionActivityPhase = (status?.type ?? 'idle') as SessionActivityPhase;

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

import { useMemo, useReducer } from 'react';
import type { FormRequest, Part } from '@/lib/opencode/model';
import { projectQuestionForm } from '@/lib/opencode/projection';
import { useSessionMessages, useSessionPartsForMessages, useSessionStatus, useSessionSelector, useSessionStatusSnapshotReady } from '@/sync/sync-context';
import { getRestartCutTurn, type RestartCutTurn } from '@/lib/sessionRestartInterruption';
import { getPendingQuestion, type PendingQuestion } from './pendingQuestion';
import { collectOrphanedQuestionRequests, findLastContentMessageIndex, inactivityInterruptionAt } from './orphanedQuestions';

const NO_PARTS: Part[] = [];

const samePendingQuestion = (left: PendingQuestion | null, right: PendingQuestion | null) => (
  left === right || (left !== null && right !== null && left.callID === right.callID && left.at === right.at)
);

const sameRestartCutTurn = (left: RestartCutTurn | null, right: RestartCutTurn | null) => (
  left === right || (left !== null && right !== null && left.messageID === right.messageID && left.at === right.at && left.callID === right.callID)
);

export function useOrphanedQuestions(sessionId: string | null, directory: string | undefined, forms: FormRequest[]) {
  const messages = useSessionMessages(sessionId ?? '', directory);
  const lastMessage = messages[findLastContentMessageIndex(messages)];
  const lastMessageId = lastMessage?.id;
  const lastMessageIds = useMemo(() => (lastMessageId ? [lastMessageId] : []), [lastMessageId]);
  const parts = useSessionPartsForMessages(lastMessageIds, directory)[lastMessageId ?? ''] ?? NO_PARTS;
  const status = useSessionStatus(sessionId ?? '', directory);
  const statusReady = useSessionStatusSnapshotReady(directory, sessionId ?? undefined);
  const inactivityAt = useSessionSelector(sessionId, directory, inactivityInterruptionAt);
  const restartCut = useSessionSelector(sessionId, directory, getRestartCutTurn, sameRestartCutTurn);
  const pending = useSessionSelector(sessionId, directory, getPendingQuestion, samePendingQuestion);
  const interruptions = useMemo(() => ({ inactivityAt, restartCut, pending }), [inactivityAt, restartCut, pending]);
  const [revision, refresh] = useReducer((value: number) => value + 1, 0);
  // Dismissals live in localStorage; refresh must read them even when sync inputs are unchanged.
  const questions = useMemo(() => {
    if (!sessionId || !lastMessage || !statusReady || (status && status.type !== 'idle')) return [];
    const live = forms.map(projectQuestionForm).filter((form) => form !== null);
    return collectOrphanedQuestionRequests(sessionId, [{ info: lastMessage, parts }], live, interruptions);
  }, [sessionId, lastMessage, statusReady, status, forms, parts, interruptions, revision]);
  return { questions, refresh };
}

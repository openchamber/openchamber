import type { Message, SessionStatus } from '@opencode-ai/sdk/v2/client';

import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';

type SessionActivityPhase = 'idle' | 'busy' | 'retry';

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

type SessionMessage = Pick<Message, 'role' | 'time'>;

type SessionActivityInput = {
  sessionId: string | null | undefined;
  status: SessionStatus | undefined;
  messages: readonly SessionMessage[];
  permissions: readonly PermissionRequest[];
  questions: readonly QuestionRequest[];
};

export function deriveSessionActivity({
  sessionId,
  status,
  messages,
  permissions,
  questions,
}: SessionActivityInput): SessionActivityResult {
  if (!sessionId) return IDLE_RESULT;

  if (permissions.length > 0 || questions.length > 0) return IDLE_RESULT;

  const phase = status?.type ?? 'idle';

  const lastMessage = messages[messages.length - 1];
  const hasCompletedAssistantTurn = Boolean(
    lastMessage
    && lastMessage.role === 'assistant'
    && typeof lastMessage.time?.completed === 'number',
  );

  if (status && phase !== 'idle' && hasCompletedAssistantTurn) {
    return IDLE_RESULT;
  }

  const hasPendingAssistant = Boolean(
    lastMessage
    && lastMessage.role === 'assistant'
    && typeof lastMessage.time?.completed !== 'number',
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
}

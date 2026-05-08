import type { Message } from '@opencode-ai/sdk/v2/client';

type SessionStatusType = 'idle' | 'busy' | 'retry' | undefined;

type ComputeSessionIsWorkingInput = {
  sessionId: string | null;
  hasBlockingRequests: boolean;
  streamingMessageId?: string | null;
  activeStreamingPhase?: string | null;
  statusType: SessionStatusType;
  hasLiveStatus: boolean;
  lastMessage?: Message;
};

export function computeSessionIsWorking(input: ComputeSessionIsWorkingInput): boolean {
  if (!input.sessionId || input.hasBlockingRequests) {
    return false;
  }

  if (input.streamingMessageId || input.activeStreamingPhase) {
    return true;
  }

  if (input.statusType === 'busy' || input.statusType === 'retry') {
    return true;
  }

  // Do not infer active work from historical incomplete assistant messages
  // when there is no live status signal for this session.
  if (!input.hasLiveStatus) {
    return false;
  }

  const lastMessage = input.lastMessage;
  return Boolean(
    lastMessage
      && lastMessage.role === 'assistant'
      && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== 'number',
  );
}

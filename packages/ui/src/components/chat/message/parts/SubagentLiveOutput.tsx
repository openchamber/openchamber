import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import type { MessageRecord } from '@/lib/messageCompletion';
import type { SessionActivityResult } from '@/hooks/useSessionActivity';
import AssistantTextPart from './AssistantTextPart';
import type { StreamPhase } from '../types';

type SubagentLiveOutputProps = {
  messages: MessageRecord[] | undefined;
  activity: SessionActivityResult | undefined;
  sessionId: string;
};

const isTextPart = (part: Part): boolean => part?.type === 'text' || part?.type === 'reasoning';

export const SubagentLiveOutput: React.FC<SubagentLiveOutputProps> = ({
  messages,
  activity,
  sessionId,
}) => {
  const latestAssistantMessage = React.useMemo(() => {
    if (!Array.isArray(messages) || messages.length === 0) {
      return null;
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.info?.role !== 'assistant') {
        continue;
      }
      const parts = Array.isArray(message.parts) ? message.parts : [];
      if (parts.some(isTextPart)) {
        return { message, parts };
      }
    }
    return null;
  }, [messages]);

  const streamPhase = React.useMemo<StreamPhase>(() => {
    if (activity?.phase === 'busy') return 'streaming';
    if (activity?.phase === 'retry') return 'cooldown';
    return 'completed';
  }, [activity?.phase]);

  if (!latestAssistantMessage) {
    return null;
  }

  const { message, parts } = latestAssistantMessage;
  const messageId = typeof message.info?.id === 'string' ? message.info.id : sessionId;

  const textParts = parts.filter(isTextPart);
  if (textParts.length === 0) {
    return null;
  }

  return (
    <div className="w-full min-w-0 space-y-1">
      {textParts.map((part, idx) => (
        <AssistantTextPart
          key={part.id ?? `${messageId}-text-${idx}`}
          part={part}
          messageId={messageId}
          streamPhase={streamPhase}
          chatRenderMode="live"
          sessionId={sessionId}
        />
      ))}
    </div>
  );
};

SubagentLiveOutput.displayName = 'SubagentLiveOutput';

import React from 'react';

import type { Message } from '@/lib/opencode/model';
import { LEAD_ANSWER_METADATA_KEY, leadReplySchema } from '@/lib/sessionLead';
import { useSessionMessagesSelector } from '@/sync/sync-context';

export type LeadReplies = { answers: ReadonlyMap<string, string>; suggestions: ReadonlyMap<string, boolean> };

const EMPTY: LeadReplies = { answers: new Map(), suggestions: new Map() };

const sameMap = <V>(left: ReadonlyMap<string, V>, right: ReadonlyMap<string, V>) => (
  left === right || (left.size === right.size && [...left].every(([key, value]) => right.get(key) === value))
);

const sameReplies = (left: LeadReplies, right: LeadReplies) => (
  left === right || (sameMap(left.answers, right.answers) && sameMap(left.suggestions, right.suggestions))
);

export function useLeadReplies(sessionId: string, directory: string | undefined, since: number): LeadReplies {
  const select = React.useCallback((messages: Message[]): LeadReplies => {
    let replies: { answers: Map<string, string>; suggestions: Map<string, boolean> } | null = null;
    for (const message of messages) {
      if (message.role !== 'synthetic' || message.time.created < since) continue;
      const reply = leadReplySchema.safeParse(message.metadata?.[LEAD_ANSWER_METADATA_KEY]);
      if (!reply.success) continue;
      replies ??= { answers: new Map(), suggestions: new Map() };
      for (const { question, answer } of reply.data.answers) replies.answers.set(question, answer);
      for (const { item, accepted } of reply.data.suggestions) replies.suggestions.set(item, accepted);
    }
    return replies ?? EMPTY;
  }, [since]);
  return useSessionMessagesSelector(sessionId, directory, select, sameReplies);
}

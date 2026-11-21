import React from 'react';

import type { Message } from '@/lib/opencode/model';
import { LEAD_ANSWER_METADATA_KEY, leadAnswerSchema } from '@/lib/sessionLead';
import { useSessionMessagesSelector } from '@/sync/sync-context';

type Answers = ReadonlyMap<string, string>;

const EMPTY: Answers = new Map();

const sameAnswers = (left: Answers, right: Answers) => (
  left === right || (left.size === right.size && [...left].every(([question, answer]) => right.get(question) === answer))
);

export function useLeadAnswers(sessionId: string, directory: string | undefined, since: number): Answers {
  const select = React.useCallback((messages: Message[]): Answers => {
    let answers: Map<string, string> | null = null;
    for (const message of messages) {
      if (message.role !== 'synthetic' || message.time.created < since) continue;
      const answer = leadAnswerSchema.safeParse(message.metadata?.[LEAD_ANSWER_METADATA_KEY]);
      if (!answer.success) continue;
      answers ??= new Map();
      answers.set(answer.data.question, answer.data.answer);
    }
    return answers ?? EMPTY;
  }, [since]);
  return useSessionMessagesSelector(sessionId, directory, select, sameAnswers);
}

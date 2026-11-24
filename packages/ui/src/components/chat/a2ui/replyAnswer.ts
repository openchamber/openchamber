import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { ascendingId } from '@/lib/opencode/ids';
import type { Message } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { commitStagedRevert } from '@/sync/session-actions';
import { useSessionMessagesSelector } from '@/sync/sync-context';
import {
  A2UI_ANSWER_METADATA_KEY,
  a2uiAnswerRecordSchema,
  stableReplyInputId,
  type A2uiAnswerData,
} from './answer';

type ReplyBlock = { sessionId: string; directory: string; messageId: string; block: string };

const inputIds = new Map<string, string>();
const sessionStore = (): Storage | undefined => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};

const inputIdFor = (runtimeKey: string, target: ReplyBlock): string =>
  stableReplyInputId(
    `a2ui:${JSON.stringify([runtimeKey, target.directory, target.sessionId, target.messageId, target.block])}`,
    sessionStore(),
    inputIds,
    () => ascendingId('msg'),
  );

export async function sendA2uiReplyAnswer(target: ReplyBlock, answer: A2uiAnswerData, text: string): Promise<void> {
  const runtimeKey = getRuntimeKey();
  await commitStagedRevert(target.sessionId, target.directory);
  await opencodeClient.resumeWithSyntheticInput({
    runtimeKey,
    id: inputIdFor(runtimeKey, target),
    sessionId: target.sessionId,
    directory: target.directory,
    text,
    metadata: { [A2UI_ANSWER_METADATA_KEY]: { messageId: target.messageId, block: target.block, answer } },
  });
}

const findAnswer = (messages: Message[], target: ReplyBlock): A2uiAnswerData | null => {
  for (const message of messages) {
    if (message.role !== 'synthetic') continue;
    const record = a2uiAnswerRecordSchema.safeParse(message.metadata?.[A2UI_ANSWER_METADATA_KEY]);
    if (record.success && record.data.messageId === target.messageId && record.data.block === target.block) {
      return record.data.answer;
    }
  }
  return null;
};

const sameAnswer = (left: A2uiAnswerData | null, right: A2uiAnswerData | null) =>
  left === right || (left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right));

export function useA2uiReplyAnswer(target: ReplyBlock | null): A2uiAnswerData | null {
  const select = React.useCallback(
    (messages: Message[]) => (target ? findAnswer(messages, target) : null),
    [target],
  );
  return useSessionMessagesSelector(target?.sessionId ?? '', target?.directory, select, sameAnswer);
}

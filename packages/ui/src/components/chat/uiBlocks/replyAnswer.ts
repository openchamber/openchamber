import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { ascendingId } from '@/lib/opencode/ids';
import type { Message } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { commitStagedRevert } from '@/sync/session-actions';
import { useSessionMessagesSelector } from '@/sync/sync-context';
import { UI_BLOCK_ANSWER_METADATA_KEY, uiBlockAnswerRecord, type UiBlockReplyAnswerData } from './answer';

type ReplyBlock = { sessionId: string; directory: string; messageId: string; block: string };

// external: https://github.com/anomalyco/opencode Reusing the input ID after a lost response lets OpenCode reject a duplicate answer.
const inputIds = new Map<string, string>();
const inputIdFor = (target: ReplyBlock): string => {
  const key = `${target.sessionId}\u0000${target.messageId}\u0000${target.block}`;
  const known = inputIds.get(key);
  if (known) return known;
  const id = ascendingId('msg');
  inputIds.set(key, id);
  return id;
};

export async function sendUiBlockReplyAnswer(target: ReplyBlock, answer: UiBlockReplyAnswerData, text: string): Promise<void> {
  const runtimeKey = getRuntimeKey();
  await commitStagedRevert(target.sessionId, target.directory);
  await opencodeClient.resumeWithSyntheticInput({
    runtimeKey,
    id: inputIdFor(target),
    sessionId: target.sessionId,
    directory: target.directory,
    text,
    metadata: { [UI_BLOCK_ANSWER_METADATA_KEY]: { messageId: target.messageId, block: target.block, answer } },
  });
}

const findAnswer = (messages: Message[], target: ReplyBlock): UiBlockReplyAnswerData | null => {
  for (const message of messages) {
    if (message.role !== 'synthetic') continue;
    const record = uiBlockAnswerRecord.safeParse(message.metadata?.[UI_BLOCK_ANSWER_METADATA_KEY]);
    if (record.success && record.data.messageId === target.messageId && record.data.block === target.block) return record.data.answer;
  }
  return null;
};

const sameAnswer = (left: UiBlockReplyAnswerData | null, right: UiBlockReplyAnswerData | null) => (
  left === right || (left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right))
);

export function useUiBlockReplyAnswer(target: ReplyBlock | null): UiBlockReplyAnswerData | null {
  const select = React.useCallback(
    (messages: Message[]) => (target ? findAnswer(messages, target) : null),
    [target],
  );
  return useSessionMessagesSelector(target?.sessionId ?? '', target?.directory, select, sameAnswer);
}

import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { ascendingId } from '@/lib/opencode/ids';
import type { Message } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { commitStagedRevert } from '@/sync/session-actions';
import { useSessionMessagesSelector } from '@/sync/sync-context';
import { stableReplyInputId, UI_BLOCK_ANSWER_METADATA_KEY, uiBlockAnswerRecord, type UiBlockReplyAnswerData } from './answer';

type ReplyBlock = { sessionId: string; directory: string; messageId: string; block: string };

// external: https://github.com/anomalyco/opencode Reusing the input ID after a lost response lets OpenCode admit the answer once.
// The ID is kept in session storage so a retry after a reload reuses it too.
const inputIds = new Map<string, string>();
const sessionStore = (): Storage | undefined => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};
const inputIdFor = (runtimeKey: string, target: ReplyBlock): string => stableReplyInputId(
  JSON.stringify([runtimeKey, target.directory, target.sessionId, target.messageId, target.block]),
  sessionStore(),
  inputIds,
  () => ascendingId('msg'),
);

export async function sendUiBlockReplyAnswer(target: ReplyBlock, answer: UiBlockReplyAnswerData, text: string): Promise<void> {
  const runtimeKey = getRuntimeKey();
  await commitStagedRevert(target.sessionId, target.directory);
  await opencodeClient.resumeWithSyntheticInput({
    runtimeKey,
    id: inputIdFor(runtimeKey, target),
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

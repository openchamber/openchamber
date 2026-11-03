import React from 'react';
import { uiBlockKey } from './answer';
import { sendUiBlockReplyAnswer, useUiBlockReplyAnswer } from './replyAnswer';
import { UiBlock, type UiBlockHost } from './UiBlock';

/**
 * A block of an assistant reply with its answer: once the reply has finished,
 * the choices made in it go to the agent in one piece (`replyAnswer.ts`), and
 * the block shows them again after a reload. Loaded on demand with the first
 * block, so the Markdown renderer does not carry the session sync it reads.
 */
export function ReplyUiBlock({ code, complete, reply, directory }: {
  code: string;
  complete: boolean;
  /** The settled reply the block belongs to; null while it streams or outside a reply. */
  reply: { sessionId: string; messageId: string } | null;
  directory: string;
}) {
  const target = React.useMemo(() => (reply && directory
    ? { sessionId: reply.sessionId, messageId: reply.messageId, directory, block: uiBlockKey(code) }
    : null), [reply, directory, code]);
  const answered = useUiBlockReplyAnswer(target);
  const host = React.useMemo<UiBlockHost>(() => ({
    kind: 'reply',
    answered,
    submit: target && !answered ? (answer, text) => sendUiBlockReplyAnswer(target, answer, text) : null,
  }), [target, answered]);
  return <UiBlock source={code} complete={complete} host={host} />;
}

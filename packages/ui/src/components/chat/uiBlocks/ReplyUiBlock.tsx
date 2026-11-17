import React from 'react';
import { uiBlockKey } from './answer';
import { sendUiBlockReplyAnswer, useUiBlockReplyAnswer } from './replyAnswer';
import { UiBlock, type UiBlockHost } from './UiBlock';

export function ReplyUiBlock({ code, complete, reply, directory }: {
  code: string;
  complete: boolean;
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

import React from 'react';
import type { CustomRendererProps } from 'streamdown';
import { uiBlockKey } from '../uiBlocks/answer';
import { sendUiBlockReplyAnswer, useUiBlockReplyAnswer } from '../uiBlocks/replyAnswer';
import type { UiBlockHost } from '../uiBlocks/UiBlock';
import { useUiBlockComponent } from '../uiBlocks/useUiBlockComponent';
import { useMarkdownPresentation } from './MarkdownPresentationContext';

/**
 * `openui-lang` fences of an assistant reply; the catalog loads with the
 * first one. Once the reply has finished, the choices made in a block go to
 * the agent in one piece (`replyAnswer.ts`), and the block shows them again
 * after a reload.
 */
export function MarkdownUiBlock({ code, isIncomplete }: CustomRendererProps) {
  const { uiBlockReply, directory } = useMarkdownPresentation();
  const UiBlock = useUiBlockComponent();
  const target = React.useMemo(() => (uiBlockReply && directory
    ? { sessionId: uiBlockReply.sessionId, messageId: uiBlockReply.messageId, directory, block: uiBlockKey(code) }
    : null), [uiBlockReply, directory, code]);
  const answered = useUiBlockReplyAnswer(target);
  const host = React.useMemo<UiBlockHost>(() => ({
    kind: 'reply',
    answered,
    submit: target && !answered ? (answer, text) => sendUiBlockReplyAnswer(target, answer, text) : null,
  }), [target, answered]);
  if (!UiBlock) return <pre dir="ltr"><code>{code}</code></pre>;
  return <UiBlock source={code} complete={!isIncomplete} host={host} />;
}

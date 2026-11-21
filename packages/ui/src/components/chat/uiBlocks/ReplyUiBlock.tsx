import React from 'react';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { uiBlockKey, uiBlockReplyDraft, type UiBlockReplyDraft } from './answer';
import { sendUiBlockReplyAnswer, useUiBlockReplyAnswer } from './replyAnswer';
import { UiBlock, type UiBlockHost } from './UiBlock';

function loadDraft(key: string): UiBlockReplyDraft | undefined {
  try {
    const raw = sessionStorage.getItem(key);
    return raw === null ? undefined : uiBlockReplyDraft.safeParse(JSON.parse(raw)).data;
  } catch {
    return undefined;
  }
}

function saveDraft(key: string, draft: UiBlockReplyDraft | null) {
  try {
    if (draft) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
  } catch {
    return;
  }
}

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
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const draftKey = target && complete
    ? `oc.ui-block.reply-draft.v1:${JSON.stringify([runtimeKey, target.directory, target.sessionId, target.messageId, target.block])}`
    : undefined;
  const draft = React.useMemo(() => draftKey ? {
    load: () => loadDraft(draftKey),
    save: (value: UiBlockReplyDraft | null) => saveDraft(draftKey, value),
  } : undefined, [draftKey]);
  const host = React.useMemo<UiBlockHost>(() => ({
    kind: 'reply',
    answered,
    submit: target && !answered ? (answer, text) => sendUiBlockReplyAnswer(target, answer, text) : null,
  }), [target, answered]);
  return <UiBlock key={draftKey} source={code} complete={complete} host={host} draft={draft} />;
}

import React from 'react';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { a2uiBlockKey, a2uiReplyDraftSchema, type A2uiReplyDraft } from './answer';
import { sendA2uiReplyAnswer, useA2uiReplyAnswer } from './replyAnswer';
import { A2uiSurface, type A2uiHost } from './A2uiSurface';

function loadDraft(key: string): A2uiReplyDraft | undefined {
  try {
    const raw = sessionStorage.getItem(key);
    return raw === null ? undefined : a2uiReplyDraftSchema.safeParse(JSON.parse(raw)).data;
  } catch {
    return undefined;
  }
}

function saveDraft(key: string, draft: A2uiReplyDraft | null) {
  try {
    if (draft) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
  } catch {
    return;
  }
}

export function ReplyA2uiBlock({
  code,
  complete,
  reply,
  directory,
}: {
  code: string;
  complete: boolean;
  reply: { sessionId: string; messageId: string } | null;
  directory: string;
}) {
  const target = React.useMemo(
    () => (reply && directory ? { sessionId: reply.sessionId, messageId: reply.messageId, directory, block: a2uiBlockKey(code) } : null),
    [reply, directory, code],
  );
  const answered = useA2uiReplyAnswer(target);
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const draftKey = target && complete
    ? `oc.a2ui.reply-draft.v1:${JSON.stringify([runtimeKey, target.directory, target.sessionId, target.messageId, target.block])}`
    : undefined;
  const draft = React.useMemo(
    () =>
      draftKey
        ? {
            load: () => loadDraft(draftKey),
            save: (value: A2uiReplyDraft | null) => saveDraft(draftKey, value),
          }
        : undefined,
    [draftKey],
  );
  const host = React.useMemo<A2uiHost>(
    () => ({
      kind: 'reply',
      answered,
      submit: target && !answered ? (answer, text) => sendA2uiReplyAnswer(target, answer, text) : null,
    }),
    [target, answered],
  );
  return <A2uiSurface key={draftKey} source={code} complete={complete} host={host} draft={draft} />;
}

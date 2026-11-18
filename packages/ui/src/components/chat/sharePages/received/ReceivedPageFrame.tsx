import React from 'react';
import { z } from 'zod';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import type { JsonValue } from '@/lib/opencode/model';
import { answerReceivedPage, type ReceivedPage } from '@/lib/received-pages/api';
import { SHARE_DOCUMENT_SOURCE, SHARE_VIEWER_SOURCE, type ViewerMessage } from '@/share-document/protocol';

import { buildReceivedPageShell, lockDownReceivedDocument, SHARE_HOST_SOURCE } from './receivedPageDocument';

const submitSchema = z.object({
  source: z.literal(SHARE_DOCUMENT_SOURCE),
  type: z.literal('submit'),
  data: z.json().catch(null),
  summary: z.string(),
  verified: z.boolean().catch(false),
});

export function ReceivedPageFrame({ receivedId, html, title, takesAnswer, answer, onAnswered }: {
  receivedId: string;
  html: string;
  title: string;
  takesAnswer: boolean;
  answer: JsonValue | null;
  onAnswered: (page: ReceivedPage) => void;
}) {
  const { t, locale } = useI18n();
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const { currentTheme } = useThemeSystem();
  const colorScheme = currentTheme.metadata.variant === 'dark' ? 'dark' : 'light';
  const answerRef = React.useRef(answer);
  answerRef.current = answer;
  const sendFailedRef = React.useRef(t('chat.sharedPage.panel.sendFailed'));
  const htmlRef = React.useRef(html);
  htmlRef.current = html;
  const shell = React.useMemo(() => buildReceivedPageShell(colorScheme, sendFailedRef.current), [colorScheme]);
  const reply = React.useCallback((message: ViewerMessage) => {
    // external: https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage Opaque-origin frames require "*" as the target origin.
    frameRef.current?.contentWindow?.postMessage(message, '*');
  }, []);

  const takesAnswerRef = React.useRef(takesAnswer);
  takesAnswerRef.current = takesAnswer;
  const loaded = React.useRef(false);
  const sendInit = React.useCallback(() => {
    const init: ViewerMessage = { source: SHARE_VIEWER_SOURCE, type: 'init', wantsAnswer: takesAnswerRef.current, locale };
    if (answerRef.current !== null) init.answer = answerRef.current;
    reply(init);
  }, [locale, reply]);
  React.useEffect(() => {
    if (loaded.current) sendInit();
  }, [answer, sendInit, takesAnswer]);
  const sending = React.useRef(false);
  const sendFailed = t('chat.sharedPage.panel.sendFailed');
  const { confirm, dialog } = useConfirmDialog();
  const confirmTitle = t('chat.sharedPage.confirm.title');
  const confirmSend = t('chat.sharedPage.confirm.send');
  const confirmCancel = t('chat.sharedPage.confirm.cancel');
  React.useEffect(() => {
    const handle = async (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const parsed = submitSchema.safeParse(event.data);
      if (!parsed.success) return;
      if (!takesAnswerRef.current || sending.current) {
        reply({ source: SHARE_VIEWER_SOURCE, type: 'submit-result', ok: false, error: sendFailed });
        return;
      }
      sending.current = true;
      if (!parsed.data.verified && !await confirm({ title: confirmTitle, message: parsed.data.summary, action: confirmSend, decline: confirmCancel })) {
        sending.current = false;
        reply({ source: SHARE_VIEWER_SOURCE, type: 'submit-result', ok: false, error: sendFailed });
        return;
      }
      answerReceivedPage(receivedId, { data: parsed.data.data, summary: parsed.data.summary })
        .then((page) => {
          reply({ source: SHARE_VIEWER_SOURCE, type: 'submit-result', ok: true, error: null });
          onAnswered(page);
        }, (error) => {
          reply({ source: SHARE_VIEWER_SOURCE, type: 'submit-result', ok: false, error: error instanceof Error ? error.message : sendFailed });
        })
        .finally(() => { sending.current = false; });
    };
    const listener = (event: MessageEvent) => { void handle(event); };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [confirm, confirmCancel, confirmSend, confirmTitle, onAnswered, receivedId, reply, sendFailed]);

  return (
    <>
      <iframe
        ref={frameRef}
        title={title}
        src={shell}
        referrerPolicy="no-referrer"
        onLoad={() => {
          loaded.current = true;
          const page = lockDownReceivedDocument(htmlRef.current, answerRef.current);
          frameRef.current?.contentWindow?.postMessage({ source: SHARE_HOST_SOURCE, type: 'page', page }, '*');
          sendInit();
        }}
        className="block size-full min-h-0 border-0"
        style={{ colorScheme: currentTheme.metadata.variant }}
      />
      {dialog}
    </>
  );
}

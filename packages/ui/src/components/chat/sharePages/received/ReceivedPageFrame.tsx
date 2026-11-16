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
  // The shell could not see a click (no activation API): the user confirms in the app first.
  verified: z.boolean().catch(false),
});

/**
 * Someone else's page, drawn as the relay's viewer draws it: the decrypted
 * document in a sandboxed frame with no network and no navigation
 * (`receivedPageDocument.ts`), told whether it takes an answer when it loads
 * and again whenever that changes. Its Send goes to the server, which seals
 * the answer for the author; the page then freezes on what was sent.
 */
export function ReceivedPageFrame({ receivedId, html, title, takesAnswer, answer, onAnswered }: {
  receivedId: string;
  html: string;
  title: string;
  takesAnswer: boolean;
  /** The data the user already sent: a page shown again freezes on it (documents shared from this version on). */
  answer: JsonValue | null;
  onAnswered: (page: ReceivedPage) => void;
}) {
  const { t, locale } = useI18n();
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  // The page picks light or dark from its frame's color scheme, as it does from the reader's system.
  const { currentTheme } = useThemeSystem();
  const colorScheme = currentTheme.metadata.variant === 'dark' ? 'dark' : 'light';
  const answerRef = React.useRef(answer);
  answerRef.current = answer;
  const sendFailedRef = React.useRef(t('chat.sharedPage.panel.sendFailed'));
  const htmlRef = React.useRef(html);
  htmlRef.current = html;
  const shell = React.useMemo(() => buildReceivedPageShell(colorScheme, sendFailedRef.current), [colorScheme]);
  const reply = React.useCallback((message: ViewerMessage) => {
    // An opaque-origin page accepts messages only addressed to any origin.
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
  // An answer sent from another window, or the page closing meanwhile, freezes the form already open here.
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
      // Never sent unseen: an answer the shell could not tie to a click goes out only on the user's word.
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
        // An unsandboxed data: shell: its frame-src holds and app gestures do not reach it (receivedPageDocument.ts); the page inside it is sandboxed.
        referrerPolicy="no-referrer"
        onLoad={() => {
          loaded.current = true;
          // The shell shows the first page it is handed and ignores any later one. Built at every
          // (re)load, so a shell reloaded after the answer (a theme switch) carries it; an answer
          // while it stays loaded arrives in `init`, with no reload.
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

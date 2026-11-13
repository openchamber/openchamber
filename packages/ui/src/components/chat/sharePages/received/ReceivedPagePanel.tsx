import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { BusyDots } from '@/components/ui/busy-dots';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { fetchReceivedPageDocument, refreshReceivedPage } from '@/lib/received-pages/api';

import { useReceivedPageTabTitle } from './openReceivedPage';
import { PinPrompt } from './PinPrompt';
import { ReceivedPageFrame } from './ReceivedPageFrame';
import { receivedStatusLook, takesAnswerNow } from './status';
import { useReceivedPage } from './useReceivedPage';

/**
 * A page someone else shared, full size: the context panel's `pages` tab, or
 * the phone's full-screen page. One line of state over the page (waiting for
 * the user's answer, the answer they sent, read only, expired), then the page
 * itself with its own Send. A page never opened asks for its PIN here.
 */
export function ReceivedPagePanel({ receivedId }: { receivedId: string }) {
  const { t } = useI18n();
  const state = useReceivedPage(receivedId);
  const { accept, fail, reload } = state;
  const page = state.page;
  const [document, setDocument] = React.useState<{ id: string; html: string } | null>(null);
  const [documentError, setDocumentError] = React.useState<string | null>(null);
  const opened = page?.opened === true;
  // What the relay says now (locked, expired, withdrawn); the stored state stays shown if it cannot be read.
  React.useEffect(() => {
    let live = true;
    refreshReceivedPage(receivedId).then((next) => { if (live) accept(next); }, () => undefined);
    return () => { live = false; };
  }, [accept, receivedId]);
  useReceivedPageTabTitle(receivedId, opened ? page?.title ?? null : null);

  React.useEffect(() => {
    if (!opened) return;
    let live = true;
    setDocumentError(null);
    fetchReceivedPageDocument(receivedId).then(
      (html) => { if (live) setDocument({ id: receivedId, html }); },
      (error) => { if (live) setDocumentError(error instanceof Error ? error.message : String(error)); },
    );
    return () => { live = false; };
  }, [opened, receivedId]);

  const message = (text: React.ReactNode) => (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">{text}</div>
  );

  if (state.turnedOff) return message(t('chat.sharedPage.turnedOff'));
  if (state.missing) return message(t('chat.sharedPage.card.gone'));
  if (!page) {
    return message(state.error ? (
      <span className="flex items-center gap-2">
        {t('chat.sharedPage.panel.loadFailed')}
        <Button type="button" size="xs" variant="ghost" onClick={() => { void reload(); }}>{t('chat.sharedPage.retry')}</Button>
      </span>
    ) : <>{t('chat.sharedPage.panel.loading')}<BusyDots /></>);
  }

  const look = receivedStatusLook(page);
  if (!opened) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center text-sm">
          <Icon name="pages" className="size-5 text-muted-foreground" />
          {page.status === 'open'
            ? <PinPrompt receivedId={receivedId} onPage={accept} onFailure={fail} centered />
            : <p className="text-muted-foreground" style={look.color ? { color: look.color } : undefined}>{t(look.key)}</p>}
        </div>
      </div>
    );
  }

  const title = page.title || t('chat.sharedPage.untitled');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-w-0 shrink-0 items-center gap-1.5 px-3 py-1.5 text-[0.8125rem]" style={look.color ? { color: look.color } : undefined}>
        <Icon name={look.icon} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate" dir="auto">
          {page.answer ? t('chat.sharedPage.panel.answered', { summary: page.answer.summary }) : t(look.key)}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {document?.id === receivedId ? (
          <ReceivedPageFrame
            receivedId={receivedId}
            html={document.html}
            title={title}
            takesAnswer={takesAnswerNow(page)}
            answer={page.answer?.data ?? null}
            onAnswered={accept}
          />
        ) : message(documentError ?? <>{t('chat.sharedPage.panel.loading')}<BusyDots /></>)}
      </div>
    </div>
  );
}

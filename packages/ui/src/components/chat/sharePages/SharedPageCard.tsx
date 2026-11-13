import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { toast } from '@/components/ui';
import { BusyDots } from '@/components/ui/busy-dots';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { copyTextToClipboard } from '@/lib/clipboard';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import type { RenderedPageShare } from '@/lib/opencode/tools';
import type { ToolPart } from '@/lib/opencode/model';
import {
  cancelSharePageRecipient,
  fetchSharePageGroup,
  fetchSharePagePreview,
  isSharingTurnedOff,
  postSharePageDocument,
  SharePageRequestError,
  type SharePageGroup,
  type ShareRecipient,
} from '@/lib/share-pages/api';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { SHARE_VIEWER_SOURCE, shareSubmitMessageSchema, type ViewerMessage } from '@/share-document/protocol';
import { useRenderPageHtml } from '../message/parts/renderPageImages';
import { buildSharePageDocument } from './shareDocument';
import { useSharePageGroup } from './useSharePageGroup';

type SharedPage = { html: string; ui?: string; title: string; share: RenderedPageShare };

type Translate = ReturnType<typeof useI18n>['t'];

/**
 * A page the agent shared with other people (`openchamber_render` with
 * `share`), drawn in place of the call: what it asks, and one row per
 * recipient with where their link stands. The links, PINs and answers live on
 * the server, never in the call, so the card reads them from there and is
 * current after a reload and on every device. "Open" shows the page from the
 * server's own copy, never through the relay, so the author's look is not
 * counted as the recipient's opening.
 */
export function SharedPageCard({ part, page, plainPage }: {
  part: ToolPart;
  page: SharedPage;
  /** The page drawn as an ordinary render, for when sharing is turned off. */
  plainPage: React.ReactNode;
}) {
  const { t } = useI18n();
  const title = page.title || t('chat.htmlRender.untitled');
  // VS Code runs without the OpenChamber server that keeps the links.
  const available = !isVSCodeRuntime();
  const state = useSharePageGroup(part.sessionID, part.callID, available);
  const group = state.group;

  // Enterprise mode without an allowed relay (decision 0005): no links, PINs
  // or preview, only the page the agent drew and why it went nowhere.
  if (state.turnedOff) {
    return (
      <>
        {plainPage}
        <p className="mb-2 text-[0.8125rem] text-muted-foreground">{t('chat.sharePage.turnedOff')}</p>
      </>
    );
  }

  return (
    <div data-component="shared-page" className="my-2 oc-tile rounded-xl px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <Icon name="send-plane" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate typography-ui-label text-foreground" dir="auto">{title}</span>
        {group?.documentState === 'ready' ? <PreviewButton part={part} title={title} group={group} onTurnedOff={state.turnOff} /> : null}
      </div>
      <SharedPageSummary page={page} summary={group?.summary ?? page.share.summary ?? null} />

      {!available ? (
        <p className="mt-2 text-[0.8125rem] text-muted-foreground">{t('chat.sharePage.unavailable')}</p>
      ) : group ? (
        <>
          {group.documentState === 'preparing' ? <DocumentUpload part={part} page={page} onUploaded={state.accept} onTurnedOff={state.turnOff} /> : null}
          <ul className="mt-2.5 flex flex-col gap-2">
            {group.recipients.map((recipient) => (
              <RecipientRow
                key={recipient.recipientId}
                part={part}
                page={page}
                group={group}
                recipient={recipient}
                onGroup={state.accept}
                reload={state.reload}
                onTurnedOff={state.turnOff}
              />
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-2 flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
          {state.missing ? t('chat.sharePage.missing')
            : state.error ? (
              <>
                <span>{t('chat.sharePage.loadFailed')}</span>
                <Button type="button" size="xs" variant="ghost" onClick={() => { void state.reload(); }}>{t('chat.sharePage.retry')}</Button>
              </>
            )
              : <>{t('chat.sharePage.loading')}<BusyDots /></>}
        </p>
      )}
    </div>
  );
}

/** For a `ui` page the questions its fields ask; for an `html` page the agent's one-line summary. */
function SharedPageSummary({ page, summary }: { page: SharedPage; summary: string | null }) {
  const questions = useSharePageQuestions(page.ui);
  if (page.ui) {
    if (!questions?.length) return null;
    return (
      <ul className="mt-1.5 flex flex-col gap-0.5 text-[0.8125rem] text-foreground">
        {questions.map((question, index) => (
          // A dot of its own, not a list marker: a marker follows the item's own direction, so a question in another script lost it.
          <li key={index} className="flex min-w-0 gap-2">
            <span aria-hidden className="text-muted-foreground">•</span>
            <span dir="auto" className="min-w-0 oc-ui-start-align">{question}</span>
          </li>
        ))}
      </ul>
    );
  }
  return summary ? <p dir="auto" className="mt-1 text-sm text-muted-foreground">{summary}</p> : null;
}

/** The page's questions, once the UI block parser has loaded; null before. */
function useSharePageQuestions(source: string | undefined): string[] | null {
  const [questions, setQuestions] = React.useState<{ source: string; list: string[] } | null>(null);
  React.useEffect(() => {
    if (!source) return;
    let live = true;
    void import('./questions').then(({ sharePageQuestions }) => {
      if (live) setQuestions({ source, list: sharePageQuestions(source) });
    });
    return () => { live = false; };
  }, [source]);
  return questions && questions.source === source ? questions.list : null;
}

// One upload per call at a time from this client, however many cards draw it.
const uploads = new Map<string, Promise<SharePageGroup>>();

/**
 * Hands the server the page for every recipient without a link yet. `html` is
 * null once the server holds the document: it reuses its copy, so every
 * recipient gets the same page. A 409 means another client got there first
 * (or the share expired meanwhile); the group read then says which.
 */
function uploadDocument(part: ToolPart, page: SharedPage, html: string | null): Promise<SharePageGroup> {
  const key = `${part.sessionID}\n${part.callID}`;
  let upload = uploads.get(key);
  if (!upload) {
    const document = html === null ? Promise.resolve('') : buildSharePageDocument({ ui: page.ui, html, title: page.title, expectAnswer: page.share.expectAnswer !== false });
    upload = document
      .then((built) => postSharePageDocument(part.sessionID, part.callID, { html: built, title: page.title }))
      .catch((error) => {
        if (error instanceof SharePageRequestError && error.status === 409) return fetchSharePageGroup(part.sessionID, part.callID);
        throw error;
      })
      .finally(() => uploads.delete(key));
    uploads.set(key, upload);
  }
  return upload;
}

/**
 * The page's local images as data URLs, then the upload; `children` gets the
 * call once both are ready. Mounted only while a document has to go up, so a
 * card at rest reads no images.
 */
function WithPageHtml({ part, page, children }: { part: ToolPart; page: SharedPage; children: (html: string) => React.ReactNode }) {
  const html = useRenderPageHtml(part, page.ui ? '' : page.html);
  return html === null ? null : <>{children(html)}</>;
}

/**
 * Builds the page every recipient gets and hands it to the server, which
 * encrypts and uploads it per recipient. The server waits for this after the
 * call; a failure says so and offers another try.
 */
function DocumentUpload({ part, page, onUploaded, onTurnedOff }: {
  part: ToolPart;
  page: SharedPage;
  onUploaded: (group: SharePageGroup) => void;
  onTurnedOff: () => void;
}) {
  const { t } = useI18n();
  const [failed, setFailed] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2 text-[0.8125rem] text-muted-foreground">
      {failed === null ? (
        <>
          <Spinner className="size-3.5" aria-hidden />
          <span>{t('chat.sharePage.preparing')}<BusyDots /></span>
          <WithPageHtml part={part} page={page}>
            {(html) => (
              <UploadOnce
                key={attempt}
                run={() => uploadDocument(part, page, html)}
                onDone={onUploaded}
                onFailed={(error) => { if (isSharingTurnedOff(error)) onTurnedOff(); else setFailed(error.message); }}
              />
            )}
          </WithPageHtml>
        </>
      ) : (
        <>
          <Icon name="error-warning" className="size-3.5 shrink-0 text-[var(--status-error)]" />
          <span className="min-w-0 truncate text-[var(--status-error)]" title={failed}>{t('chat.sharePage.prepareFailed')}</span>
          <Button type="button" size="xs" variant="ghost" onClick={() => { setFailed(null); setAttempt((value) => value + 1); }}>
            {t('chat.sharePage.retry')}
          </Button>
        </>
      )}
    </div>
  );
}

function UploadOnce({ run, onDone, onFailed }: {
  run: () => Promise<SharePageGroup>;
  onDone: (group: SharePageGroup) => void;
  onFailed: (error: Error) => void;
}) {
  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    run().then(onDone, (error) => onFailed(error instanceof Error ? error : new Error(String(error))));
  }, [onDone, onFailed, run]);
  return null;
}

const formatMoment = (at: number, now: number) => {
  const locale = getCurrentIntlLocale();
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  const time = new Intl.DateTimeFormat(locale, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  return { time, sameDay };
};

/**
 * "in 2 days", "in 5 hours", or null once past. Days round to the nearest one: a link made a
 * minute ago that lives four days must not read "in 3 days".
 */
const formatTimeLeft = (expiresAt: number, now: number): string | null => {
  const left = expiresAt - now;
  if (left <= 0) return null;
  const format = new Intl.RelativeTimeFormat(getCurrentIntlLocale(), { numeric: 'always' });
  const hours = Math.floor(left / 3_600_000);
  if (hours >= 24) return format.format(Math.round(left / 86_400_000), 'day');
  if (hours >= 1) return format.format(hours, 'hour');
  return format.format(Math.max(1, Math.floor(left / 60_000)), 'minute');
};

// Time left reads in whole minutes at the finest, so a minute's tick keeps it true.
function useMinuteClock(): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

type StatusLook = { icon: IconName | null; text: string; color?: string };

function recipientLook(recipient: ShareRecipient, now: number, t: Translate): StatusLook {
  switch (recipient.status) {
    case 'preparing':
      return { icon: null, text: t('chat.sharePage.status.preparing') };
    case 'open': {
      const opened = recipient.opens.length ? Math.max(...recipient.opens) : null;
      if (opened === null) return { icon: 'time', text: t('chat.sharePage.status.notOpened') };
      const { time, sameDay } = formatMoment(opened, now);
      return { icon: 'eye', text: sameDay ? t('chat.sharePage.status.openedAt', { time }) : t('chat.sharePage.status.openedOn', { date: time }) };
    }
    case 'answered': {
      const color = 'var(--status-success)';
      if (recipient.answeredAt === null) return { icon: 'checkbox-circle', text: t('chat.sharePage.status.answered'), color };
      const { time, sameDay } = formatMoment(recipient.answeredAt, now);
      return { icon: 'checkbox-circle', text: sameDay ? t('chat.sharePage.status.answeredAt', { time }) : t('chat.sharePage.status.answeredOn', { date: time }), color };
    }
    case 'locked':
      return { icon: 'lock', text: t('chat.sharePage.status.locked'), color: 'var(--status-error)' };
    case 'expired':
      return { icon: 'time', text: t('chat.sharePage.status.expired') };
    case 'cancelled':
      return { icon: 'close-circle', text: t('chat.sharePage.status.cancelled') };
    case 'failed':
      return { icon: 'error-warning', text: t('chat.sharePage.status.failed'), color: 'var(--status-error)' };
  }
}

function RecipientRow({ part, page, group, recipient, onGroup, reload, onTurnedOff }: {
  part: ToolPart;
  page: SharedPage;
  group: SharePageGroup;
  recipient: ShareRecipient;
  onGroup: (group: SharePageGroup) => void;
  reload: () => Promise<void>;
  onTurnedOff: () => void;
}) {
  const { t } = useI18n();
  const now = useMinuteClock();
  const look = recipientLook(recipient, now, t);
  const timeLeft = recipient.status === 'open' && group.expiresAt !== null ? formatTimeLeft(group.expiresAt, now) : null;
  const { confirm, dialog } = useConfirmDialog();
  const [busy, setBusy] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);

  const cancel = async () => {
    const confirmed = await confirm({
      title: t('chat.sharePage.cancelConfirm.title', { label: recipient.label }),
      message: t('chat.sharePage.cancelConfirm.message', { label: recipient.label }),
      action: t('chat.sharePage.cancel'),
      decline: t('chat.sharePage.cancelConfirm.keep'),
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const next = await cancelSharePageRecipient(part.sessionID, part.callID, recipient.recipientId);
      if (next) onGroup(next);
      else await reload();
    } catch (error) {
      if (error instanceof Error && isSharingTurnedOff(error)) onTurnedOff();
      else toast.error(t('chat.sharePage.cancelFailed'), { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="min-w-0">
      <div className="flex min-w-0 items-center gap-2 text-[0.8125rem]">
        <span className="min-w-0 max-w-[45%] shrink-0 truncate font-medium text-foreground" dir="auto">{recipient.label}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1 text-muted-foreground" style={look.color ? { color: look.color } : undefined}>
          {recipient.status === 'preparing' ? <Spinner className="size-3 shrink-0" aria-hidden /> : look.icon ? <Icon name={look.icon} className="size-3.5 shrink-0" /> : null}
          <span className="min-w-0 truncate">
            {look.text}
            {timeLeft ? <span className="text-muted-foreground"> · {t('chat.sharePage.expires', { time: timeLeft })}</span> : null}
          </span>
        </span>
        {recipient.status === 'open' ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="xs" variant="ghost" className="shrink-0 pointer-coarse:size-9" disabled={busy} aria-label={t('chat.sharePage.recipientActions', { label: recipient.label })}>
                <Icon name="more" className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onSelect={() => { void cancel(); }}>
                <Icon name="close-circle" className="size-3.5 shrink-0" />
                {t('chat.sharePage.cancel')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {recipient.status === 'answered' && recipient.answerSummary ? (
        <p dir="auto" className="mt-0.5 line-clamp-4 whitespace-pre-line text-[0.8125rem] text-foreground oc-ui-start-align">{recipient.answerSummary}</p>
      ) : null}
      {recipient.status === 'failed' && recipient.error ? (
        <p dir="auto" className="mt-0.5 text-[0.8125rem] text-muted-foreground">{recipient.error}</p>
      ) : null}
      {recipient.status === 'open' && recipient.link && recipient.pin ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <CopyButton icon="link" label={t('chat.sharePage.copyLink')} value={recipient.link} />
          <CopyButton icon="key" label={t('chat.sharePage.copyPin')} value={recipient.pin} />
        </div>
      ) : null}
      {recipient.status === 'failed' && group.documentState === 'ready' ? (
        <div className="mt-1.5 flex items-center gap-1.5">
          {retrying ? (
            <UploadOnce
              run={() => uploadDocument(part, page, null)}
              onDone={(next) => { setRetrying(false); onGroup(next); }}
              onFailed={(error) => {
                setRetrying(false);
                if (isSharingTurnedOff(error)) onTurnedOff();
                else toast.error(t('chat.sharePage.prepareFailed'), { description: error.message });
              }}
            />
          ) : null}
          <Button type="button" size="sm" variant="outline" disabled={retrying} onClick={() => setRetrying(true)}>
            {retrying ? <Spinner className="size-3.5" aria-hidden /> : <Icon name="restart" className="size-3.5" />}
            {t('chat.sharePage.retry')}
          </Button>
        </div>
      ) : null}
      {dialog}
    </li>
  );
}

/** A copy button that answers the click with a check in place of its icon for a moment. */
function CopyButton({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    const result = await copyTextToClipboard(value);
    if (result.ok) setCopied(true);
    else toast.error(t('chat.sharePage.copyFailed'));
  };
  return (
    <Button type="button" size="sm" variant="outline" className="pointer-coarse:h-9" onClick={() => { void copy(); }}>
      <Icon name={copied ? 'check' : icon} className="size-3.5" />
      {label}
    </Button>
  );
}

/**
 * "Open": the page as the recipients get it, from the copy the server keeps,
 * in the app's sandboxed frame. It runs the page's real script, so the frame
 * plays the viewer's part: it says whether the page takes an answer and turns
 * a Send down, since an answer only counts from a recipient's link.
 */
function PreviewButton({ part, title, group, onTurnedOff }: { part: ToolPart; title: string; group: SharePageGroup; onTurnedOff: () => void }) {
  const { t, locale } = useI18n();
  const [html, setHtml] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const open = async () => {
    setLoading(true);
    try {
      setHtml(await fetchSharePagePreview(part.sessionID, part.callID));
    } catch (error) {
      if (error instanceof Error && isSharingTurnedOff(error)) onTurnedOff();
      else toast.error(t('chat.sharePage.openFailed'), { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <Button type="button" size="sm" variant="ghost" className="ms-auto" disabled={loading} onClick={() => { void open(); }}>
        {loading ? <Spinner className="size-3.5" aria-hidden /> : <Icon name="eye" className="size-3.5" />}
        {t('chat.sharePage.open')}
      </Button>
      <Dialog open={html !== null} onOpenChange={(next) => { if (!next) setHtml(null); }}>
        <DialogContent className="max-w-[min(72rem,100%)] gap-0 overflow-hidden bg-background p-0">
          <DialogTitle className="truncate px-5 py-4 pe-12" dir="auto">{title}</DialogTitle>
          {html !== null ? (
            <SharePreviewFrame
              html={html}
              title={title}
              wantsAnswer={group.expectAnswer}
              locale={locale}
              refusal={t('chat.sharePage.preview.noSend')}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function SharePreviewFrame({ html, title, wantsAnswer, locale, refusal }: {
  html: string;
  title: string;
  wantsAnswer: boolean;
  locale: string;
  refusal: string;
}) {
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  // The page picks light or dark from its frame's color scheme, as it does from the reader's system.
  const { currentTheme } = useThemeSystem();
  const reply = React.useCallback((message: ViewerMessage) => {
    // An opaque-origin page accepts messages only addressed to any origin.
    frameRef.current?.contentWindow?.postMessage(message, '*');
  }, []);
  React.useEffect(() => {
    const handle = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (!shareSubmitMessageSchema.safeParse(event.data).success) return;
      reply({ source: SHARE_VIEWER_SOURCE, type: 'submit-result', ok: false, error: refusal });
      toast.info(refusal);
    };
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, [refusal, reply]);
  return (
    <iframe
      ref={frameRef}
      title={title}
      srcDoc={html}
      sandbox="allow-scripts allow-forms"
      onLoad={() => reply({ source: SHARE_VIEWER_SOURCE, type: 'init', wantsAnswer, locale })}
      className="block h-[min(75vh,48rem)] w-full border-0"
      style={{ colorScheme: currentTheme.metadata.variant }}
    />
  );
}

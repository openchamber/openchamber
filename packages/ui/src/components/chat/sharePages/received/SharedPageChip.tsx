import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { BusyDots } from '@/components/ui/busy-dots';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { refreshReceivedPage } from '@/lib/received-pages/api';
import { isSharingTurnedOff } from '@/lib/share-pages/api';

import type { ComposerReference } from '../../composer/composerReferences';

import { PinPrompt } from './PinPrompt';
import { receivedStatusLook } from './status';
import { readShareLinkRegistration } from './takeShareLink';
import { useReceivedPage } from './useReceivedPage';
import { useReceivedPageText } from './useReceivedPageText';

type SharedPageReference = Extract<ComposerReference, { kind: 'shared-page' }>;

/**
 * A share link pasted or typed into the composer, standing in for the link
 * (decision 0013). Before the PIN it says whether the page can still be
 * opened; the right PIN opens it here and the chip shows its title and
 * outline, and the agent then gets the page's content with the message.
 * Sent without the PIN, the agent learns only that a link was shared.
 */
export function SharedPageChip({ reference, onChange, onRemove }: {
  reference: SharedPageReference;
  onChange: (next: SharedPageReference) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const [registerError, setRegisterError] = React.useState<string | null>(null);
  const [relayError, setRelayError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const state = useReceivedPage(reference.receivedId);
  const { accept, fail } = state;
  const page = state.page;
  const text = useReceivedPageText(page);

  // The link went to the server when it left the text; the chip learns the page's id from its answer.
  const latest = React.useRef(reference);
  latest.current = reference;
  React.useEffect(() => {
    if (reference.receivedId) return;
    const pending = readShareLinkRegistration(reference.shareKey);
    if (!pending) {
      setRegisterError(t('chat.sharedPage.chip.failed'));
      return;
    }
    let live = true;
    pending.then((registered) => {
      if (!live) return;
      accept(registered);
      onChange({ ...latest.current, receivedId: registered.receivedId });
    }, (error) => {
      if (!live) return;
      if (error instanceof Error && isSharingTurnedOff(error)) fail(error);
      else setRegisterError(error instanceof Error ? error.message : t('chat.sharedPage.chip.failed'));
    });
    return () => { live = false; };
  }, [accept, fail, onChange, reference.receivedId, reference.shareKey, t]);

  // Before the PIN, what the relay says now: locked, expired, answered or withdrawn show at once.
  const [checked, setChecked] = React.useState(false);
  React.useEffect(() => {
    if (!reference.receivedId) return;
    let live = true;
    refreshReceivedPage(reference.receivedId).then((next) => {
      if (live) accept(next);
    }, (error) => {
      if (!live) return;
      if (error instanceof Error && isSharingTurnedOff(error)) fail(error);
      else setRelayError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (live) setChecked(true);
    });
    return () => { live = false; };
  }, [accept, fail, reference.receivedId]);

  // Once opened, the agent's copy is the page itself.
  React.useEffect(() => {
    if (!page?.opened || !text) return;
    const current = latest.current;
    if (current.opened && current.contextText === text.agentText && current.title === page.title) return;
    onChange({ ...current, opened: true, title: page.title, contextText: text.agentText });
  }, [onChange, page?.opened, page?.title, text]);

  const retry = async () => {
    if (!reference.receivedId) return;
    setBusy(true);
    try {
      accept(await refreshReceivedPage(reference.receivedId));
      setRelayError(null);
    } catch (error) {
      setRelayError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const title = page?.opened && page.title ? page.title : t('chat.sharedPage.chip.label', { host: reference.host });
  const look = page ? receivedStatusLook(page) : null;
  const needsPin = page && !page.opened && page.status === 'open' && !relayError;

  let detail: React.ReactNode;
  if (state.turnedOff) {
    detail = <span className="text-muted-foreground">{t('chat.sharedPage.turnedOff')}</span>;
  } else if (registerError) {
    detail = <span className="min-w-0 truncate text-[var(--status-error)]" title={registerError}>{t('chat.sharedPage.chip.failed')}</span>;
  } else if (!page || (!checked && !page.opened && !relayError)) {
    detail = <span className="text-muted-foreground">{t('chat.sharedPage.chip.loading')}<BusyDots /></span>;
  } else if (relayError) {
    detail = (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-[var(--status-error)]" title={relayError}>{t('chat.sharedPage.chip.relayError')}</span>
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => { void retry(); }}>{t('chat.sharedPage.retry')}</Button>
      </span>
    );
  } else if (needsPin && reference.receivedId) {
    detail = <PinPrompt receivedId={reference.receivedId} onPage={accept} onFailure={fail} />;
  } else if (look) {
    detail = (
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground" style={look.color ? { color: look.color } : undefined}>
          <Icon name={look.icon} className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{t(look.key)}</span>
        </span>
        {text?.outline.length ? (
          <span className="flex min-w-0 flex-col">
            {text.outline.slice(0, 3).map((line, index) => (
              <span key={index} className="flex min-w-0 gap-1.5 text-foreground">
                <span aria-hidden className="text-muted-foreground">•</span>
                <span dir="auto" className="min-w-0 truncate oc-ui-start-align">{line}</span>
              </span>
            ))}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <div data-component="shared-page-chip" className="inline-flex max-w-[min(28rem,100%)] min-w-0 flex-col gap-1 rounded-lg border border-edge bg-background px-2 py-1.5 text-xs">
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon name="pages" className="size-3.5 shrink-0 text-muted-foreground" />
        <span dir="auto" className="min-w-0 flex-1 truncate text-foreground" title={title}>{title}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onRemove}
              className="flex size-5 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--interactive-hover)] pointer-coarse:size-8"
              aria-label={t('chat.sharedPage.chip.remove')}
            >
              <Icon name="close" className="size-3.5 text-muted-foreground" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{t('chat.sharedPage.chip.remove')}</TooltipContent>
        </Tooltip>
      </div>
      {detail ? <div className="flex min-w-0 items-center">{detail}</div> : null}
    </div>
  );
}

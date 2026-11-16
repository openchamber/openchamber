import React from 'react';

import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/lib/i18n';
import { openReceivedPage, type ReceivedPage } from '@/lib/received-pages/api';
import { isSharingTurnedOff } from '@/lib/share-pages/api';
import { cn } from '@/lib/utils';

import { PinField } from './PinField';

/**
 * The PIN boxes with the line under them: the hint, then the attempts left
 * after a wrong PIN. The right PIN, or a share that turned locked, expired or
 * answered meanwhile, comes back through `onPage`.
 */
export function PinPrompt({ receivedId, onPage, onFailure, centered = false }: {
  receivedId: string;
  /** Centred under the page's icon in the panel; at the start of the line in the chip. */
  centered?: boolean;
  onPage: (page: ReceivedPage) => void;
  /** A refusal the page itself cannot show (the policy turned receiving off). */
  onFailure: (error: Error) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [resets, setResets] = React.useState(0);

  const submit = async (pin: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await openReceivedPage(receivedId, pin);
      onPage(next);
      if (next.pinRejected && next.status === 'open') {
        setError(t('chat.sharedPage.pin.wrong', { count: next.attemptsLeft ?? 0 }));
        setResets((value) => value + 1);
      }
    } catch (failure) {
      if (failure instanceof Error && isSharingTurnedOff(failure)) onFailure(failure);
      else setError(t('chat.sharedPage.openFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1', centered && 'justify-center text-center')}>
      <PinField onComplete={(pin) => { void submit(pin); }} disabled={busy} invalid={Boolean(error)} resetKey={resets} />
      {busy ? <Spinner className="size-3.5" aria-hidden /> : null}
      <span role="status" className={error ? 'text-[var(--status-error)]' : 'text-muted-foreground'}>
        {error ?? t('chat.sharedPage.pin.hint')}
      </span>
    </span>
  );
}

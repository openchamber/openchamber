import React, { memo } from 'react';

import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useExtensionWaitsStore, type ExtensionWait } from '@/sync/extension-waits';
import { stopExtensionWaits } from '@/sync/extension-waits-sync';
import { useMinuteTickerNow } from '@/hooks/useDurationTicker';
import { timerMinutesLeft, waitOrigin, waitSubject } from './waitPresentation';

const NO_WAITS: readonly ExtensionWait[] = [];

export const ExtensionWaitStrip = memo(({ sessionId }: { sessionId: string | null }) => {
  const { t } = useI18n();
  const waits = useExtensionWaitsStore(React.useCallback((state) => (sessionId ? state.bySession.get(sessionId) ?? NO_WAITS : NO_WAITS), [sessionId]));
  const shown = waits.find((wait) => wait.status === 'waking') ?? waits[0];

  const now = useMinuteTickerNow(shown?.source === 'timer' && shown.status === 'waiting');

  if (!shown) return null;
  const describe = (wait: ExtensionWait) => [waitSubject(wait, t), waitOrigin(wait)].filter(Boolean).join(' · ');
  const origin = waitOrigin(shown);
  const minutesLeft = shown.status === 'waiting' ? timerMinutesLeft(shown, now) : undefined;

  const handleStop = () => {
    void stopExtensionWaits(shown.sessionID).catch((error) => {
      console.warn('[extension-waits] failed to stop waiting', error);
      toast.error(t('chat.extensionWait.toast.stopFailed'));
    });
  };

  return (
    <div
      role="status"
      className="flex oc-composer-row min-w-0 items-center gap-2 border-b border-edge ps-3 pe-1.5"
      title={waits.map(describe).join('\n')}
    >
      <Icon name="timer" className="size-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {t('chat.extensionWait.title', { title: waitSubject(shown, t) })}
        {origin ? <span className="text-muted-foreground"> · {origin}</span> : null}
        {minutesLeft !== undefined ? <span className="text-muted-foreground"> · {t('chat.waits.remaining', { minutes: minutesLeft })}</span> : null}
        {shown.status === 'waking' ? <span className="text-muted-foreground"> · {t('chat.extensionWait.status.waking')}</span> : null}
        {waits.length > 1 ? <span className="text-muted-foreground"> · +{waits.length - 1}</span> : null}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleStop}
        onMouseDown={(event) => event.preventDefault()}
        className="shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
      >
        {t('chat.extensionWait.actions.stop')}
      </Button>
    </div>
  );
});

ExtensionWaitStrip.displayName = 'ExtensionWaitStrip';

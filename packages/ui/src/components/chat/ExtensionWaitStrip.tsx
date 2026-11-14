import React, { memo } from 'react';

import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useExtensionWaitsStore, type ExtensionWait } from '@/sync/extension-waits';
import { stopExtensionWaits } from '@/sync/extension-waits-sync';

const NO_WAITS: readonly ExtensionWait[] = [];

/** "Timer (10 s)": the wait's title with the label its extension, or the host for a timer, gave it. */
const subjectOf = (wait: ExtensionWait): string => (wait.label ? `${wait.title} (${wait.label})` : wait.title);

/**
 * The agent ended its turn to wait on a timer or on something an extension
 * follows; the server wakes it when the time is up or the extension says it
 * fired. The row names the wait
 * (the one waking first, else the oldest) and how many more there are, and
 * lets the user stop them all, after which nothing wakes the session.
 */
export const ExtensionWaitStrip = memo(({ sessionId }: { sessionId: string | null }) => {
  const { t } = useI18n();
  const waits = useExtensionWaitsStore(React.useCallback((state) => (sessionId ? state.bySession.get(sessionId) ?? NO_WAITS : NO_WAITS), [sessionId]));
  const shown = waits.find((wait) => wait.status === 'waking') ?? waits[0];

  if (!shown) return null;

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
      title={waits.map((wait) => `${subjectOf(wait)} · ${wait.extension}`).join('\n')}
    >
      <Icon name="timer" className="size-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {t('chat.extensionWait.title', { title: subjectOf(shown) })}
        <span className="text-muted-foreground"> · {shown.extension}</span>
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

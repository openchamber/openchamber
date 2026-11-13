import React, { memo } from 'react';

import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { usePrWatchStore, type PrWatch } from '@/sync/pr-watch';
import { stopPrWatch } from '@/sync/pr-watch-sync';

const STATUS_LABEL = {
  pending: 'chat.prWatch.status.pending',
  passed: 'chat.prWatch.status.passed',
  failed: 'chat.prWatch.status.failed',
  waking: 'chat.prWatch.status.waking',
} satisfies Partial<Record<PrWatch['status'], I18nKey>>;

const hasStatusLabel = (status: PrWatch['status']): status is keyof typeof STATUS_LABEL => status in STATUS_LABEL;

/**
 * The agent ended its turn to wait on its pull request; the server wakes it
 * when the pull request changes. The row says what it waits on and lets the
 * user stop the wait, after which nothing wakes the session.
 */
export const PullRequestWatchStrip = memo(({ sessionId }: { sessionId: string | null }) => {
  const { t } = useI18n();
  const watch = usePrWatchStore(React.useCallback((state) => (sessionId ? state.bySession.get(sessionId) ?? null : null), [sessionId]));

  if (!watch) return null;

  const handleStop = () => {
    void stopPrWatch(watch.sessionID).catch((error) => {
      console.warn('[pr-watch] failed to stop watching', error);
      toast.error(t('chat.prWatch.toast.stopFailed'));
    });
  };

  return (
    <div role="status" className="flex oc-composer-row min-w-0 items-center gap-2 border-b border-edge ps-3 pe-1.5" title={watch.title || undefined}>
      <Icon name="git-pull-request" className="size-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {t('chat.prWatch.title', { number: watch.number })}
        {hasStatusLabel(watch.status) ? <span className="text-muted-foreground"> · {t(STATUS_LABEL[watch.status])}</span> : null}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleStop}
        onMouseDown={(event) => event.preventDefault()}
        className="shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
      >
        {t('chat.prWatch.actions.stop')}
      </Button>
    </div>
  );
});

PullRequestWatchStrip.displayName = 'PullRequestWatchStrip';

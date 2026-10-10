import React, { memo } from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useUIStore } from '@/stores/useUIStore';
import { useChatSessionSelection } from './chatColumnSession';

/**
 * A running review loop, as a top row of the composer next to the background
 * commands: what it waits for, Open for the read-only review session, Stop.
 */
export const AutoReviewStrip = memo(() => {
  const { t } = useI18n();
  const currentSessionId = useChatSessionSelection().sessionId;
  const run = useAutoReviewStore(React.useCallback((state) => {
    if (!currentSessionId) return null;
    const run = state.runsByOriginalSessionID[currentSessionId] ?? null;
    return run?.runtimeKey === getRuntimeKey() ? run : null;
  }, [currentSessionId]));
  const stopRun = useAutoReviewStore((state) => state.stopRun);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);

  if (!currentSessionId || !run || run.status !== 'running') {
    return null;
  }

  const statusLabel = run.phase === 'waiting_for_reviewer'
    ? t('chat.autoReview.status.waitingForReviewer')
    : t('chat.autoReview.status.waitingForImplementer');

  const handleOpenReviewSession = () => {
    openContextPanelTab(run.directory, {
      mode: 'chat',
      dedupeKey: `session:${run.reviewSessionID}`,
      label: t('chat.autoReview.reviewSessionLabel'),
      readOnly: true,
    });
  };

  return (
    <div role="status" className="flex h-10 min-w-0 items-center gap-2 border-b border-border/60 pl-3 pr-1.5">
      <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {t('chat.autoReview.title')}
        <span className="text-muted-foreground"> · {statusLabel}</span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleOpenReviewSession}
        onMouseDown={(event) => event.preventDefault()}
        className="shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
      >
        {t('chat.autoReview.actions.open')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => stopRun(currentSessionId)}
        onMouseDown={(event) => event.preventDefault()}
        className="shrink-0 text-status-error/80 hover:bg-transparent hover:text-status-error"
      >
        {t('chat.autoReview.actions.stop')}
      </Button>
    </div>
  );
});

AutoReviewStrip.displayName = 'AutoReviewStrip';

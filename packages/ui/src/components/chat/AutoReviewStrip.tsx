import React, { memo } from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { selectAutoReviewRun, useAutoReviewStore, type AutoReviewRun } from '@/stores/useAutoReviewStore';
import { useUIStore } from '@/stores/useUIStore';
import { useChatSessionSelection } from './chatColumnSession';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

type SettledStatus = Exclude<AutoReviewRun['status'], 'running'>;

const RESULT = {
  clean: { icon: 'checkbox-circle', className: 'text-status-success', labelKey: 'chat.autoReview.result.clean' },
  disputed: { icon: 'error-warning', className: 'text-status-warning', labelKey: 'chat.autoReview.result.disputed' },
  limit: { icon: 'error-warning', className: 'text-status-warning', labelKey: 'chat.autoReview.result.limit' },
  failed: { icon: 'close-circle', className: 'text-status-error', labelKey: 'chat.autoReview.result.failed' },
  stopped: { icon: 'stop', className: 'text-muted-foreground', labelKey: 'chat.autoReview.result.stopped' },
} satisfies Record<SettledStatus, { icon: IconName; className: string; labelKey: I18nKey }>;

/**
 * The session's review loop as a top row of the composer. While it runs: what
 * it waits for, Open for the read-only review session, Stop. Once it ends, the
 * row stays with the result until dismissed, so a finished, contested or
 * failed review is never just a row that disappeared.
 */
export const AutoReviewStrip = memo(() => {
  const { t } = useI18n();
  const { sessionId: currentSessionId, directory: currentDirectory } = useChatSessionSelection();
  const run = useAutoReviewStore(React.useMemo(
    () => selectAutoReviewRun(currentSessionId, currentDirectory),
    [currentSessionId, currentDirectory],
  ));
  const removeRun = useAutoReviewStore((state) => state.removeRun);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  // Which run's dispute is unfolded, so another chat or a new run starts folded.
  const [unfoldedRun, setUnfoldedRun] = React.useState<string | null>(null);
  const disputeId = React.useId();

  if (!currentSessionId || !run) {
    return null;
  }

  const handleOpenReviewSession = () => {
    openContextPanelTab(run.directory, {
      mode: 'chat',
      dedupeKey: `session:${run.reviewSessionID}`,
      label: t('chat.autoReview.reviewSessionLabel'),
      readOnly: true,
    });
  };

  const handleRemove = () => {
    void removeRun(run.originalSessionID, run.directory).catch((error) => {
      console.warn('[auto-review] failed to stop or dismiss the review', error);
      toast.error(t('chat.autoReview.toast.removeFailed'));
    });
  };

  const openButton = (
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
  );

  if (run.status === 'running') {
    const statusLabel = run.step === 'review'
      ? t('chat.autoReview.status.waitingForReviewer')
      : t('chat.autoReview.status.waitingForImplementer');
    return (
      <div role="status" className="flex oc-composer-row min-w-0 items-center gap-2 border-b border-edge ps-3 pe-1.5">
        <Spinner className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {t('chat.autoReview.title')}
          <span className="text-muted-foreground"> · {statusLabel}</span>
        </span>
        {openButton}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleRemove}
          onMouseDown={(event) => event.preventDefault()}
          className="shrink-0 text-status-error/80 hover:bg-transparent hover:text-status-error"
        >
          {t('chat.autoReview.actions.stop')}
        </Button>
      </div>
    );
  }

  const result = RESULT[run.status];
  const label = (
    <span className="min-w-0 flex-1 truncate text-start text-sm text-foreground">
      {t(result.labelKey)}
      {run.error ? <span className="text-muted-foreground"> · {run.error}</span> : null}
    </span>
  );
  // A dispute unfolds in place, as the queue does: both positions, without
  // opening two sessions to find out what the disagreement is about.
  const runId = `${run.originalSessionID}:${run.startedAt}`;
  const unfolded = Boolean(run.dispute) && unfoldedRun === runId;
  return (
    <div role="status" className="border-b border-edge" title={run.error}>
      <div className="flex oc-composer-row min-w-0 items-center gap-2 ps-3 pe-1.5">
        <Icon name={result.icon} className={`size-3.5 flex-shrink-0 ${result.className}`} aria-hidden="true" />
        {run.dispute ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setUnfoldedRun(unfolded ? null : runId)}
            onMouseDown={(event) => event.preventDefault()}
            aria-expanded={unfolded}
            aria-controls={unfolded ? disputeId : undefined}
            className="min-w-0 flex-1 shrink justify-start gap-2 px-0 font-normal normal-case hover:!bg-transparent has-[>svg]:px-0"
          >
            {label}
            <Icon name={unfolded ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Button>
        ) : label}
        {openButton}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleRemove}
          onMouseDown={(event) => event.preventDefault()}
          className="shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
        >
          {t('chat.autoReview.actions.dismiss')}
        </Button>
      </div>
      {unfolded ? (
        <ScrollableOverlay id={disputeId} outerClassName="max-h-48" className="whitespace-pre-wrap break-words ps-8 pe-3 pb-2 text-sm text-muted-foreground" disableHorizontal>
          {run.dispute}
        </ScrollableOverlay>
      ) : null}
    </div>
  );
});

AutoReviewStrip.displayName = 'AutoReviewStrip';

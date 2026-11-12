import React, { memo } from 'react';

import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { changeRequestTermOfUrl, useRepositoryUrlMatcher, type RepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { usePrWatchStore, type PrWatch } from '@/sync/pr-watch';
import { stopPrWatch } from '@/sync/pr-watch-sync';

const STATUS_LABEL = {
  pending: 'chat.prWatch.status.pending',
  passed: 'chat.prWatch.status.passed',
  failed: 'chat.prWatch.status.failed',
  waking: 'chat.prWatch.status.waking',
} satisfies Partial<Record<PrWatch['status'], I18nKey>>;

const hasStatusLabel = (status: PrWatch['status']): status is keyof typeof STATUS_LABEL => status in STATUS_LABEL;

const NO_WATCHES: readonly PrWatch[] = [];

const STOP_BUTTON_CLASS = 'shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground';

const WatchRow: React.FC<{ watch: PrWatch; urls: RepositoryUrlMatcher; onStop: (watch: PrWatch) => void }> = ({ watch, urls, onStop }) => {
  const { t } = useI18n();
  return (
    <div className="flex oc-composer-row min-w-0 items-center gap-2 ps-3 pe-1.5">
      <Icon name="git-pull-request" className="size-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={watch.title || undefined}>
        {t(changeRequestCopy('chat.prWatch.title', changeRequestTermOfUrl(watch.url, urls)), { number: watch.number })}
        {hasStatusLabel(watch.status) ? <span className="text-muted-foreground"> · {t(STATUS_LABEL[watch.status])}</span> : null}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onStop(watch)}
            onMouseDown={(event) => event.preventDefault()}
            className={STOP_BUTTON_CLASS}
          >
            {t('chat.prWatch.actions.stop')}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>{t('contextTooltips.chat.prWatchStop')}</TooltipContent>
      </Tooltip>
    </div>
  );
};

/**
 * The agent ended its turn to wait on its pull requests; the server wakes it
 * when one of them changes. The row says what it waits on and lets the user
 * stop a wait, after which that pull request no longer wakes the session.
 * Several collapse into a count that expands in place, as background commands do.
 */
export const PullRequestWatchStrip = memo(({ sessionId }: { sessionId: string | null }) => {
  const { t } = useI18n();
  const urls = useRepositoryUrlMatcher();
  const watches = usePrWatchStore(React.useCallback((state) => (sessionId ? state.bySession.get(sessionId) : undefined) ?? NO_WATCHES, [sessionId]));
  const [expanded, setExpanded] = React.useState(false);
  const listId = React.useId();

  if (!sessionId || watches.length === 0) return null;

  const stop = (url?: string) => {
    void stopPrWatch(sessionId, url).catch((error) => {
      console.warn('[pr-watch] failed to stop watching', error);
      toast.error(t('chat.prWatch.toast.stopFailed'));
    });
  };
  const stopOne = (watch: PrWatch) => stop(watch.url);
  // Pull and merge requests together read as changes.
  const terms = watches.map((watch) => changeRequestTermOfUrl(watch.url, urls));
  const countTerm = terms.every((term) => term === terms[0]) ? terms[0] : 'change';
  const row = (watch: PrWatch) => <WatchRow key={watch.url} watch={watch} urls={urls} onStop={stopOne} />;

  if (watches.length === 1) {
    return <div role="status" className="border-b border-edge">{row(watches[0])}</div>;
  }

  return (
    <div role="status" className="border-b border-edge">
      <div className="flex oc-composer-row items-center gap-2 ps-3 pe-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((value) => !value)}
              onMouseDown={(event) => event.preventDefault()}
              aria-expanded={expanded}
              aria-controls={expanded ? listId : undefined}
              className="min-w-0 flex-1 shrink justify-start gap-2 px-0 text-sm font-normal normal-case text-muted-foreground hover:!bg-transparent hover:text-foreground has-[>svg]:px-0"
            >
              <Icon name="git-pull-request" className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-start">
                {t(changeRequestCopy('chat.prWatch.count', countTerm), { count: watches.length })}
              </span>
              <Icon name={expanded ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 shrink-0" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{t(expanded ? 'contextTooltips.chat.prWatchesHide' : 'contextTooltips.chat.prWatchesShow')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => stop()}
              onMouseDown={(event) => event.preventDefault()}
              className={STOP_BUTTON_CLASS}
            >
              {t('chat.prWatch.actions.stopAll')}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{t('contextTooltips.chat.prWatchStopAll')}</TooltipContent>
        </Tooltip>
      </div>
      {expanded ? <div id={listId}>{watches.map(row)}</div> : null}
    </div>
  );
});

PullRequestWatchStrip.displayName = 'PullRequestWatchStrip';

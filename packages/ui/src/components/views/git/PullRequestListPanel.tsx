import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { formatChangeRequestReference } from '@/lib/source-control/providers/terminology';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { joinProjectPath } from '@/lib/source-control/projectPath';
import { cn } from '@/lib/utils';
import { PullRequestFilterButton } from './PullRequestFilterButton';

import { isSelectedPullRequest, type ChangeRequestEntry, type PullRequestComparison } from './pullRequestSelection';


export const PullRequestListPanel: React.FC<{
  comparison: PullRequestComparison;
  onSelect: (pr: ChangeRequestEntry) => void;
  focusSelected?: boolean;
  onFocused?: () => void;
}> = ({ comparison, onSelect, focusSelected = false, onFocused }) => {
  const { t: translate } = useI18n();
  const descriptor = useSourceControlProvider(comparison.provider);
  const t = (key: I18nKey) => translate(changeRequestCopy(key, descriptor.terminology.changeRequest));
  const searchLabel = t('pullRequestComparison.searchShort');
  const searchHint = t('session.githubPrPicker.searchPlaceholder');
  const refreshLabel = translate('session.githubIssuePicker.actions.refresh');
  const { visiblePrs } = comparison;

  const showsProject = new Set(comparison.prs.map((pr) => joinProjectPath(pr.project.owner, pr.project.name))).size > 1;

  const renderBody = () => {
    if (comparison.loading && comparison.prs.length === 0) {
      return (
        <div className="flex flex-1 items-center justify-center gap-2 px-4 text-muted-foreground">
          <Icon name="loader-4" className="size-4 animate-spin" />
          <span className="typography-ui-label">{t('session.githubPrPicker.loading.pullRequests')}</span>
        </div>
      );
    }
    if (comparison.error && comparison.prs.length === 0 && !comparison.hasMore) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <p className="typography-meta text-muted-foreground">{comparison.error}</p>
          <Button variant="outline" size="sm" onClick={() => void comparison.refresh()}>{t('diffView.actions.retry')}</Button>
        </div>
      );
    }
    if (comparison.prs.length === 0 && !comparison.hasMore) {
      const partial = !comparison.error && comparison.incompleteProjectIds.length > 0;
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center typography-meta text-muted-foreground">
          <span>{t(partial ? 'pullRequestComparison.partial' : 'session.githubPrPicker.empty.noPullRequestsFound')}</span>
          {partial ? <Button variant="outline" size="sm" onClick={() => void comparison.refresh()}>{t('diffView.actions.retry')}</Button> : null}
        </div>
      );
    }
    return (
      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="px-1.5 pb-3" disableHorizontal preventOverscroll>
        {visiblePrs.length === 0 ? (
          <p className="px-4 py-6 text-center typography-meta text-muted-foreground">{t('session.githubPrPicker.empty.noPullRequestsFound')}</p>
        ) : null}
        <ul className="flex flex-col gap-0.5">
          {visiblePrs.map((pr) => {
            const isSelected = isSelectedPullRequest(comparison, pr);
            return (
              <li key={`${joinProjectPath(pr.project.owner, pr.project.name)}#${pr.number}`}>
                <button
                  type="button"
                  onClick={() => onSelect(pr)}
                  ref={isSelected && focusSelected ? (node) => {
                    if (!node) return;
                    node.focus();
                    onFocused?.();
                  } : undefined}
                  aria-current={isSelected ? 'true' : undefined}
                  className={cn(
                    'flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2.5 py-2 text-start transition-colors',
                    isSelected
                      ? 'bg-[var(--interactive-selection)]/45 text-foreground'
                      : 'text-foreground/85 hover:bg-[var(--interactive-hover)]/60 hover:text-foreground',
                  )}
                >
                  <div
                    dir="auto"
                    className={cn('oc-ui-start-align truncate typography-ui-label', isSelected ? 'font-semibold text-foreground' : 'font-medium')}
                    title={pr.title}
                  >
                    <span className="tabular-nums text-muted-foreground">{formatChangeRequestReference(descriptor, pr.number)}</span> {pr.title}
                  </div>
                  <div dir="ltr" className="oc-ui-start-align truncate typography-micro text-muted-foreground">
                    {pr.head} → {pr.base}{showsProject ? ` · ${joinProjectPath(pr.project.owner, pr.project.name)}` : ''}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
        {comparison.error ? <p className="px-2.5 pt-2 typography-meta text-muted-foreground">{comparison.error}</p> : null}
        {!comparison.error && comparison.incompleteProjectIds.length > 0 ? (
          <div className="flex items-center justify-between gap-2 px-2.5 pt-2 typography-meta text-muted-foreground">
            <span>{t('pullRequestComparison.partial')}</span>
            <Button variant="outline" size="sm" onClick={() => void comparison.refresh()}>{t('diffView.actions.retry')}</Button>
          </div>
        ) : null}
        {comparison.hasMore ? (
          <div className="flex justify-center pt-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={comparison.loadingMore}
              onClick={() => void comparison.loadMore()}
              className="px-3 text-muted-foreground hover:text-foreground"
            >
              {comparison.loadingMore ? (
                <span className="flex items-center gap-1">
                  <Icon name="loader-4" className="size-3 animate-spin" />
                  {translate('gitView.history.loadingMore')}
                </span>
              ) : comparison.error ? t('diffView.actions.retry') : t('session.githubPrPicker.actions.loadMore')}
            </Button>
          </div>
        ) : null}
      </ScrollableOverlay>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2.5 pt-2 pb-1.5">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Icon name="search" className="pointer-events-none absolute inset-s-2.5 size-3.5 text-muted-foreground" />
          <Input
            inputSize="compact"
            value={comparison.query}
            onChange={(event) => comparison.setQuery(event.target.value)}
            placeholder={searchLabel}
            aria-label={searchHint}
            title={searchHint}
            className={cn('ps-8', comparison.query ? 'pe-14' : 'pe-9')}
          />
          {comparison.query ? (
            <button
              type="button"
              onClick={() => comparison.setQuery('')}
              aria-label={translate('gitView.history.actions.cancelButton')}
              className="absolute inset-e-7 flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <Icon name="close" className="size-3.5" />
            </button>
          ) : null}
          <span className="absolute inset-e-1.5 flex size-6 items-center justify-center">
            <PullRequestFilterButton comparison={comparison} positionerClassName="z-[70]" />
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground"
              disabled={comparison.loading}
              onClick={() => void comparison.refresh()}
              aria-label={refreshLabel}
            >
              <Icon name="refresh" className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{refreshLabel}</TooltipContent>
        </Tooltip>
      </div>
      {renderBody()}
    </div>
  );
};

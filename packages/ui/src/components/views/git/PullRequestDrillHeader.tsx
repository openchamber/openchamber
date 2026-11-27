import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { revisionSuffix, type PullRequestSource } from '@/lib/diff/pullRequestDiff';
import { useI18n } from '@/lib/i18n';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { joinProjectPath } from '@/lib/source-control/projectPath';
import type { ChangeRequestTerm } from '@/lib/source-control/providers/descriptor';
import type { ChangeRequest } from '@/lib/source-control/types';

import { GitDrillHeader } from './GitDrillHeader';

export const PullRequestDrillHeader: React.FC<{
  source: PullRequestSource;
  entry: ChangeRequest | null;
  reference: string;
  term: ChangeRequestTerm;
  refreshing: boolean;
  focusOnMount: boolean;
  onFocused: () => void;
  onBack: () => void;
  onRefresh: () => void;
}> = ({ source, entry, reference, term, refreshing, focusOnMount, onFocused, onBack, onRefresh }) => {
  const { t } = useI18n();
  const refreshLabel = t('session.githubIssuePicker.actions.refresh');
  return (
    <GitDrillHeader
      backLabel={t('contextPanel.actions.backToPanel', {
        panel: t(changeRequestCopy('session.githubIntegration.tabs.pullRequests', term)),
      })}
      onBack={onBack}
      focusOnMount={focusOnMount}
      onFocused={onFocused}
      title={`${reference}${revisionSuffix(source)}${entry ? ` ${entry.title}` : ''}`}
      meta={entry ? (
        <span dir="ltr" className="truncate">
          {entry.head} → {entry.base}
        </span>
      ) : source.sourceRepo ? (
        <span dir="ltr" className="truncate">{joinProjectPath(source.sourceRepo.owner, source.sourceRepo.repo)}</span>
      ) : null}
      actions={(
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={refreshing}
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground"
              aria-label={refreshLabel}
              onClick={onRefresh}
            >
              <Icon name="refresh" className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{refreshLabel}</TooltipContent>
        </Tooltip>
      )}
    />
  );
};

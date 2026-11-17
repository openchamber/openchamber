import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { SessionDraft } from '@/stores/useSessionDraftsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGitBranchLabel } from '@/stores/useGitStore';
import { formatProjectLabel } from '../utils';
import { TimelineProjectIcon, TimelineProjectName } from '../sessions/SessionTimelineRowBody';
import { useZoneProjectNames } from '../sessions/useZoneProjectNames';
import { isRowBoxClick } from '../sessions/rowBoxClick';
import { sessionDetailedRowPaddingLeft, sessionTreeRowPaddingLeft } from '../sessions/sessionTreeGeometry';
import { useSessionDraftRow } from './useSessionDraftRow';

type Props = {
  draft: SessionDraft;
  depth: number;
  detailed: boolean;
  mixed: boolean;
  alwaysShowActions: boolean;
  mobileVariant: boolean;
  setSessionSwitcherOpen: (open: boolean) => void;
};

export function SessionDraftRow({ draft, depth, detailed: detailedRequested, mixed, alwaysShowActions, mobileVariant, setSessionSwitcherOpen }: Props): React.ReactNode {
  const { t } = useI18n();
  const { isOpen, firstLine, attachmentCount, label, open, discard: discardDraft } = useSessionDraftRow(draft, () => {
    if (mobileVariant) setSessionSwitcherOpen(false);
  });
  const project = useProjectsStore(React.useCallback(
    (state) => (detailedRequested && mixed && draft.projectId ? state.projects.find((entry) => entry.id === draft.projectId) ?? null : null),
    [detailedRequested, mixed, draft.projectId],
  ));
  const projectNamed = useZoneProjectNames();
  const branch = useGitBranchLabel(detailedRequested ? draft.directory : null);
  const detailed = detailedRequested && Boolean(project || branch || (firstLine && attachmentCount > 0));
  const discard = (event: React.MouseEvent): void => {
    event.stopPropagation();
    discardDraft();
  };

  return (
    <div
      style={{ paddingInlineStart: detailed ? sessionDetailedRowPaddingLeft(depth) : sessionTreeRowPaddingLeft(depth) }}
      onClick={(event) => {
        if (isRowBoxClick(event)) open();
      }}
      className={cn(
        'group/draft relative my-0.5 flex cursor-pointer select-none rounded-md pe-2.5',
        detailed ? 'py-1.5' : 'py-[5px]',
        detailed ? 'flex-col gap-px' : 'items-center gap-1.5',
        isOpen ? 'oc-selected text-interactive-selection-foreground' : 'hover:bg-interactive-hover/60',
      )}
    >
      <div className={cn('flex w-full min-w-0 flex-1 items-center gap-1.5', detailed && 'h-5')}>
      {detailed ? null : (
        <span className="inline-flex size-3.5 flex-shrink-0 items-center justify-center text-muted-foreground">
          <Icon name="edit" className="h-3 w-3" />
        </span>
      )}
      <div
        role="button"
        tabIndex={0}
        className={cn(
          '@container relative flex min-w-0 flex-1 items-center gap-1 focus-visible:outline-none',
          !alwaysShowActions && '[--oc-actions-reserve:0.625rem]',
        )}
        aria-label={t('sessions.sidebar.draft.openAria', { label })}
        onClick={open}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          open();
        }}
      >
        <span
          dir="auto"
          className={cn(
            'oc-ui-start-align min-w-0 flex-1 truncate typography-ui-label italic',
            isOpen ? 'text-interactive-selection-foreground' : 'oc-title-rest',
            !alwaysShowActions && 'group-hover/draft:oc-actions-mask group-has-[:focus-visible]/draft:oc-actions-mask',
          )}
        >
          {label}
        </span>
        <span className={cn(
          'ms-auto flex flex-shrink-0 items-center gap-1',
          alwaysShowActions ? 'pe-7' : 'group-hover/draft:opacity-0 group-has-[:focus-visible]/draft:opacity-0',
        )}>
          {!detailed && firstLine && attachmentCount > 0 ? <Icon name="attachment-2" className="h-3 w-3 text-muted-foreground" /> : null}
        </span>
      </div>
      </div>
      {detailed ? (
        <div className="flex h-4 w-full min-w-0 items-center gap-1">
          {project ? <TimelineProjectIcon project={project} label={projectNamed ? null : formatProjectLabel(project.label?.trim() || project.path)} /> : null}
          {project && projectNamed ? <TimelineProjectName project={project} separated={false} /> : null}
          <Icon name="edit" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
          {branch ? <span dir="ltr" className="min-w-0 truncate typography-micro text-muted-foreground">{branch}</span> : null}
          {firstLine && attachmentCount > 0 ? <Icon name="attachment-2" className="ms-auto h-3 w-3 flex-shrink-0 text-muted-foreground" /> : null}
        </div>
      ) : null}
      <div className={cn(
        'absolute inset-e-1 z-10 flex items-center',
        detailed ? 'top-1.5 h-5' : 'top-1/2 -translate-y-1/2',
        alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover/draft:opacity-100 group-has-[:focus-visible]/draft:opacity-100',
      )}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                alwaysShowActions ? 'h-6 w-6' : 'h-4 w-4',
              )}
              aria-label={t('sessions.sidebar.draft.discard')}
              onClick={discard}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <Icon name="close" className={alwaysShowActions ? 'h-3.5 w-3.5' : 'h-3 w-3'} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{t('sessions.sidebar.draft.discard')}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

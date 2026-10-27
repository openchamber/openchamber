import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { SessionDraft } from '@/stores/useSessionDraftsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGitBranchLabel } from '@/stores/useGitStore';
import { formatProjectLabel } from '../utils';
import { TimelineProjectIcon } from '../sessions/SessionTimelineRowBody';
import { isRowBoxClick } from '../sessions/rowBoxClick';
import { sessionDetailedRowPaddingLeft, sessionTreeRowPaddingLeft } from '../sessions/sessionTreeGeometry';
import { useSessionDraftRow } from './useSessionDraftRow';

type Props = {
  draft: SessionDraft;
  depth: number;
  /** Two lines, as the works around it with Detailed rows on. */
  detailed: boolean;
  /** In a zone among other projects' works, so it names its project. */
  mixed: boolean;
  alwaysShowActions: boolean;
  mobileVariant: boolean;
  setSessionSwitcherOpen: (open: boolean) => void;
};

/**
 * A new session's draft not sent yet: a pen in the slot, the start of what
 * was typed, and a cross that throws it away. A click opens it in the
 * composer, where it goes on as the same draft; while it is there its row is
 * the selected one. Sending turns it into the session's row. With Detailed
 * rows its second line says where it will go: the project (in a zone) and
 * the branch, as a detailed session row's does.
 */
export function SessionDraftRow({ draft, depth, detailed, mixed, alwaysShowActions, mobileVariant, setSessionSwitcherOpen }: Props): React.ReactNode {
  const { t } = useI18n();
  const { isOpen, firstLine, attachmentCount, label, open, discard: discardDraft } = useSessionDraftRow(draft, () => {
    if (mobileVariant) setSessionSwitcherOpen(false);
  });
  const project = useProjectsStore(React.useCallback(
    (state) => (detailed && mixed && draft.projectId ? state.projects.find((entry) => entry.id === draft.projectId) ?? null : null),
    [detailed, mixed, draft.projectId],
  ));
  // Known once the directory's git status has been read; the line keeps its height without it.
  const branch = useGitBranchLabel(detailed ? draft.directory : null);
  const discard = (event: React.MouseEvent): void => {
    event.stopPropagation();
    discardDraft();
  };

  return (
    <div
      style={{ paddingInlineStart: detailed ? sessionDetailedRowPaddingLeft(depth) : sessionTreeRowPaddingLeft(depth) }}
      // The whole box opens the draft, its second line and paddings too.
      onClick={(event) => {
        if (isRowBoxClick(event)) open();
      }}
      className={cn(
        'group/draft relative my-0.5 flex cursor-pointer select-none rounded-md py-1.5 pe-2.5',
        detailed ? 'flex-col gap-px' : 'items-center gap-1.5',
        isOpen ? 'bg-interactive-selection/70 text-interactive-selection-foreground' : 'hover:bg-interactive-hover/60',
      )}
    >
      <div className={cn('flex w-full min-w-0 flex-1 items-center gap-1.5', detailed && 'h-5')}>
      {/* Two lines have no slot: the pen opens the second line instead. */}
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
        // Fixed 16px, as a detailed session row's second line: the project
        // where projects mix, the pen, then the branch it will go to.
        <div className="flex h-4 w-full min-w-0 items-center gap-1">
          {project ? <TimelineProjectIcon project={project} label={formatProjectLabel(project.label?.trim() || project.path)} /> : null}
          <Icon name="edit" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
          {branch ? <span className="min-w-0 truncate typography-micro text-muted-foreground">{branch}</span> : null}
          {firstLine && attachmentCount > 0 ? <Icon name="attachment-2" className="ms-auto h-3 w-3 flex-shrink-0 text-muted-foreground" /> : null}
        </div>
      ) : null}
      <div className={cn(
        'absolute inset-e-1 z-10 flex items-center',
        // On the first line: a detailed row's second line has none.
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

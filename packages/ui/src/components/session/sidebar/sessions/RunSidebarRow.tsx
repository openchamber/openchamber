import React from 'react';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import { Icon } from '@/components/icon/Icon';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { FileTreeChevron } from '@/components/views/files/FileTreeRowParts';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { handleSessionRenameKeyDown } from '@/components/session/sessionRenameKeyboard';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { MultiRunSummary } from '@/lib/multirun/runs';
import type { SessionNode } from '../types';
import { CollapsedActivityIndicator } from './collapsedActivityIndicator';
import { useCollapsedSessionActivityState } from './collapsedActivityState';
import { SessionTimelineRowBody } from './SessionTimelineRowBody';
import { useRunWork } from './useRunWork';
import { sessionDetailedRowPaddingLeft, sessionTreeRowPaddingLeft } from './sessionTreeGeometry';

const MAX_LOGOS = 4;
const NO_NAVIGATION = (): void => undefined;

type MenuSlots = {
  Item: React.ComponentType<{ className?: string; onClick?: (event: React.MouseEvent) => void; children?: React.ReactNode }>;
  Separator: React.ComponentType;
};
const DROPDOWN_SLOTS: MenuSlots = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator };
const CONTEXT_MENU_SLOTS: MenuSlots = { Item: ContextMenuItem, Separator: ContextMenuSeparator };

type Props = {
  run: MultiRunSummary;
  depth: number;
  laneNodes: readonly SessionNode[];
  // Sessions whose pending requests block a lane, hidden subagents included.
  blockingSessionIds: readonly string[];
  /** Two lines, as the works around it with Detailed rows on. */
  detailed: boolean;
  projectId: string | null;
  projectLabel: string | null;
  /** Listed among other projects' works, so a detailed row names its project. */
  mixed: boolean;
  expansionKey: string;
  expanded: boolean;
  forceExpanded: boolean;
  alwaysShowActions: boolean;
  toggleParent: (key: string) => void;
};

function ProviderLogos({ providerIDs, ringClass }: { providerIDs: readonly string[]; ringClass: string }): React.ReactNode {
  return (
    <span className="inline-flex shrink-0 items-center -space-x-1">
      {providerIDs.slice(0, MAX_LOGOS).map((providerID) => (
        <span key={providerID} className={cn('inline-flex h-4 w-4 items-center justify-center rounded-full bg-sidebar ring-1', ringClass)}>
          <ProviderLogo providerId={providerID} className="h-3 w-3" />
        </span>
      ))}
    </span>
  );
}

/**
 * A multi-run in the sidebar: a work like a session or a worktree. It reads
 * like their rows (the lanes' state in the slot, else the run's mark; the
 * title; the lanes' models), opens to its lanes, and takes the same hover
 * actions: Done for every lane, and a menu with the overview, Rename and
 * Archive run. A click opens the overview. Two-line rows follow the detailed
 * rows: no slot, the state on the right, the chevron over the second line's
 * first icon on hover.
 */
function RunSidebarRowComponent({
  run,
  depth,
  laneNodes,
  blockingSessionIds,
  detailed,
  projectId,
  projectLabel,
  mixed,
  expansionKey,
  expanded,
  forceExpanded,
  alwaysShowActions,
  toggleParent,
}: Props): React.ReactNode {
  const { t } = useI18n();
  const work = useRunWork(run, laneNodes, NO_NAVIGATION);
  const { isActive, sessionWorkEnabled, inWork, busy } = work;
  const project = useProjectsStore(React.useCallback((state) => (
    detailed && mixed && projectId ? state.projects.find((entry) => entry.id === projectId) ?? null : null
  ), [detailed, mixed, projectId]));
  const laneCount = run.lanes.length;
  const laneCountLabel = laneCount === 1
    ? t('sessions.sidebar.run.laneCountSingle', { count: laneCount })
    : t('sessions.sidebar.run.laneCountPlural', { count: laneCount });
  const activityNodes = React.useMemo(() => [...laneNodes], [laneNodes]);
  const activityState = useCollapsedSessionActivityState({ nodes: activityNodes, blockingSessionIds });
  const activity = activityState ? <CollapsedActivityIndicator state={activityState} /> : null;
  const expandable = laneNodes.length > 0;
  const isExpanded = forceExpanded || expanded;
  const [renaming, setRenaming] = React.useState(false);
  const [renameDraft, setRenameDraft] = React.useState('');
  const renameInputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (!renaming) return;
    // Focused once the menu that started it has closed and returned focus.
    const frame = requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [renaming]);

  const openOverview = (): void => {
    if (!renaming) work.openOverview();
  };
  const openRun = (): void => {
    if (!renaming) work.open();
  };
  const toggle = (event: React.SyntheticEvent): void => {
    event.stopPropagation();
    if (!forceExpanded) toggleParent(expansionKey);
  };
  const toggleWork = (event: React.MouseEvent): void => {
    event.stopPropagation();
    void work.toggleWork();
  };
  const startRename = (): void => {
    setRenameDraft(run.title);
    setRenaming(true);
  };
  const saveRename = async (): Promise<void> => {
    setRenaming(false);
    await work.rename(renameDraft);
  };
  const archive = work.archive;

  const renderMenuItems = (Slots: MenuSlots): React.ReactNode => (
    <>
      <Slots.Item onClick={openOverview}>
        <ArrowsMerge className="h-4 w-4" aria-hidden="true" />
        <span>{t('sessions.sidebar.run.menu.openOverview')}</span>
      </Slots.Item>
      <Slots.Item onClick={startRename}>
        <Icon name="edit" className="h-4 w-4" />
        <span>{t('multirun.overview.rename.aria')}</span>
      </Slots.Item>
      <Slots.Separator />
      <Slots.Item onClick={() => { void archive(); }}>
        <Icon name="archive" className="h-4 w-4" />
        <span>{t('multirun.overview.archive.action')}</span>
      </Slots.Item>
    </>
  );

  const hoverOut = alwaysShowActions ? undefined : 'transition-opacity group-hover/run:opacity-0 group-has-[:focus-visible]/run:opacity-0';
  const hoverIn = alwaysShowActions ? undefined : 'opacity-0 transition-opacity group-hover/run:opacity-100 group-has-[:focus-visible]/run:opacity-100';
  const chevron = expandable ? (
    <span
      role="button"
      tabIndex={0}
      className={cn('absolute inset-0 inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none', hoverIn)}
      aria-label={isExpanded ? t('sessions.sidebar.run.collapse') : t('sessions.sidebar.run.expand')}
      aria-expanded={isExpanded}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggle(event);
      }}
    >
      <FileTreeChevron expanded={isExpanded} />
    </span>
  ) : null;
  // The run's mark, where a worktree shows its branch mark.
  const runMark = <ArrowsMerge className={cn(detailed ? 'h-3 w-3' : 'h-3.5 w-3.5', 'shrink-0 text-muted-foreground/70')} aria-hidden="true" />;
  // One line: the slot holds the lanes' state, else the run's mark; the
  // chevron takes its place on hover. Two lines have no slot: the chevron
  // swaps in for the second line's first icon instead.
  const slot = (
    <span className="relative inline-flex size-3.5 flex-shrink-0 items-center justify-center">
      <span className={cn('inline-flex items-center justify-center', expandable && hoverOut)}>{activity ?? runMark}</span>
      {chevron}
    </span>
  );

  const title = renaming ? (
    <form
      // One text line tall, as a session's rename: the buttons never grow the row.
      className="flex h-[1lh] w-full min-w-0 items-center gap-1 typography-ui-label"
      onClick={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        void saveRename();
      }}
    >
      <input
        ref={renameInputRef}
        value={renameDraft}
        onChange={(event) => setRenameDraft(event.target.value)}
        onKeyDown={(event) => handleSessionRenameKeyDown(event, () => setRenaming(false))}
        className="min-w-0 flex-1 bg-transparent typography-ui-label text-foreground outline-none"
        aria-label={t('multirun.overview.rename.aria')}
      />
      <button type="submit" aria-label={t('sessions.sidebar.session.rename.save')} className="shrink-0 text-muted-foreground hover:text-foreground">
        <Icon name="check" className="size-3.5" />
      </button>
      <button type="button" onClick={() => setRenaming(false)} aria-label={t('sessions.sidebar.session.rename.cancel')} className="shrink-0 text-muted-foreground hover:text-foreground">
        <Icon name="close" className="size-3.5" />
      </button>
    </form>
  ) : run.title;
  // The hover actions hide while renaming, so the rename's own buttons take
  // the whole line: no room reserved for them and no fade over its end.
  const actionsReserve = renaming ? undefined : sessionWorkEnabled ? '[--oc-actions-reserve:2.875rem]' : '[--oc-actions-reserve:1.75rem]';
  const maskOnHover = alwaysShowActions || renaming ? undefined : 'group-hover/run:oc-actions-mask group-has-[:focus-visible]/run:oc-actions-mask';
  const actionButtonClass = cn(
    'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    alwaysShowActions ? 'h-6 w-6' : 'h-4 w-4',
  );

  const body = detailed ? (
    <SessionTimelineRowBody
      project={project}
      projectLabel={projectLabel}
      title={title}
      titleClassName={renaming ? 'text-foreground' : isActive ? 'text-interactive-selection-foreground' : 'text-muted-foreground'}
      branchLabel={null}
      leadIcon={runMark}
      metaLineLead={(
        <>
          {project ? runMark : null}
          <span className="min-w-0 truncate typography-micro text-muted-foreground/50">{laneCountLabel}</span>
        </>
      )}
      leadToggle={chevron}
      leadIconClassName={chevron ? (alwaysShowActions ? 'opacity-0' : 'group-hover/run:opacity-0 group-has-[:focus-visible]/run:opacity-0') : undefined}
      statusDot={activity}
      pinnedMarker={null}
      timeSlot={null}
      directoryIndicator={null}
      prBadge={null}
      zombieIndicator={null}
      badges={<ProviderLogos providerIDs={run.providerIDs} ringClass="ring-sidebar opacity-60" />}
      hideMetaOnHoverClass={hoverOut ?? ''}
      actionsReserveClass={actionsReserve}
      actionsMaskClass={maskOnHover}
    />
  ) : (
    <div className={cn('@container relative flex min-w-0 flex-1 items-center gap-1', actionsReserve)}>
      {renaming ? title : (
        <span dir="auto" className={cn('oc-ui-start-align block min-w-0 flex-1 truncate typography-ui-label font-normal', isActive ? 'text-interactive-selection-foreground' : 'text-muted-foreground', maskOnHover)}>{title}</span>
      )}
      <span className={cn('ms-auto flex flex-shrink-0 items-center', renaming && 'hidden', alwaysShowActions ? (sessionWorkEnabled ? 'pe-14' : 'pe-7') : hoverOut)}>
        <ProviderLogos providerIDs={run.providerIDs} ringClass="ring-sidebar" />
      </span>
    </div>
  );

  return (
    <ContextMenu disabled={renaming}>
      <ContextMenuTrigger render={<div />}>
        <div
          data-run-row={run.key}
          aria-current={isActive ? 'page' : undefined}
          style={{ paddingInlineStart: detailed ? sessionDetailedRowPaddingLeft(depth) : sessionTreeRowPaddingLeft(depth) }}
          className={cn(
            'group/run relative my-0.5 flex cursor-pointer items-center rounded-md py-1.5 pe-2.5',
            !detailed && 'gap-1.5',
            isActive ? 'bg-interactive-selection/70 text-interactive-selection-foreground' : 'hover:bg-interactive-hover/60',
          )}
        >
          {detailed ? null : slot}
          <div
            role="button"
            tabIndex={0}
            className="flex min-w-0 flex-1 items-center focus-visible:outline-none"
            aria-label={t('sessions.sidebar.run.openOverviewAria', { title: run.title })}
            onClick={openRun}
            onDoubleClick={(event) => {
              event.stopPropagation();
              startRename();
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
              event.preventDefault();
              openRun();
            }}
          >
            {body}
          </div>
          <div className={cn(
            'absolute inset-e-1 z-10 flex items-center gap-0.5 transition-opacity',
            // On the first line: a two-line row's second line has none.
            detailed ? 'top-1.5 h-5' : 'top-1/2 -translate-y-1/2',
            renaming && 'hidden',
            alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover/run:opacity-100 group-has-[:focus-visible]/run:opacity-100 has-[[data-popup-open]]:opacity-100',
          )}>
            <TooltipProvider delayDuration={400}>
              {sessionWorkEnabled ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(actionButtonClass, inWork && 'text-status-success hover:text-status-success')}
                      aria-label={inWork ? t('sessions.sidebar.session.work.markDone') : t('sessions.sidebar.session.work.track')}
                      disabled={busy}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => { void toggleWork(event); }}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <Icon name={inWork ? 'check' : 'eye'} className={alwaysShowActions ? 'h-4 w-4' : (inWork ? 'h-3 w-3' : 'h-2.5 w-2.5')} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    {inWork ? t('sessions.sidebar.session.work.markDone') : t('sessions.sidebar.session.work.track')}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={actionButtonClass}
                    aria-label={t('sessions.sidebar.work.menu.label', { label: run.title })}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <Icon name="more-2" className={alwaysShowActions ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5'} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[180px]">
                  {renderMenuItems(DROPDOWN_SLOTS)}
                </DropdownMenuContent>
              </DropdownMenu>
            </TooltipProvider>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[180px]">
        {renderMenuItems(CONTEXT_MENU_SLOTS)}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export const RunSidebarRow = React.memo(RunSidebarRowComponent);

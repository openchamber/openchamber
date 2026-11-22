import React from 'react';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import { FileTreeChevron } from '@/components/views/files/FileTreeRowParts';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import type { MultiRunSummary } from '@/lib/multirun/runs';
import type { SessionNode } from '../types';
import { isMultiLineTimelineContext, type SessionSidebarRenderContext } from '../sessionSidebarRowModel';
import { formatSessionCompactDateLabel } from '../utils';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { CollapsedSessionActivityIndicator } from './collapsedActivityIndicator';
import { SessionTimelineRowBody } from './SessionTimelineRowBody';
import { sessionTreeRowPaddingLeft } from './sessionTreeGeometry';

// Timeline rows have no gutter; grouped rows are file tree rows, like the
// session rows around them.
const TIMELINE_ROW_LEFT_PX = 10;
const MAX_LOGOS = 4;

type Props = {
  run: MultiRunSummary;
  depth: number;
  laneNodes: readonly SessionNode[];
  // Sessions whose pending requests block a lane, hidden subagents included.
  blockingSessionIds: readonly string[];
  renderContext: SessionSidebarRenderContext;
  projectId: string | null;
  projectLabel: string | null;
  expansionKey: string;
  expanded: boolean;
  forceExpanded: boolean;
  notifyOnSubtasks: boolean;
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

function RunSidebarRowComponent({
  run,
  depth,
  laneNodes,
  blockingSessionIds,
  renderContext,
  projectId,
  projectLabel,
  expansionKey,
  expanded,
  forceExpanded,
  notifyOnSubtasks,
  toggleParent,
}: Props): React.ReactNode {
  const { t } = useI18n();
  const isActive = useUIStore((state) => state.runOverviewKey === run.key);
  // The Tree view's zone rows are flat too, on one line, and keep the tree
  // slot for their state; List rows with one line per session stay flat.
  const isTreeOneLineRow = renderContext === 'mixed-compact';
  const isOneLineRow = isTreeOneLineRow || renderContext === 'mixed-flat' || renderContext === 'timeline-chat';
  const isTimelineRow = isMultiLineTimelineContext(renderContext) || isOneLineRow;
  // The list by time names the project on a first line of its own.
  const hasProjectLine = renderContext === 'timeline-by-time';
  // Only the zones, the combined list and the list by time mix projects;
  // under a project header the row needs no icon.
  const timelineProject = useProjectsStore(React.useCallback((state) => (
    (renderContext === 'timeline-mixed' || renderContext === 'mixed-flat' || hasProjectLine) && projectId
      ? state.projects.find((entry) => entry.id === projectId) ?? null
      : null
  ), [hasProjectLine, renderContext, projectId]));
  const laneCount = run.lanes.length;
  const laneCountLabel = laneCount === 1
    ? t('sessions.sidebar.run.laneCountSingle', { count: laneCount })
    : t('sessions.sidebar.run.laneCountPlural', { count: laneCount });
  const activityNodes = React.useMemo(() => [...laneNodes], [laneNodes]);
  const activity = <CollapsedSessionActivityIndicator nodes={activityNodes} blockingSessionIds={blockingSessionIds} includeUnreadSubtasks={notifyOnSubtasks} />;
  // Optional row elements (branch, PR badge, provider logo, project icon,
  // goal, time). Live status always shows.
  const rowElements = useSessionDisplayStore((state) => state.sessionRowDisplay);
  const providerBadges = rowElements.showProviderLogo
    ? <ProviderLogos providerIDs={run.providerIDs} ringClass="ring-sidebar opacity-60" />
    : null;
  // Muted like an idle session title; the run's state shows in its mark.
  const titleClassName = isActive ? 'text-interactive-selection-foreground' : 'text-muted-foreground';
  const openOverview = () => useUIStore.getState().setRunOverviewKey(run.key);

  // Timeline rows read like the session rows around them: the title with its
  // status and time, then what ran. They never expand; the overview lists lanes.
  if (isTimelineRow) {
    return (
      <button
        type="button"
        data-run-row={run.key}
        aria-current={isActive ? 'page' : undefined}
        aria-label={t('sessions.sidebar.run.openOverviewAria', { title: run.title })}
        onClick={openOverview}
        // The Tree view's one-line rows keep the tree slot for their state,
        // like the session rows beside them; List rows stay flat.
        style={{ paddingInlineStart: isTreeOneLineRow ? sessionTreeRowPaddingLeft(depth) : TIMELINE_ROW_LEFT_PX }}
        className={cn(
          'group relative my-0.5 flex w-full cursor-pointer items-center rounded-md pe-2.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          isOneLineRow ? 'gap-1.5 py-1' : 'py-1.5',
          isActive ? 'bg-interactive-selection/70 text-interactive-selection-foreground' : 'hover:bg-interactive-hover/60',
        )}
      >
        {isTreeOneLineRow ? <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">{activity}</span> : null}
        <SessionTimelineRowBody
          compact={isOneLineRow}
          project={timelineProject}
          projectLabel={projectLabel}
          projectLine={hasProjectLine}
          title={run.title}
          titleClassName={titleClassName}
          branchLabel={null}
          metaLineLead={(
            <>
              <ArrowsMerge className="h-3 w-3 flex-shrink-0 text-muted-foreground/40" aria-hidden="true" />
              <span className="min-w-0 truncate typography-micro text-muted-foreground/50">{laneCountLabel}</span>
            </>
          )}
          statusDot={isTreeOneLineRow ? null : activity}
          pinnedMarker={null}
          timeSlot={formatSessionCompactDateLabel(run.lastActivity)}
          directoryIndicator={null}
          prBadge={null}
          zombieIndicator={null}
          badges={providerBadges}
          hideMetaOnHoverClass=""
          elements={rowElements}
        />
      </button>
    );
  }

  const toggle = (event: React.SyntheticEvent) => {
    event.stopPropagation();
    if (!forceExpanded) toggleParent(expansionKey);
  };

  return (
    <div
      data-run-row={run.key}
      aria-current={isActive ? 'page' : undefined}
      onClick={openOverview}
      style={{ paddingInlineStart: sessionTreeRowPaddingLeft(depth) }}
      className={cn(
        'group relative my-0.5 flex cursor-pointer items-center gap-1.5 rounded-md py-[3px] pe-2.5',
        isActive ? 'bg-interactive-selection/70 text-interactive-selection-foreground' : 'hover:bg-interactive-hover/60',
      )}
    >
      <button
        type="button"
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle(event);
          }
        }}
        className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={expanded}
        aria-label={expanded ? t('sessions.sidebar.run.collapse') : t('sessions.sidebar.run.expand')}
      >
        <FileTreeChevron expanded={expanded} />
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          openOverview();
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t('sessions.sidebar.run.openOverviewAria', { title: run.title })}
      >
        <ArrowsMerge className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span dir="auto" className={cn('oc-ui-start-align block min-w-0 flex-1 truncate typography-ui-label font-normal', titleClassName)}>{run.title}</span>
        {rowElements.showProviderLogo ? <ProviderLogos providerIDs={run.providerIDs} ringClass="ring-sidebar" /> : null}
        {activity}
      </button>
    </div>
  );
}

export const RunSidebarRow = React.memo(RunSidebarRowComponent);

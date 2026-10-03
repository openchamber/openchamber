import React from 'react';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import { Icon } from '@/components/icon/Icon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import type { MultiRunSummary } from '@/lib/multirun/runs';
import type { SessionNode } from '../types';
import type { SessionSidebarRenderContext } from '../sessionSidebarRowModel';
import { formatSessionCompactDateLabel } from '../utils';
import { CollapsedSessionActivityIndicator } from './collapsedActivityIndicator';
import { SessionTimelineRowBody } from './SessionTimelineRowBody';

// Mirrors the session row gutter in SessionNodeItem so the run row's title
// lines up with session titles and its chevron with their chevrons.
const ROW_GUTTER_LEFT_PX = 6;
const ROW_DEPTH_STEP_PX = 14;
const ROW_TEXT_LEFT_PX = ROW_GUTTER_LEFT_PX + 14 + 6;
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
  const isTimelineRow = renderContext === 'timeline';
  const timelineProject = useProjectsStore(React.useCallback((state) => (
    isTimelineRow && projectId ? state.projects.find((entry) => entry.id === projectId) ?? null : null
  ), [isTimelineRow, projectId]));
  const laneCount = run.lanes.length;
  const laneCountLabel = laneCount === 1
    ? t('sessions.sidebar.run.laneCountSingle', { count: laneCount })
    : t('sessions.sidebar.run.laneCountPlural', { count: laneCount });
  const activityNodes = React.useMemo(() => [...laneNodes], [laneNodes]);
  const activity = <CollapsedSessionActivityIndicator nodes={activityNodes} blockingSessionIds={blockingSessionIds} includeUnreadSubtasks={notifyOnSubtasks} />;
  const titleClassName = isActive ? 'text-interactive-selection-foreground' : 'text-foreground/80';
  const openOverview = () => useUIStore.getState().setRunOverviewKey(run.key);

  // Timeline rows read like the session rows around them: project and time,
  // then the title, then what ran. They never expand; the overview lists lanes.
  if (isTimelineRow) {
    return (
      <button
        type="button"
        data-run-row={run.key}
        aria-current={isActive ? 'page' : undefined}
        aria-label={t('sessions.sidebar.run.openOverviewAria', { title: run.title })}
        onClick={openOverview}
        style={{ paddingLeft: ROW_GUTTER_LEFT_PX + 4 }}
        className={cn(
          'group relative my-0.5 flex w-full cursor-pointer items-center rounded-md py-1.5 pr-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          isActive ? 'bg-interactive-selection/70 text-interactive-selection-foreground' : 'hover:bg-interactive-hover/60',
        )}
      >
        <SessionTimelineRowBody
          project={timelineProject}
          projectLabel={projectLabel}
          title={run.title}
          titleClassName={titleClassName}
          branchLabel={null}
          thirdLineLead={(
            <>
              <ArrowsMerge className="h-3 w-3 flex-shrink-0 text-muted-foreground/40" aria-hidden="true" />
              <span className="min-w-0 truncate typography-micro text-muted-foreground/50">{laneCountLabel}</span>
            </>
          )}
          statusDot={activity}
          pinnedMarker={null}
          timeSlot={formatSessionCompactDateLabel(run.lastActivity)}
          directoryIndicator={null}
          prBadge={null}
          zombieIndicator={null}
          badges={<ProviderLogos providerIDs={run.providerIDs} ringClass="ring-sidebar opacity-60" />}
          hideMetaOnHoverClass=""
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
      style={{ paddingLeft: ROW_TEXT_LEFT_PX + depth * ROW_DEPTH_STEP_PX }}
      className={cn(
        'group relative my-0.5 flex cursor-pointer items-center rounded-md py-1 pr-2.5',
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
        style={{ left: ROW_GUTTER_LEFT_PX + depth * ROW_DEPTH_STEP_PX }}
        className="absolute top-1/2 inline-flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={expanded}
        aria-label={expanded ? t('sessions.sidebar.run.collapse') : t('sessions.sidebar.run.expand')}
      >
        <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          openOverview();
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t('sessions.sidebar.run.openOverviewAria', { title: run.title })}
      >
        <ArrowsMerge className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className={cn('block min-w-0 flex-1 truncate typography-ui-label font-normal', titleClassName)}>{run.title}</span>
        <ProviderLogos providerIDs={run.providerIDs} ringClass="ring-sidebar" />
        {activity}
      </button>
    </div>
  );
}

export const RunSidebarRow = React.memo(RunSidebarRowComponent);

import React from 'react';
import { useSessionTurnActive } from '@/sync/global-session-status';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import type { Session } from '@/lib/opencode/model';

import { Icon } from '@/components/icon/Icon';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { useSessionAiRenameAction } from '@/components/session/useSessionAiRenameAction';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useHasSessionActivityDuration } from '@/sync/session-activity-timing';

import { MobileProjectIcon, type MobileProjectIconProject } from './MobileProjectIcon';
import { MobileSessionRenameForm } from './MobileSessionRenameForm';
import { MobileSessionRowActions, MobileSwipeActionsRow, ROW_ACTION_SLOT_WIDTH, ROW_ACTIONS_WIDTH } from './MobileSessionSwipe';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import { CollapsedActivityIndicator } from '@/components/session/sidebar/sessions/collapsedActivityIndicator';
import { useCollapsedSessionActivityState } from '@/components/session/sidebar/sessions/collapsedActivityState';
import type { SessionNode } from '@/components/session/sidebar/types';
import type { MultiRunSummary } from '@/lib/multirun/runs';
import { useUIStore } from '@/stores/useUIStore';
import { formatRelativeShort, getSessionTimestamp } from './mobileSessionFields';
import { MobileRunProviderLogos } from './MobileRunProviderLogos';
import { MobileSessionGoalGlyph, MobileSessionPendingBadges } from './MobileSessionStateBadges';
import { usePendingRequestCounts } from './usePendingRequestCounts';
import { getSessionGoal } from '@/lib/sessionGoalMetadata';

export type TimelineProject = MobileProjectIconProject & { label: string };

export type TimelineEntry = {
  kind: 'session';
  session: Session;
  project: TimelineProject;
  /** Worktree branch for worktree sessions, project root branch otherwise.
      Null when no branch is known — the row then drops its third line. */
  branch: string | null;
} | {
  /** A multi-run takes one row at its first lane's position. */
  kind: 'run';
  run: MultiRunSummary;
  /** Lanes with their subsessions, for the aggregate activity indicator. */
  laneNodes: readonly SessionNode[];
  project: TimelineProject;
};

export type TimelineRowHandlers = {
  currentSessionId: string | null;
  revealedSessionId: string | null;
  confirmingDeleteSessionId: string | null;
  renamingSessionId: string | null;
  onSelect: (session: Session) => void;
  onRevealedChange: (sessionId: string, revealed: boolean) => void;
  onArchive: (session: Session) => void;
  onRequestDelete: (sessionId: string) => void;
  onConfirmDelete: (session: Session) => void;
  onRequestRename: (sessionId: string) => void;
  onSubmitRename: (sessionId: string, title: string) => void;
  onCancelRename: () => void;
  /** Track / Done; absent while the feature is off. */
  onToggleWork?: (session: Session, inWork: boolean) => void;
  isPinned: (session: Session) => boolean;
  onTogglePin: (session: Session) => void;
  /** Subsessions of a row, for the requests they are waiting on. */
  descendantIdsOf: (sessionId: string) => readonly string[];
};

const TIMELINE_ROW_INDENT = 12;

// Timeline rows are three lines inside a button; this padding, not a min-h-*
// utility, sets their height, because mobile.css gives every button a 36px
// floor that beats Tailwind's min-h-*.
const TIMELINE_ROW_LAYOUT_CLASS = 'flex min-w-0 flex-1 flex-col gap-1 py-2.5 pr-3 text-left';

/**
 * A multi-run in the timeline, shaped like the session rows around it:
 * project and time, then the title, then the run mark and lane count where a
 * session shows its branch. Tapping opens the run overview.
 */
const MobileTimelineRunRow: React.FC<{
  entry: Extract<TimelineEntry, { kind: 'run' }>;
}> = ({ entry }) => {
  const { t } = useI18n();
  const { run, project } = entry;
  const active = useUIStore((state) => state.runOverviewKey === run.key);
  const activity = useCollapsedSessionActivityState({ nodes: entry.laneNodes, includeUnreadSubtasks: false });
  const time = formatRelativeShort(run.lastActivity);
  const laneCount = run.lanes.length;
  return (
    <div
      data-active-session={active || undefined}
      className={cn('relative bg-background transition-colors', active && 'bg-[color-mix(in_srgb,var(--primary)_10%,var(--background))]')}
    >
      <button
        type="button"
        className={cn(TIMELINE_ROW_LAYOUT_CLASS, 'w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring')}
        style={{ paddingLeft: TIMELINE_ROW_INDENT, touchAction: 'manipulation' }}
        onClick={() => useUIStore.getState().setRunOverviewKey(run.key)}
        aria-label={t('sessions.sidebar.run.openOverviewAria', { title: run.title })}
      >
        <span className="flex min-w-0 items-center gap-2">
          <MobileProjectIcon project={project} size="sm" />
          <span className="block min-w-0 flex-1 truncate typography-micro text-muted-foreground">{project.label}</span>
          {activity ? <CollapsedActivityIndicator state={activity} /> : null}
          {time ? <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{time}</span> : null}
        </span>
        <span className={cn('block min-w-0 truncate typography-ui-label', active ? 'text-primary' : 'text-foreground')}>
          {run.title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <ArrowsMerge className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="block min-w-0 flex-1 truncate typography-micro">
            {laneCount === 1
              ? t('sessions.sidebar.run.laneCountSingle', { count: laneCount })
              : t('sessions.sidebar.run.laneCountPlural', { count: laneCount })}
          </span>
          <MobileRunProviderLogos providerIDs={run.providerIDs} />
        </span>
      </button>
    </div>
  );
};

const MobileTimelineRow: React.FC<{
  entry: Extract<TimelineEntry, { kind: 'session' }>;
  active: boolean;
  revealed: boolean;
  confirmingDelete: boolean;
  renaming: boolean;
  handlers: TimelineRowHandlers;
}> = ({ entry, active, revealed, confirmingDelete, renaming, handlers }) => {
  const { t } = useI18n();
  const { session, project, branch } = entry;
  const title = session.title?.trim() || t('mobile.sessions.untitled');
  const time = formatRelativeShort(getSessionTimestamp(session));
  const aiRename = useSessionAiRenameAction(session.id, session.directory, revealed || renaming);

  // Live indicators, same conventions as the grouped rows: busy/retry →
  // info dot; unseen activity on a non-active row → success dot.
  const unseenCount = useSessionUnseenCount(session.id);
  const isStreaming = useSessionTurnActive(session.id);
  const showUnreadDot = !isStreaming && unseenCount > 0 && !active;
  const hasActivityDuration = useHasSessionActivityDuration(session.id, isStreaming);
  const showActivityDuration = (isStreaming || showUnreadDot) && hasActivityDuration;
  const onToggleWork = handlers.onToggleWork;
  const inWork = isSessionInWork(session);
  const work = onToggleWork ? { inWork, onToggle: () => onToggleWork(session, inWork) } : undefined;
  const pinned = handlers.isPinned(session);
  const pin = { pinned, onToggle: () => handlers.onTogglePin(session) };
  // Timeline rows never expand, so their subsessions' requests count here.
  const { descendantIdsOf } = handlers;
  const familyIds = React.useMemo(() => [session.id, ...descendantIdsOf(session.id)], [descendantIdsOf, session.id]);
  const pendingRequests = usePendingRequestCounts(familyIds);
  const hasPendingRequests = pendingRequests.permissionCount > 0 || pendingRequests.formCount > 0;
  const hasGoal = getSessionGoal(session) !== null;

  return (
    <MobileSwipeActionsRow
      // Every timeline row is top-level, so Pin is always there.
      actionsWidth={ROW_ACTIONS_WIDTH + ROW_ACTION_SLOT_WIDTH + (work ? ROW_ACTION_SLOT_WIDTH : 0)}
      revealed={revealed}
      onRevealedChange={(next) => handlers.onRevealedChange(session.id, next)}
      dataActiveSession={active}
      contentClassName={cn(
        'relative flex w-full items-center bg-background transition-colors',
        active && 'bg-[color-mix(in_srgb,var(--primary)_10%,var(--background))]',
      )}
      actions={(
        <MobileSessionRowActions
          sessionId={session.id}
          title={title}
          revealed={revealed}
          confirmingDelete={confirmingDelete}
          onArchive={() => handlers.onArchive(session)}
          onRequestDelete={() => handlers.onRequestDelete(session.id)}
          onConfirmDelete={() => handlers.onConfirmDelete(session)}
          onRequestRename={() => handlers.onRequestRename(session.id)}
          onRevealedChange={(next) => handlers.onRevealedChange(session.id, next)}
          work={work}
          pin={pin}
        />
      )}
    >
      {(() => {
        const lines = (
          <>
            <span className="flex min-w-0 items-center gap-2">
              <MobileProjectIcon project={project} size="sm" />
              <span className="block min-w-0 flex-1 truncate typography-micro text-muted-foreground">
                {project.label}
              </span>
              {pinned ? (
                <Icon name="pushpin" className="size-3 shrink-0 text-muted-foreground" aria-label={t('sessions.sidebar.session.status.pinned')} />
              ) : null}
              {aiRename.pending ? (
                <Icon name="loader-4" className="size-3 shrink-0 animate-spin text-primary" aria-label={t('sessions.aiRename.generating')} />
              ) : isStreaming || showUnreadDot ? (
                <SessionActivityIndicator
                  state={isStreaming ? 'running' : 'unread'}
                  label={isStreaming ? t('sessions.sidebar.session.status.active') : t('sessions.sidebar.session.status.unread')}
                />
              ) : null}
              {showActivityDuration ? (
                <SessionActivityDuration sessionId={session.id} running={isStreaming} className="shrink-0 typography-micro" />
              ) : time ? (
                <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{time}</span>
              ) : null}
            </span>
            {renaming ? (
              // The title line becomes the editor; project and branch stay put
              // so the card does not change shape while renaming.
              <MobileSessionRenameForm
                initialTitle={title}
                indent={0}
                aiRename={aiRename}
                // One title line tall; the save/cancel controls shrink to fit it.
                className="h-[1lh] pr-0 typography-ui-label [&_button]:size-6 [&_button>svg]:size-3.5"
                onSubmit={(next) => handlers.onSubmitRename(session.id, next)}
                onCancel={handlers.onCancelRename}
              />
            ) : (
              <span className={cn('block min-w-0 truncate typography-ui-label', active ? 'text-primary' : 'text-foreground')}>
                {title}
              </span>
            )}
            {branch || hasGoal || hasPendingRequests ? (
              // Branch on the left; goal and waiting requests close the line,
              // the same state cluster the desktop timeline row ends with.
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                {branch ? (
                  <>
                    <Icon name="git-branch" className="size-3.5 shrink-0" />
                    <span className="block min-w-0 truncate typography-micro">{branch}</span>
                  </>
                ) : null}
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  <MobileSessionGoalGlyph session={session} />
                  <MobileSessionPendingBadges {...pendingRequests} />
                </span>
              </span>
            ) : null}
          </>
        );
        const layoutClassName = TIMELINE_ROW_LAYOUT_CLASS;
        if (renaming) {
          return <div className={layoutClassName} style={{ paddingLeft: TIMELINE_ROW_INDENT }}>{lines}</div>;
        }
        return (
          <button
            type="button"
            className={cn(layoutClassName, 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring')}
            style={{ paddingLeft: TIMELINE_ROW_INDENT, touchAction: 'manipulation' }}
            onClick={() => {
              // A tap while the actions are out just closes them.
              if (revealed) {
                handlers.onRevealedChange(session.id, false);
                return;
              }
              handlers.onSelect(session);
            }}
          >
            {lines}
          </button>
        );
      })()}
    </MobileSwipeActionsRow>
  );
};

/** Watches the end of the list inside the sheet's own scroller and asks for
    the next page before the user reaches the bottom. Re-created whenever the
    revealed count changes, because a sentinel that stays intersecting never
    fires a second time on its own. */
const TimelineEndSentinel: React.FC<{
  scrollRootRef: React.RefObject<HTMLElement | null>;
  visibleCount: number;
  onReachEnd: () => void;
}> = ({ scrollRootRef, visibleCount, onReachEnd }) => {
  const sentinelRef = React.useRef<HTMLDivElement>(null);
  const onReachEndRef = React.useRef(onReachEnd);
  React.useEffect(() => {
    onReachEndRef.current = onReachEnd;
  }, [onReachEnd]);

  React.useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onReachEndRef.current();
      },
      { root: scrollRootRef.current ?? null, rootMargin: '400px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [scrollRootRef, visibleCount]);

  return <div ref={sentinelRef} aria-hidden className="h-px w-full" />;
};

/** Flat "Projects" timeline: every non-archived root project session across
    all projects and worktrees, in one lifecycle-ordered list. */
export const MobileTimelineList: React.FC<{
  entries: TimelineEntry[];
  visibleCount: number;
  onRevealMore: () => void;
  scrollRootRef: React.RefObject<HTMLElement | null>;
  handlers: TimelineRowHandlers;
}> = ({ entries, visibleCount, onRevealMore, scrollRootRef, handlers }) => {
  const { t } = useI18n();
  const visibleEntries = entries.slice(0, visibleCount);

  return (
    <section className="border-t border-border/70">
      <div className="flex min-h-12 w-full items-center gap-2 px-3 py-1.5">
        <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--surface-muted)] text-muted-foreground">
          <Icon name="folder-6" className="size-4" />
        </span>
        <span className="block min-w-0 flex-1 truncate typography-ui-label font-semibold text-foreground">
          {t('mobile.sessions.section.projects')}
        </span>
        <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{entries.length}</span>
      </div>
      <div className="pb-2">
        {visibleEntries.map((entry) => (entry.kind === 'run' ? (
          <MobileTimelineRunRow key={`run:${entry.run.key}`} entry={entry} />
        ) : (
          <MobileTimelineRow
            key={entry.session.id}
            entry={entry}
            active={handlers.currentSessionId === entry.session.id}
            revealed={handlers.revealedSessionId === entry.session.id}
            confirmingDelete={handlers.confirmingDeleteSessionId === entry.session.id}
            renaming={handlers.renamingSessionId === entry.session.id}
            handlers={handlers}
          />
        )))}
        {visibleEntries.length < entries.length ? (
          <TimelineEndSentinel
            scrollRootRef={scrollRootRef}
            visibleCount={visibleCount}
            onReachEnd={onRevealMore}
          />
        ) : null}
      </div>
    </section>
  );
};

import React from 'react';
import { useSessionTurnActivity } from '@/sync/global-session-status';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import type { Session } from '@/lib/opencode/model';

import { Icon } from '@/components/icon/Icon';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { useSessionAiRenameAction } from '@/components/session/useSessionAiRenameAction';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionUnread } from '@/sync/session-unread';
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
import { usePendingRequests } from './usePendingRequests';
import { mobileSessionTitleClass } from './mobileSessionTitle';

export type TimelineProject = MobileProjectIconProject & { label: string };

export type TimelineEntry = {
  kind: 'session';
  session: Session;
  project: TimelineProject;
  /** Worktree branch for worktree sessions, project root branch otherwise.
      Null when no branch is known; the second line then holds only state. */
  branch: string | null;
  /** The branch is an isolated space's name; the row marks it with the space's container icon. */
  inSpace: boolean;
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

/** Left padding of timeline rows and of the Show more / Show fewer rows under them. */
export const TIMELINE_ROW_INDENT = 12;

// Timeline rows are two lines inside a button; this padding, not a min-h-*
// utility, sets their height, because mobile.css gives every button a 36px
// floor that beats Tailwind's min-h-*.
const TIMELINE_ROW_LAYOUT_CLASS = 'flex min-w-0 flex-1 flex-col gap-1 py-2.5 pe-3 text-start';

// The second line has a fixed height and is always rendered, so a row without
// a branch is as tall as its neighbours and a branch arriving does not move
// the list.
const TIMELINE_META_LINE_CLASS = 'flex h-4 min-w-0 items-center gap-1.5 text-muted-foreground';

// One-line rows (Pinned and In work in the Tree view): the title line alone,
// with the goal and waiting requests joining its status cluster.
const COMPACT_ROW_LAYOUT_CLASS = 'flex min-w-0 flex-1 flex-col justify-center py-2.5 pe-3 text-start';

/** The project's icon, opening the second line where projects mix. */
const TimelineRowProject: React.FC<{ project: TimelineProject }> = ({ project }) => (
  <span role="img" aria-label={project.label} className="inline-flex shrink-0">
    <MobileProjectIcon project={project} size="xs" />
  </span>
);

/** The list by time: the project's icon and name on a first line of their
    own, with the row's state and time at its end. */
const TimelineRowProjectLine: React.FC<{ project: TimelineProject; children: React.ReactNode }> = ({ project, children }) => (
  <span className="flex h-4 min-w-0 items-center gap-1.5">
    <MobileProjectIcon project={project} size="xs" />
    <span className="block min-w-0 flex-1 truncate typography-micro text-muted-foreground">{project.label}</span>
    <span className="flex shrink-0 items-center gap-2">{children}</span>
  </span>
);

/**
 * A multi-run in the timeline, shaped like the session rows around it: the
 * title with its activity and time, then the run mark and lane count where a
 * session shows its branch. Tapping opens the run overview.
 */
const MobileTimelineRunRow: React.FC<{
  entry: Extract<TimelineEntry, { kind: 'run' }>;
  showProject: boolean;
  projectLine: boolean;
  compact: boolean;
}> = ({ entry, showProject, projectLine, compact }) => {
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
        className={cn(compact ? COMPACT_ROW_LAYOUT_CLASS : TIMELINE_ROW_LAYOUT_CLASS, 'w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring')}
        style={{ paddingInlineStart: TIMELINE_ROW_INDENT, touchAction: 'manipulation' }}
        onClick={() => useUIStore.getState().setRunOverviewKey(run.key)}
        aria-label={t('sessions.sidebar.run.openOverviewAria', { title: run.title })}
      >
        {(() => {
          const status = <>
            {activity ? <CollapsedActivityIndicator state={activity} /> : null}
            {time ? <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{time}</span> : null}
          </>;
          const titleText = (
            <span dir="auto" className={cn('block min-w-0 flex-1 truncate oc-ui-start-align typography-ui-label', active ? 'text-primary' : 'text-foreground')}>
              {run.title}
            </span>
          );
          return projectLine && !compact ? <>
            <TimelineRowProjectLine project={project}>{status}</TimelineRowProjectLine>
            <span className="flex min-w-0 items-center">{titleText}</span>
          </> : (
            <span className="flex min-w-0 items-center gap-2">
              {titleText}
              {status}
            </span>
          );
        })()}
        {compact ? null : <span className={TIMELINE_META_LINE_CLASS}>
          {showProject && !projectLine ? <TimelineRowProject project={project} /> : null}
          <ArrowsMerge className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="block min-w-0 flex-1 truncate typography-micro">
            {laneCount === 1
              ? t('sessions.sidebar.run.laneCountSingle', { count: laneCount })
              : t('sessions.sidebar.run.laneCountPlural', { count: laneCount })}
          </span>
          <MobileRunProviderLogos providerIDs={run.providerIDs} />
        </span>}
      </button>
    </div>
  );
};

const MobileTimelineRow: React.FC<{
  entry: Extract<TimelineEntry, { kind: 'session' }>;
  showProject: boolean;
  projectLine: boolean;
  compact: boolean;
  pinMarker: boolean;
  active: boolean;
  revealed: boolean;
  confirmingDelete: boolean;
  renaming: boolean;
  handlers: TimelineRowHandlers;
}> = ({ entry, showProject, projectLine, compact, pinMarker, active, revealed, confirmingDelete, renaming, handlers }) => {
  const { t } = useI18n();
  const { session, project, branch, inSpace } = entry;
  const title = session.title?.trim() || t('mobile.sessions.untitled');
  const time = formatRelativeShort(getSessionTimestamp(session));
  const aiRename = useSessionAiRenameAction(session.id, session.directory, revealed || renaming);

  // Live indicators, same conventions as the grouped rows: busy/retry →
  // running-kind icon; unseen activity on a non-active row → unread icon.
  // Unread (an unseen turn or a mark), as one count the row's dot reads.
  const unseenCount = useSessionUnread(session.id) ? 1 : 0;
  const turnActivity = useSessionTurnActivity(session.id);
  const isStreaming = turnActivity !== null;
  const showUnreadDot = !isStreaming && unseenCount > 0 && !active;
  const hasActivityDuration = useHasSessionActivityDuration(session.id, isStreaming);
  const showActivityDuration = (isStreaming || showUnreadDot) && hasActivityDuration;
  const onToggleWork = handlers.onToggleWork;
  const inWork = isSessionInWork(session);
  const work = onToggleWork ? { inWork, onToggle: () => onToggleWork(session, inWork) } : undefined;
  const pinned = handlers.isPinned(session);
  const pin = { pinned, onToggle: () => handlers.onTogglePin(session) };
  // Timeline rows never expand, so their subsessions' requests show here.
  const { descendantIdsOf } = handlers;
  const familyIds = React.useMemo(() => [session.id, ...descendantIdsOf(session.id)], [descendantIdsOf, session.id]);
  const pendingRequests = usePendingRequests(familyIds);

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
        const status = (
          <>
            {compact ? (
              <>
                <MobileSessionGoalGlyph session={session} />
                <MobileSessionPendingBadges {...pendingRequests} />
              </>
            ) : null}
            {pinned && pinMarker ? (
              <Icon name="pushpin" className="size-3 shrink-0 text-muted-foreground" aria-label={t('sessions.sidebar.session.status.pinned')} />
            ) : null}
            {aiRename.pending ? (
              <Icon name="loader-4" className="size-3 shrink-0 animate-spin text-primary" aria-label={t('sessions.aiRename.generating')} />
            ) : isStreaming || showUnreadDot ? (
              <SessionActivityIndicator
                state={turnActivity ?? 'unread'}
              />
            ) : null}
            {showActivityDuration ? (
              <SessionActivityDuration sessionId={session.id} running={isStreaming} className="shrink-0 typography-micro" />
            ) : time ? (
              <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{time}</span>
            ) : null}
          </>
        );
        // The list by time names the project on a first line of its own and
        // moves the state and time there, so the title gets the whole line.
        const withProjectLine = projectLine && !compact;
        const lines = (
          <>
            {withProjectLine ? <TimelineRowProjectLine project={project}>{status}</TimelineRowProjectLine> : null}
            {renaming ? (
              // The title line becomes the editor; the branch line stays put
              // so the card does not change shape while renaming.
              <MobileSessionRenameForm
                initialTitle={title}
                indent={0}
                aiRename={aiRename}
                // One title line tall; the save/cancel controls shrink to fit it.
                className="h-[1lh] pe-0 typography-ui-label [&_button]:size-6 [&_button>svg]:size-3.5"
                onSubmit={(next) => handlers.onSubmitRename(session.id, next)}
                onCancel={handlers.onCancelRename}
              />
            ) : (
              <span className="flex min-w-0 items-center gap-2">
                <span dir="auto" className={cn('block min-w-0 flex-1 truncate oc-ui-start-align typography-ui-label', mobileSessionTitleClass({ active, unread: showUnreadDot, running: isStreaming, pending: pendingRequests }))}>
                  {title}
                </span>
                {withProjectLine ? null : status}
              </span>
            )}
            {/* Branch on the left; goal and waiting requests close the line,
                the same state cluster the desktop timeline row ends with. */}
            {compact ? null : <span className={TIMELINE_META_LINE_CLASS}>
              {showProject && !withProjectLine ? <TimelineRowProject project={project} /> : null}
              {branch ? (
                <>
                  {inSpace
                    ? <Icon name="box-3" className="size-3.5 shrink-0" aria-hidden={false} role="img" aria-label={t('sessions.sidebar.group.space')} />
                    : <Icon name="git-branch" className="size-3.5 shrink-0" />}
                  <span className="block min-w-0 truncate typography-micro">{branch}</span>
                </>
              ) : null}
              <span className="ms-auto flex shrink-0 items-center gap-1.5">
                <MobileSessionGoalGlyph session={session} />
                <MobileSessionPendingBadges {...pendingRequests} />
              </span>
            </span>}
          </>
        );
        const layoutClassName = compact ? COMPACT_ROW_LAYOUT_CLASS : TIMELINE_ROW_LAYOUT_CLASS;
        if (renaming) {
          return <div className={layoutClassName} style={{ paddingInlineStart: TIMELINE_ROW_INDENT }}>{lines}</div>;
        }
        return (
          <button
            type="button"
            className={cn(layoutClassName, 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring')}
            style={{ paddingInlineStart: TIMELINE_ROW_INDENT, touchAction: 'manipulation' }}
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

/** Two-line timeline rows. Under a project header they need no project mark;
    Pinned and In work mix projects, so there each row shows its project's
    icon. `projectLine` gives the list by time three lines, the project's
    icon and name on the first. `compact` puts a row on one line, the Tree
    view's default for Pinned and In work. The Pinned section passes
    `pinMarker={false}`: its header already says every row there is pinned. */
export const MobileTimelineRows: React.FC<{
  entries: readonly TimelineEntry[];
  showProject: boolean;
  projectLine?: boolean;
  compact?: boolean;
  pinMarker?: boolean;
  handlers: TimelineRowHandlers;
}> = ({ entries, showProject, projectLine = false, compact = false, pinMarker = true, handlers }) => (
  <>
    {entries.map((entry) => (entry.kind === 'run' ? (
      <MobileTimelineRunRow key={`run:${entry.run.key}`} entry={entry} showProject={showProject} projectLine={projectLine} compact={compact} />
    ) : (
      <MobileTimelineRow
        key={entry.session.id}
        entry={entry}
        showProject={showProject}
        projectLine={projectLine}
        compact={compact}
        pinMarker={pinMarker}
        active={handlers.currentSessionId === entry.session.id}
        revealed={handlers.revealedSessionId === entry.session.id}
        confirmingDelete={handlers.confirmingDeleteSessionId === entry.session.id}
        renaming={handlers.renamingSessionId === entry.session.id}
        handlers={handlers}
      />
    )))}
  </>
);

/** Watches the end of the list by time inside the sheet's own scroller and
    asks for the next page before the user reaches the bottom: the sheet is a
    plain scroller, so a workspace with thousands of sessions must not mount
    them all at once. Re-created whenever the revealed count changes, because
    a sentinel that stays in view never fires a second time on its own. */
export const TimelineEndSentinel: React.FC<{
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

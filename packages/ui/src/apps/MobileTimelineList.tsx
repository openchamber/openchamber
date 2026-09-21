import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2/client';

import { Icon } from '@/components/icon/Icon';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { useSessionAiRenameAction } from '@/components/session/useSessionAiRenameAction';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useHasSessionActivityDuration } from '@/sync/session-activity-timing';
import { useGlobalSessionStatus } from '@/sync/sync-context';

import { MobileProjectIcon, type MobileProjectIconProject } from './MobileProjectIcon';
import { MobileSessionRenameForm } from './MobileSessionRenameForm';
import { MobileSessionRowActions, MobileSwipeActionsRow, ROW_ACTIONS_WIDTH } from './MobileSessionSwipe';
import { formatRelativeShort, getSessionTimestamp } from './mobileSessionFields';

export type TimelineProject = MobileProjectIconProject & { label: string };

export type TimelineEntry = {
  session: Session;
  project: TimelineProject;
  /** Worktree branch for worktree sessions, project root branch otherwise.
      Null when no branch is known — the row then drops its third line. */
  branch: string | null;
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
};

const TIMELINE_ROW_INDENT = 12;

const MobileTimelineRow: React.FC<{
  entry: TimelineEntry;
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
  const aiRename = useSessionAiRenameAction(session.id, session.directory, revealed);

  // Live indicators, same conventions as the grouped rows: busy/retry →
  // info dot; unseen activity on a non-active row → success dot.
  const liveStatus = useGlobalSessionStatus(session.id);
  const unseenCount = useSessionUnseenCount(session.id);
  const statusType = liveStatus?.type ?? 'idle';
  const isStreaming = statusType === 'busy' || statusType === 'retry';
  const showUnreadDot = !isStreaming && unseenCount > 0 && !active;
  const hasActivityDuration = useHasSessionActivityDuration(session.id, isStreaming);
  const showActivityDuration = (isStreaming || showUnreadDot) && hasActivityDuration;

  return (
    <MobileSwipeActionsRow
      actionsWidth={ROW_ACTIONS_WIDTH}
      revealed={revealed}
      onRevealedChange={(next) => handlers.onRevealedChange(session.id, next)}
      dataActiveSession={active}
      contentClassName={cn(
        'relative flex w-full items-center bg-background transition-colors',
        active && 'bg-[color-mix(in_srgb,var(--primary)_10%,var(--background))]',
      )}
      actions={(
        <MobileSessionRowActions
          title={title}
          revealed={revealed}
          confirmingDelete={confirmingDelete}
          aiRename={aiRename}
          onArchive={() => handlers.onArchive(session)}
          onRequestDelete={() => handlers.onRequestDelete(session.id)}
          onConfirmDelete={() => handlers.onConfirmDelete(session)}
          onRequestRename={() => handlers.onRequestRename(session.id)}
          onRevealedChange={(next) => handlers.onRevealedChange(session.id, next)}
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
              {aiRename.pending ? (
                <Icon name="loader-4" className="size-3 shrink-0 animate-spin text-primary" aria-label={t('sessions.aiRename.generating')} />
              ) : isStreaming || showUnreadDot ? (
                <span
                  className={cn('size-1.5 shrink-0 rounded-full', isStreaming ? 'bg-[var(--status-info)]' : 'bg-[var(--status-success)]')}
                  aria-hidden
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
            {branch ? (
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <Icon name="git-branch" className="size-3.5 shrink-0" />
                <span className="block min-w-0 truncate typography-micro">{branch}</span>
              </span>
            ) : null}
          </>
        );
        // Explicit padding instead of a min-height utility: mobile.css gives
        // every button a 36px floor that beats Tailwind's min-h-*, so the
        // row's height comes from its own three lines plus this padding.
        const layoutClassName = 'flex min-w-0 flex-1 flex-col gap-1 py-2.5 pr-3 text-left';
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
        {visibleEntries.map((entry) => (
          <MobileTimelineRow
            key={entry.session.id}
            entry={entry}
            active={handlers.currentSessionId === entry.session.id}
            revealed={handlers.revealedSessionId === entry.session.id}
            confirmingDelete={handlers.confirmingDeleteSessionId === entry.session.id}
            renaming={handlers.renamingSessionId === entry.session.id}
            handlers={handlers}
          />
        ))}
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

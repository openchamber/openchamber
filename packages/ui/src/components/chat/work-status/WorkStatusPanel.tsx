import React from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { useUIStore } from '@/stores/useUIStore';
import { WORK_STATUS_PANEL_WIDTH } from './useWorkStatusVisibility';
import { WorkStatusGoalRow } from './WorkStatusGoalRow';
import { WorkStatusPrimaryGroup } from './WorkStatusPrimaryGroup';
import { WorkStatusUsageSection } from './WorkStatusUsageSection';
import { WorkStatusSubagentsSection } from './WorkStatusSubagentsSection';
import { WorkStatusTasksSection } from './WorkStatusTasksSection';
import { WorkStatusMcpSection } from './WorkStatusMcpSection';
import { WorkStatusPinnedSection } from './WorkStatusPinnedSection';
import { WorkStatusContextSection } from './WorkStatusContextSection';
import { WorkStatusSectionsDialog } from './WorkStatusSectionsDialog';
import { isWorkStatusSectionVisible } from './sections';
import { Icon } from '@/components/icon/Icon';

type Props = {
  /** Null on a new-session draft: repository readouts still apply. */
  sessionId: string | null;
  directory: string | null;
  /** Whether the panel should currently occupy space. */
  visible: boolean;
};

/**
 * Matches the context panel's own width animation exactly.
 *
 * The two are siblings of the transcript, and opening the context panel hides
 * this one. With an instant unmount the chat first jumped wider (this panel
 * gone) and then eased narrower (the context panel expanding) — two opposite
 * width changes in a row, which reads as a flutter. Collapsing on the same
 * curve and duration makes the chat's width move once, in one direction.
 */
const PANEL_TRANSITION_MS = 200;
const PANEL_TRANSITION_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * Work-status panel: a card inside the chat column reporting the state of the
 * session, its branch and its subagents.
 *
 * Ordering is by durability, not by category. The first sections hold readouts
 * that stay true for the whole session, then the state of the work in flight,
 * then episodic material an agent may never produce. Each section renders
 * nothing when it has nothing, so the panel collapses toward the top instead of
 * reserving empty space.
 *
 * The card clips; the scroller lives inside it, so the same top/bottom scroll
 * shadows the transcript uses stay within the rounded border instead of
 * bleeding past it. The scrollbar itself is hidden — at this width it would
 * eat a visible slice of every row's trailing value, and the shadows already
 * say there is more to see.
 */
export const WorkStatusPanel: React.FC<Props> = ({ sessionId, directory, visible }) => {
  const { t } = useI18n();
  const setScrollTop = useUIStore((state) => state.setWorkStatusScrollTop);
  const hiddenSections = useUIStore((state) => state.workStatusHiddenSections);
  const [sectionsDialogOpen, setSectionsDialogOpen] = React.useState(false);
  const sectionVisible = React.useCallback(
    (sectionId: Parameters<typeof isWorkStatusSectionVisible>[1]) =>
      isWorkStatusSectionVisible(hiddenSections, sectionId),
    [hiddenSections],
  );
  const frameRef = React.useRef<number | null>(null);

  // Restoring the offset has to happen the moment the scroller attaches, and
  // the panel unmounts whenever the context panel opens. Reading the stored
  // value through a ref keeps this a mount-time restore rather than a
  // subscription that would fight the user mid-scroll.
  // Content is dropped only after the collapse finishes, so the card animates
  // out with something in it rather than emptying first, and its subscriptions
  // stop once it is truly gone.
  const [contentMounted, setContentMounted] = React.useState(visible);
  React.useEffect(() => {
    if (visible) {
      setContentMounted(true);
      return undefined;
    }
    const timer = window.setTimeout(() => setContentMounted(false), PANEL_TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);

  const restore = React.useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const stored = useUIStore.getState().workStatusScrollTop;
    if (stored > 0) node.scrollTop = stored;
  }, []);

  // Coalesced to one write per frame: scroll fires far faster than the store
  // needs to hear about it.
  const handleScroll = React.useCallback((event: React.UIEvent<HTMLElement>) => {
    const { scrollTop } = event.currentTarget;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setScrollTop(scrollTop);
    });
  }, [setScrollTop]);

  React.useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  return (
    <aside
      aria-label={t('chat.workStatus.ariaLabel')}
      aria-hidden={!visible}
      className={cn(
        // `self-start` keeps the card at content height instead of stretching
        // to the row; `max-h` then caps it so a long panel scrolls rather than
        // overflowing the chat.
        // A left margin as well as a right one: flush against the transcript
        // the card's own shadow had no room and was clipped down that edge.
        'relative my-4 flex shrink-0 flex-col self-start overflow-hidden',
        'max-h-[calc(100%-2rem)]',
        visible ? 'ml-2 mr-4' : 'ml-0 mr-0',
        'motion-reduce:transition-none',
        'rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-muted)]/40',
        // A lighter version of the composer's lift: the same shape, but this
        // card is taller, so the composer's spread reads as heavy here.
        'shadow-[0_2px_8px_-3px_rgb(0_0_0_/_0.08)]',
      )}
      style={{
        width: visible ? WORK_STATUS_PANEL_WIDTH : 0,
        opacity: visible ? 1 : 0,
        // Leaves to the right and arrives from it, so the card reads as sliding
        // out past the window edge rather than dissolving in place.
        transform: visible ? 'translateX(0)' : `translateX(${WORK_STATUS_PANEL_WIDTH / 4}px)`,
        transitionProperty: 'width, opacity, transform, margin',
        transitionDuration: `${PANEL_TRANSITION_MS}ms`,
        transitionTimingFunction: PANEL_TRANSITION_EASING,
        pointerEvents: visible ? undefined : 'none',
      }}
    >
      {/* Overlaid rather than placed in flow: the panel has no header of its
          own, and giving it one would cost a row of height on every session. */}
      <button
        type="button"
        aria-label={t('chat.workStatus.sections.open')}
        onClick={() => setSectionsDialogOpen(true)}
        className="absolute right-2 top-1.5 z-10 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <Icon name="equalizer-2" className="size-4" />
      </button>

      {contentMounted ? (
      <ScrollShadow
        ref={restore}
        onScroll={handleScroll}
        size={24}
        className="oc-hide-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2"
      >
        <WorkStatusPrimaryGroup
          sessionId={sessionId}
          directory={directory}
          showSession={sectionVisible('session')}
          showRepository={sectionVisible('repository')}
          goalRow={<WorkStatusGoalRow sessionId={sessionId} directory={directory} />}
        />
        {sectionVisible('usage') ? <WorkStatusUsageSection /> : null}
        {sectionVisible('subagents') ? <WorkStatusSubagentsSection sessionId={sessionId} directory={directory} /> : null}
        {sectionVisible('tasks') ? <WorkStatusTasksSection sessionId={sessionId} directory={directory} /> : null}
        {sectionVisible('mcp') ? <WorkStatusMcpSection directory={directory} /> : null}
        {sectionVisible('pinned') ? <WorkStatusPinnedSection sessionId={sessionId} directory={directory} /> : null}
        {sectionVisible('contextSources') ? <WorkStatusContextSection sessionId={sessionId} directory={directory} /> : null}
      </ScrollShadow>
      ) : null}

      <WorkStatusSectionsDialog open={sectionsDialogOpen} onOpenChange={setSectionsDialogOpen} />
    </aside>
  );
};

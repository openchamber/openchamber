import React from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { Button } from '@/components/ui/button';
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
import {
  areAllWorkStatusSectionsHidden,
  getWorkStatusPanelPresentation,
  isWorkStatusSectionVisible,
} from './sections';
import { WorkStatusPresenceProvider } from './presence';
import { Icon } from '@/components/icon/Icon';

type Props = {
  /** Null on a new-session draft: repository readouts still apply. */
  sessionId: string | null;
  directory: string | null;
  /** Managed Chats have no project repository, even if another project remains active. */
  repositoryEnabled?: boolean;
  /** Whether the panel should currently occupy space. */
  visible: boolean;
  /**
   * Floats over the transcript instead of sitting beside it, for when the chat
   * is too narrow to give it a column of its own.
   */
  overlay?: boolean;
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
export const WorkStatusPanel: React.FC<Props> = ({ sessionId, directory, visible, repositoryEnabled = true, overlay = false }) => {
  const { t } = useI18n();
  const setScrollTop = useUIStore((state) => state.setWorkStatusScrollTop);
  const setOverlayOpen = useUIStore((state) => state.setWorkStatusOverlayOpen);
  const hiddenSections = useUIStore((state) => state.workStatusHiddenSections);
  const [sectionsDialogOpen, setSectionsDialogOpen] = React.useState(false);
  // Starts optimistic: sections report after their first commit, and rendering
  // nothing on the way in would make the card flash out and back on arrival.
  const [renderedSections, setRenderedSections] = React.useState(1);
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
  // Hidden or mid-collapse: the card is not something the user can act on.
  // When `visible` but all sections are hidden, the panel stays interactive so
  // the settings button remains reachable — otherwise there is no way to
  // re-enable sections. The previous `renderedSections > 0` guard is preserved
  // for the transient "no data yet" state so the panel doesn't flash a bare
  // bordered card on first mount.
  const allSectionsHidden = areAllWorkStatusSectionsHidden(hiddenSections);
  const { interactive, showEmptyState } = getWorkStatusPanelPresentation({
    visible,
    contentMounted,
    renderedSections,
    allSectionsHidden,
  });
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

  // The offset belongs to the panel a session produced, not to the panel in
  // general: restoring one session's scroll into another's shorter panel lands
  // somewhere arbitrary.
  React.useEffect(() => {
    setScrollTop(0);
  }, [sessionId, setScrollTop]);

  // Dismissed like any transient surface: a click elsewhere or Escape. It
  // covers the transcript, so leaving it up would block the thing it reports on.
  const overlayRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    // Only while it is actually up: a hidden overlay listening for clicks would
    // swallow the very press that opens it.
    if (!overlay || !visible) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (overlayRef.current?.contains(target)) return;
      // The header toggle closes it on its own; letting this fire too would
      // close and immediately reopen.
      if (target?.closest('[data-work-status-toggle]')) return;
      setOverlayOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOverlayOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [overlay, setOverlayOpen, visible]);

  return (
    <aside
      ref={overlayRef}
      aria-label={t('chat.workStatus.ariaLabel')}
      aria-hidden={!interactive}
      // The card stays mounted while hidden so it can animate its own collapse,
      // and the sections button sits outside the content gate. Without `inert`
      // Tab could land on an invisible control — and `aria-hidden` around a
      // focusable descendant is an accessibility fault in its own right.
      inert={!interactive}
      className={cn(
        // `self-start` keeps the card at content height instead of stretching
        // to the row; `max-h` then caps it so a long panel scrolls rather than
        // overflowing the chat.
        // A left margin as well as a right one: flush against the transcript
        // the card's own shadow had no room and was clipped down that edge.
        'relative my-4 flex shrink-0 flex-col self-start overflow-hidden',
        'max-h-[calc(100%-2rem)]',
        interactive ? 'ml-2 mr-4' : 'ml-0 mr-0',
        // Out of the flow entirely, anchored to the chat column's top-right so
        // it reads as a dropdown from the header button. As a flex child it
        // took part in the layout and pushed the transcript, which is the one
        // thing an overlay must not do. Stronger shadow: it sits on content now.
        overlay && [
          'absolute right-3 top-3 z-30 mx-0 my-0',
          'max-h-[calc(100%-1.5rem)]',
          'shadow-[0_8px_28px_-8px_rgb(0_0_0_/_0.28)]',
          // Beside the transcript the translucent fill reads as depth; on top
          // of it, message bubbles showed straight through the rows. Frosting
          // separates the two without going fully opaque.
          'oc-glass-panel',
        ],
        // When every section is hidden the card keeps its border and background
        // so the settings button stays discoverable — going transparent made the
        // only recovery path unreachable.
        'motion-reduce:transition-none',
        'rounded-xl border border-[var(--interactive-border)]',
        !overlay && 'bg-[var(--surface-muted)]/40',
        // A lighter version of the composer's lift: the same shape, but this
        // card is taller, so the composer's spread reads as heavy here.
        'shadow-[0_2px_8px_-3px_rgb(0_0_0_/_0.08)]',
      )}
      style={{
        // The overlay keeps its width: it takes no space from the chat, so
        // collapsing it would animate a dimension nothing depends on. It fades
        // and lifts instead, like the dropdown it reads as.
        width: overlay || interactive ? WORK_STATUS_PANEL_WIDTH : 0,
        opacity: interactive ? 1 : 0,
        transform: visible
          ? 'translateY(0) scale(1)'
          : overlay
            ? 'translateY(-6px) scale(0.98)'
            // Inline: leaves to the right and arrives from it, so the card
            // reads as sliding out past the window edge.
            : `translateX(${WORK_STATUS_PANEL_WIDTH / 4}px)`,
        transformOrigin: 'top right',
        transitionProperty: 'width, opacity, transform, margin',
        transitionDuration: `${PANEL_TRANSITION_MS}ms`,
        transitionTimingFunction: PANEL_TRANSITION_EASING,
        pointerEvents: interactive ? undefined : 'none',
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
      <WorkStatusPresenceProvider onChange={setRenderedSections}>
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
          showRepository={repositoryEnabled && sectionVisible('repository')}
          goalRow={<WorkStatusGoalRow sessionId={sessionId} directory={directory} />}
        />
        {sectionVisible('usage') ? <WorkStatusUsageSection /> : null}
        {sectionVisible('subagents') ? <WorkStatusSubagentsSection sessionId={sessionId} directory={directory} /> : null}
        {sectionVisible('tasks') ? <WorkStatusTasksSection sessionId={sessionId} directory={directory} /> : null}
        {sectionVisible('mcp') ? <WorkStatusMcpSection directory={directory} /> : null}
        {sectionVisible('pinned') ? <WorkStatusPinnedSection sessionId={sessionId} directory={directory} /> : null}
        {sectionVisible('contextSources') ? <WorkStatusContextSection sessionId={sessionId} directory={directory} /> : null}
      </ScrollShadow>
      </WorkStatusPresenceProvider>
      ) : null}

      {showEmptyState ? (
        <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
          <span className="text-sm text-muted-foreground">{t('chat.workStatus.sections.allHidden')}</span>
          <Button
            variant="link"
            size="xs"
            onClick={() => setSectionsDialogOpen(true)}
            className="mt-2 normal-case text-muted-foreground hover:text-foreground"
          >
            {t('chat.workStatus.sections.open')}
          </Button>
        </div>
      ) : null}

      <WorkStatusSectionsDialog open={sectionsDialogOpen} onOpenChange={setSectionsDialogOpen} />
    </aside>
  );
};

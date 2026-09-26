import React from 'react';
import { useSessionTurnActive } from '@/sync/global-session-status';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Popover } from '@base-ui/react/popover';
import type { Session } from '@/lib/opencode/model';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownMenuItemClass, dropdownMenuPopupClass, dropdownMenuSeparatorClass } from '@/components/ui/dropdown-menu.styles';
import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { Icon } from '@/components/icon/Icon';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useSessionTabsStore } from '@/stores/useSessionTabsStore';
import { closeSessionTabAndActivateNeighbour } from '@/lib/sessionTabs';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useIsSessionAiRenamePending } from '@/sync/use-session-ai-rename';

const restrictToXAxis: Modifier = ({ transform }) => ({ ...transform, y: 0 });

// Equal-width tabs share the row: they grow together up to the ceiling and
// shrink together down to the floor, left-aligned. The floor matches the slot's
// `min-w-[4.75rem]`, the ceiling its `max-w-[11rem]`, and the gap is `gap-1.5`;
// all three are rem-based so they track the UI font scale.
const TAB_FLOOR_REM = 4.75;
const DEFAULT_TAB_FLOOR_PX = 76;
const DEFAULT_GAP_PX = 6;
/** Trigger fallback until the strip measures the real button: padding, icon,
 *  gap, and the fixed-min-width count span, so ~50px for one or two digits. */
const DEFAULT_TRIGGER_WIDTH_PX = 50;

/** The rem-based tab floor in px, so the fit decision follows the UI font scale. */
const readTabFloorWidthPx = (): number => {
  const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(rootFontSize) && rootFontSize > 0
    ? rootFontSize * TAB_FLOOR_REM
    : DEFAULT_TAB_FLOOR_PX;
};

type SessionTab = { id: string; session: Session };

type StripMetrics = {
  /** Width of the strip's whole available slot, including the trigger. */
  outerWidth: number;
  /** Computed gap between the row and the trigger. */
  outerGap: number;
  /** Measured width of the overflow trigger. */
  triggerWidth: number;
  /** Measured width of the tab row (less than outerWidth once a trigger shows). */
  rowWidth: number;
  /** Floor width of one tab in px, tracking the UI font scale. */
  floorWidth: number;
  /** Computed gap between tabs. */
  gap: number;
};

type StripLayout =
  | { mode: 'all' }
  | { mode: 'title' }
  | { mode: 'window'; count: number };

const sameLayout = (a: StripLayout, b: StripLayout): boolean => {
  if (a.mode !== b.mode) return false;
  if (a.mode === 'window' && b.mode === 'window') return a.count === b.count;
  return true;
};

/**
 * The fallback decision, and the only layout choice JS makes:
 * - every slot fits at the floor -> render them all;
 * - otherwise a contiguous window centered on the active tab, with the rest
 *   behind the overflow trigger and its panel;
 * - not even the trigger and one floor-width tab fit -> the title fallback.
 */
const deriveLayout = (metrics: StripMetrics, slots: number, tabCount: number): StripLayout => {
  if (slots <= 0 || tabCount <= 0 || metrics.outerWidth <= 0) return { mode: 'all' };
  if (metrics.outerWidth < metrics.triggerWidth + metrics.outerGap + metrics.floorWidth) {
    return { mode: 'title' };
  }
  const floorSetWidth = slots * metrics.floorWidth + (slots - 1) * metrics.gap;
  if (floorSetWidth <= metrics.outerWidth) return { mode: 'all' };
  const rowWidth = metrics.rowWidth > 0
    ? metrics.rowWidth
    : metrics.outerWidth - metrics.triggerWidth - metrics.outerGap;
  const fit = Math.floor((rowWidth + metrics.gap) / (metrics.floorWidth + metrics.gap));
  return { mode: 'window', count: Math.max(1, Math.min(tabCount, fit)) };
};

type StripWindow = {
  visibleTabs: SessionTab[];
  hiddenTabs: SessionTab[];
  draftVisible: boolean;
};

export type SessionTabMenuComponents = {
  Item: React.ComponentType<{
    className?: string;
    disabled?: boolean;
    onClick?: React.MouseEventHandler;
    children?: React.ReactNode;
  }>;
  Separator: React.ComponentType<{ className?: string }>;
};

export type SessionTabMenuArgs = {
  session: Session;
  open: boolean;
  isActive: boolean;
  select: () => void;
  closeOtherTabs: () => void;
  /** Menu primitives for the surface the menu opens in (dropdown or context menu). */
  components: SessionTabMenuComponents;
};

const dropdownComponents: SessionTabMenuComponents = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
};

const contextComponents: SessionTabMenuComponents = {
  Item: ({ className, ...props }) => (
    <ContextMenu.Item className={cn(dropdownMenuItemClass, className)} {...props} />
  ),
  Separator: ({ className, ...props }) => (
    <ContextMenu.Separator className={cn(dropdownMenuSeparatorClass, className)} {...props} />
  ),
};

/**
 * One tab, active or not. The tab drags to reorder; the menu and close
 * controls are in-flow flex items at the tab's end (menu first, close after
 * it), so they reserve their own width instead of overlaying the title. The
 * active tab shows them always. An inactive tab reserves their width but keeps
 * them hidden and out of the tab order until the slot is hovered or focus
 * enters the tab, or while its menu is open; below the narrow gate it drops
 * them so the title keeps the full width, and below the `…` threshold even the
 * active tab drops just the menu trigger while keeping its close (see
 * `index.css` for the exact rules and width math). One session menu — supplied
 * by the header via `renderMenu` — backs both the "..." dropdown and the
 * right-click context menu, which opens under the cursor without changing the
 * active tab. The dropdown's anchor stays mounted and visible through the
 * close animation (`menuVisible`), so the popup never flashes detached and a
 * resize that crosses a gate mid-close cannot hide the trigger or strand
 * focus. While the active tab is renaming, the whole controls block is
 * suppressed — only the rename controls show.
 */
const SessionTabItem: React.FC<{
  tab: SessionTab;
  isActive: boolean;
  suppressControls: boolean;
  onSelect: (tab: SessionTab) => void;
  onClose: (id: string) => void;
  renderMenu: (args: SessionTabMenuArgs) => React.ReactNode;
  closeOtherTabs: (id: string) => void;
  onMenuOpenChangeComplete?: (open: boolean) => void;
  children?: React.ReactNode;
}> = ({ tab, isActive, suppressControls, onSelect, onClose, renderMenu, closeOtherTabs, onMenuOpenChangeComplete, children }) => {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = React.useState(false);
  // Stays true from open until the popup's close animation finishes, keeping
  // the trigger laid out (and exempt from the narrow-gate `display: none`) so
  // the anchor never detaches mid-close.
  const [menuVisible, setMenuVisible] = React.useState(false);
  const [contextMenuOpen, setContextMenuOpen] = React.useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });

  const title = tab.session.title?.trim() || t('sessions.sidebar.session.untitled');
  // Drives the open tab's highlight, keeps the controls shown while the menu is
  // open or still animating closed, and backs `data-controls-open` on the slot.
  const overlayVisible = !suppressControls && (menuOpen || menuVisible);

  // Session state for the dot and the hover tooltip.
  const isAiRenaming = useIsSessionAiRenamePending(tab.id, resolveGlobalSessionDirectory(tab.session));
  const isStreaming = useSessionTurnActive(tab.id);
  const unseenCount = useSessionUnseenCount(tab.id);
  const showUnread = unseenCount > 0 && !isActive && !isStreaming;
  const showDot = isStreaming || showUnread;
  const dotLabel = isStreaming
    ? t('sessions.sidebar.session.status.active')
    : t('sessions.sidebar.session.status.unread');

  const menuArgsFor = (components: SessionTabMenuComponents): SessionTabMenuArgs => ({
    session: tab.session,
    open: menuOpen || contextMenuOpen,
    isActive,
    select: () => onSelect(tab),
    closeOtherTabs: () => closeOtherTabs(tab.id),
    components,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      data-session-tab-slot=""
      className={cn(
        'session-tab-slot flex h-7 flex-1 basis-0 touch-none min-w-[4.75rem] max-w-[11rem]',
        isDragging && 'z-10 opacity-60',
      )}
      data-active={isActive ? 'true' : 'false'}
      data-controls-open={overlayVisible ? 'true' : 'false'}
      {...(isActive ? { 'data-active-session-tab': true } : {})}
      {...attributes}
      {...listeners}
    >
      <ContextMenu.Root
        open={contextMenuOpen}
        onOpenChange={setContextMenuOpen}
        onOpenChangeComplete={(open) => onMenuOpenChangeComplete?.(open)}
      >
        <ContextMenu.Trigger
              render={(triggerProps) => (
                <div
                  {...triggerProps}
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? undefined : 0}
                  onClick={isActive ? undefined : () => onSelect(tab)}
                  onKeyDown={isActive ? undefined : (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(tab);
                    }
                  }}
                  onAuxClick={(event) => {
                    if (event.button === 1) {
                      event.preventDefault();
                      onClose(tab.id);
                    }
                  }}
                  onMouseDown={(event) => {
                    // Suppress the browser's middle-click autoscroll on the tab
                    // surface; the middle-click close still fires via onAuxClick.
                    if (event.button === 1) {
                      event.preventDefault();
                    }
                  }}
                  className={cn(
                    // No color transition: activation must snap. A crossfade
                    // here reads as the switch itself being slow, since the
                    // old and new tab trade colors over several frames right
                    // after the click.
                    'session-tab flex h-7 w-full min-w-0 select-none items-center rounded-md px-2',
                    isActive
                      ? 'bg-interactive-selection text-interactive-selection-foreground'
                      : cn(
                        'cursor-pointer text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                        overlayVisible && 'bg-interactive-hover text-foreground',
                      ),
                  )}
                >
                  <div className="flex min-w-0 flex-1 items-center">
                    {isAiRenaming ? (
                      <Icon name="loader-4" className="mr-1.5 size-3 shrink-0 animate-spin text-primary" aria-label={t('sessions.aiRename.generating')} />
                    ) : showDot ? (
                      <SessionActivityIndicator
                        state={isStreaming ? 'running' : 'unread'}
                        label={dotLabel}
                        className="mr-1.5 shrink-0"
                      />
                    ) : null}
                    <div className={cn(
                      'min-w-0 flex-1 overflow-hidden whitespace-nowrap',
                      !suppressControls && 'session-tab-title',
                    )}
                    >
                      {/* Same box as the active content the header renders
                          (a centered column with a block title), so the
                          title sits at the same height before and after
                          activation and does not jump when the tab swaps
                          its content. */}
                      {isActive ? children : (
                        <div className="flex min-w-0 flex-col justify-center">
                          <span className="block max-w-full overflow-hidden whitespace-nowrap text-[13px] font-medium leading-4">{title}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  {!suppressControls ? (
                    <div
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                      className="session-tab-controls flex items-center gap-0.5"
                    >
                      <DropdownMenu
                        open={menuOpen}
                        onOpenChange={(open) => {
                          setMenuOpen(open);
                          if (open) setMenuVisible(true);
                        }}
                        onOpenChangeComplete={(open) => {
                          if (!open) setMenuVisible(false);
                          onMenuOpenChangeComplete?.(open);
                        }}
                      >
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={t('header.sessionTabs.tabMenuAria')}
                            className="session-tab-menu flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                          >
                            <Icon name="more" className="size-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="min-w-[190px]">
                          {renderMenu(menuArgsFor(dropdownComponents))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <button
                        type="button"
                        aria-label={t('header.sessionTabs.closeTab')}
                        onClick={() => onClose(tab.id)}
                        className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                      >
                        <Icon name="close" className="size-4" />
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
        />
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="app-region-no-drag z-50">
            <ContextMenu.Popup
              data-slot="dropdown-menu-content"
              style={{ color: 'var(--surface-elevated-foreground)' }}
              className={cn(dropdownMenuPopupClass, 'min-w-[190px]')}
            >
              {renderMenu(menuArgsFor(contextComponents))}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </div>
  );
};

/**
 * One hidden tab in the overflow panel. The row's body is the activate target
 * and the close control sits next to it, so the row is a plain list item rather
 * than a menu item.
 */
const SessionTabOverflowRow: React.FC<{
  tab: SessionTab;
  index: number;
  registerActivate: (id: string, element: HTMLButtonElement | null) => void;
  onSelect: (tab: SessionTab) => void;
  onClose: (id: string) => void;
}> = ({ tab, index, registerActivate, onSelect, onClose }) => {
  const { t } = useI18n();
  const title = tab.session.title?.trim() || t('sessions.sidebar.session.untitled');
  const sessionStatus = useGlobalSessionStatus(tab.id);
  const isStreaming = sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry';
  const unseenCount = useSessionUnseenCount(tab.id);
  const showDot = isStreaming || unseenCount > 0;
  const dotLabel = isStreaming
    ? t('sessions.sidebar.session.status.active')
    : t('sessions.sidebar.session.status.unread');
  const closeLabel = t('header.sessionTabs.closeTabAria', { label: title });

  return (
    <div
      data-overflow-row={index}
      className="flex items-center gap-0.5 rounded-lg hover:bg-interactive-hover focus-within:bg-interactive-hover"
    >
      <button
        type="button"
        ref={(element) => { registerActivate(tab.id, element); }}
        onClick={() => onSelect(tab)}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1 text-left text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
      >
        {showDot ? (
          <SessionActivityIndicator
            state={isStreaming ? 'running' : 'unread'}
            label={dotLabel}
            className="shrink-0"
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate typography-ui-label">{title}</span>
      </button>
      <button
        type="button"
        aria-label={closeLabel}
        title={closeLabel}
        onClick={() => onClose(tab.id)}
        className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
      >
        <Icon name="close" className="size-3.5" />
      </button>
    </div>
  );
};

/**
 * The header's horizontal working set of sessions (web/desktop only).
 *
 * Every session the user opens joins the strip once; the tab whose session is
 * current renders `children` — the header's title/rename block — inside a
 * selected pill. Closing a tab only removes it from the strip; closing the
 * active one activates its neighbour. Ids whose session has not loaded (or
 * was archived/deleted) stay in the store but do not render, so a partial
 * session list never destroys the working set.
 *
 * Horizontal room is finite, so tabs are equal-width flex items that grow and
 * shrink together, left-aligned, with any spare room left to the right of the
 * last tab. Flex reflow itself is instant: a resize re-lays out the tabs in a
 * single frame. A slot that enters the visible window — a new tab, or one
 * revealed when the strip grows — animates in from collapsed with
 * `session-tab-enter`, so growing the strip shows the newly visible tabs
 * stepping in; a tab that leaves the layout is unmounted without an exit
 * animation. That enter animation and its `prefers-reduced-motion` opt-out live
 * on the slot class in `index.css`. JS only picks the fallback: while every tab
 * fits at the floor
 * they all render; past the floor the active tab stays visible inside a
 * contiguous window of the store order and the rest move behind the overflow
 * trigger and its panel, so every tab stays reachable. When not even the
 * trigger and one floor-width tab fit, the strip falls back to the plain
 * session title.
 */
export const SessionTabsStrip: React.FC<{
  /** Menu items for one tab's session, supplied by the header. */
  renderMenu: (args: SessionTabMenuArgs) => React.ReactNode;
  /** Fires when a tab menu finishes opening/closing (deferred rename hook). */
  onMenuOpenChangeComplete?: (open: boolean) => void;
  /** While the active tab renames, its controls stay hidden. */
  suppressActiveTabControls?: boolean;
  children: React.ReactNode;
}> = ({ renderMenu, onMenuOpenChangeComplete, suppressActiveTabControls = false, children }) => {
  const { t } = useI18n();
  const tabIds = useSessionTabsStore((state) => state.tabIds);
  const ensureTab = useSessionTabsStore((state) => state.ensureTab);
  const closeOtherTabs = useSessionTabsStore((state) => state.closeOtherTabs);
  const reorderTabs = useSessionTabsStore((state) => state.reorderTabs);

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);

  // Opening a session anywhere (sidebar, palette, deep link) adds its tab.
  React.useEffect(() => {
    if (currentSessionId) ensureTab(currentSessionId);
  }, [currentSessionId, ensureTab]);

  const sessionsById = React.useMemo(() => {
    const map = new Map<string, Session>();
    for (const session of activeSessions) map.set(session.id, session);
    return map;
  }, [activeSessions]);

  // Only tabs with a known live session render; unknown ids stay stored.
  const tabs = React.useMemo<SessionTab[]>(() => {
    const list: SessionTab[] = [];
    for (const id of tabIds) {
      const session = sessionsById.get(id);
      if (session) list.push({ id, session });
    }
    return list;
  }, [tabIds, sessionsById]);

  const handleSelect = React.useCallback((tab: SessionTab) => {
    setCurrentSession(tab.id, resolveGlobalSessionDirectory(tab.session));
  }, [setCurrentSession]);

  const handleClose = React.useCallback((id: string) => {
    closeSessionTabAndActivateNeighbour(id);
  }, []);

  const handleCloseOthers = React.useCallback((id: string) => {
    closeOtherTabs(id);
    if (currentSessionId && currentSessionId !== id) {
      const kept = tabs.find((tab) => tab.id === id);
      if (kept) handleSelect(kept);
    }
  }, [closeOtherTabs, currentSessionId, handleSelect, tabs]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      reorderTabs(String(active.id), String(over.id));
    }
  }, [reorderTabs]);

  // The strip measures itself and picks a fallback. The row is
  // `flex-1 min-w-0 overflow-hidden`, so its width never depends on how many
  // tabs render — measurement cannot feed back into layout. Raw measurements
  // live in a ref; only the derived `{mode, count}` is state, so a resize that
  // does not change the fallback causes no re-render.
  const outerRef = React.useRef<HTMLDivElement | null>(null);
  const rowRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const metricsRef = React.useRef<StripMetrics | null>(null);
  const slotCountsRef = React.useRef({ slots: 0, tabCount: 0 });
  const overflowRowRefs = React.useRef(new Map<string, HTMLButtonElement>());
  // Set by a panel row close so the effect below can move focus after React
  // removes the row, instead of leaving focus on the document.
  const pendingRowFocusRef = React.useRef<string | null>(null);
  const pendingTriggerFocusRef = React.useRef(false);
  // True while keyboard focus sits on a control inside the overflow panel or on
  // its trigger, so a collapse that unmounts them can still hand focus onward.
  const overflowFocusRef = React.useRef(false);
  const [layout, setLayout] = React.useState<StripLayout>({ mode: 'all' });
  const [overflowOpen, setOverflowOpen] = React.useState(false);

  const measure = React.useCallback(() => {
    const outer = outerRef.current;
    if (!outer) return;

    const outerGapValue = Number.parseFloat(getComputedStyle(outer).columnGap);
    const outerGap = Number.isFinite(outerGapValue) ? outerGapValue : DEFAULT_GAP_PX;
    const outerWidth = outer.getBoundingClientRect().width;
    const measuredTriggerWidth = triggerRef.current?.getBoundingClientRect().width ?? 0;

    const row = rowRef.current;
    const previous = metricsRef.current;
    let rowWidth = 0;
    let gap = previous?.gap ?? DEFAULT_GAP_PX;
    if (row) {
      rowWidth = row.getBoundingClientRect().width;
      const gapValue = Number.parseFloat(getComputedStyle(row).columnGap);
      if (Number.isFinite(gapValue)) gap = gapValue;
    }

    const nextMetrics: StripMetrics = {
      outerWidth,
      outerGap,
      triggerWidth: measuredTriggerWidth > 0
        ? measuredTriggerWidth
        : previous?.triggerWidth ?? DEFAULT_TRIGGER_WIDTH_PX,
      rowWidth,
      floorWidth: readTabFloorWidthPx(),
      gap,
    };
    metricsRef.current = nextMetrics;

    const { slots, tabCount } = slotCountsRef.current;
    const nextLayout = deriveLayout(nextMetrics, slots, tabCount);
    setLayout((current) => (sameLayout(current, nextLayout) ? current : nextLayout));
  }, []);

  // Coalesce observer bursts into one measurement per frame.
  const scheduleMeasure = React.useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      measure();
    });
  }, [measure]);

  // A brand-new draft (no session yet) shows as a transient active pill after
  // the tabs; it becomes a real tab once the first message creates the session.
  const showDraftPill = !currentSessionId || !tabs.some((tab) => tab.id === currentSessionId);

  // What `measure` needs from this render: the draft pill is a slot too, but the
  // window count only ever holds tabs.
  slotCountsRef.current = { slots: tabs.length + (showDraftPill ? 1 : 0), tabCount: tabs.length };

  const activeIndex = tabs.findIndex((tab) => tab.id === currentSessionId);

  const { visibleTabs, hiddenTabs, draftVisible } = React.useMemo<StripWindow>(() => {
    if (layout.mode === 'title') {
      return { visibleTabs: [], hiddenTabs: tabs, draftVisible: false };
    }
    if (layout.mode === 'all') {
      return { visibleTabs: tabs, hiddenTabs: [], draftVisible: showDraftPill };
    }
    const total = tabs.length;
    if (showDraftPill) {
      // The draft is the active surface: keep it, and fill the rest of the
      // window with the tabs immediately before it.
      const visibleCount = Math.max(0, layout.count - 1);
      const start = Math.max(0, total - visibleCount);
      return { visibleTabs: tabs.slice(start), hiddenTabs: tabs.slice(0, start), draftVisible: true };
    }
    const start = Math.max(0, Math.min(
      activeIndex - Math.floor((layout.count - 1) / 2),
      Math.max(0, total - layout.count),
    ));
    return {
      visibleTabs: tabs.slice(start, start + layout.count),
      hiddenTabs: [...tabs.slice(0, start), ...tabs.slice(start + layout.count)],
      draftVisible: false,
    };
  }, [activeIndex, layout, showDraftPill, tabs]);

  const visibleTabIds = React.useMemo(() => visibleTabs.map((tab) => tab.id), [visibleTabs]);

  // Measure before paint so the first overflow render is already correct.
  React.useLayoutEffect(() => {
    measure();
  }, [currentSessionId, layout.mode, measure, showDraftPill, tabs.length]);

  React.useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    if (!globalThis.ResizeObserver) {
      window.addEventListener('resize', scheduleMeasure);
      return () => window.removeEventListener('resize', scheduleMeasure);
    }
    const observer = new globalThis.ResizeObserver(scheduleMeasure);
    observer.observe(outer);
    if (rowRef.current) observer.observe(rowRef.current);
    if (triggerRef.current) observer.observe(triggerRef.current);
    return () => observer.disconnect();
  }, [layout.mode, scheduleMeasure, showDraftPill, tabs.length]);

  React.useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
  }, []);

  React.useEffect(() => {
    if (!overflowOpen) return;
    if (layout.mode !== 'window' || hiddenTabs.length === 0) setOverflowOpen(false);
  }, [hiddenTabs.length, layout.mode, overflowOpen]);

  // Tracks whether focus currently sits on the overflow trigger or a control
  // inside the overflow panel. A later collapse that unmounts them can then move
  // focus onward instead of letting it fall to the document.
  React.useEffect(() => {
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      overflowFocusRef.current = target instanceof Element && (
        target.closest('[data-overflow-row]') !== null || target === triggerRef.current
      );
    };
    document.addEventListener('focusin', handleFocusIn);
    return () => document.removeEventListener('focusin', handleFocusIn);
  }, []);

  // Closing a hidden row unmounts the button that had focus; a resize can
  // unmount the whole panel the same way. Move focus to the intended surviving
  // row, then the trigger, the active tab, or the row container, so it never
  // falls to the document. Runs before paint.
  React.useLayoutEffect(() => {
    let restoreFocus = pendingTriggerFocusRef.current;
    pendingTriggerFocusRef.current = false;

    if (pendingRowFocusRef.current) {
      const id = pendingRowFocusRef.current;
      pendingRowFocusRef.current = null;
      const survivingRow = overflowRowRefs.current.get(id);
      if (survivingRow) {
        survivingRow.focus();
        return;
      }
      // The intended row is gone too, so keep falling through the chain.
      restoreFocus = true;
    }

    // The overflow was open with focus among its controls and is now unmounting
    // because it collapsed (or its last row closed), so the trigger's focus
    // restore can no longer land.
    const overflowCollapsed = overflowFocusRef.current
      && (layout.mode !== 'window' || hiddenTabs.length === 0);
    if (!restoreFocus && !overflowCollapsed) return;

    overflowFocusRef.current = false;
    const trigger = triggerRef.current;
    if (trigger) {
      trigger.focus();
      return;
    }
    const activeTab = rowRef.current?.querySelector<HTMLElement>('[data-active-session-tab]');
    if (activeTab) {
      activeTab.focus();
      return;
    }
    // Last resort: the strip container stays mounted in every layout, including
    // `title`, where the row and active tab are not rendered.
    (rowRef.current ?? outerRef.current)?.focus();
  }, [hiddenTabs, layout.mode]);

  const registerOverflowRow = React.useCallback((id: string, element: HTMLButtonElement | null) => {
    if (element) overflowRowRefs.current.set(id, element);
    else overflowRowRefs.current.delete(id);
  }, []);

  const handlePanelKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isIMECompositionEvent(event)) return;

    const move = (delta: number) => {
      const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-overflow-row]'));
      if (rows.length === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const currentRow = target?.closest<HTMLElement>('[data-overflow-row]');
      // With no row focused, ArrowDown enters at the first row and ArrowUp at
      // the last, so the two directions are mirror images from the popup.
      if (!currentRow) {
        const entryIndex = delta > 0 ? 0 : rows.length - 1;
        rows[entryIndex]?.querySelector<HTMLButtonElement>('button')?.focus();
        return;
      }
      const currentIndex = Number(currentRow.dataset.overflowRow);
      const nextIndex = ((currentIndex + delta) % rows.length + rows.length) % rows.length;
      rows[nextIndex]?.querySelector<HTMLButtonElement>('button')?.focus();
    };

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
      return;
    }
    handleDropdownNavigationKey(event, (navigationKey) => move(navigationKey === 'ArrowDown' ? 1 : -1));
  }, []);

  const handleOverflowSelect = React.useCallback((tab: SessionTab) => {
    setOverflowOpen(false);
    handleSelect(tab);
  }, [handleSelect]);

  // Keep the panel open so several hidden tabs can be closed in a row. Record
  // where focus should land once React removes the closed row.
  const handleOverflowClose = React.useCallback((id: string) => {
    const index = hiddenTabs.findIndex((tab) => tab.id === id);
    const next = hiddenTabs[index + 1] ?? hiddenTabs[index - 1] ?? null;
    if (next) pendingRowFocusRef.current = next.id;
    else pendingTriggerFocusRef.current = true;
    handleClose(id);
  }, [handleClose, hiddenTabs]);

  return (
    // The strip floor is one tab floor (`min-w-[4.75rem]`) + the row gap
    // (`gap-1.5` = 0.375rem) + the overflow trigger's minimum (~3.125rem) =
    // 8.25rem, plus 0.5rem of buffer: the trigger can measure wider than its
    // estimate, and `deriveLayout`'s `title` branch fires at exactly that sum,
    // so without the buffer a wider trigger would make `title` reachable again.
    // The header drops its secondary right-cluster controls before the row can
    // shrink this far (see `deriveHeaderHideLevel`), keeping `title` a latent
    // safety net. Must stay in sync with `TAB_STRIP_FLOOR_REM` in `Header.tsx`.
    <div ref={outerRef} tabIndex={-1} className="app-region-no-drag flex h-full min-w-[8.75rem] flex-1 items-center gap-1.5">
      {layout.mode === 'title' ? (
        <div className="flex min-w-0 flex-1 items-center">{children}</div>
      ) : (
        <>
          <div
            ref={rowRef}
            tabIndex={-1}
            className="relative flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
            role="tablist"
            aria-label={t('header.sessionTabs.stripAria')}
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToXAxis]}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={visibleTabIds} strategy={horizontalListSortingStrategy}>
                {visibleTabs.map((tab) => (
                  <SessionTabItem
                    key={tab.id}
                    tab={tab}
                    isActive={tab.id === currentSessionId}
                    suppressControls={tab.id === currentSessionId && suppressActiveTabControls}
                    onSelect={handleSelect}
                    onClose={handleClose}
                    renderMenu={renderMenu}
                    closeOtherTabs={handleCloseOthers}
                    onMenuOpenChangeComplete={onMenuOpenChangeComplete}
                  >
                    {tab.id === currentSessionId ? children : null}
                  </SessionTabItem>
                ))}
              </SortableContext>
            </DndContext>
            {draftVisible ? (
              <div
                role="tab"
                aria-selected
                data-session-tab-slot=""
                data-active="true"
                className="session-tab-slot flex h-7 flex-1 basis-0 items-center rounded-md bg-interactive-selection px-2 min-w-[4.75rem] max-w-[11rem]"
              >
                <div className="min-w-0 flex-1">{children}</div>
              </div>
            ) : null}
          </div>
          {layout.mode === 'window' ? (
            <Popover.Root
              open={overflowOpen}
              onOpenChange={setOverflowOpen}
              onOpenChangeComplete={(open) => {
                if (!open) return;
                const first = hiddenTabs[0];
                if (first) overflowRowRefs.current.get(first.id)?.focus();
              }}
            >
              <Popover.Trigger
                render={
                  <button
                    ref={triggerRef}
                    type="button"
                    aria-label={t('header.sessionTabs.moreTabsAria', { count: hiddenTabs.length })}
                    title={t('header.sessionTabs.moreTabsAria', { count: hiddenTabs.length })}
                    className="app-region-no-drag flex h-7 shrink-0 items-center gap-0.5 rounded-md px-2 text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
                  />
                }
              >
                <Icon name="arrow-down-s" className="size-4" />
                {/* Fixed minimum width keeps the trigger a constant size for
                    1–2 digit counts, so the measured row width cannot feed
                    back into the count. */}
                <span className="inline-block min-w-4 text-center tabular-nums typography-meta">{hiddenTabs.length}</span>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Positioner side="bottom" align="end" sideOffset={4} className="app-region-no-drag z-50">
                  <Popover.Popup
                    aria-label={t('header.sessionTabs.moreTabsAria', { count: hiddenTabs.length })}
                    className={cn(dropdownMenuPopupClass, 'flex w-64 max-w-[calc(100vw-2rem)] flex-col overflow-y-auto p-1')}
                    onKeyDown={handlePanelKeyDown}
                  >
                    {hiddenTabs.map((tab, index) => (
                      <SessionTabOverflowRow
                        key={tab.id}
                        tab={tab}
                        index={index}
                        registerActivate={registerOverflowRow}
                        onSelect={handleOverflowSelect}
                        onClose={handleOverflowClose}
                      />
                    ))}
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
          ) : null}
        </>
      )}
    </div>
  );
};

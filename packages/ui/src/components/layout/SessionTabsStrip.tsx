import React from 'react';
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
import type { Session } from '@opencode-ai/sdk/v2';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownMenuItemClass, dropdownMenuPopupClass, dropdownMenuSeparatorClass } from '@/components/ui/dropdown-menu.styles';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useSessionTabsStore } from '@/stores/useSessionTabsStore';
import { closeSessionTabAndActivateNeighbour } from '@/lib/sessionTabs';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionStatus } from '@/sync/sync-context';
import { useSessionUnseenCount } from '@/sync/notification-store';

const restrictToXAxis: Modifier = ({ transform }) => ({ ...transform, y: 0 });

type SessionTab = { id: string; session: Session };

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
 * controls sit in a hover-revealed overlay at the tab's end (menu first,
 * close after it). One session menu — supplied by the header via
 * `renderMenu` — backs both the "..." dropdown and the right-click context
 * menu, which opens under the cursor without changing the active tab. The
 * dropdown's anchor overlay stays mounted through the close animation so the
 * popup never flashes detached. While the active tab is renaming, the
 * overlay is suppressed entirely — only the rename controls show.
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
  // Keeps the overlay (the dropdown's anchor) mounted through the close animation.
  const [menuVisible, setMenuVisible] = React.useState(false);
  const [contextMenuOpen, setContextMenuOpen] = React.useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });

  const title = tab.session.title?.trim() || t('sessions.sidebar.session.untitled');
  const overlayVisible = !suppressControls && (menuOpen || menuVisible);

  // Session state for the dot and the hover tooltip.
  const sessionStatus = useGlobalSessionStatus(tab.id);
  const isStreaming = sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry';
  const unseenCount = useSessionUnseenCount(tab.id);
  const showUnread = unseenCount > 0 && !isActive && !isStreaming;
  const showDot = isStreaming || showUnread;
  const dotLabel = isStreaming
    ? t('sessions.sidebar.session.status.active')
    : t('sessions.sidebar.session.status.unread');

  const menuArgsFor = (components: SessionTabMenuComponents): SessionTabMenuArgs => ({
    session: tab.session,
    isActive,
    select: () => onSelect(tab),
    closeOtherTabs: () => closeOtherTabs(tab.id),
    components,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      className={cn('session-tab-slot flex h-7 w-44 shrink-0 touch-none', isDragging && 'z-10 opacity-60')}
      data-active={isActive ? 'true' : 'false'}
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
                  data-controls-open={overlayVisible ? 'true' : 'false'}
                  className={cn(
                    'session-tab group/session-tab relative flex h-7 w-full min-w-0 select-none items-center rounded-md px-2',
                    'transition-colors duration-75',
                    isActive
                      ? 'bg-interactive-selection'
                      : cn(
                        'cursor-pointer text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                        overlayVisible && 'bg-interactive-hover text-foreground',
                      ),
                  )}
                >
                  <div className={cn(
                    'flex min-w-0 flex-1 items-center',
                    !suppressControls && 'group-hover/session-tab:pr-10',
                    overlayVisible && 'pr-10',
                  )}
                  >
                    <div className={cn(
                      'min-w-0 flex-1 overflow-hidden whitespace-nowrap',
                      !suppressControls && 'session-tab-title',
                    )}
                    >
                      {isActive ? children : (
                        <span className="text-[13px] font-medium leading-4">{title}</span>
                      )}
                    </div>
                    {showDot ? (
                      <span
                        className={cn(
                          'ml-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                          isStreaming ? 'bg-primary' : 'bg-[var(--status-info)]',
                          !suppressControls && 'group-hover/session-tab:opacity-0',
                          overlayVisible && 'opacity-0',
                        )}
                        aria-label={dotLabel}
                      />
                    ) : null}
                  </div>
                  {!suppressControls ? (
                    <div
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                      className={cn(
                        'absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5',
                        'opacity-0 transition-opacity duration-150',
                        'group-hover/session-tab:flex group-hover/session-tab:opacity-100',
                        overlayVisible && 'flex opacity-100',
                      )}
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
                            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
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
 * The header's horizontal working set of sessions (web/desktop only).
 *
 * Every session the user opens joins the strip once; the tab whose session is
 * current renders `children` — the header's title/rename block — inside a
 * selected pill. Closing a tab only removes it from the strip; closing the
 * active one activates its neighbour. Ids whose session has not loaded (or
 * was archived/deleted) stay in the store but do not render, so a partial
 * session list never destroys the working set.
 */
export const SessionTabsStrip: React.FC<{
  /** Menu items for one tab's session, supplied by the header. */
  renderMenu: (args: SessionTabMenuArgs) => React.ReactNode;
  /** Fires when a tab menu finishes opening/closing (deferred rename hook). */
  onMenuOpenChangeComplete?: (open: boolean) => void;
  /** While the active tab renames, its hover controls stay hidden. */
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

  // Soft fade at the edges while more tabs hide behind them.
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });
  const updateEdges = React.useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const left = node.scrollLeft > 2;
    const right = node.scrollLeft + node.clientWidth < node.scrollWidth - 2;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);
  React.useEffect(() => {
    updateEdges();
    const node = scrollRef.current;
    if (!node || !globalThis.ResizeObserver) return;
    const observer = new ResizeObserver(updateEdges);
    observer.observe(node);
    return () => observer.disconnect();
  }, [updateEdges, tabs.length]);

  // Keep the active tab in view when it changes.
  React.useEffect(() => {
    scrollRef.current
      ?.querySelector('[data-active-session-tab]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [currentSessionId]);

  const maskImage = edges.left && edges.right
    ? 'linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)'
    : edges.left
      ? 'linear-gradient(to right, transparent, black 24px)'
      : edges.right
        ? 'linear-gradient(to right, black calc(100% - 24px), transparent)'
        : undefined;

  const tabIdsInOrder = React.useMemo(() => tabs.map((tab) => tab.id), [tabs]);

  // A brand-new draft (no session yet) shows as a transient active pill after
  // the tabs; it becomes a real tab once the first message creates the session.
  const showDraftPill = !currentSessionId || !tabs.some((tab) => tab.id === currentSessionId);

  return (
    <div className="app-region-no-drag flex h-full min-w-0 flex-1 items-center" role="tablist" aria-label={t('header.sessionTabs.stripAria')}>
      <div
        ref={scrollRef}
        onScroll={updateEdges}
        className="session-tabs-scroll flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overscroll-x-contain"
        style={maskImage ? { maskImage, WebkitMaskImage: maskImage } : undefined}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToXAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={tabIdsInOrder} strategy={horizontalListSortingStrategy}>
            {tabs.map((tab) => (
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
        {showDraftPill ? (
          <div
            role="tab"
            aria-selected
            className="session-tab-slot flex h-7 w-44 shrink-0 items-center rounded-md bg-interactive-selection px-2"
            data-active="true"
          >
            <div className="min-w-0 flex-1">{children}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

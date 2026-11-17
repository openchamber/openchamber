import React from 'react';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { scrollTabsWithWheel } from '@/components/ui/tab-strip-wheel';
import { formatShortcutForDisplay, getEffectiveShortcutCombo, getEffectiveShortcutPrefix, UNASSIGNED_SHORTCUT } from '@/lib/shortcuts';
import { useSessionTurnActivity } from '@/sync/global-session-status';
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
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { ContextMenu } from '@base-ui/react/context-menu';
import { ContextMenu as ContextMenuRoot, ContextMenuContent } from '@/components/ui/context-menu';
import type { Session } from '@/lib/opencode/model';

import { contextSessionMenuSlots, type SessionMenuSlots } from '@/components/session/sidebar/sessions/sessionMenuSlots';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { isRightToLeft, useI18n } from '@/lib/i18n';
import { GLOBAL_SESSION_TAB_SCOPE, useSessionTabsStore } from '@/stores/useSessionTabsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { sessionTabChatsScope, sessionTabScopeFor, sessionTabSeedFor } from '@/lib/sessionTabScope';
import { activateSessionTabByIndex, closeSessionTabAndActivateNeighbour } from '@/lib/sessionTabs';
import { registerCloseTabTarget } from '@/lib/closeTabTarget';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { toggleSessionRead } from '@/components/session/sessionReadActions';
import { openSessionInSidePanel } from '@/components/session/sessionSidePanel';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionDraftsStore } from '@/stores/useSessionDraftsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionMarkedUnread, useSessionUnread } from '@/sync/session-unread';
import { useIsSessionAiRenamePending } from '@/sync/use-session-ai-rename';
import { useMultiRunMemberIds } from '@/lib/multirun/useMultiRuns';
import { SessionProjectIcon } from './SessionProjectIcon';
import { SESSION_TAB_EDGE_FADE_PX, sessionTabRevealDelta } from './sessionTabReveal';

const restrictToXAxis: Modifier = ({ transform }) => ({ ...transform, y: 0 });

type SessionTab = { id: string; session: Session };

export type SessionTabMenuArgs = {
  session: Session;
  open: boolean;
  isActive: boolean;
  select: () => void;
  closeOtherTabs: () => void;
  components: SessionMenuSlots;
};

const SessionTabItem: React.FC<{
  tab: SessionTab;
  tabNumber: number;
  isActive: boolean;
  isPreview: boolean;
  suppressControls: boolean;
  onSelect: (tab: SessionTab) => void;
  onPin: (id: string) => void;
  onClose: (id: string) => void;
  renderMenu: (args: SessionTabMenuArgs) => React.ReactNode;
  closeOtherTabs: (id: string) => void;
  onMenuOpenChangeComplete?: (open: boolean) => void;
  menuReturnsFocus?: () => boolean;
  children?: React.ReactNode;
}> = ({ tab, tabNumber, isActive, isPreview, suppressControls, onSelect, onPin, onClose, renderMenu, closeOtherTabs, onMenuOpenChangeComplete, menuReturnsFocus, children }) => {
  const { t } = useI18n();
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const tabPrefix = getEffectiveShortcutPrefix('switch_session_tab', shortcutOverrides);
  const tabShortcut = tabPrefix && tabPrefix !== UNASSIGNED_SHORTCUT && tabNumber <= 9
    ? formatShortcutForDisplay(`${tabPrefix}+${tabNumber}`)
    : undefined;
  const [contextMenuOpen, setContextMenuOpen] = React.useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });

  const title = tab.session.title?.trim() || t('sessions.sidebar.session.untitled');

  const isAiRenaming = useIsSessionAiRenamePending(tab.id, resolveGlobalSessionDirectory(tab.session));
  const turnActivity = useSessionTurnActivity(tab.id);
  const isStreaming = turnActivity !== null;
  const isUnread = useSessionUnread(tab.id);
  const markedUnread = useSessionMarkedUnread(tab.id);
  const showUnread = isUnread && (!isActive || markedUnread) && !isStreaming;
  const showDot = isStreaming || showUnread;

  const menuArgs: SessionTabMenuArgs = {
    session: tab.session,
    open: contextMenuOpen,
    isActive,
    select: () => onSelect(tab),
    closeOtherTabs: () => closeOtherTabs(tab.id),
    components: contextSessionMenuSlots,
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      className={cn('app-region-no-drag session-tab-slot flex h-7 w-44 shrink-0 touch-none', isDragging && 'z-10 opacity-60')}
      data-active={isActive ? 'true' : 'false'}
      {...(isActive ? { 'data-active-session-tab': true } : {})}
      {...attributes}
      {...listeners}
    >
      <ContextMenuRoot
        open={contextMenuOpen}
        onOpenChange={setContextMenuOpen}
        onOpenChangeComplete={(open) => onMenuOpenChangeComplete?.(open)}
      >
        <Tooltip>
        <TooltipTrigger asChild>
        <ContextMenu.Trigger
              render={(triggerProps) => (
                <div
                  {...triggerProps}
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? undefined : 0}
                  onClick={(event) => {
                    if (event.altKey) {
                      toggleSessionRead(tab.id, isUnread, t);
                      return;
                    }
                    const directory = resolveGlobalSessionDirectory(tab.session);
                    if (event.shiftKey && directory && !isVSCodeRuntime()) {
                      openSessionInSidePanel(tab.id, directory, title);
                      return;
                    }
                    if (!isActive) onSelect(tab);
                  }}
                  onDoubleClick={isPreview ? () => onPin(tab.id) : undefined}
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
                  className={cn(
                    'session-tab group/session-tab relative flex h-7 w-full min-w-0 select-none items-center rounded-md px-2',
                    isActive
                      ? 'bg-interactive-selection text-interactive-selection-foreground'
                      : 'cursor-pointer text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                  )}
                >
                  <div className="flex min-w-0 flex-1 items-center">
                    <span className="relative me-1.5 inline-flex size-3.5 shrink-0 items-center justify-center">
                      <SessionProjectIcon
                        directory={resolveGlobalSessionDirectory(tab.session)}
                        className={cn(!suppressControls && 'group-hover/session-tab:opacity-0 group-has-[:focus-visible]/session-tab:opacity-0')}
                      />
                      {!suppressControls ? (
                        <Tooltip>
                        <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={t('header.sessionTabs.closeTab')}
                          onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}
                          onPointerDown={(event) => event.stopPropagation()}
                          className="absolute inset-0 flex items-center justify-center rounded text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/session-tab:opacity-100"
                        >
                          <Icon name="close" className="size-3.5" />
                        </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" sideOffset={6}><TooltipLabelWithShortcut label={t('header.sessionTabs.closeTab')} shortcut={isActive ? formatShortcutForDisplay(isDesktopShell() ? 'mod+w' : getEffectiveShortcutCombo('close_session_tab', shortcutOverrides), '') : undefined} /></TooltipContent>
                        </Tooltip>
                      ) : null}
                    </span>
                    <div className={cn(
                      'min-w-0 flex-1 overflow-hidden whitespace-nowrap',
                      !suppressControls && 'session-tab-title',
                      isPreview && !suppressControls && 'italic',
                    )}
                    >
                      {isActive ? children : (
                        <div className="flex min-w-0 flex-col justify-center">
                          <span dir="auto" className="block max-w-full overflow-hidden whitespace-nowrap oc-ui-start-align text-[0.8125rem] font-medium leading-4">{title}</span>
                        </div>
                      )}
                    </div>
                    {isAiRenaming ? (
                      <Icon name="loader-4" className="ms-1.5 size-3 shrink-0 animate-spin text-primary" aria-label={t('sessions.aiRename.generating')} />
                    ) : showDot ? (
                      <SessionActivityIndicator state={turnActivity ?? 'unread'} className="ms-1.5 shrink-0" />
                    ) : null}
                  </div>
                </div>
              )}
        />
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}><TooltipLabelWithShortcut label={title} shortcut={tabShortcut} /></TooltipContent>
        </Tooltip>
        <ContextMenuContent finalFocus={() => menuReturnsFocus?.() ?? true} className="min-w-[190px]">
          {renderMenu(menuArgs)}
        </ContextMenuContent>
      </ContextMenuRoot>
    </div>
  );
};

export const SessionTabsStrip: React.FC<{
  renderMenu: (args: SessionTabMenuArgs) => React.ReactNode;
  onMenuOpenChangeComplete?: (open: boolean) => void;
  suppressActiveTabControls?: boolean;
  menuReturnsFocus?: () => boolean;
  children: React.ReactNode;
}> = ({ renderMenu, onMenuOpenChangeComplete, suppressActiveTabControls = false, menuReturnsFocus, children }) => {
  const { t, direction } = useI18n();
  // external: https://docs.dndkit.com/presets/sortable/sortable-strategies RTL uses rectangle sorting because horizontal-list sorting assumes later items are farther right.
  const isRtl = direction === 'rtl';
  const tabIds = useSessionTabsStore((state) => state.tabIds);
  const previewTabId = useSessionTabsStore((state) => state.previewTabId);
  const ensureTab = useSessionTabsStore((state) => state.ensureTab);
  const pinTab = useSessionTabsStore((state) => state.pinTab);
  const closeOtherTabs = useSessionTabsStore((state) => state.closeOtherTabs);
  const reorderTabs = useSessionTabsStore((state) => state.reorderTabs);

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);

  const perWorkspace = useUIStore((state) => state.sessionTabsPerWorkspace);
  const enterScope = useSessionTabsStore((state) => state.enterScope);
  const sessionsLoaded = useGlobalSessionsStore((state) => state.hasLoaded);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const draftOpen = useSessionUIStore((state) => state.newSessionDraft.open);
  const workDraftId = useSessionUIStore((state) => state.newSessionDraft.workDraftId ?? null);
  const draftIsChat = useSessionUIStore((state) => state.newSessionDraft.target === 'chat');
  const draftDirectory = useSessionUIStore((state) => state.newSessionDraft.directoryOverride);
  const draftProjectId = useSessionUIStore((state) => state.newSessionDraft.selectedProjectId ?? null);
  const draftProjectPath = useProjectsStore((state) => {
    const projectId = draftProjectId ?? state.activeProjectId;
    return state.projects.find((project) => project.id === projectId)?.path ?? null;
  });

  const currentRunMemberIds = useMultiRunMemberIds(currentSessionId);
  React.useEffect(() => {
    if (!perWorkspace) {
      enterScope(GLOBAL_SESSION_TAB_SCOPE, () => []);
    } else {
      if (!sessionsLoaded) return;
      const runtimeKey = getRuntimeKey();
      const chatDraft = !currentSessionId && draftOpen && draftIsChat;
      const directory = currentSessionId ? currentSessionDirectory : draftOpen && !draftIsChat ? draftDirectory ?? draftProjectPath : null;
      const scope = chatDraft ? sessionTabChatsScope(runtimeKey) : sessionTabScopeFor(runtimeKey, directory);
      if (!scope) return;
      enterScope(scope, () => sessionTabSeedFor(
        directory,
        useGlobalSessionsStore.getState().activeSessions,
        useProjectsStore.getState().projects.map((project) => project.path),
      ));
    }
    if (currentSessionId) ensureTab(currentSessionId, currentRunMemberIds);
  }, [currentRunMemberIds, currentSessionDirectory, currentSessionId, draftDirectory, draftIsChat, draftOpen, draftProjectPath, ensureTab, enterScope, perWorkspace, sessionsLoaded]);

  const sessionsById = React.useMemo(() => {
    const map = new Map<string, Session>();
    for (const session of activeSessions) map.set(session.id, session);
    return map;
  }, [activeSessions]);

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

  const showDraftTab = !currentSessionId && draftOpen;
  const draftFirstLine = useSessionDraftsStore((state) => {
    if (!showDraftTab || !workDraftId) return '';
    const text = state.drafts.find((draft) => draft.id === workDraftId)?.text ?? '';
    return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
  });

  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const openNewSessionHere = React.useCallback(() => {
    const { currentSessionId: openId, newSessionDraft, openNewSessionDraft } = useSessionUIStore.getState();
    const directory = openId ? useDirectoryStore.getState().currentDirectory : newSessionDraft.directoryOverride;
    openNewSessionDraft(directory ? { directoryOverride: directory } : undefined);
  }, []);

  const hasClosableTab = tabs.some((tab) => tab.id === currentSessionId) || (showDraftTab && tabs.length > 0);
  React.useEffect(() => {
    if (!hasClosableTab) return;
    return registerCloseTabTarget(() => {
      const id = useSessionUIStore.getState().currentSessionId;
      if (id) closeSessionTabAndActivateNeighbour(id);
      else activateSessionTabByIndex(-1);
    }, { current: document.body });
  }, [hasClosableTab]);

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

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });
  const updateEdges = React.useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const max = node.scrollWidth - node.clientWidth;
    const fromLeft = isRightToLeft(node) ? max + node.scrollLeft : node.scrollLeft;
    const left = fromLeft > 2;
    const right = fromLeft < max - 2;
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

  React.useEffect(() => {
    const node = scrollRef.current;
    const tab = node?.querySelector<HTMLElement>('[data-active-session-tab]');
    if (!node || !tab) return;
    const delta = sessionTabRevealDelta(node.getBoundingClientRect(), tab.getBoundingClientRect());
    if (delta === 0) return;
    node.scrollLeft += delta;
    updateEdges();
  }, [currentSessionId, updateEdges]);

  const maskImage = edges.left && edges.right
    ? `linear-gradient(to right, transparent, black ${SESSION_TAB_EDGE_FADE_PX}px, black calc(100% - ${SESSION_TAB_EDGE_FADE_PX}px), transparent)`
    : edges.left
      ? `linear-gradient(to right, transparent, black ${SESSION_TAB_EDGE_FADE_PX}px)`
      : edges.right
        ? `linear-gradient(to right, black calc(100% - ${SESSION_TAB_EDGE_FADE_PX}px), transparent)`
        : undefined;

  const tabIdsInOrder = React.useMemo(() => tabs.map((tab) => tab.id), [tabs]);

  const showPendingTab = Boolean(currentSessionId) && !tabs.some((tab) => tab.id === currentSessionId);

  return (
    <div className="flex h-full min-w-0 flex-1 items-center" role="tablist" aria-label={t('header.sessionTabs.stripAria')}>
      <div
        ref={scrollRef}
        onScroll={updateEdges}
        onWheel={scrollTabsWithWheel}
        className="session-tabs-scroll flex min-w-0 flex-initial items-center gap-1.5 overflow-x-auto overscroll-x-contain"
        style={maskImage ? { maskImage, WebkitMaskImage: maskImage } : undefined}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToXAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={tabIdsInOrder} strategy={isRtl ? rectSortingStrategy : horizontalListSortingStrategy}>
            {tabs.map((tab, index) => (
              <SessionTabItem
                tabNumber={index + 1}
                key={tab.id}
                tab={tab}
                isActive={tab.id === currentSessionId}
                isPreview={tab.id === previewTabId}
                suppressControls={tab.id === currentSessionId && suppressActiveTabControls}
                onSelect={handleSelect}
                onPin={pinTab}
                onClose={handleClose}
                renderMenu={renderMenu}
                closeOtherTabs={handleCloseOthers}
                onMenuOpenChangeComplete={onMenuOpenChangeComplete}
                menuReturnsFocus={menuReturnsFocus}
              >
                {tab.id === currentSessionId ? children : null}
              </SessionTabItem>
            ))}
          </SortableContext>
        </DndContext>
        {showDraftTab ? (
          <div
            role="tab"
            aria-selected
            className="app-region-no-drag session-tab-slot flex h-7 w-44 shrink-0 items-center rounded-md bg-interactive-selection px-2 text-interactive-selection-foreground"
            data-active="true"
            data-active-session-tab
          >
            <Icon name="edit" className="me-1.5 size-3.5 shrink-0" />
            <div className="session-tab-title min-w-0 flex-1 overflow-hidden whitespace-nowrap italic">
              <span dir="auto" className="block max-w-full overflow-hidden whitespace-nowrap oc-ui-start-align text-[0.8125rem] font-medium leading-4">
                {draftFirstLine || t('sessions.switcher.draftTitle')}
              </span>
            </div>
          </div>
        ) : null}
        {showPendingTab ? (
          <div
            role="tab"
            aria-selected
            className="app-region-no-drag session-tab-slot flex h-7 w-44 shrink-0 items-center rounded-md bg-interactive-selection px-2"
            data-active="true"
          >
            <div className="min-w-0 flex-1">{children}</div>
          </div>
        ) : null}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={openNewSessionHere}
            aria-label={t('sessions.sidebar.header.actions.newSession')}
            className="app-region-no-drag ms-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon name="add" className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          <TooltipLabelWithShortcut label={t('sessions.sidebar.header.actions.newSession')} shortcut={formatShortcutForDisplay(getEffectiveShortcutCombo('new_chat', shortcutOverrides), '')} />
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

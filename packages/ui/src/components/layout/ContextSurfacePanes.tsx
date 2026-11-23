import React from 'react';

import { TerminalView } from '@/components/views/TerminalView';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { BrowserPane } from '@/components/browser/BrowserPane';
import { ChatView } from '@/components/views/ChatView';
import { Icon } from '@/components/icon/Icon';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useGuestTabsInScope } from '@/hooks/useGuestSurfaces';
import { useDraftSpaceTarget } from '@/lib/spaces/useDraftSpaceTarget';
import { panelContentDirectory } from '@/lib/spaces/space-creation-requests';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { SpacePreparing } from '@/components/session/spaces/SpacePreparing';
import { resolvePlanRequestOwner } from '@/hooks/useProjectContextOwner';
import { isRightToLeft, useI18n } from '@/lib/i18n';
import { resolveProjectContextId } from '@/lib/projectContextApi';
import { cn } from '@/lib/utils';
import { registerBrowserCloser, registerBrowserOpener, registerBrowserTabActivity, registerSleepingBrowserTab, setShownBrowserTab } from '@/lib/browser/controlClient';
import { AGENT_TAB_IDLE_MS, dropIdleAgentTabs, pickLiveBrowserTabs, touchRecentBrowserTab } from '@/lib/browser/liveTabs';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useGuestsStore } from '@/lib/guests/store';
import { guestHasSharedSurface, guestSurfaceDocking, type GuestSurfaceDocking } from '@/lib/guests/surfaces';
import { isPluginContextPanelMode, pluginIdFromMode } from '@/lib/surfaces/modes';
import {
  getZoneView,
  resolveZoneActiveTab,
  zoneOfMode,
  type ContextZone,
} from '@/lib/workspace/zones';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { clampContextEditorTreeWidth, normalizeContextPanelDirectoryKey, useUIStore, type PendingDiffScope } from '@/stores/useUIStore';
import { markSessionViewed } from '@/sync/notification-store';
import { setExternallyViewedSession } from '@/sync/sync-context';
import { ContextPanelHeaderSlotProvider } from './contextPanelHeaderSlot';
import { getSessionIDFromDedupeKey } from './contextPanelSessionTitles';
import { ReceivedPagePanel } from '@/components/chat/sharePages/received/ReceivedPagePanel';
import { MovablePane } from './MovablePane';
import { SidebarFilesTree } from './SidebarFilesTree';
import { startZoneDragGesture } from './zoneDrag';
import { ZoneSurfaceDragContext } from './zoneSurfaceDragContext';
import { useZoneHostsStore } from './zoneHosts';
import { useRightSlotStore } from './rightSlot';
import { useOpenUntilSettled, useOpenWhenSettled } from './useOpenUntilSettled';
import { useClosingZoneTab } from './useClosingZoneTab';
import { isZoneDisplaced } from './zoneFitWatch';
import { isZoneExposed, ZoneInteractiveContext } from './zoneInteractiveContext';
import { PauseClock } from '@/components/ui/pause-clock';
import { DockedPanelSurfaceContext } from '@/hooks/usePageColors';

const WalkthroughView = lazyWithChunkRecovery(() => import('@/components/views/walkthrough/WalkthroughView').then((m) => ({ default: m.WalkthroughView })));
const DiffView = lazyWithChunkRecovery(() => import('@/components/views/DiffView').then((m) => ({ default: m.DiffView })));
const FilesView = lazyWithChunkRecovery(() => import('@/components/views/FilesView').then((m) => ({ default: m.FilesView })));
const GuestPanelContent = React.lazy(() => import('./GuestPanelContent').then((module) => ({ default: module.GuestPanelContent })));

type PanelBrowserTab = {
  directory: string;
  id: string;
  targetPath: string | null;
  ownerSessionId: string | null;
};

const browserTabRenderKey = (directory: string, tabId: string): string => `${directory}\u0000${tabId}`;
const AGENT_TAB_IDLE_SWEEP_MS = 60_000;

const EditorTreeColumn: React.FC<{ visible: boolean; active: boolean; fill?: boolean; stretch?: boolean; side: 'left' | 'right' }> = ({ visible, active, fill = false, stretch = false, side }) => {
  const { t } = useI18n();
  const width = useUIStore((state) => state.contextEditorTreeWidth);
  const setWidth = useUIStore((state) => state.setContextEditorTreeWidth);
  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const liveWidthRef = React.useRef<number | null>(null);
  const pointerIDRef = React.useRef<number | null>(null);
  const columnRef = React.useRef<HTMLDivElement | null>(null);

  const applyLiveTreeWidth = React.useCallback((nextWidth: number) => {
    const column = columnRef.current;
    if (!column) {
      return;
    }
    column.style.width = `${nextWidth}px`;
    column.style.setProperty('--oc-editor-tree-width', `${nextWidth}px`);
  }, []);

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!visible) {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    pointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    liveWidthRef.current = width;
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!isResizing || pointerIDRef.current !== event.pointerId) {
      return;
    }
    const towardEditor = side === 'left' ? event.clientX - startXRef.current : startXRef.current - event.clientX;
    const delta = isRightToLeft(event.currentTarget) ? -towardEditor : towardEditor;
    const nextWidth = clampContextEditorTreeWidth(startWidthRef.current + delta);
    if (liveWidthRef.current === nextWidth) {
      return;
    }
    liveWidthRef.current = nextWidth;
    applyLiveTreeWidth(nextWidth);
  };

  const handlePointerEnd = (event: React.PointerEvent) => {
    if (pointerIDRef.current !== event.pointerId) {
      return;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    const finalWidth = clampContextEditorTreeWidth(liveWidthRef.current ?? width);
    pointerIDRef.current = null;
    liveWidthRef.current = null;
    setIsResizing(false);
    setWidth(finalWidth);
  };

  const appliedWidth = visible ? width : 0;
  const stretched = fill && stretch && visible;

  return (
    <div
      ref={columnRef}
      className={cn(
        'relative h-full flex-shrink-0 overflow-hidden bg-background will-change-[width] motion-reduce:transition-none',
        fill && (side === 'left' ? 'me-auto' : 'ms-auto'),
      )}
      style={{
        width: stretched ? '100%' : `${isResizing ? (liveWidthRef.current ?? appliedWidth) : appliedWidth}px`,
        maxWidth: fill ? '100%' : undefined,
        ['--oc-editor-tree-width' as string]: `${isResizing ? (liveWidthRef.current ?? width) : width}px`,
        overflowX: 'clip',
        transitionProperty: isResizing || stretch ? 'none' : 'width',
        transitionDuration: '200ms',
        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      aria-hidden={!visible}
    >
      {visible && !fill && (
        <div aria-hidden="true" className={cn('pointer-events-none absolute inset-y-0 z-20 w-px bg-border', side === 'left' ? 'inset-e-0' : 'inset-s-0')} />
      )}
      {visible && !fill && (
        <div
          className={cn(
            'absolute top-0 z-20 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
            side === 'left' ? 'inset-e-0' : 'inset-s-0',
            isResizing && 'bg-[var(--interactive-border)]'
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('contextPanel.actions.resizePanelAria')}
        />
      )}
      <div
        className={cn(
          'relative z-10 h-full shrink-0 transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          isResizing && 'pointer-events-none',
          !visible && 'pointer-events-none select-none opacity-0'
        )}
        style={{ width: stretched ? '100%' : 'var(--oc-editor-tree-width)', maxWidth: fill ? '100%' : undefined }}
        aria-hidden={!visible}
      >
        <SidebarFilesTree visible={visible && active} />
      </div>
    </div>
  );
};

const ZonePane: React.FC<{
  zone: ContextZone;
  isOpen: boolean;
  interactive: boolean;
  hidden: boolean;
  className?: string;
  children: React.ReactNode;
}> = ({ zone, isOpen, interactive, hidden, className, children }) => {
  return (
    <MovablePane zone={zone}>
      <div className={className}>
        <DockedPanelSurfaceContext.Provider value>
          <ZoneInteractiveContext.Provider value={interactive}>
            <PauseClock paused={!isOpen || hidden}>{children}</PauseClock>
          </ZoneInteractiveContext.Provider>
        </DockedPanelSurfaceContext.Provider>
      </div>
    </MovablePane>
  );
};

export const ContextSurfacePanes: React.FC = () => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const directoryKey = React.useMemo(
    () => (effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : ''),
    [effectiveDirectory],
  );
  const panelState = useGuestTabsInScope(useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined)));
  const draftSpace = useDraftSpaceTarget();
  const spacePreparing = draftSpace?.kind === 'preparing';
  const draftSpaceDirectory = draftSpace?.kind === 'ready' ? draftSpace.directory : null;
  const contentDirectory = panelContentDirectory(draftSpace, effectiveDirectory) ?? '';
  const placement = useUIStore((state) => state.contextSurfaceZones);
  const contextPanelByDirectory = useUIStore((state) => state.contextPanelByDirectory);
  const closeContextPanelTab = useUIStore((state) => state.closeContextPanelTab);
  const closeContextFile = useUIStore((state) => state.closeContextFile);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const openAgentBrowserTab = useUIStore((state) => state.openAgentBrowserTab);
  const openContextFile = useUIStore((state) => state.openContextFile);
  const contextEditorTreeVisible = useUIStore((state) => state.contextEditorTreeVisible);
  const contextEditorVisible = useUIStore((state) => state.contextEditorVisible);
  const fileTreeSide = useUIStore((state) => state.fileTreeSide);
  const setSelectedFilePath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const headerSlots = useZoneHostsStore((state) => state.headerSlot);

  const tabs = React.useMemo(() => panelState?.tabs ?? [], [panelState?.tabs]);

  const chatCovered = useRightSlotStore((state) => state.chatCovered);

  const storedZones = React.useMemo(() => {
    const viewOf = (zone: ContextZone) => {
      const activeTab = panelState ? resolveZoneActiveTab(panelState, placement, zone) : null;
      const covered = zone === 'bottom' && chatCovered;
      return { activeTab, isOpen: Boolean(panelState && getZoneView(panelState, zone).isOpen && activeTab) && !covered };
    };
    return { left: viewOf('left'), right: viewOf('right'), bottom: viewOf('bottom') };
  }, [chatCovered, panelState, placement]);
  const zones = {
    left: { ...storedZones.left, activeTab: useClosingZoneTab(storedZones.left.activeTab, storedZones.left.isOpen) },
    right: { ...storedZones.right, activeTab: useClosingZoneTab(storedZones.right.activeTab, storedZones.right.isOpen) },
    bottom: { ...storedZones.bottom, activeTab: useClosingZoneTab(storedZones.bottom.activeTab, storedZones.bottom.isOpen) },
  };

  const settledShown = {
    left: useOpenUntilSettled(zones.left.isOpen),
    right: useOpenUntilSettled(zones.right.isOpen),
    bottom: useOpenUntilSettled(zones.bottom.isOpen),
  };
  const contentHidden = (zone: ContextZone): boolean => !settledShown[zone];
  const settledOpen = {
    left: useOpenWhenSettled(zones.left.isOpen),
    right: useOpenWhenSettled(zones.right.isOpen),
    bottom: useOpenWhenSettled(zones.bottom.isOpen),
  };
  const interactive = {
    left: isZoneExposed(zones.left.isOpen, settledOpen.left, zones.left.activeTab?.mode),
    right: isZoneExposed(zones.right.isOpen, settledOpen.right, zones.right.activeTab?.mode),
    bottom: isZoneExposed(zones.bottom.isOpen, settledOpen.bottom, zones.bottom.activeTab?.mode),
  };

  const zoneFor = (mode: Parameters<typeof zoneOfMode>[1]) => {
    const zone = zoneOfMode(placement, mode);
    return { zone, ...zones[zone] };
  };
  const fileZone = zoneFor('file');
  const chatZone = zoneFor('chat');
  const browserZone = zoneFor('browser');
  const diffZone = zoneFor('diff');
  const terminalZone = zoneFor('terminal');
  const walkthroughZone = zoneFor('walkthrough');

  const [recentBrowserTabs, setRecentBrowserTabs] = React.useState<readonly string[]>([]);
  const browserTabLastUsed = React.useRef(new Map<string, number>());
  const wakeBrowserTab = React.useCallback((directory: string, tabId: string) => {
    const key = browserTabRenderKey(directory, tabId);
    browserTabLastUsed.current.set(key, Date.now());
    setRecentBrowserTabs((current) => touchRecentBrowserTab(current, key));
  }, []);
  React.useEffect(() => registerBrowserTabActivity((directory, tabId) => {
    browserTabLastUsed.current.set(browserTabRenderKey(directory, tabId), Date.now());
  }), []);
  const liveBrowserTabLimit = useUIStore((state) => state.liveBrowserTabLimit);
  const agentBrowserSharesLogins = useUIStore((state) => state.agentBrowserSharesLogins);

  React.useEffect(() => registerBrowserOpener((url, context) => {
    const directory = context.directory ? normalizeContextPanelDirectoryKey(context.directory) : directoryKey;
    if (!directory) return null;
    const tabId = openAgentBrowserTab(directory, url, context.sessionId);
    if (tabId) wakeBrowserTab(directory, tabId);
    return tabId;
  }), [directoryKey, openAgentBrowserTab, wakeBrowserTab]);
  React.useEffect(() => registerBrowserCloser((directory, tabId) => {
    const tabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs;
    if (!tabs?.some((tab) => tab.id === tabId && tab.mode === 'browser')) return false;
    closeContextPanelTab(directory, tabId);
    return true;
  }), [closeContextPanelTab]);
  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type !== 'file-open-request') return;
    const directory = event.directory ?? effectiveDirectory;
    if (!directory) return;
    openContextFile(directory, event.path);
  }), [effectiveDirectory, openContextFile]);
  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type !== 'plan-open-request') return;
    const directory = event.directory ?? effectiveDirectory;
    const projectRef = resolvePlanRequestOwner(directory, event.projectId);
    if (!directory || !projectRef) return;
    useUIStore.getState().openProjectKnowledgePlan(directory, resolveProjectContextId(projectRef), event.planId);
  }), [effectiveDirectory]);

  const storedBrowserTab = storedZones[browserZone.zone].activeTab;
  const shownBrowserTabId = storedBrowserTab?.mode === 'browser' ? storedBrowserTab.id : null;
  React.useEffect(() => {
    setShownBrowserTab(directoryKey, shownBrowserTabId);
  }, [directoryKey, shownBrowserTabId]);

  const fileActiveTab = storedZones[fileZone.zone].activeTab;
  React.useEffect(() => {
    if (!contentDirectory || fileActiveTab?.mode !== 'file' || !fileActiveTab.targetPath) {
      return;
    }
    const sameSide = spaceIdOfDirectory(fileActiveTab.targetPath) === spaceIdOfDirectory(contentDirectory);
    setSelectedFilePath(normalizeContextPanelDirectoryKey(contentDirectory), fileActiveTab.targetPath, { allowOutsideRoot: !draftSpace && sameSide });
  }, [contentDirectory, draftSpace, fileActiveTab, setSelectedFilePath]);

  const hasOpenEditorFile = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file' && tab.targetPath),
    [tabs],
  );
  const hasFileTabs = React.useMemo(() => tabs.some((tab) => tab.mode === 'file'), [tabs]);
  const showsEditor = hasOpenEditorFile && (contextEditorVisible || !contextEditorTreeVisible);
  const isFileTabActive = fileZone.activeTab?.mode === 'file';

  const handleCloseEditorFile = React.useCallback((filePath: string) => {
    if (directoryKey) closeContextFile(directoryKey, filePath);
  }, [closeContextFile, directoryKey]);

  const chatActiveTab = chatZone.isOpen && chatZone.activeTab?.mode === 'chat' ? chatZone.activeTab : null;
  const activeChatSessionID = chatActiveTab ? getSessionIDFromDedupeKey(chatActiveTab.dedupeKey) : null;
  const activeChatDirectory = React.useMemo(() => {
    const own = chatActiveTab?.targetDirectory ? normalizeContextPanelDirectoryKey(chatActiveTab.targetDirectory) : '';
    return own || directoryKey || null;
  }, [chatActiveTab?.targetDirectory, directoryKey]);
  const activeChatPinnedSession = React.useMemo(
    () => (activeChatSessionID ? { sessionId: activeChatSessionID, directory: activeChatDirectory } : null),
    [activeChatSessionID, activeChatDirectory],
  );

  React.useEffect(() => {
    if (!activeChatDirectory || !activeChatSessionID || typeof window === 'undefined') {
      return;
    }

    const markActiveChatViewed = () => {
      if (document.visibilityState === 'hidden' || !document.hasFocus()) {
        setExternallyViewedSession(activeChatDirectory, activeChatSessionID, false);
        return;
      }

      markSessionViewed(activeChatSessionID);
      setExternallyViewedSession(activeChatDirectory, activeChatSessionID, true);
    };

    markActiveChatViewed();
    const interval = window.setInterval(markActiveChatViewed, 10_000);
    window.addEventListener('focus', markActiveChatViewed);
    window.addEventListener('blur', markActiveChatViewed);
    document.addEventListener('visibilitychange', markActiveChatViewed);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', markActiveChatViewed);
      window.removeEventListener('blur', markActiveChatViewed);
      document.removeEventListener('visibilitychange', markActiveChatViewed);
      setExternallyViewedSession(activeChatDirectory, activeChatSessionID, false);
    };
  }, [activeChatDirectory, activeChatSessionID]);

  const diffActiveTab = diffZone.activeTab;
  const handleDiffScopeChange = React.useCallback((nextScope: PendingDiffScope) => {
    if (!directoryKey || diffActiveTab?.mode !== 'diff') {
      return;
    }

    openContextPanelTab(directoryKey, {
      mode: 'diff',
      targetPath: diffActiveTab.targetPath,
      targetDirectory: diffActiveTab.targetDirectory,
      stagedDiff: nextScope === 'staged',
      diffScope: nextScope,
    });
  }, [diffActiveTab, directoryKey, openContextPanelTab]);

  const visibleBrowserTabId = browserZone.isOpen && browserZone.activeTab?.mode === 'browser' ? browserZone.activeTab.id : null;
  React.useEffect(() => {
    if (visibleBrowserTabId && directoryKey) wakeBrowserTab(directoryKey, visibleBrowserTabId);
  }, [directoryKey, visibleBrowserTabId, wakeBrowserTab]);
  const shownBrowserTabKey = React.useRef<string | null>(null);
  React.useEffect(() => {
    shownBrowserTabKey.current = visibleBrowserTabId && directoryKey ? browserTabRenderKey(directoryKey, visibleBrowserTabId) : null;
  }, [directoryKey, visibleBrowserTabId]);
  React.useEffect(() => {
    const sweep = () => {
      const now = Date.now();
      const lastUsed = browserTabLastUsed.current;
      if (shownBrowserTabKey.current) lastUsed.set(shownBrowserTabKey.current, now);
      const agentTabs = new Set<string>();
      for (const [directory, directoryState] of Object.entries(useUIStore.getState().contextPanelByDirectory)) {
        for (const tab of directoryState.tabs) {
          if (tab.mode === 'browser' && tab.ownerSessionId !== null) agentTabs.add(browserTabRenderKey(directory, tab.id));
        }
      }
      setRecentBrowserTabs((current) => dropIdleAgentTabs(current, agentTabs, lastUsed, now - AGENT_TAB_IDLE_MS));
    };
    const interval = window.setInterval(sweep, AGENT_TAB_IDLE_SWEEP_MS);
    return () => window.clearInterval(interval);
  }, []);
  const { loadedBrowserTabs, sleepingBrowserTabs } = React.useMemo(() => {
    const recent = new Set(recentBrowserTabs);
    const openUserTabs = new Set<string>();
    for (const [directory, directoryState] of Object.entries(contextPanelByDirectory)) {
      for (const tab of directoryState.tabs) {
        if (tab.mode === 'browser' && tab.ownerSessionId === null) openUserTabs.add(browserTabRenderKey(directory, tab.id));
      }
    }
    const liveUserTabs = pickLiveBrowserTabs(recentBrowserTabs, openUserTabs, liveBrowserTabLimit);
    const loaded: PanelBrowserTab[] = [];
    const sleeping: PanelBrowserTab[] = [];
    for (const [directory, directoryState] of Object.entries(contextPanelByDirectory)) {
      const isShownDirectory = directory === directoryKey;
      for (const tab of directoryState.tabs) {
        if (tab.mode !== 'browser') continue;
        const key = browserTabRenderKey(directory, tab.id);
        const isUserTab = tab.ownerSessionId === null;
        const isLoaded = (isShownDirectory && tab.id === visibleBrowserTabId)
          || (isUserTab ? liveUserTabs.has(key) : recent.has(key));
        if (!isLoaded && !isShownDirectory && isUserTab) continue;
        const entry = { directory, id: tab.id, targetPath: tab.targetPath, ownerSessionId: tab.ownerSessionId };
        (isLoaded ? loaded : sleeping).push(entry);
      }
    }
    loaded.sort((a, b) => (browserTabRenderKey(a.directory, a.id) < browserTabRenderKey(b.directory, b.id) ? -1 : 1));
    return { loadedBrowserTabs: loaded, sleepingBrowserTabs: sleeping };
  }, [contextPanelByDirectory, directoryKey, liveBrowserTabLimit, recentBrowserTabs, visibleBrowserTabId]);
  React.useEffect(() => {
    if (!window.__OPENCHAMBER_ELECTRON__) return;
    const unregister = sleepingBrowserTabs.map((tab) => registerSleepingBrowserTab({
      tabId: tab.id,
      directory: tab.directory,
      ownerSessionId: tab.ownerSessionId,
      describe: () => ({ title: '', url: tab.targetPath ?? '' }),
      wake: () => wakeBrowserTab(tab.directory, tab.id),
    }));
    return () => unregister.forEach((release) => release());
  }, [sleepingBrowserTabs, wakeBrowserTab]);

  const diffTabs = React.useMemo(() => tabs.filter((tab) => tab.mode === 'diff'), [tabs]);
  const terminalTab = React.useMemo(
    () => tabs.find((tab) => tab.mode === 'terminal') ?? null,
    [tabs],
  );
  const walkthroughTab = React.useMemo(() => tabs.find((tab) => tab.mode === 'walkthrough') ?? null, [tabs]);
  const pluginTabs = React.useMemo(() => tabs.filter((tab) => isPluginContextPanelMode(tab.mode)), [tabs]);
  const pageTabs = React.useMemo(() => tabs.filter((tab) => tab.mode === 'pages' && tab.targetPath), [tabs]);
  const guests = useGuestsStore((state) => state.guests);
  const surfaceGuestIds = React.useMemo(
    () => new Set(guests.filter(guestHasSharedSurface).map((guest) => guest.id)),
    [guests],
  );
  const surfaceDockings = React.useMemo(() => {
    const dockings = new Map<string, GuestSurfaceDocking>();
    for (const guest of guests) {
      const docking = guestSurfaceDocking(guest);
      if (docking) dockings.set(guest.id, docking);
    }
    return dockings;
  }, [guests]);

  const terminalZoneOfPlacement = terminalZone.zone;
  const terminalDragOut = React.useCallback((isOutside: (point: { x: number; y: number }) => boolean) => {
    const gesture = startZoneDragGesture({ mode: 'terminal', label: t('layout.mainTab.terminal'), from: terminalZoneOfPlacement }, isOutside);
    return { finish: () => gesture.finish(directoryKey), cancel: gesture.cancel };
  }, [directoryKey, t, terminalZoneOfPlacement]);

  const headerSlotFor = (zone: ContextZone, active: boolean): HTMLElement | null => (active ? headerSlots[zone] : null);


  const [seenPluginTabs, setSeenPluginTabs] = React.useState<ReadonlySet<string>>(() => new Set());
  const newlyShownPluginTabs = [...pluginTabs, ...pageTabs].filter((tab) => {
    if (seenPluginTabs.has(tab.id)) return false;
    const zone = zoneFor(tab.mode);
    return zone.isOpen && zone.activeTab?.id === tab.id;
  });
  if (newlyShownPluginTabs.length > 0) {
    setSeenPluginTabs(new Set([...seenPluginTabs, ...newlyShownPluginTabs.map((tab) => tab.id)]));
  }

  return (
    <>
      {hasFileTabs ? (
        <ZonePane
          zone={fileZone.zone}
          interactive={interactive[fileZone.zone]}
          isOpen={fileZone.isOpen}
          hidden={contentHidden(fileZone.zone)}
          className={cn('absolute inset-0 flex', fileTreeSide === 'left' && 'flex-row-reverse', isFileTabActive ? 'flex' : 'hidden')}
        >
          {spacePreparing ? (
            <div className="h-full min-w-0 flex-1"><SpacePreparing /></div>
          ) : hasOpenEditorFile || !contextEditorTreeVisible ? (
            <div className={cn('h-full min-w-0 flex-1', hasOpenEditorFile && !showsEditor && 'hidden')}>
              {hasOpenEditorFile ? (
                <React.Suspense fallback={null}><FilesView visible={!contentHidden(fileZone.zone) && isFileTabActive && showsEditor} onCloseFile={handleCloseEditorFile} /></React.Suspense>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                  <Icon name="file-code" className="h-12 w-12 text-muted-foreground/50" />
                  <div className="typography-ui-header text-foreground">{t('contextPanel.editorEmpty.title')}</div>
                  <div className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.editorEmpty.description')}</div>
                </div>
              )}
            </div>
          ) : null}
          {spacePreparing ? null : <EditorTreeColumn visible={contextEditorTreeVisible} active={fileZone.isOpen && isFileTabActive} fill={!showsEditor} stretch={fileZone.zone === 'bottom'} side={fileTreeSide} />}
        </ZonePane>
      ) : null}
      {chatActiveTab && activeChatSessionID && activeChatPinnedSession ? (
        <ZonePane key={chatActiveTab.id} zone={chatZone.zone} interactive={interactive[chatZone.zone]} isOpen={chatZone.isOpen} hidden={contentHidden(chatZone.zone)} className="absolute inset-0 bg-background">
          <section
            aria-label={t('contextPanel.iframe.sessionChatTitle', { sessionID: activeChatSessionID })}
            className="h-full"
          >
            <ChatView
              pinnedSession={activeChatPinnedSession}
              readOnly={chatActiveTab.readOnly}
            />
          </section>
        </ZonePane>
      ) : null}
      {loadedBrowserTabs.map((tab) => {
        const shown = tab.directory === directoryKey && browserZone.activeTab?.id === tab.id;
        const siteDirectory = tab.directory === directoryKey ? draftSpaceDirectory ?? tab.directory : tab.directory;
        return (
          <ZonePane
            key={browserTabRenderKey(tab.directory, tab.id)}
            zone={browserZone.zone}
            interactive={interactive[browserZone.zone]}
            isOpen={browserZone.isOpen}
            hidden={contentHidden(browserZone.zone)}
            className={cn('absolute inset-0', !shown && 'invisible pointer-events-none')}
          >
            <div className="h-full" aria-hidden={!shown || undefined}>
              <PauseClock paused={!shown}>
              {tab.directory === directoryKey && spacePreparing ? <SpacePreparing /> : (
                <BrowserPane
                  key={tab.ownerSessionId !== null && !agentBrowserSharesLogins ? `${siteDirectory}\u0000agent` : siteDirectory}
                  initialUrl={tab.targetPath ?? ''}
                  directory={tab.directory}
                  siteDirectory={siteDirectory}
                  tabID={tab.id}
                  ownerSessionId={tab.ownerSessionId}
                  visible={shown && browserZone.isOpen}
                />
              )}
              </PauseClock>
            </div>
          </ZonePane>
        );
      })}
      {diffTabs.map((tab) => {
        const active = diffZone.activeTab?.id === tab.id;
        return (
          <ZonePane
            key={tab.id}
            zone={diffZone.zone}
            interactive={interactive[diffZone.zone]}
            isOpen={diffZone.isOpen}
            hidden={contentHidden(diffZone.zone)}
            className={cn('absolute inset-0', !active && 'hidden')}
          >
            <React.Suspense fallback={null}>
              <ContextPanelHeaderSlotProvider value={headerSlotFor(diffZone.zone, active)}>
                {spacePreparing && !tab.targetDirectory ? <SpacePreparing /> : <DiffView
                  directory={tab.targetDirectory ?? draftSpaceDirectory}
                  visible={diffZone.isOpen && active}
                  hideStackedFileSidebar
                  stackedDefaultCollapsedAll
                  pinSelectedFileHeaderToTopOnNavigate
                  showOpenInEditorAction
                  diffScope={tab.diffScope ?? (tab.stagedDiff ? 'staged' : null)}
                  onDiffScopeChange={handleDiffScopeChange}
                  targetFilePath={tab.targetPath}
                  flushContent
                />}
              </ContextPanelHeaderSlotProvider>
            </React.Suspense>
          </ZonePane>
        );
      })}
      {terminalTab ? (
        <ZonePane
          zone={terminalZone.zone}
          interactive={interactive[terminalZone.zone]}
          isOpen={terminalZone.isOpen}
          hidden={contentHidden(terminalZone.zone)}
          className={cn('absolute inset-0', terminalZone.activeTab?.mode === 'terminal' ? 'block' : 'hidden')}
        >
          <ContextPanelHeaderSlotProvider value={headerSlotFor(terminalZone.zone, terminalZone.activeTab?.mode === 'terminal')}>
            <ZoneSurfaceDragContext.Provider value={terminalDragOut}>
              <TerminalView
                visible={terminalZone.isOpen && terminalZone.activeTab?.mode === 'terminal'}
                directory={terminalTab.targetDirectory}
                onLastTabClosed={() => { if (directoryKey) closeContextPanelTab(directoryKey, terminalTab.id); }}
              />
            </ZoneSurfaceDragContext.Provider>
          </ContextPanelHeaderSlotProvider>
        </ZonePane>
      ) : null}
      {walkthroughTab ? (
        <ZonePane
          zone={walkthroughZone.zone}
          interactive={interactive[walkthroughZone.zone]}
          isOpen={walkthroughZone.isOpen}
          hidden={contentHidden(walkthroughZone.zone)}
          className={cn('absolute inset-0', walkthroughZone.activeTab?.mode === 'walkthrough' ? 'block' : 'hidden')}
        >
          <React.Suspense fallback={null}>
            <ContextPanelHeaderSlotProvider value={headerSlotFor(walkthroughZone.zone, walkthroughZone.activeTab?.mode === 'walkthrough')}>
              <WalkthroughView directory={walkthroughTab.targetDirectory ?? effectiveDirectory} visible={walkthroughZone.isOpen && walkthroughZone.activeTab?.mode === 'walkthrough'} />
            </ContextPanelHeaderSlotProvider>
          </React.Suspense>
        </ZonePane>
      ) : null}
      {pageTabs.map((tab) => {
        const pageZone = zoneFor(tab.mode);
        if (!seenPluginTabs.has(tab.id) || !tab.targetPath) return null;
        return (
          <ZonePane
            key={tab.id}
            zone={pageZone.zone}
            interactive={interactive[pageZone.zone]}
            isOpen={pageZone.isOpen}
            hidden={contentHidden(pageZone.zone)}
            className={cn('absolute inset-0', pageZone.activeTab?.id === tab.id ? 'block' : 'hidden')}
          >
            <ReceivedPagePanel receivedId={tab.targetPath} />
          </ZonePane>
        );
      })}
      {pluginTabs.map((tab) => {
        if (!isPluginContextPanelMode(tab.mode)) return null;
        const pluginZone = zoneFor(tab.mode);
        if (!seenPluginTabs.has(tab.id)) return null;
        const guestId = pluginIdFromMode(tab.mode);
        const sharedSurface = surfaceGuestIds.has(guestId);
        const docking = surfaceDockings.get(guestId);
        const shown = pluginZone.activeTab?.id === tab.id;
        const surfaceMounted = shown && pluginZone.isOpen;
        if (sharedSurface && !docking && !surfaceMounted) return null;
        return (
          <ZonePane
            key={tab.id}
            zone={pluginZone.zone}
            interactive={interactive[pluginZone.zone]}
            isOpen={pluginZone.isOpen}
            hidden={contentHidden(pluginZone.zone)}
            className={cn('absolute inset-0', shown ? 'block' : 'hidden')}
          >
            <React.Suspense fallback={null}>
              <GuestPanelContent mode={tab.mode} sharedSurface={sharedSurface} docking={docking ?? null} surfaceMounted={surfaceMounted} panelOpen={Boolean(panelState && getZoneView(panelState, pluginZone.zone).isOpen) || isZoneDisplaced(directoryKey, pluginZone.zone)} />
            </React.Suspense>
          </ZonePane>
        );
      })}
    </>
  );
};

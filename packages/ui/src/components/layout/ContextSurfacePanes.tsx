import React from 'react';

import { TerminalView } from '@/components/views/TerminalView';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { BrowserPane } from '@/components/browser/BrowserPane';
import { ChatView } from '@/components/views/ChatView';
import { Icon } from '@/components/icon/Icon';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { registerBrowserOpener, registerSleepingBrowserTab, setShownBrowserTab } from '@/lib/browser/controlClient';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useGuestsStore } from '@/lib/guests/store';
import { guestHasSharedSurface, guestSurfaceDocking, type GuestSurfaceDocking } from '@/lib/guests/surfaces';
import { GUEST_SURFACE_DOCK_SIZE_MIN } from '@openchamber/sdk';
import { isPluginContextPanelMode, pluginIdFromMode, type PluginContextPanelMode } from '@/lib/surfaces/modes';
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
import { MovablePane } from './MovablePane';
import { SidebarFilesTree } from './SidebarFilesTree';
import { closeZoneOnEscape } from './zoneEscape';
import { startZoneDragGesture } from './zoneDrag';
import { ZoneSurfaceDragContext } from './zoneSurfaceDragContext';
import { useZoneHostsStore } from './zoneHosts';
import { useRightSlotStore } from './rightSlot';
import { useOpenUntilSettled } from './useOpenUntilSettled';

// Heavy views stay on-demand (same as MainLayout): importing DiffView/FilesView
// or the walkthrough statically pulls the CodeMirror and @pierre/diffs stacks
// into the eager startup graph even when no such tab is open.
const WalkthroughView = lazyWithChunkRecovery(() => import('@/components/views/walkthrough/WalkthroughView').then((m) => ({ default: m.WalkthroughView })));
const DiffView = lazyWithChunkRecovery(() => import('@/components/views/DiffView').then((m) => ({ default: m.DiffView })));
const FilesView = lazyWithChunkRecovery(() => import('@/components/views/FilesView').then((m) => ({ default: m.FilesView })));
const PluginPane = React.lazy(() => import('./PluginPane').then((module) => ({ default: module.PluginPane })));
const GuestSurfacePane = React.lazy(() => import('./GuestSurfacePane').then((module) => ({ default: module.GuestSurfacePane })));

// How an extension page sits beside its shared surface: flex direction puts
// the page first on top/left and last on bottom/right; the page's size is
// fixed across the docked edge and the picture takes the rest.
const DOCK_LAYOUT = {
  top: { container: 'flex-col', page: 'border-b border-border', vertical: true },
  bottom: { container: 'flex-col-reverse', page: 'border-t border-border', vertical: true },
  left: { container: 'flex-row', page: 'border-r border-border', vertical: false },
  right: { container: 'flex-row-reverse', page: 'border-l border-border', vertical: false },
} as const;

/**
 * A shared-surface extension's own page, docked to one edge of the picture.
 * It starts at the manifest's `panel.size` and follows the page's
 * `host.setHeight` after that (the thickness across its edge, so a width
 * for a left or right dock), never below the manifest minimum and never past
 * half the panel, so the picture always stays in view.
 */
const DockedGuestPage: React.FC<{ mode: PluginContextPanelMode; docking: GuestSurfaceDocking }> = ({ mode, docking }) => {
  const [requested, setRequested] = React.useState<number | null>(null);
  const layout = DOCK_LAYOUT[docking.dock];
  const size = Math.max(GUEST_SURFACE_DOCK_SIZE_MIN, requested ?? docking.size);
  return (
    <div
      className={cn(
        'shrink-0 overflow-hidden duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        layout.vertical ? 'max-h-[50%] transition-[height]' : 'max-w-[50%] transition-[width]',
        layout.page,
      )}
      style={layout.vertical ? { height: size } : { width: size }}
    >
      <PluginPane mode={mode} onResize={setRequested} />
    </div>
  );
};

/** A browser tab with the project it belongs to, which may not be the one on screen. */
type PanelBrowserTab = {
  directory: string;
  id: string;
  targetPath: string | null;
  ownerSessionId: string | null;
};

// The editor surface's file-tree column: docked on the side the user picked
// (`fileTreeSide`, right by default), resizable from the edge that faces the
// editor, and animated open/closed like the app sidebars. In tree-only mode
// (`fill`), the panel collapses around this fixed-width column, aligned to
// its side.
const EditorTreeColumn: React.FC<{ visible: boolean; active: boolean; fill?: boolean; side: 'left' | 'right' }> = ({ visible, active, fill = false, side }) => {
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
    // The column grows away from its side's edge, toward the editor.
    const delta = side === 'left' ? event.clientX - startXRef.current : startXRef.current - event.clientX;
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

  return (
    <div
      ref={columnRef}
      className={cn(
        'relative h-full flex-shrink-0 overflow-hidden bg-background will-change-[width] motion-reduce:transition-none',
        fill && (side === 'left' ? 'mr-auto' : 'ml-auto'),
      )}
      style={{
        width: `${isResizing ? (liveWidthRef.current ?? appliedWidth) : appliedWidth}px`,
        maxWidth: fill ? '100%' : undefined,
        ['--oc-editor-tree-width' as string]: `${isResizing ? (liveWidthRef.current ?? width) : width}px`,
        overflowX: 'clip',
        transitionProperty: isResizing ? 'none' : 'width',
        transitionDuration: '200ms',
        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      aria-hidden={!visible}
    >
      {/* Paint the divider without shifting tree content when the editor closes. */}
      {visible && !fill && (
        <div aria-hidden="true" className={cn('pointer-events-none absolute inset-y-0 z-20 w-px bg-border', side === 'left' ? 'right-0' : 'left-0')} />
      )}
      {visible && !fill && (
        <div
          className={cn(
            'absolute top-0 z-20 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
            side === 'left' ? 'right-0' : 'left-0',
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
        style={{ width: 'var(--oc-editor-tree-width)', maxWidth: fill ? '100%' : undefined }}
        aria-hidden={!visible}
      >
        <SidebarFilesTree visible={visible && active} />
      </div>
    </div>
  );
};

/**
 * A keep-alive pane: portalled into its zone's body, with the zone's Escape.
 * Its React events do not pass through the zone frame, so it closes the zone
 * itself.
 */
const ZonePane: React.FC<{
  zone: ContextZone;
  isOpen: boolean;
  directoryKey: string;
  className?: string;
  children: React.ReactNode;
}> = ({ zone, isOpen, directoryKey, className, children }) => {
  const closeContextZone = useUIStore((state) => state.closeContextZone);
  const handleKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    closeZoneOnEscape(event, isOpen, () => {
      if (directoryKey) closeContextZone(directoryKey, zone);
    }, event.currentTarget.closest('[data-context-zone]'));
  }, [closeContextZone, directoryKey, isOpen, zone]);
  return (
    <MovablePane zone={zone}>
      <div className={className} onKeyDownCapture={handleKeyDownCapture}>
        {children}
      </div>
    </MovablePane>
  );
};

/**
 * Every keep-alive context surface, mounted once for the whole layout and
 * placed into the zone its surface lives in (`MovablePane`). The zone frames
 * (`ContextPanel`) render their chrome and the surfaces that remount on
 * switch (git, notes, plan, ...); these hold state a remount would lose.
 *
 * Rendered after every zone frame: the frames register their bodies from
 * refs and begin their layout animation in layout effects, both of which have
 * to run before the panes attach and the settle step queues behind them.
 */
export const ContextSurfacePanes: React.FC = () => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const directoryKey = React.useMemo(
    () => (effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : ''),
    [effectiveDirectory],
  );
  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
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

  // A page covering the chat (Archive, Usage, ...) covers the bottom zone
  // under it too; its frame closes then (ContextPanel), and so must its panes.
  const chatCovered = useRightSlotStore((state) => state.chatCovered);

  // What each zone shows. A zone is open only with a tab of its own.
  const zones = React.useMemo(() => {
    const viewOf = (zone: ContextZone) => {
      const activeTab = panelState ? resolveZoneActiveTab(panelState, placement, zone) : null;
      const covered = zone === 'bottom' && chatCovered;
      return { activeTab, isOpen: Boolean(panelState && getZoneView(panelState, zone).isOpen && activeTab) && !covered };
    };
    return { left: viewOf('left'), right: viewOf('right'), bottom: viewOf('bottom') };
  }, [chatCovered, panelState, placement]);

  // A closing zone's content leaves the document (the editor's `detached`)
  // only once its animation has settled. The zone frame runs the same hook
  // for its `inert`; both settle in one task, so they change in one commit.
  // Rendered after the frames, so their animation has begun by now.
  const settledShown = {
    left: useOpenUntilSettled(zones.left.isOpen),
    right: useOpenUntilSettled(zones.right.isOpen),
    bottom: useOpenUntilSettled(zones.bottom.isOpen),
  };
  const contentHidden = (zone: ContextZone): boolean => !settledShown[zone];

  // The zone each keep-alive surface lives in, and what that zone shows.
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

  // A browser tab loads its page only once it is needed: shown in an open
  // zone, opened by the agent, or woken by an agent action. Tabs restored
  // from a previous run otherwise stay asleep, since every loaded tab costs a
  // Chromium process. Once loaded, a tab stays loaded until it is closed.
  const [wokenBrowserTabIds, setWokenBrowserTabIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const wakeBrowserTab = React.useCallback((tabId: string) => {
    setWokenBrowserTabIds((current) => (current.has(tabId) ? current : new Set(current).add(tabId)));
  }, []);

  // Lets an agent's browser.open create its own tab; the id goes back to the
  // agent so it keeps working there. Registered here because opening a tab is panel state, not
  // something the browser view itself can do before it exists. Background on
  // purpose: an agent working a page must not pop the panel open or steal the
  // active tab while the user reads something else, and that includes taking
  // a screenshot of it. The tab appears in the strip of the calling session's
  // project, which is not always the project on screen, and belongs to that
  // session.
  React.useEffect(() => registerBrowserOpener((url, context) => {
    const directory = context.directory ? normalizeContextPanelDirectoryKey(context.directory) : directoryKey;
    if (!directory) return null;
    const tabId = openAgentBrowserTab(directory, url, context.sessionId);
    if (tabId) wakeBrowserTab(tabId);
    return tabId;
  }), [directoryKey, openAgentBrowserTab, wakeBrowserTab]);
  // The agent asked for a file to be shown. It opens in front of whatever tab
  // the user had, on purpose: the agent is pointing at a result, and the prior
  // tab is one click away.
  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type !== 'file-open-request') return;
    const directory = event.directory ?? effectiveDirectory;
    if (!directory) return;
    openContextFile(directory, event.path);
  }), [effectiveDirectory, openContextFile]);

  // Tells agent browser control which project is on screen and which browser
  // tab the user last had in front of them there; a session without a tab of
  // its own may use that tab only when it is the user's and in its project.
  const shownBrowserTabId = browserZone.activeTab?.mode === 'browser' ? browserZone.activeTab.id : null;
  React.useEffect(() => {
    setShownBrowserTab(directoryKey, shownBrowserTabId);
  }, [directoryKey, shownBrowserTabId]);

  const fileActiveTab = fileZone.activeTab;
  React.useEffect(() => {
    if (!directoryKey || fileActiveTab?.mode !== 'file' || !fileActiveTab.targetPath) {
      return;
    }
    setSelectedFilePath(directoryKey, fileActiveTab.targetPath, { allowOutsideRoot: true });
  }, [directoryKey, fileActiveTab, setSelectedFilePath]);

  const hasOpenEditorFile = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file' && tab.targetPath),
    [tabs],
  );
  const hasFileTabs = React.useMemo(() => tabs.some((tab) => tab.mode === 'file'), [tabs]);
  // The editor column is shown for an open file unless the user hid it; the
  // tree never hides alongside it, so a hidden tree forces the editor back.
  const showsEditor = hasOpenEditorFile && (contextEditorVisible || !contextEditorTreeVisible);
  const isFileTabActive = fileZone.activeTab?.mode === 'file';

  // The editor's Cmd/Ctrl+W and its unsaved-changes prompt close the file's
  // tab here, so the strip and the next file follow as with the close button.
  const handleCloseEditorFile = React.useCallback((filePath: string) => {
    if (directoryKey) closeContextFile(directoryKey, filePath);
  }, [closeContextFile, directoryKey]);

  const chatActiveTab = chatZone.isOpen && chatZone.activeTab?.mode === 'chat' ? chatZone.activeTab : null;
  const activeChatSessionID = chatActiveTab ? getSessionIDFromDedupeKey(chatActiveTab.dedupeKey) : null;
  // A chat opened from another project (or Chat) carries its own directory;
  // tabs opened without one (subtasks, reviews) belong to this panel's.
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
      stagedDiff: nextScope === 'staged',
      diffScope: nextScope,
    });
  }, [diffActiveTab, directoryKey, openContextPanelTab]);

  const visibleBrowserTabId = browserZone.isOpen && browserZone.activeTab?.mode === 'browser' ? browserZone.activeTab.id : null;
  React.useEffect(() => {
    if (visibleBrowserTabId) wakeBrowserTab(visibleBrowserTabId);
  }, [visibleBrowserTabId, wakeBrowserTab]);
  // The browser tabs agents can reach: this project's, and every other
  // project's agent tabs, so a session working in a project the user is not
  // looking at keeps its page. The user's own tabs in other projects are left
  // out and unload with their project, as before. Sorted by directory and tab
  // id, an order that neither the project on screen nor the store's own
  // reordering of directories can change: a moved webview reloads its page.
  const { loadedBrowserTabs, sleepingBrowserTabs } = React.useMemo(() => {
    const loaded: PanelBrowserTab[] = [];
    const sleeping: PanelBrowserTab[] = [];
    for (const [directory, directoryState] of Object.entries(contextPanelByDirectory)) {
      const isShownDirectory = directory === directoryKey;
      for (const tab of directoryState.tabs) {
        if (tab.mode !== 'browser' || (!isShownDirectory && tab.ownerSessionId === null)) continue;
        const entry = { directory, id: tab.id, targetPath: tab.targetPath, ownerSessionId: tab.ownerSessionId };
        const isLoaded = wokenBrowserTabIds.has(tab.id) || (isShownDirectory && tab.id === visibleBrowserTabId);
        (isLoaded ? loaded : sleeping).push(entry);
      }
    }
    const renderKeyOf = (tab: PanelBrowserTab) => `${tab.directory}\u0000${tab.id}`;
    loaded.sort((a, b) => (renderKeyOf(a) < renderKeyOf(b) ? -1 : 1));
    return { loadedBrowserTabs: loaded, sleepingBrowserTabs: sleeping };
  }, [contextPanelByDirectory, directoryKey, visibleBrowserTabId, wokenBrowserTabIds]);
  React.useEffect(() => {
    // Only a Chromium host mounts views that agents can drive, so only it may
    // offer to wake a tab; anywhere else a claimed action could never run.
    if (!window.__OPENCHAMBER_ELECTRON__) return;
    const unregister = sleepingBrowserTabs.map((tab) => registerSleepingBrowserTab({
      tabId: tab.id,
      directory: tab.directory,
      ownerSessionId: tab.ownerSessionId,
      describe: () => ({ title: '', url: tab.targetPath ?? '' }),
      wake: () => wakeBrowserTab(tab.id),
    }));
    return () => unregister.forEach((release) => release());
  }, [sleepingBrowserTabs, wakeBrowserTab]);

  const diffTabs = React.useMemo(() => tabs.filter((tab) => tab.mode === 'diff'), [tabs]);
  const terminalTab = React.useMemo(
    () => tabs.find((tab) => tab.mode === 'terminal') ?? null,
    [tabs],
  );
  // Keep-alive: the walkthrough holds reading progress and scroll position that
  // a remount would silently throw away.
  const hasWalkthroughTab = React.useMemo(() => tabs.some((tab) => tab.mode === 'walkthrough'), [tabs]);
  const pluginTabs = React.useMemo(() => tabs.filter((tab) => isPluginContextPanelMode(tab.mode)), [tabs]);
  const guests = useGuestsStore((state) => state.guests);
  const surfaceGuestIds = React.useMemo(
    () => new Set(guests.filter(guestHasSharedSurface).map((guest) => guest.id)),
    [guests],
  );
  // Surface extensions that also ship a page: it is docked to one edge of the picture.
  const surfaceDockings = React.useMemo(() => {
    const dockings = new Map<string, GuestSurfaceDocking>();
    for (const guest of guests) {
      const docking = guestSurfaceDocking(guest);
      if (docking) dockings.set(guest.id, docking);
    }
    return dockings;
  }, [guests]);

  // A terminal tab dragged out of the terminal's own strip moves the terminal.
  const terminalZoneOfPlacement = terminalZone.zone;
  const terminalDragOut = React.useCallback((isOutside: (point: { x: number; y: number }) => boolean) => {
    const gesture = startZoneDragGesture({ mode: 'terminal', label: t('layout.mainTab.terminal'), from: terminalZoneOfPlacement }, isOutside);
    return { finish: () => gesture.finish(directoryKey), cancel: gesture.cancel };
  }, [directoryKey, t, terminalZoneOfPlacement]);

  // The header slot goes to the pane on screen in its zone only.
  const headerSlotFor = (zone: ContextZone, active: boolean): HTMLElement | null => (active ? headerSlots[zone] : null);

  return (
    <>
      {hasFileTabs ? (
        <ZonePane
          zone={fileZone.zone}
          isOpen={fileZone.isOpen}
          directoryKey={directoryKey}
          className={cn('absolute inset-0 flex', fileTreeSide === 'left' && 'flex-row-reverse', isFileTabActive ? 'flex' : 'hidden')}
        >
          {hasOpenEditorFile || !contextEditorTreeVisible ? (
            // Hidden rather than unmounted so a hidden editor keeps its state.
            <div className={cn('h-full min-w-0 flex-1', hasOpenEditorFile && !showsEditor && 'hidden')}>
              {hasOpenEditorFile ? (
                <React.Suspense fallback={null}><FilesView mode="editor-only" visible={!contentHidden(fileZone.zone) && isFileTabActive && showsEditor} onCloseFile={handleCloseEditorFile} /></React.Suspense>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                  <Icon name="file-code" className="h-12 w-12 text-muted-foreground/50" />
                  <div className="typography-ui-header text-foreground">{t('contextPanel.editorEmpty.title')}</div>
                  <div className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.editorEmpty.description')}</div>
                </div>
              )}
            </div>
          ) : null}
          <EditorTreeColumn visible={contextEditorTreeVisible} active={fileZone.isOpen && isFileTabActive} fill={!showsEditor} side={fileTreeSide} />
        </ZonePane>
      ) : null}
      {chatActiveTab && activeChatSessionID && activeChatPinnedSession ? (
        // The chat renders in this app, pinned to its session: it shares
        // the app's connection, stores and theme, and opens like a session
        // switch instead of booting a second app.
        <ZonePane key={chatActiveTab.id} zone={chatZone.zone} isOpen={chatZone.isOpen} directoryKey={directoryKey} className="absolute inset-0 bg-background">
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
        return (
          <ZonePane
            // Keyed by the directory as well: a tab of the next directory with the
            // same id is another tab, with its own view and its own session. Kept
            // on the same instance, the view went on showing the previous
            // directory's page, and a space's page would run in the host's
            // session instead of the space's own.
            key={`${tab.directory}\u0000${tab.id}`}
            zone={browserZone.zone}
            isOpen={browserZone.isOpen}
            directoryKey={directoryKey}
            // Invisible rather than display:none, so a background tab the agent
            // is working keeps its layout and its snapshots read a real page.
            className={cn('absolute inset-0', !shown && 'invisible pointer-events-none')}
          >
            <div className="h-full" aria-hidden={!shown || undefined}>
              <BrowserPane
                initialUrl={tab.targetPath ?? ''}
                directory={tab.directory}
                tabID={tab.id}
                ownerSessionId={tab.ownerSessionId}
              />
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
            isOpen={diffZone.isOpen}
            directoryKey={directoryKey}
            className={cn('absolute inset-0', !active && 'hidden')}
          >
            <React.Suspense fallback={null}>
              <ContextPanelHeaderSlotProvider value={headerSlotFor(diffZone.zone, active)}>
                <DiffView
                  visible={diffZone.isOpen && active}
                  hideStackedFileSidebar
                  stackedDefaultCollapsedAll
                  pinSelectedFileHeaderToTopOnNavigate
                  showOpenInEditorAction
                  diffScope={tab.diffScope ?? (tab.stagedDiff ? 'staged' : 'working')}
                  onDiffScopeChange={handleDiffScopeChange}
                  targetFilePath={tab.targetPath}
                  flushContent
                />
              </ContextPanelHeaderSlotProvider>
            </React.Suspense>
          </ZonePane>
        );
      })}
      {terminalTab ? (
        <ZonePane
          zone={terminalZone.zone}
          isOpen={terminalZone.isOpen}
          directoryKey={directoryKey}
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
      {hasWalkthroughTab ? (
        <ZonePane
          zone={walkthroughZone.zone}
          isOpen={walkthroughZone.isOpen}
          directoryKey={directoryKey}
          className={cn('absolute inset-0', walkthroughZone.activeTab?.mode === 'walkthrough' ? 'block' : 'hidden')}
        >
          <React.Suspense fallback={null}>
            <ContextPanelHeaderSlotProvider value={headerSlotFor(walkthroughZone.zone, walkthroughZone.activeTab?.mode === 'walkthrough')}>
              <WalkthroughView directory={effectiveDirectory} visible={walkthroughZone.isOpen && walkthroughZone.activeTab?.mode === 'walkthrough'} />
            </ContextPanelHeaderSlotProvider>
          </React.Suspense>
        </ZonePane>
      ) : null}
      {pluginTabs.map((tab) => {
        if (!isPluginContextPanelMode(tab.mode)) return null;
        const pluginZone = zoneFor(tab.mode);
        // A shared-surface extension's picture is drawn by the host and
        // mounted only while shown, so an unwatched surface holds no socket
        // and its service can idle out. Its own page, when it has one, is
        // docked to one edge of the picture and stays mounted like any
        // panel iframe.
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
            isOpen={pluginZone.isOpen}
            directoryKey={directoryKey}
            className={cn('absolute inset-0', shown ? 'block' : 'hidden')}
          >
            <React.Suspense fallback={null}>
              {!sharedSurface ? (
                <PluginPane mode={tab.mode} />
              ) : !docking ? (
                <GuestSurfacePane mode={tab.mode} />
              ) : (
                <div className={cn('flex h-full', DOCK_LAYOUT[docking.dock].container)}>
                  <DockedGuestPage mode={tab.mode} docking={docking} />
                  <div className="min-h-0 min-w-0 flex-1">
                    {surfaceMounted ? <GuestSurfacePane mode={tab.mode} /> : null}
                  </div>
                </div>
              )}
            </React.Suspense>
          </ZonePane>
        );
      })}
    </>
  );
};

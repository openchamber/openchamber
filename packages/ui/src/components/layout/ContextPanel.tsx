import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { DiffViewIcon } from '@/components/icons/DiffIcon';
import { Button } from '@/components/ui/button';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { PullRequestView } from '@/components/views/PullRequestView';
import { TerminalView } from '@/components/views/TerminalView';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

// Heavy views stay on-demand (same as MainLayout): importing DiffView/FilesView
// or the walkthrough statically pulls the CodeMirror and @pierre/diffs stacks
// into the eager startup graph even when no such tab is open.
const WalkthroughView = lazyWithChunkRecovery(() => import('@/components/views/walkthrough/WalkthroughView').then((m) => ({ default: m.WalkthroughView })));
const DiffView = lazyWithChunkRecovery(() => import('@/components/views/DiffView').then((m) => ({ default: m.DiffView })));
const FilesView = lazyWithChunkRecovery(() => import('@/components/views/FilesView').then((m) => ({ default: m.FilesView })));
const GitView = lazyWithChunkRecovery(() => import('@/components/views/GitView').then((m) => ({ default: m.GitView })));
// The Linear rail icon stays hidden until a workspace is connected, so most
// users never render this panel; keep it out of the main bundle.
const PlanView = lazyWithChunkRecovery(() => import('@/components/views/PlanView').then((m) => ({ default: m.PlanView })));
import { areTitleMapsEqual, buildSessionTitleMap, EMPTY_SESSION_TITLE_MAP } from './contextPanelSessionTitles';
import { ProjectContextPanel } from './RightSidebarTabs';
import { SidebarFilesTree } from './SidebarFilesTree';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRepositoryReferenceProvider } from '@/components/references/referenceSources';
import { useGuestSurfaces } from '@/hooks/useGuestSurfaces';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useBrowserFaviconStore } from '@/stores/useBrowserFaviconStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { clampContextEditorTreeWidth, normalizeContextPanelDirectoryKey, useUIStore, type ContextPanelMode, type PendingDiffScope } from '@/stores/useUIStore';
import { markSessionViewed } from '@/sync/notification-store';
import { setExternallyViewedSession, useChildStoreManager } from '@/sync/sync-context';
import { ContextPanelContent } from './ContextSidebarTab';
import { BrowserPane } from '@/components/browser/BrowserPane';
import { browserUrlLabel } from '@/lib/browser/url';
import { registerBrowserOpener, registerSleepingBrowserTab, setShownBrowserTab } from '@/lib/browser/controlClient';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { Icon } from "@/components/icon/Icon";
import { GuestIcon } from './GuestRailIcon';
import { ChatView } from '@/components/views/ChatView';
const PluginPane = React.lazy(() => import('./PluginPane').then((module) => ({ default: module.PluginPane })));
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

const GuestSurfacePane = React.lazy(() => import('./GuestSurfacePane').then((module) => ({ default: module.GuestSurfacePane })));
import { useGuestsStore } from '@/lib/guests/store';
import { guestHasSharedSurface, guestSurfaceDocking, type GuestSurfaceDocking } from '@/lib/guests/surfaces';
import { FALLBACK_GUEST_ICON } from '@/lib/guests/icon';
import { GUEST_SURFACE_DOCK_SIZE_MIN } from '@openchamber/sdk';
import { isPluginContextPanelMode, pluginIdFromMode, type PluginContextPanelMode } from '@/lib/surfaces/modes';
import { getContextSurfaceDefaultWidth } from '@/lib/surfaces/registry';
import { beginLayoutAnimation, cancelWhenLayoutSettled, LAYOUT_ANIMATION_EASING, LAYOUT_ANIMATION_MS, runWhenLayoutSettled } from '@/lib/layoutAnimation';
import { WORK_STATUS_COLUMN_WIDTH } from '@/components/chat/work-status/useWorkStatusVisibility';
import { setWorkStatusHost, useRightSlotStore } from './rightSlot';
import { useOpenUntilSettled } from './useOpenUntilSettled';
import { isEditorEventTarget } from '@/lib/editorFocus';
import { isTerminalEventTarget } from '@/lib/terminalFocus';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { ContextPanelHeaderSlotProvider } from './contextPanelHeaderSlot';

const CONTEXT_PANEL_MIN_WIDTH = 320;
const CONTEXT_PANEL_DEFAULT_WIDTH = 600;
// The panel has no absolute pixel ceiling: on large monitors the user may
// want it nearly full-width (side-by-side diffs with the chat open). The
// only limit during a drag is leaving the chat column this much width.
const CONTEXT_CHAT_MIN_WIDTH = 400;
const RESIZE_FOLLOW_INTERVAL_MS = 100;
const CONTEXT_TAB_LABEL_MAX_CHARS = 24;
type TranslateFn = ReturnType<typeof useI18n>['t'];

/** A browser tab with the project it belongs to, which may not be the one on screen. */
type PanelBrowserTab = {
  directory: string;
  id: string;
  targetPath: string | null;
  ownerSessionId: string | null;
};



const normalizeDirectoryKey = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+$/g, '');
  normalized = normalized.replace(/\/+/g, '/');

  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  if (normalized === '') {
    return raw.startsWith('/') ? '/' : '';
  }

  return normalized;
};

const clampWidth = (width: number, maxWidth: number): number => {
  if (!Number.isFinite(width)) {
    return CONTEXT_PANEL_DEFAULT_WIDTH;
  }

  return Math.min(maxWidth, Math.max(CONTEXT_PANEL_MIN_WIDTH, Math.round(width)));
};

// Ceiling derived from the space the panel actually shares with the chat:
// everything except a minimum chat column, never below the panel minimum.
// Without a measured area there is no ceiling (see `areaWidth` below).
const maxPanelWidth = (availableWidth: number | null): number => {
  if (availableWidth === null) return Number.POSITIVE_INFINITY;
  return Math.max(CONTEXT_PANEL_MIN_WIDTH, availableWidth - CONTEXT_CHAT_MIN_WIDTH);
};

const getAvailablePanelWidth = (panel: HTMLElement | null): number | null => {
  const parentWidth = panel?.parentElement?.clientWidth;
  if (!parentWidth || parentWidth <= 0) {
    return null;
  }

  return parentWidth;
};

const getRelativePathLabel = (filePath: string | null, directory: string): string => {
  if (!filePath) {
    return '';
  }
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedDir = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedDir && normalizedFile.startsWith(normalizedDir + '/')) {
    return normalizedFile.slice(normalizedDir.length + 1);
  }
  return normalizedFile;
};

const getModeLabel = (
  mode: ContextPanelMode,
  t: TranslateFn
): string => {
  if (mode === 'chat') return t('contextPanel.mode.chat');
  if (mode === 'file') return t('contextPanel.mode.files');
  if (mode === 'diff') return t('contextPanel.mode.diff');
  if (mode === 'walkthrough') return t('contextPanel.mode.walkthrough');
  if (mode === 'plan') return t('contextPanel.mode.plan');
  if (mode === 'browser') return t('contextPanel.mode.browser');
  if (mode === 'git') return t('layout.rightSidebar.git');
  if (mode === 'pr') return t('contextPanel.mode.pr');
  if (mode === 'notes') return t('contextRail.surface.notes');
  if (mode === 'terminal') return t('layout.mainTab.terminal');
  if (isPluginContextPanelMode(mode)) {
    const guest = useGuestsStore.getState().guests.find((entry) => entry.id === pluginIdFromMode(mode));
    return guest?.name ?? t('contextRail.surface.plugin');
  }
  return t('contextPanel.mode.context');
};

const getFileNameFromPath = (path: string | null): string | null => {
  if (!path) {
    return null;
  }

  const normalized = path.replace(/\\/g, '/').trim();
  if (!normalized) {
    return null;
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return normalized;
  }

  return segments[segments.length - 1] || null;
};

const getTabLabel = (
  tab: { mode: ContextPanelMode; label: string | null; targetPath: string | null; dedupeKey?: string; sessionTitleFallback?: string | null; stagedDiff?: boolean },
  sessionTitleById: ReadonlyMap<string, string>,
  t: TranslateFn
): string => {
  if (tab.mode === 'chat') {
    const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
    if (sessionID) {
      const sessionTitle = sessionTitleById.get(sessionID)?.trim();
      if (sessionTitle) {
        return sessionTitle;
      }
    }

    const sessionTitleFallback = tab.sessionTitleFallback?.trim();
    if (sessionTitleFallback) {
      return sessionTitleFallback;
    }

    return t('contextPanel.mode.chat');
  }

  // Ahead of the stored label on purpose: a browser tab is named after the page
  // it is showing, and the stored label is only ever the address it opened at.
  // Keeping that would leave the tab claiming one host while the address bar
  // shows another.
  if (tab.mode === 'browser') {
    return browserUrlLabel(tab.targetPath ?? '') || tab.label || t('contextPanel.mode.browser');
  }

  if (tab.label) {
    return tab.label;
  }

  if (tab.mode === 'file') {
    return getFileNameFromPath(tab.targetPath) || t('contextPanel.mode.files');
  }

  if (tab.mode === 'diff') {
    return t('contextPanel.mode.diff');
  }

  return getModeLabel(tab.mode, t);
};

const ContextGuestIcon: React.FC<{ mode: ContextPanelMode }> = ({ mode }) => {
  const surfaces = useGuestSurfaces();
  const surface = surfaces.find((entry) => entry.mode === mode);
  return <GuestIcon icon={surface?.icon ?? FALLBACK_GUEST_ICON} iconSrc={surface?.iconSrc} className="h-3.5 w-3.5" />;
};

const getTabIcon = (
  tab: { mode: ContextPanelMode; targetPath: string | null },
  faviconByOrigin: Record<string, string> = {},
): React.ReactNode | undefined => {
  if (tab.mode === 'file') {
    return tab.targetPath
      ? <FileTypeIcon filePath={tab.targetPath} className="h-3.5 w-3.5" />
      : undefined;
  }

  if (tab.mode === 'diff') {
    return <DiffViewIcon className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'walkthrough') {
    return <Icon name="route" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'git') {
    return <Icon name="git-branch" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'pr') {
    return <Icon name="github" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'notes') {
    return <Icon name="sticky-note" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'terminal') {
    return <Icon name="terminal-box" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'plan') {
    return <Icon name="file-text" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'context') {
    return <Icon name="donut-chart-fill" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'chat') {
    return <Icon name="chat-4" className="h-3.5 w-3.5" />;
  }

  if (isPluginContextPanelMode(tab.mode)) {
    return <ContextGuestIcon mode={tab.mode} />;
  }

  if (tab.mode === 'browser') {
    const icon = browserFaviconFor(tab.targetPath ?? '', faviconByOrigin);
    // The page's own icon when it has reported one; the placeholder otherwise,
    // including in runtimes where a page never can.
    return icon
      ? <img src={icon} alt="" aria-hidden="true" className="h-3.5 w-3.5 rounded-[3px] object-contain" />
      : <Icon name="global" className="h-3.5 w-3.5" />;
  }

  return undefined;
};

const browserFaviconFor = (url: string, faviconByOrigin: Record<string, string>): string => {
  try {
    return faviconByOrigin[new URL(url).origin] ?? '';
  } catch {
    return '';
  }
};

// The editor surface's file-tree column: docked on the right, resizable from
// its left edge, and animated open/closed like the app sidebars. In tree-only
// mode (`fill`), the panel collapses around this fixed-width, right-aligned column.
const EditorTreeColumn: React.FC<{ visible: boolean; active: boolean; fill?: boolean }> = ({ visible, active, fill = false }) => {
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
    const delta = startXRef.current - event.clientX;
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
        fill && 'ml-auto',
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
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 z-20 w-px bg-border" />
      )}
      {visible && !fill && (
        <div
          className={cn(
            'absolute left-0 top-0 z-20 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
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

const getSessionIDFromDedupeKey = (dedupeKey: string | undefined): string | null => {
  if (!dedupeKey || !dedupeKey.startsWith('session:')) {
    return null;
  }

  const sessionID = dedupeKey.slice('session:'.length).trim();
  return sessionID || null;
};

// Titles come from every live directory because a chat tab may show a
// session from another project; an inactive tab whose directory is not
// loaded keeps its sessionTitleFallback.
const useSessionTitleMap = (sessionIDs: readonly string[]): ReadonlyMap<string, string> => {
  const childStores = useChildStoreManager();
  const snapshotRef = React.useRef<ReadonlyMap<string, string>>(EMPTY_SESSION_TITLE_MAP);
  const sessionIDsRef = React.useRef<readonly string[]>(sessionIDs);

  sessionIDsRef.current = sessionIDs;

  return React.useSyncExternalStore(
    React.useCallback(
      (notify: () => void) => childStores.subscribeAllSelected((state) => state.session, notify),
      [childStores],
    ),
    React.useCallback(() => {
      const liveStates = Array.from(childStores.children.values(), (store) => store.getState());
      const next = buildSessionTitleMap(liveStates, sessionIDsRef.current);
      if (areTitleMapsEqual(snapshotRef.current, next)) {
        return snapshotRef.current;
      }
      snapshotRef.current = next;
      return next;
    }, [childStores]),
    () => EMPTY_SESSION_TITLE_MAP,
  );
};


const truncateTabLabel = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3)}...`;
};


export const ContextPanel: React.FC = () => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const repositoryProvider = useRepositoryReferenceProvider(effectiveDirectory || null);
  // Tab names in this repository's words: a GitLab project's change request tab is a merge request.
  const tabT = React.useCallback<TranslateFn>(
    (key, params) => t(changeRequestCopy(key, repositoryProvider), params),
    [repositoryProvider, t],
  );
  const directoryKey = React.useMemo(() => normalizeDirectoryKey(effectiveDirectory), [effectiveDirectory]);

  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const closeContextPanelTab = useUIStore((state) => state.closeContextPanelTab);
  const closeContextFile = useUIStore((state) => state.closeContextFile);
  const pinContextPanelTab = useUIStore((state) => state.pinContextPanelTab);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const toggleContextPanelExpanded = useUIStore((state) => state.toggleContextPanelExpanded);
  const setContextPanelWidth = useUIStore((state) => state.setContextPanelWidth);
  const setActiveContextPanelTab = useUIStore((state) => state.setActiveContextPanelTab);
  const openAgentBrowserTab = useUIStore((state) => state.openAgentBrowserTab);

  // A browser tab loads its page only once it is needed: shown in the open
  // panel, opened by the agent, or woken by an agent action. Tabs restored
  // from a previous run otherwise stay asleep, since every loaded tab costs a
  // Chromium process. Once loaded, a tab stays loaded until it is closed.
  const [wokenBrowserTabIds, setWokenBrowserTabIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [headerSlotEl, setHeaderSlotEl] = React.useState<HTMLDivElement | null>(null);
  const wakeBrowserTab = React.useCallback((tabId: string) => {
    setWokenBrowserTabIds((current) => (current.has(tabId) ? current : new Set(current).add(tabId)));
  }, []);

  // Lets an agent's browser.open create its own tab; the id goes back to the
  // agent so it keeps working there. Registered from the panel because opening a tab is panel state, not
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
  const openContextFile = useUIStore((state) => state.openContextFile);
  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type !== 'file-open-request') return;
    const directory = event.directory ?? effectiveDirectory;
    if (!directory) return;
    openContextFile(directory, event.path);
  }), [effectiveDirectory, openContextFile]);
  const reorderContextPanelTabs = useUIStore((state) => state.reorderContextPanelTabs);
  const setSelectedFilePath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const contextEditorTreeVisible = useUIStore((state) => state.contextEditorTreeVisible);
  const contextEditorTreeWidth = useUIStore((state) => state.contextEditorTreeWidth);
  const setContextEditorTreeWidth = useUIStore((state) => state.setContextEditorTreeWidth);
  const toggleContextEditorTree = useUIStore((state) => state.toggleContextEditorTree);
  const contextEditorVisible = useUIStore((state) => state.contextEditorVisible);
  const toggleContextEditor = useUIStore((state) => state.toggleContextEditor);
  const openNewContextBrowserTab = useUIStore((state) => state.openNewContextBrowserTab);
  const faviconByOrigin = useBrowserFaviconStore((state) => state.byOrigin);

  const tabs = React.useMemo(() => panelState?.tabs ?? [], [panelState?.tabs]);
  const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? tabs[tabs.length - 1] ?? null;
  // Tells agent browser control which project is on screen and which browser
  // tab the user last had in front of them there; a session without a tab of
  // its own may use that tab only when it is the user's and in its project.
  const shownBrowserTabId = activeTab?.mode === 'browser' ? activeTab.id : null;
  React.useEffect(() => {
    setShownBrowserTab(directoryKey, shownBrowserTabId);
  }, [directoryKey, shownBrowserTabId]);
  // The issues and PRs board stays beside it and narrows instead.
  const isOpen = Boolean(panelState?.isOpen && activeTab);
  const workStatusReserved = useRightSlotStore((state) => state.workStatusReserved);
  const chatCovered = useRightSlotStore((state) => state.chatCovered);
  const hasOpenEditorFile = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file' && tab.targetPath),
    [tabs],
  );
  // The editor column is shown for an open file unless the user hid it; the
  // tree never hides alongside it, so a hidden tree forces the editor back.
  const showsEditor = hasOpenEditorFile && (contextEditorVisible || !contextEditorTreeVisible);
  const activeModeForWidth = activeTab?.mode ?? null;
  const isTreeOnly = activeModeForWidth === 'file' && !showsEditor;
  const isExpanded = Boolean(isOpen && panelState?.expanded && !isTreeOnly);
  // A fixed width in px: the one the user resized this surface to, else the
  // surface's default. It does not follow the chat area, so a sidebar toggle
  // or a window resize leaves it alone unless the chat would get too narrow.
  const manualWidth = activeModeForWidth ? panelState?.widthByMode?.[activeModeForWidth] : undefined;
  const desiredWidth = isTreeOnly
    ? contextEditorTreeWidth
    : clampWidth(manualWidth ?? (activeModeForWidth ? getContextSurfaceDefaultWidth(activeModeForWidth) : CONTEXT_PANEL_DEFAULT_WIDTH), Number.POSITIVE_INFINITY);

  // The chat area's width, as state only while it decides something: the
  // panel is expanded over it, or the ceiling binds (the panel would leave
  // the chat less than its minimum). Otherwise it is null, so the many width
  // changes that cannot matter (every frame of a sidebar animation, most
  // window resizes) do not re-render the panel and everything in it. Changes
  // that arrive during a side-column animation are applied once it ends.
  const [areaWidth, setAreaWidth] = React.useState<number | null>(null);
  const measuredAreaWidthRef = React.useRef<number | null>(null);
  const areaDecidesRef = React.useRef<(areaWidth: number) => boolean>(() => false);
  areaDecidesRef.current = (measured) => isExpanded || (!isTreeOnly && measured - CONTEXT_CHAT_MIN_WIDTH < desiredWidth);
  const applyAreaWidth = React.useCallback(() => {
    const measured = measuredAreaWidthRef.current;
    setAreaWidth(measured !== null && areaDecidesRef.current(measured) ? measured : null);
  }, []);
  const width = isTreeOnly ? desiredWidth : clampWidth(desiredWidth, maxPanelWidth(areaWidth));
  const chatSessionIDs = React.useMemo(() => {
    const ids: string[] = [];
    for (const tab of tabs) {
      if (tab.mode !== 'chat') continue;
      const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
      if (sessionID && !ids.includes(sessionID)) ids.push(sessionID);
    }
    return ids;
  }, [tabs]);
  const sessionTitleById = useSessionTitleMap(chatSessionIDs);

  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const resizingWidthRef = React.useRef<number | null>(null);
  const activeResizePointerIDRef = React.useRef<number | null>(null);
  const panelRef = React.useRef<HTMLElement | null>(null);
  const wasOpenRef = React.useRef(false);

  React.useLayoutEffect(() => {
    const parent = panelRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const measured = entries[entries.length - 1]?.contentRect.width;
      measuredAreaWidthRef.current = measured ? Math.round(measured) : null;
      runWhenLayoutSettled(applyAreaWidth);
    });
    observer.observe(parent);
    measuredAreaWidthRef.current = parent.clientWidth || null;
    applyAreaWidth();

    return () => {
      observer.disconnect();
      cancelWhenLayoutSettled(applyAreaWidth);
    };
  }, [applyAreaWidth]);

  // Expanding, or a surface wanting another width, may make the area matter.
  React.useLayoutEffect(() => {
    applyAreaWidth();
  }, [applyAreaWidth, desiredWidth, isExpanded]);

  React.useEffect(() => {
    if (!isOpen || wasOpenRef.current) {
      wasOpenRef.current = isOpen;
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus({ preventScroll: true });
    });

    wasOpenRef.current = true;
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  // Deferred resize: reflowing the chat column and the active surface (xterm,
  // editor, embedded chat iframes) on every drag frame is unavoidably janky,
  // so during the drag only a ghost guide line follows the pointer and the
  // real width is applied once on release (riding the width transition).
  const resizeAvailableWidthRef = React.useRef<number | null>(null);
  // The panel content follows the guide line lazily: the real width is
  // re-applied at most every RESIZE_FOLLOW_INTERVAL_MS and the standing
  // 200ms width transition smooths each step, VS Code-style.
  const resizeFollowTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyFollowWidth = React.useCallback(() => {
    resizeFollowTimerRef.current = null;
    const panel = panelRef.current;
    const next = resizingWidthRef.current;
    if (!panel || next === null) {
      return;
    }
    panel.style.setProperty('--oc-context-panel-width', `${next}px`);
  }, []);

  React.useEffect(() => () => {
    if (resizeFollowTimerRef.current !== null) {
      clearTimeout(resizeFollowTimerRef.current);
    }
  }, []);

  const clampWidthForDrag = React.useCallback((nextWidth: number) => {
    const available = resizeAvailableWidthRef.current;
    const clamped = isTreeOnly ? clampContextEditorTreeWidth(nextWidth) : clampWidth(nextWidth, maxPanelWidth(available));
    return available === null ? clamped : Math.min(clamped, Math.max(1, available));
  }, [isTreeOnly]);

  const handleResizeStart = React.useCallback((event: React.PointerEvent) => {
    if (!isOpen || isExpanded || !directoryKey) {
      return;
    }

    activeResizePointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    resizingWidthRef.current = width;
    // Measure once per drag; no layout reads happen during pointermove.
    resizeAvailableWidthRef.current = getAvailablePanelWidth(panelRef.current);
    document.documentElement.style.cursor = 'col-resize';
    event.preventDefault();
  }, [directoryKey, isExpanded, isOpen, width]);

  const finishResize = React.useCallback(() => {
    // Apply the final width once, letting the regular 200ms width transition
    // carry the panel to the release position.
    const finalWidth = clampWidthForDrag(resizingWidthRef.current ?? width);
    resizingWidthRef.current = null;
    resizeAvailableWidthRef.current = null;
    if (resizeFollowTimerRef.current !== null) {
      clearTimeout(resizeFollowTimerRef.current);
      resizeFollowTimerRef.current = null;
    }
    document.documentElement.style.cursor = '';
    if (isTreeOnly) {
      setContextEditorTreeWidth(finalWidth);
    } else if (directoryKey && activeModeForWidth) {
      setContextPanelWidth(directoryKey, activeModeForWidth, finalWidth);
    }
    setIsResizing(false);
    activeResizePointerIDRef.current = null;
  }, [activeModeForWidth, clampWidthForDrag, directoryKey, isTreeOnly, setContextEditorTreeWidth, setContextPanelWidth, width]);

  // Window-level drag listeners: tracking the pointer via the 3px handle and
  // pointer capture is unreliable (capture can fail over iframes and a missed
  // pointerup leaves the drag stuck), so while resizing the whole window
  // tracks the pointer and any release/cancel/blur ends the drag.
  React.useEffect(() => {
    if (!isResizing) {
      return;
    }

    const handleMove = (event: PointerEvent) => {
      if (activeResizePointerIDRef.current !== event.pointerId) {
        return;
      }
      const delta = startXRef.current - event.clientX;
      const nextWidth = clampWidthForDrag(startWidthRef.current + delta);
      if (resizingWidthRef.current === nextWidth) {
        return;
      }
      resizingWidthRef.current = nextWidth;
      if (resizeFollowTimerRef.current === null) {
        resizeFollowTimerRef.current = setTimeout(applyFollowWidth, RESIZE_FOLLOW_INTERVAL_MS);
      }
    };

    const handleUp = (event: PointerEvent) => {
      if (activeResizePointerIDRef.current !== event.pointerId) {
        return;
      }
      finishResize();
    };

    const handleWindowBlur = () => {
      finishResize();
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [applyFollowWidth, clampWidthForDrag, finishResize, isResizing]);

  React.useEffect(() => {
    if (!isResizing) {
      resizingWidthRef.current = null;
      document.documentElement.style.cursor = '';
    }
  }, [isResizing]);

  // The editor's Cmd/Ctrl+W and its unsaved-changes prompt close the file's
  // tab here, so the strip and the next file follow as with the close button.
  const handleCloseEditorFile = React.useCallback((filePath: string) => {
    if (directoryKey) closeContextFile(directoryKey, filePath);
  }, [closeContextFile, directoryKey]);

  const handleClose = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    closeContextPanel(directoryKey);
  }, [closeContextPanel, directoryKey]);

  const handleToggleExpanded = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    toggleContextPanelExpanded(directoryKey);
  }, [directoryKey, toggleContextPanelExpanded]);

  const handlePanelKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    // Closed, the slot holds only the work-status card, whose Escape is not
    // the panel's to take.
    if (event.key !== 'Escape' || !isOpen) {
      return;
    }

    // Portalled menus and dialogs own Escape even though their React events
    // still pass through this panel's capture handler.
    if (event.target instanceof Node && !event.currentTarget.contains(event.target)) {
      return;
    }

    // Terminal owns Escape so the PTY receives it (e.g. Vim Normal mode).
    // The terminal input listens in the bubble phase; stopping capture here
    // would swallow the key before the terminal ever sees it (issue #2644).
    if (isTerminalEventTarget(event.target)) {
      return;
    }
    // Same for the file editor and what it opens over itself (search, the
    // symbol list, go to line): Escape closes those, leaves Vim's INSERT mode
    // or collapses several cursors, and must not close the whole panel.
    if (isEditorEventTarget(event.target)) {
      return;
    }
    // Something under the panel already handled this Escape.
    if (event.defaultPrevented) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    handleClose();
  }, [handleClose, isOpen]);

  React.useEffect(() => {
    if (!directoryKey || !activeTab) {
      return;
    }

    if (activeTab.mode === 'file' && activeTab.targetPath) {
      setSelectedFilePath(directoryKey, activeTab.targetPath, { allowOutsideRoot: true });
      return;
    }

  }, [activeTab, directoryKey, setSelectedFilePath]);

  const chatTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'chat'),
    [tabs],
  );
  const activeChatTabID = isOpen && activeTab?.mode === 'chat' ? activeTab.id : null;
  const activeChatSessionID = isOpen && activeTab?.mode === 'chat' ? getSessionIDFromDedupeKey(activeTab.dedupeKey) : null;
  const activeChatTab = activeChatTabID ? chatTabs.find((tab) => tab.id === activeChatTabID) ?? null : null;
  // A chat opened from another project (or Chat) carries its own directory;
  // tabs opened without one (subtasks, reviews) belong to this panel's.
  const activeChatDirectory = React.useMemo(() => {
    const own = activeChatTab?.targetDirectory ? normalizeDirectoryKey(activeChatTab.targetDirectory) : '';
    return own || directoryKey || null;
  }, [activeChatTab?.targetDirectory, directoryKey]);
  const activeChatPinnedSession = React.useMemo(
    () => (activeChatSessionID ? { sessionId: activeChatSessionID, directory: activeChatDirectory } : null),
    [activeChatSessionID, activeChatDirectory],
  );

  React.useEffect(() => {
    if (!isOpen || !activeChatDirectory || !activeChatSessionID || typeof window === 'undefined') {
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
  }, [activeChatDirectory, activeChatSessionID, isOpen]);


  const handleDiffScopeChange = React.useCallback((nextScope: PendingDiffScope) => {
    if (!directoryKey || activeTab?.mode !== 'diff') {
      return;
    }

    openContextPanelTab(directoryKey, {
      mode: 'diff',
      targetPath: activeTab.targetPath,
      stagedDiff: nextScope === 'staged',
      diffScope: nextScope,
    });
  }, [activeTab, directoryKey, openContextPanelTab]);


  // The rail switches between surfaces (modes); the in-panel strip only lists
  // instances of the active multi-instance surface (open files, split chats,
  // browser targets).
  const isMultiInstanceMode = activeTab?.mode === 'file' || activeTab?.mode === 'chat' || activeTab?.mode === 'browser';
  const activeModeTabs = React.useMemo(
    () => (activeTab ? tabs.filter((tab) => tab.mode === activeTab.mode) : []),
    [activeTab, tabs],
  );

  const tabItems = React.useMemo(() => activeModeTabs.map((tab) => {
    const rawLabel = getTabLabel(tab, sessionTitleById, tabT);
    const label = truncateTabLabel(rawLabel, CONTEXT_TAB_LABEL_MAX_CHARS);
    const tabPathLabel = getRelativePathLabel(tab.targetPath, effectiveDirectory);
    return {
      id: tab.id,
      label,
      icon: getTabIcon(tab, faviconByOrigin),
      title: tabPathLabel ? `${rawLabel}: ${tabPathLabel}` : rawLabel,
      closeLabel: t('contextPanel.tab.closeTabAria', { label }),
      preview: tab.preview,
    };
  }), [activeModeTabs, effectiveDirectory, faviconByOrigin, sessionTitleById, t, tabT]);

  const activeNonChatContent = activeTab?.mode === 'context'
        ? <ContextPanelHeaderSlotProvider value={headerSlotEl}><ContextPanelContent /></ContextPanelHeaderSlotProvider>
        : activeTab?.mode === 'git'
            ? <React.Suspense fallback={null}><ContextPanelHeaderSlotProvider value={headerSlotEl}><GitView isActive={isOpen} /></ContextPanelHeaderSlotProvider></React.Suspense>
            : activeTab?.mode === 'pr'
                ? <PullRequestView />
            : activeTab?.mode === 'notes'
                ? <ContextPanelHeaderSlotProvider value={headerSlotEl}><ProjectContextPanel visible={isOpen} /></ContextPanelHeaderSlotProvider>
        : activeTab?.mode === 'plan'
            ? <React.Suspense fallback={null}><ContextPanelHeaderSlotProvider value={headerSlotEl}><PlanView
                targetPath={activeTab.targetPath}
                savedProjectPlan={activeTab.projectPlanId && activeTab.projectPlanRef
                  ? { projectRef: activeTab.projectPlanRef, planId: activeTab.projectPlanId }
                  : null}
              /></ContextPanelHeaderSlotProvider></React.Suspense>
            : null;

  const visibleBrowserTabId = isOpen && activeTab?.mode === 'browser' ? activeTab.id : null;
  React.useEffect(() => {
    if (visibleBrowserTabId) wakeBrowserTab(visibleBrowserTabId);
  }, [visibleBrowserTabId, wakeBrowserTab]);
  // The browser tabs agents can reach: this project's, and every other
  // project's agent tabs, so a session working in a project the user is not
  // looking at keeps its page. The user's own tabs in other projects are left
  // out and unload with their project, as before. Sorted by directory and tab
  // id, an order that neither the project on screen nor the store's own
  // reordering of directories can change: a moved webview reloads its page.
  const contextPanelByDirectory = useUIStore((state) => state.contextPanelByDirectory);
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
  const diffTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'diff'),
    [tabs],
  );
  const terminalTab = React.useMemo(
    () => tabs.find((tab) => tab.mode === 'terminal') ?? null,
    [tabs],
  );
  // Keep-alive: the walkthrough holds reading progress and scroll position that
  // a remount would silently throw away.
  const hasWalkthroughTab = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'walkthrough'),
    [tabs],
  );
  const pluginTabs = React.useMemo(
    () => tabs.filter((tab) => isPluginContextPanelMode(tab.mode)),
    [tabs],
  );
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
  const hasFileTabs = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file'),
    [tabs],
  );

  const isFileTabActive = activeTab?.mode === 'file';

  const closeContextPanelTabs = useUIStore((state) => state.closeContextPanelTabs);
  const renderTabContextMenu = React.useCallback(
    (args: { id: string; index: number; allIds: string[]; close: () => void }): React.ReactNode => {
      if (!directoryKey) {
        return null;
      }
      const { id, index, allIds, close } = args;
      const closeOthers = () => closeContextPanelTabs(directoryKey, allIds.filter((tabId) => tabId !== id));
      const closeToLeft = () => closeContextPanelTabs(directoryKey, allIds.slice(0, index));
      const closeToRight = () => closeContextPanelTabs(directoryKey, allIds.slice(index + 1));
      const closeAll = () => closeContextPanelTabs(directoryKey, allIds);
      const hasOthers = allIds.length > 1;
      const isFirst = index === 0;
      const isLast = index === allIds.length - 1;
      return (
        <>
          <ContextMenuItem onClick={close}>
            <Icon name="close" className="mr-2 size-4" />
            {t('contextPanel.tab.menu.close')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={closeOthers} disabled={!hasOthers}>
            <Icon name="expand-horizontal" className="mr-2 size-4" />
            {t('contextPanel.tab.menu.closeOthers')}
          </ContextMenuItem>
          <ContextMenuItem onClick={closeToLeft} disabled={isFirst}>
            <Icon name="expand-left" className="mr-2 size-4" />
            {t('contextPanel.tab.menu.closeToLeft')}
          </ContextMenuItem>
          <ContextMenuItem onClick={closeToRight} disabled={isLast}>
            <Icon name="expand-right" className="mr-2 size-4" />
            {t('contextPanel.tab.menu.closeToRight')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={closeAll} disabled={!hasOthers}>
            <Icon name="close-circle" className="mr-2 size-4" />
            {t('contextPanel.tab.menu.closeAll')}
          </ContextMenuItem>
        </>
      );
    },
    [closeContextPanelTabs, directoryKey, t],
  );

  const header = (
    <header className="group/panel-header flex min-h-10 items-stretch border-b border-border">
      {isMultiInstanceMode ? (
        <SortableTabsStrip
          items={tabItems}
          activeId={activeTab?.id ?? null}
          onSelect={(tabID) => {
            if (!directoryKey) {
              return;
            }
            setActiveContextPanelTab(directoryKey, tabID);
          }}
          onClose={(tabID) => {
            if (!directoryKey) {
              return;
            }
            closeContextPanelTab(directoryKey, tabID);
          }}
          onReorder={(activeTabID, overTabID) => {
            if (!directoryKey) {
              return;
            }
            reorderContextPanelTabs(directoryKey, activeTabID, overTabID);
          }}
          onDoubleClickTab={(tabID) => {
            if (directoryKey) pinContextPanelTab(directoryKey, tabID);
          }}
          layoutMode="scrollable"
          variant="default"
          tabContextMenu={renderTabContextMenu}
        />
      ) : (
        <>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-3 group-has-[[data-context-panel-toolbar]]/panel-header:hidden">
          {/* A GitLab project's change requests are merge requests. */}
          {activeTab?.mode === 'pr' && repositoryProvider === 'gitlab'
            ? <Icon name="gitlab" className="h-3.5 w-3.5" />
            : activeTab ? getTabIcon(activeTab, faviconByOrigin) : null}
          <span className="truncate typography-ui-label text-foreground">
            {activeTab?.mode === 'pr' && repositoryProvider === 'gitlab'
              ? t('contextPanel.mode.mr')
              : activeTab ? getModeLabel(activeTab.mode, tabT) : null}
          </span>
        </div>
        {/* The active surface's own toolbar lands here (contextPanelHeaderSlot). */}
        <div ref={setHeaderSlotEl} className="flex min-w-0 flex-1 items-stretch pl-1.5 empty:hidden" />
        </>
      )}
      <div className="flex h-10 shrink-0 items-center gap-1 self-start px-1.5">
        {activeTab?.mode === 'browser' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (!directoryKey) return;
              openNewContextBrowserTab(directoryKey);
            }}
            className="h-7 w-7 p-0"
            title={t('contextPanel.browser.newTab')}
            aria-label={t('contextPanel.browser.newTab')}
          >
            <Icon name="add" className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        {isFileTabActive && hasOpenEditorFile ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={toggleContextEditor}
            className="h-7 w-7 p-0"
            title={t('contextRail.editor.toggle')}
            aria-label={t('contextRail.editor.toggle')}
            aria-pressed={showsEditor}
          >
            <Icon name="layout-left" className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        {isFileTabActive ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={toggleContextEditorTree}
            className="h-7 w-7 p-0"
            title={t('contextRail.editorTree.toggle')}
            aria-label={t('contextRail.editorTree.toggle')}
            aria-pressed={contextEditorTreeVisible}
          >
            <Icon name="layout-right" className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        {!isTreeOnly ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleToggleExpanded}
            className="h-7 w-7 p-0"
            title={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')}
            aria-label={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')}
          >
            {isExpanded ? <Icon name="fullscreen-exit" className="h-3.5 w-3.5" /> : <Icon name="fullscreen" className="h-3.5 w-3.5" />}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleClose}
          className="h-7 w-7 p-0"
          title={t('contextPanel.actions.closePanel')}
          aria-label={t('contextPanel.actions.closePanel')}
        >
          <Icon name="close" className="h-3.5 w-3.5" />
        </Button>
      </div>
    </header>
  );

  // The right slot: this aside holds the context panel and the inline
  // work-status card (rendered into the host below by ChatContainer), and
  // animates one width for both (rightSlot.ts). Closed, it keeps the card's
  // column when the card wants it and the chat is on screen; open, it is the
  // panel's width. Every value stays interpolable across open/close (no
  // instant min/max jumps).
  const workStatusColumn = workStatusReserved && !chatCovered;
  const expandedWidth = areaWidth !== null ? `${areaWidth}px` : '100%';
  const slotWidth = !isOpen
    ? (workStatusColumn ? `${WORK_STATUS_COLUMN_WIDTH}px` : '0px')
    : isExpanded
      // px, not '100%': px↔% width changes do not interpolate, which
      // would make the expand/collapse width snap instead of animating.
      ? expandedWidth
      : 'min(var(--oc-context-panel-width), 100%)';

  // What the user changed, as opposed to the slot following the window: a
  // toggle, expanding, the card's column, another surface's or a dragged
  // width. Only these animate as an announced layout animation; the chat area
  // resizing (a window drag, a clamp) is tracked without one, so the work
  // that waits for an animation's end is not held back for the whole drag.
  const animationKey = `${isOpen}|${isExpanded}|${workStatusColumn}|${isOpen ? desiredWidth : ''}`;
  const animationKeyRef = React.useRef(animationKey);
  // A surface page covering or uncovering the chat moves the slot while the
  // chat is not on screen: that change snaps.
  const coveredRef = React.useRef(chatCovered);
  const coverChanged = coveredRef.current !== chatCovered;
  React.useLayoutEffect(() => {
    coveredRef.current = chatCovered;
  }, [chatCovered]);
  React.useLayoutEffect(() => {
    if (animationKeyRef.current === animationKey) return;
    animationKeyRef.current = animationKey;
    if (!coverChanged) beginLayoutAnimation(LAYOUT_ANIMATION_MS);
  }, [animationKey, coverChanged]);

  // A closing panel's content fades out and only then leaves the
  // accessibility tree, in the same commit that takes the file editor's DOM
  // out (CodeMirrorEditor `detached`). Hiding the editor from accessibility
  // while it is still in the document costs Chrome a 200 to 300 ms frame
  // whenever an accessibility client is on (a screen reader, or any app
  // that reads other windows, common on macOS); removing it costs a few ms.
  // After the layout effect above, which begins the animation.
  const contentHidden = !useOpenUntilSettled(isOpen);

  const panelStyle: React.CSSProperties = {
    ['--oc-context-panel-width' as string]: isOpen && isExpanded ? expandedWidth : `${width}px`,
    width: slotWidth,
    maxWidth: '100%',
    transitionDuration: coverChanged ? '0ms' : `${LAYOUT_ANIMATION_MS}ms`,
    transitionTimingFunction: LAYOUT_ANIMATION_EASING,
  };

  return (
    <aside
      ref={panelRef}
      data-context-panel="true"
      data-right-slot=""
      data-context-panel-open={isOpen ? 'true' : 'false'}
      tabIndex={-1}
      className={cn(
        // `overflow-clip` on both axes, never `hidden`: a `hidden` axis makes
        // the slot a scroll container, and an `overflow-x: clip` beside an
        // `overflow-y: hidden` computes to `hidden` too. The closed panel's
        // content is wider than the card's column, so a `scrollIntoView`
        // inside it (the tab strip revealing its active tab on mount)
        // scrolled the slot sideways and dragged the card left, clipped.
        // The gutter sets the panel apart from the chat as a card of its own
        // and leaves the card's shadow room on every side the aside clips;
        // the resize handle sits in the left one.
        'box-border flex min-h-0 flex-col overflow-clip bg-background pb-2 pl-2 pr-1.5',
        // Right-anchored while expanded: `inset-0` would teleport the left
        // edge instantly (position does not transition), so only the width
        // animates and the panel grows leftwards from its docked position.
        isExpanded
          ? 'absolute inset-y-0 right-0 z-20 min-w-0'
          : 'relative h-full flex-shrink-0',
        'transition-[width] motion-reduce:transition-none',
      )}
      onKeyDownCapture={handlePanelKeyDownCapture}
      style={panelStyle}
    >
      {/* The inline work-status card's host, right-anchored under the panel:
          the card fades out while the panel fades in over it, and back. */}
      <div ref={setWorkStatusHost} className={cn('absolute inset-y-0 right-0 z-0 flex', chatCovered && 'invisible')} />
      {isOpen && !isExpanded && (
        // Straddles the card's left edge (the aside's pl-2 gutter) and spans
        // only the card's height. Nothing paints on hover or drag: the cursor
        // says it is draggable, and the card edge itself moves on release.
        <div
          className="absolute bottom-2 left-1 top-0 z-50 w-2 cursor-col-resize"
          onPointerDown={handleResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('contextPanel.actions.resizePanelAria')}
        />
      )}
      <div
        className={cn(
          'relative z-10 flex h-full min-h-0 shrink-0 flex-col motion-reduce:transition-none',
          // A framed card, inset from the chat: its own border and radius rather
          // than a divider running the height of the window.
          // The dropdown's hairline ring (`oc-panel-edge`), shared with the
          // work-status card.
          'oc-panel-edge overflow-hidden rounded-[10px] bg-background',
          // Width animates in sync with the panel (surface switches, resize
          // release); during the drag itself nothing resizes — only the ghost
          // guide line moves.
          'transition-[width,opacity]',
          !isOpen && 'pointer-events-none select-none opacity-0'
        )}
        // px in the expanded state too: px↔% width changes cannot interpolate,
        // so the header controls would snap instead of riding the animation.
        style={{
          // Less the gutters (pl-2, pr-1.5) the aside reserves for the card.
          width: isExpanded
            ? (areaWidth !== null ? `calc(${areaWidth}px - 0.875rem)` : '100%')
            : 'calc(var(--oc-context-panel-width) - 0.875rem)',
          transitionDuration: `${LAYOUT_ANIMATION_MS}ms`,
          transitionTimingFunction: LAYOUT_ANIMATION_EASING,
        }}
        aria-hidden={contentHidden}
        inert={contentHidden || undefined}
      >
      {header}
      <div className={cn('relative min-h-0 flex-1 overflow-hidden', isResizing && 'pointer-events-none')}>
        {hasFileTabs ? (
          <div className={cn('absolute inset-0 flex', isFileTabActive ? 'flex' : 'hidden')}>
            {hasOpenEditorFile || !contextEditorTreeVisible ? (
              // Hidden rather than unmounted so a hidden editor keeps its state.
              <div className={cn('h-full min-w-0 flex-1', hasOpenEditorFile && !showsEditor && 'hidden')}>
                {hasOpenEditorFile ? (
                  <React.Suspense fallback={null}><FilesView mode="editor-only" visible={!contentHidden && isFileTabActive && showsEditor} onCloseFile={handleCloseEditorFile} /></React.Suspense>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                    <Icon name="file-code" className="h-12 w-12 text-muted-foreground/50" />
                    <div className="typography-ui-header text-foreground">{t('contextPanel.editorEmpty.title')}</div>
                    <div className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.editorEmpty.description')}</div>
                  </div>
                )}
              </div>
            ) : null}
            <EditorTreeColumn visible={contextEditorTreeVisible} active={isOpen && isFileTabActive} fill={!showsEditor} />
          </div>
        ) : null}
        {activeChatTab && activeChatSessionID && activeChatPinnedSession ? (
          // The chat renders in this app, pinned to its session: it shares
          // the app's connection, stores and theme, and opens like a session
          // switch instead of booting a second app.
          <section
            key={activeChatTab.id}
            aria-label={t('contextPanel.iframe.sessionChatTitle', { sessionID: activeChatSessionID })}
            className="absolute inset-0 bg-background"
          >
            <ChatView
              pinnedSession={activeChatPinnedSession}
              readOnly={activeChatTab.readOnly}
            />
          </section>
        ) : null}
        {loadedBrowserTabs.map((tab) => {
          const shown = tab.directory === directoryKey && activeTab?.id === tab.id;
          return (
            <div
              // Keyed by the directory as well: a tab of the next directory with the
              // same id is another tab, with its own view and its own session. Kept
              // on the same instance, the view went on showing the previous
              // directory's page, and a space's page would run in the host's
              // session instead of the space's own.
              key={`${tab.directory}\u0000${tab.id}`}
              // Invisible rather than display:none, so a background tab the agent
              // is working keeps its layout and its snapshots read a real page.
              className={cn('absolute inset-0', !shown && 'invisible pointer-events-none')}
              aria-hidden={!shown || undefined}
            >
              <BrowserPane
                initialUrl={tab.targetPath ?? ''}
                directory={tab.directory}
                tabID={tab.id}
                ownerSessionId={tab.ownerSessionId}
              />
            </div>
          );
        })}
        {diffTabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              'absolute inset-0',
              activeTab?.id !== tab.id && 'hidden'
            )}
          >
            <React.Suspense fallback={null}>
              <ContextPanelHeaderSlotProvider value={activeTab?.id === tab.id ? headerSlotEl : null}>
              <DiffView
                visible={isOpen && activeTab?.id === tab.id}
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
          </div>
        ))}
        {terminalTab ? (
          <div className={cn('absolute inset-0', activeTab?.mode === 'terminal' ? 'block' : 'hidden')}>
            <ContextPanelHeaderSlotProvider value={activeTab?.mode === 'terminal' ? headerSlotEl : null}>
              <TerminalView
                visible={isOpen && activeTab?.mode === 'terminal'}
                directory={terminalTab.targetDirectory}
                onLastTabClosed={() => { if (directoryKey) closeContextPanelTab(directoryKey, terminalTab.id); }}
              />
            </ContextPanelHeaderSlotProvider>
          </div>
        ) : null}
        {hasWalkthroughTab ? (
          <div className={cn('absolute inset-0', activeTab?.mode === 'walkthrough' ? 'block' : 'hidden')}>
            <React.Suspense fallback={null}>
              <ContextPanelHeaderSlotProvider value={activeTab?.mode === 'walkthrough' ? headerSlotEl : null}>
                <WalkthroughView directory={effectiveDirectory} visible={isOpen && activeTab?.mode === 'walkthrough'} />
              </ContextPanelHeaderSlotProvider>
            </React.Suspense>
          </div>
        ) : null}
        {pluginTabs.map((tab) => {
          if (!isPluginContextPanelMode(tab.mode)) return null;
          // A shared-surface extension's picture is drawn by the host and
          // mounted only while shown, so an unwatched surface holds no socket
          // and its service can idle out. Its own page, when it has one, is
          // docked to one edge of the picture and stays mounted like any
          // panel iframe.
          const guestId = pluginIdFromMode(tab.mode);
          const sharedSurface = surfaceGuestIds.has(guestId);
          const docking = surfaceDockings.get(guestId);
          const shown = activeTab?.id === tab.id;
          const surfaceMounted = shown && isOpen;
          if (sharedSurface && !docking && !surfaceMounted) return null;
          return (
            <div
              key={tab.id}
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
            </div>
          );
        })}
        {activeTab?.mode !== 'chat' && !isFileTabActive && activeTab?.mode !== 'browser' && activeTab?.mode !== 'diff' && activeTab?.mode !== 'terminal' && activeTab?.mode !== 'walkthrough' && !(activeTab && isPluginContextPanelMode(activeTab.mode)) ? activeNonChatContent : null}
      </div>
      </div>
    </aside>
  );
};

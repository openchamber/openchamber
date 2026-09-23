import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { DiffViewIcon } from '@/components/icons/DiffIcon';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { PullRequestView } from '@/components/views/PullRequestView';
import { TerminalView } from '@/components/views/TerminalView';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

// Heavy views stay on-demand (same as MainLayout): importing DiffView/FilesView
// or the walkthrough statically pulls the CodeMirror and @pierre/diffs stacks
// into the eager startup graph even when no such tab is open.
const WalkthroughView = lazyWithChunkRecovery(() => import('@/components/views/walkthrough/WalkthroughView').then((m) => ({ default: m.WalkthroughView })));
const DiffView = lazyWithChunkRecovery(() => import('@/components/views/DiffView').then((m) => ({ default: m.DiffView })));
const GitView = lazyWithChunkRecovery(() => import('@/components/views/GitView').then((m) => ({ default: m.GitView })));
// The Linear rail icon stays hidden until a workspace is connected, so most
// users never render this panel; keep it out of the main bundle.
const LinearIssuesView = lazyWithChunkRecovery(() => import('@/components/views/LinearIssuesView').then((m) => ({ default: m.LinearIssuesView })));
const PlanView = lazyWithChunkRecovery(() => import('@/components/views/PlanView').then((m) => ({ default: m.PlanView })));
import { ProjectContextPanel } from './RightSidebarTabs';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useGuestSurfaces } from '@/hooks/useGuestSurfaces';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useBrowserFaviconStore } from '@/stores/useBrowserFaviconStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { activeContextTabForZone, clampContextEditorTreeWidth, useUIStore, type ContextPanelMode, type PendingDiffScope } from '@/stores/useUIStore';
import { markSessionViewed } from '@/sync/notification-store';
import { setExternallyViewedSession, useDirectoryStore } from '@/sync/sync-context';
import { ContextPanelContent } from './ContextSidebarTab';
import { BrowserPane } from '@/components/browser/BrowserPane';
import { browserUrlLabel } from '@/lib/browser/url';
import { getRuntimeBearerTokenSync, getRuntimeExtraHeadersSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';
import { getActiveRelayDescriptor } from '@/lib/relay/runtime-tunnel';
import { Icon } from "@/components/icon/Icon";
import { GuestIcon } from './GuestRailIcon';
import {
  EMBEDDED_RUNTIME_BOOTSTRAP_REQUEST,
  EMBEDDED_RUNTIME_BOOTSTRAP_RESPONSE,
  EMBEDDED_VISIBILITY_REQUEST,
  EMBEDDED_VISIBILITY_UPDATE,
  getActiveEmbeddedSessionChatTab,
  getOrCreateEmbeddedSessionChatURL,
  type EmbeddedSessionChatURLCacheEntry,
  type EmbeddedSessionRuntimeBootstrap,
} from './contextPanelEmbeddedChat';
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

const GuestSurfacePane = React.lazy(() => import('./GuestSurfacePane').then((module) => ({ default: module.GuestSurfacePane })));
import { useGuestsStore } from '@/lib/guests/store';
import { guestHasSharedSurface, guestSurfaceDocking, type GuestSurfaceDocking } from '@/lib/guests/surfaces';
import { FALLBACK_GUEST_ICON } from '@/lib/guests/icon';
import { isPluginContextPanelMode, pluginIdFromMode } from '@/lib/surfaces/modes';
import { CONTEXT_SURFACES, getContextSurfaceWidthFraction } from '@/lib/surfaces/registry';
import { MAIN_CHAT_TAB_ID, mainChatZone, zoneOfMode, type WorkspaceZone } from '@/lib/workspace/layout';
import { WorkspaceMoveMenuItems } from './workspace/WorkspaceMoveMenuItems';
import { FilesSurface } from './FilesSurface';
import { TabCloseMenuItems } from './TabCloseMenuItems';
import {
  FILES_SURFACE_TAB_ID,
  fileTabToActivate,
  mountedFileTabs,
  reorderForStripDrag,
  splitWorkspaceStripClose,
  stripEntryMode,
  workspaceStripEntries,
} from './workspace/filesSurfaceTabs';
import { isVimEditorEventTarget } from '@/lib/editorFocus';
import { isTerminalEventTarget } from '@/lib/terminalFocus';

/** Registry id owning a panel mode, for the tab menu's "Move to ..." rows. */
const surfaceIdForMode = (mode: ContextPanelMode | null): string | null => {
  if (mode === null) return null;
  if (isPluginContextPanelMode(mode)) return mode;
  return CONTEXT_SURFACES.find((surface) => surface.mode === mode)?.id ?? null;
};

const CONTEXT_PANEL_MIN_WIDTH = 320;
const CONTEXT_PANEL_DEFAULT_WIDTH = 600;
// The panel has no absolute pixel ceiling: on large monitors the user may
// want it nearly full-width (side-by-side diffs with the chat open). The
// only limit during a drag is leaving the chat column this much width.
const CONTEXT_CHAT_MIN_WIDTH = 400;
const RESIZE_FOLLOW_INTERVAL_MS = 100;
const CONTEXT_TAB_LABEL_MAX_CHARS = 24;
type TranslateFn = ReturnType<typeof useI18n>['t'];
const EMPTY_SESSION_TITLE_MAP = new Map<string, string>();



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
const maxPanelWidth = (availableWidth?: number | null): number => {
  const base = availableWidth
    ?? (typeof window !== 'undefined' ? window.innerWidth : CONTEXT_PANEL_DEFAULT_WIDTH * 2);
  return Math.max(CONTEXT_PANEL_MIN_WIDTH, base - CONTEXT_CHAT_MIN_WIDTH);
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
  if (mode === 'linear') return t('contextPanel.mode.linear');
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

  if (tab.mode === 'linear') {
    return <Icon name="linear" className="h-3.5 w-3.5" />;
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

const getSessionIDFromDedupeKey = (dedupeKey: string | undefined): string | null => {
  if (!dedupeKey || !dedupeKey.startsWith('session:')) {
    return null;
  }

  const sessionID = dedupeKey.slice('session:'.length).trim();
  return sessionID || null;
};

const areTitleMapsEqual = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean => {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
};

const buildSessionTitleMap = (sessions: Array<{ id: string; title?: string | null }>, sessionIDs: readonly string[]): Map<string, string> => {
  if (sessionIDs.length === 0) return EMPTY_SESSION_TITLE_MAP;
  const wanted = new Set(sessionIDs);
  const next = new Map<string, string>();
  for (const session of sessions) {
    if (!wanted.has(session.id)) continue;
    const title = session.title?.trim();
    if (title) next.set(session.id, title);
  }
  return next.size === 0 ? EMPTY_SESSION_TITLE_MAP : next;
};

const useSessionTitleMap = (directory: string | undefined, sessionIDs: readonly string[]): ReadonlyMap<string, string> => {
  const store = useDirectoryStore(directory);
  const snapshotRef = React.useRef<ReadonlyMap<string, string>>(EMPTY_SESSION_TITLE_MAP);
  const sessionIDsRef = React.useRef<readonly string[]>(sessionIDs);

  sessionIDsRef.current = sessionIDs;

  return React.useSyncExternalStore(
    store.subscribe,
    React.useCallback(() => {
      const next = buildSessionTitleMap(store.getState().session, sessionIDsRef.current);
      if (areTitleMapsEqual(snapshotRef.current, next)) {
        return snapshotRef.current;
      }
      snapshotRef.current = next;
      return next;
    }, [store]),
    () => EMPTY_SESSION_TITLE_MAP,
  );
};


const truncateTabLabel = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3)}...`;
};

/** Files as a whole wears the rail's Files icon, not the icon of a file. */
const FILES_SURFACE_ICON = <Icon name="file-edit" className="h-3.5 w-3.5" />;



type ContextPanelProps = {
  /**
   * Which workspace zone this panel draws. One instance is mounted per zone
   * that holds surfaces, and each one renders only the tabs docked in it, so
   * a terminal at the bottom and a diff on the right are on screen together.
   */
  zone: WorkspaceZone;
  /**
   * Renders the session conversation as this zone's first, unclosable tab.
   * The chat is not a panel tab — it has no entry in `contextPanelByDirectory`
   * — so the zone holding the `chat` surface is told about it instead.
   */
  mainChat?: React.ReactNode;
};

export const ContextPanel: React.FC<ContextPanelProps> = ({ zone, mainChat }) => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const directoryKey = React.useMemo(() => normalizeDirectoryKey(effectiveDirectory), [effectiveDirectory]);

  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const workspaceLayout = useUIStore((state) => state.workspaceLayout);
  const closeContextZone = useUIStore((state) => state.closeContextZone);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const toggleContextPanelExpanded = useUIStore((state) => state.toggleContextPanelExpanded);
  const setContextPanelWidth = useUIStore((state) => state.setContextPanelWidth);
  const setActiveContextPanelTab = useUIStore((state) => state.setActiveContextPanelTab);
  const focusMainChat = useUIStore((state) => state.focusMainChat);
  // The agent's browser opener and file-open requests are window-wide, so
  // they are registered once by the workspace (useWorkspaceOpeners), not by
  // every zone's panel.
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
  const allowPromptingSubagentSessions = useUIStore((state) => state.allowPromptingSubagentSessions);
  const { themeMode, setThemeMode, lightThemeId, darkThemeId, currentTheme } = useThemeSystem();

  // Every derivation below — browser tabs, diff tabs, the terminal, plugin
  // panes, the editor — reads from this one list, so scoping it to the zone is
  // what makes a second zone render a different surface rather than the same
  // one twice.
  const zoneOf = React.useCallback(
    (mode: ContextPanelMode) => zoneOfMode(workspaceLayout, mode),
    [workspaceLayout],
  );
  const tabs = React.useMemo(
    () => (panelState?.tabs ?? []).filter((tab) => zoneOf(tab.mode) === zone),
    [panelState?.tabs, zone, zoneOf],
  );
  const activeTab = React.useMemo(() => activeContextTabForZone(
    panelState,
    zone,
    zoneOf,
    mainChatZone(workspaceLayout),
  ), [panelState, workspaceLayout, zone, zoneOf]);
  // The chat has no tab record, so `activeContextTabForZone` returning null in
  // the chat's own zone is exactly what "the conversation is showing" means.
  const showsMainChat = Boolean(mainChat) && activeTab === null;
  // The center, and wherever the conversation is docked, are always drawn:
  // neither can be collapsed, so neither appears in `openZones`.
  const isPermanentZone = zone === 'center' || Boolean(mainChat);
  // The center never collapses. Without the conversation in it, what it shows
  // is still an ordinary surface, so its header closes that surface instead
  // (Files hides, keeping its files), as the rail toggle does.
  const closesSurfaceNotZone = zone === 'center' && !mainChat;
  const isOpen = (isPermanentZone || Boolean(panelState?.openZones.includes(zone)))
    && (Boolean(activeTab) || showsMainChat);
  const [availablePanelAreaWidth, setAvailablePanelAreaWidth] = React.useState<number | null>(null);
  // A hidden Files keeps its container, and so its editor, mounted here.
  const filesTabs = React.useMemo(
    () => mountedFileTabs(tabs, panelState?.hiddenFileTabs ?? [], zoneOf('file') === zone),
    [panelState?.hiddenFileTabs, tabs, zone, zoneOf],
  );
  const hasOpenEditorFile = React.useMemo(
    () => filesTabs.some((tab) => tab.targetPath),
    [filesTabs],
  );
  // The editor column is shown for an open file unless the user hid it; the
  // tree never hides alongside it, so a hidden tree forces the editor back.
  const showsEditor = hasOpenEditorFile && (contextEditorVisible || !contextEditorTreeVisible);
  // The conversation has no tab, so a zone showing it keeps its width under
  // the chat surface's own key; without one the resize could not be saved.
  const activeModeForWidth: ContextPanelMode | null = activeTab?.mode ?? (showsMainChat ? 'chat' : null);
  const isTreeOnly = activeModeForWidth === 'file' && !showsEditor;
  // Expanding grows leftwards over the center, which only the right panel can do.
  const canExpand = zone === 'right';
  const isExpanded = Boolean(canExpand && isOpen && panelState?.expanded && !isTreeOnly);
  const manualWidth = activeModeForWidth ? panelState?.widthByMode?.[activeModeForWidth] : undefined;
  const manualWidthFraction = activeModeForWidth ? panelState?.widthFractionByMode?.[activeModeForWidth] : undefined;
  const widthFraction = activeModeForWidth ? getContextSurfaceWidthFraction(activeModeForWidth) : 0.5;
  const widthFallbackBase = availablePanelAreaWidth
    ?? (typeof window !== 'undefined' ? window.innerWidth : CONTEXT_PANEL_DEFAULT_WIDTH * 2);
  const effectiveManualWidth = manualWidthFraction != null && availablePanelAreaWidth != null
    ? Math.round(manualWidthFraction * availablePanelAreaWidth)
    : manualWidth;
  const width = isTreeOnly
    ? contextEditorTreeWidth
    : clampWidth(effectiveManualWidth ?? Math.round(widthFraction * widthFallbackBase), maxPanelWidth(availablePanelAreaWidth ?? widthFallbackBase));

  // Convert legacy pixel-only preferences to a ratio the first time the
  // available area is known, so existing users also get responsive sizing.
  React.useEffect(() => {
    if (zone !== 'right' || !directoryKey || !activeModeForWidth || isTreeOnly || manualWidthFraction != null || manualWidth == null || availablePanelAreaWidth == null) return;
    setContextPanelWidth(directoryKey, activeModeForWidth, manualWidth, availablePanelAreaWidth);
  }, [activeModeForWidth, availablePanelAreaWidth, directoryKey, isTreeOnly, manualWidth, manualWidthFraction, setContextPanelWidth, zone]);
  const chatSessionIDs = React.useMemo(() => {
    const ids: string[] = [];
    for (const tab of tabs) {
      if (tab.mode !== 'chat') continue;
      const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
      if (sessionID && !ids.includes(sessionID)) ids.push(sessionID);
    }
    return ids;
  }, [tabs]);
  const sessionTitleById = useSessionTitleMap(directoryKey || undefined, chatSessionIDs);

  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const resizingWidthRef = React.useRef<number | null>(null);
  const activeResizePointerIDRef = React.useRef<number | null>(null);
  const panelRef = React.useRef<HTMLElement | null>(null);
  const chatFrameRefs = React.useRef<Map<string, HTMLIFrameElement>>(new Map());
  const chatFrameSrcByTabIDRef = React.useRef<Map<string, EmbeddedSessionChatURLCacheEntry>>(new Map());
  const wasOpenRef = React.useRef(false);

  // Defaults and manually resized surfaces track the same available area.
  React.useLayoutEffect(() => {
    const parent = panelRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      setAvailablePanelAreaWidth(parent.clientWidth || null);
    });
    observer.observe(parent);
    setAvailablePanelAreaWidth(parent.clientWidth || null);

    return () => observer.disconnect();
  }, []);

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
    const availableWidth = resizeAvailableWidthRef.current;
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
      setContextPanelWidth(directoryKey, activeModeForWidth, finalWidth, availableWidth ?? undefined);
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

  const handleClose = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    closeContextZone(directoryKey, zone);
  }, [closeContextZone, directoryKey, zone]);

  const handleToggleExpanded = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    toggleContextPanelExpanded(directoryKey);
  }, [directoryKey, toggleContextPanelExpanded]);

  const handlePanelKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') {
      return;
    }

    // Escape closes a zone. The center and the conversation's zone cannot
    // close, so they leave the key alone: the chat uses it to dismiss its own
    // popups, leave shell mode and collapse the composer.
    if (isPermanentZone) {
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
    // Same for the file editor on the Vim keymap: Escape leaves INSERT mode
    // there, and CodeMirror only sees it if this handler stays out of the way.
    if (isVimEditorEventTarget(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    handleClose();
  }, [handleClose, isPermanentZone]);

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
  const activeChatTab = getActiveEmbeddedSessionChatTab(chatTabs, activeChatTabID);

  React.useEffect(() => {
    if (!isOpen || !directoryKey || !activeChatSessionID || typeof window === 'undefined') {
      return;
    }

    const markActiveChatViewed = () => {
      if (document.visibilityState === 'hidden' || !document.hasFocus()) {
        setExternallyViewedSession(directoryKey, activeChatSessionID, false);
        return;
      }

      markSessionViewed(activeChatSessionID);
      setExternallyViewedSession(directoryKey, activeChatSessionID, true);
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
      setExternallyViewedSession(directoryKey, activeChatSessionID, false);
    };
  }, [activeChatSessionID, directoryKey, isOpen]);

  const getEmbeddedChatSrc = React.useCallback((tabID: string, sessionID: string, readOnly: boolean): string => {
    return getOrCreateEmbeddedSessionChatURL(chatFrameSrcByTabIDRef.current, tabID, sessionID, directoryKey || null, readOnly, {
      mode: themeMode,
      lightThemeId,
      darkThemeId,
      currentTheme,
    }, { allowPromptingSubagentSessions });
  }, [allowPromptingSubagentSessions, currentTheme, darkThemeId, directoryKey, lightThemeId, themeMode]);

  const activeChatSrc = activeChatTab && activeChatSessionID
    ? getEmbeddedChatSrc(activeChatTab.id, activeChatSessionID, activeChatTab.readOnly)
    : null;

  React.useEffect(() => {
    const liveTabIDs = new Set(tabs.map((tab) => tab.id));
    for (const tabID of chatFrameSrcByTabIDRef.current.keys()) {
      if (!liveTabIDs.has(tabID)) {
        chatFrameSrcByTabIDRef.current.delete(tabID);
      }
    }
  }, [tabs]);

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

  const postThemeSyncToEmbeddedChat = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const payload = {
      themeMode,
      lightThemeId,
      darkThemeId,
      currentTheme,
    };

    for (const frame of chatFrameRefs.current.values()) {
      const frameWindow = frame.contentWindow;
      if (!frameWindow) {
        continue;
      }

      frameWindow.postMessage(
        {
          type: 'openchamber:theme-sync',
          payload,
        },
        window.location.origin,
      );
    }
  }, [currentTheme, darkThemeId, lightThemeId, themeMode]);

  const postChatSettingsSyncToEmbeddedChat = React.useCallback(() => {
    if (typeof window === 'undefined') return;

    const payload = { allowPromptingSubagentSessions };
    for (const frame of chatFrameRefs.current.values()) {
      const frameWindow = frame.contentWindow;
      if (!frameWindow) continue;

      frameWindow.postMessage({ type: 'openchamber:chat-settings-sync', payload }, window.location.origin);
    }
  }, [allowPromptingSubagentSessions]);

  const postEmbeddedVisibilityToChat = React.useCallback((
    tabID: string,
    frame: HTMLIFrameElement,
    targetOrigin: string,
  ) => {
    const frameWindow = frame.contentWindow;
    if (!frameWindow) {
      return;
    }

    frameWindow.postMessage(
      {
        type: EMBEDDED_VISIBILITY_UPDATE,
        payload: { visible: activeChatTabID === tabID },
      },
      targetOrigin,
    );
  }, [activeChatTabID]);

  const postEmbeddedVisibilityToChats = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    for (const [tabID, frame] of chatFrameRefs.current.entries()) {
      postEmbeddedVisibilityToChat(tabID, frame, window.location.origin);
    }
  }, [postEmbeddedVisibilityToChat]);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const sourceChatFrame = Array.from(chatFrameRefs.current.entries())
        .find(([, frame]) => frame.contentWindow === event.source);
      if (!sourceChatFrame) {
        return;
      }

      const data = event.data as { type?: unknown; requestId?: unknown };
      if (data?.type === EMBEDDED_VISIBILITY_REQUEST) {
        const [tabID, frame] = sourceChatFrame;
        postEmbeddedVisibilityToChat(tabID, frame, event.origin);
        return;
      }
      if (data?.type === EMBEDDED_RUNTIME_BOOTSTRAP_REQUEST) {
        if (typeof data.requestId !== 'string' || !data.requestId) return;
        const runtimeKey = getRuntimeKey();
        const payload: EmbeddedSessionRuntimeBootstrap = {
          apiBaseUrl: getRuntimeApiBaseUrl(),
          clientToken: getRuntimeBearerTokenSync(),
          localOrigin: typeof window.__OPENCHAMBER_LOCAL_ORIGIN__ === 'string'
            ? window.__OPENCHAMBER_LOCAL_ORIGIN__
            : '',
          runtimeHeaders: getRuntimeExtraHeadersSync(),
          relayHostId: runtimeKey.startsWith('host:') ? runtimeKey.slice('host:'.length) : '',
          relay: getActiveRelayDescriptor() ?? undefined,
        };
        (event.source as WindowProxy | null)?.postMessage({
          type: EMBEDDED_RUNTIME_BOOTSTRAP_RESPONSE,
          requestId: data.requestId,
          payload,
        }, event.origin);
        return;
      }
      if (data?.type === 'openchamber:theme-sync-request') {
        postThemeSyncToEmbeddedChat();
        return;
      }
      if (data?.type === 'openchamber:chat-settings-request') {
        postChatSettingsSyncToEmbeddedChat();
        return;
      }
      if (data?.type !== 'openchamber:cycle-theme-request') {
        return;
      }

      const modes: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system'];
      const currentIndex = modes.indexOf(themeMode);
      const nextIndex = (currentIndex + 1) % modes.length;
      setThemeMode(modes[nextIndex]);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [postChatSettingsSyncToEmbeddedChat, postEmbeddedVisibilityToChat, postThemeSyncToEmbeddedChat, setThemeMode, themeMode]);

  React.useLayoutEffect(() => {
    const hasAnyChatTab = tabs.some((tab) => tab.mode === 'chat');
    if (!hasAnyChatTab) {
      return;
    }

    postThemeSyncToEmbeddedChat();
    postChatSettingsSyncToEmbeddedChat();
    postEmbeddedVisibilityToChats();
  }, [darkThemeId, lightThemeId, postChatSettingsSyncToEmbeddedChat, postEmbeddedVisibilityToChats, postThemeSyncToEmbeddedChat, tabs, themeMode]);

  // Everything docked in this zone is a tab here: the surfaces sharing the
  // zone as well as the several instances a surface can have (split chats,
  // browser targets). Open files are not among them: they belong to Files,
  // which is one tab here and lists its files in its own strip below. The rail
  // still opens a surface; this strip is how the user moves between what the
  // zone already holds.
  const tabItems = React.useMemo(() => {
    const items = workspaceStripEntries(tabs).map((tab) => {
      if (tab === FILES_SURFACE_TAB_ID) {
        const label = t('contextPanel.mode.files');
        return {
          id: FILES_SURFACE_TAB_ID,
          label,
          icon: FILES_SURFACE_ICON,
          title: label,
          closeLabel: t('contextPanel.tab.closeTabAria', { label }),
        };
      }
      const rawLabel = getTabLabel(tab, sessionTitleById, t);
      const label = truncateTabLabel(rawLabel, CONTEXT_TAB_LABEL_MAX_CHARS);
      const tabPathLabel = getRelativePathLabel(tab.targetPath, effectiveDirectory);
      return {
        id: tab.id,
        label,
        icon: getTabIcon(tab, faviconByOrigin),
        title: tabPathLabel ? `${rawLabel}: ${tabPathLabel}` : rawLabel,
        closeLabel: t('contextPanel.tab.closeTabAria', { label }),
      };
    });

    if (!mainChat) return items;

    // The conversation leads its zone and cannot be closed: closing it would
    // leave the user with no way back to the session they are working in.
    const chatLabel = t('layout.mainTab.chat');
    return [{
      id: MAIN_CHAT_TAB_ID,
      label: chatLabel,
      icon: <Icon name="chat-4" className="h-3.5 w-3.5" />,
      title: chatLabel,
      closable: false,
    }, ...items];
  }, [effectiveDirectory, faviconByOrigin, mainChat, sessionTitleById, t, tabs]);

  // Multi-instance surfaces keep their strip even at one tab, so a single
  // split chat still has its own close control. A lone singleton surface,
  // Files included, shows its name instead, as it always did.
  const isMultiInstanceMode = activeTab?.mode === 'chat' || activeTab?.mode === 'browser';
  const showsTabStrip = tabItems.length > 1 || isMultiInstanceMode;
  // The center zone cannot be closed and has nothing to say when it holds one
  // surface, so it draws no chrome there — which is what keeps the default
  // layout's chat looking exactly as it did before the workspace zones. Files
  // is the exception: its editor and tree toggles live in this header.
  const showsHeader = !isPermanentZone || closesSurfaceNotZone || showsTabStrip || activeTab?.mode === 'file';
  const workspaceActiveId = showsMainChat
    ? MAIN_CHAT_TAB_ID
    : activeTab?.mode === 'file' ? FILES_SURFACE_TAB_ID : activeTab?.id ?? null;

  // Files keeps its open files in its own strip. Only real files are listed:
  // the explorer placeholder is Files with nothing open, not a file.
  const openFileTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'file' && tab.targetPath),
    [tabs],
  );
  const fileTabItems = React.useMemo(() => openFileTabs.map((tab) => {
    const rawLabel = getTabLabel(tab, sessionTitleById, t);
    const label = truncateTabLabel(rawLabel, CONTEXT_TAB_LABEL_MAX_CHARS);
    const tabPathLabel = getRelativePathLabel(tab.targetPath, effectiveDirectory);
    return {
      id: tab.id,
      label,
      icon: getTabIcon(tab, faviconByOrigin),
      title: tabPathLabel ? `${rawLabel}: ${tabPathLabel}` : rawLabel,
      closeLabel: t('contextPanel.tab.closeTabAria', { label }),
    };
  }), [effectiveDirectory, faviconByOrigin, openFileTabs, sessionTitleById, t]);
  const zoneLabel = t(`workspace.zone.label.${zone}`);

  const activeNonChatContent = activeTab?.mode === 'context'
        ? <ContextPanelContent />
        : activeTab?.mode === 'git'
            ? <React.Suspense fallback={null}><GitView isActive={isOpen} /></React.Suspense>
            : activeTab?.mode === 'pr'
                ? <PullRequestView />
            : activeTab?.mode === 'linear'
                ? <React.Suspense fallback={null}><LinearIssuesView /></React.Suspense>
            : activeTab?.mode === 'notes'
                ? <ProjectContextPanel />
        : activeTab?.mode === 'plan'
            ? <React.Suspense fallback={null}><PlanView
                targetPath={activeTab.targetPath}
                savedProjectPlan={activeTab.projectPlanId && activeTab.projectPlanRef
                  ? { projectRef: activeTab.projectPlanRef, planId: activeTab.projectPlanId }
                  : null}
              /></React.Suspense>
            : null;

  const browserTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'browser'),
    [tabs],
  );
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
  const hasFileTabs = filesTabs.length > 0;

  const isFileTabActive = activeTab?.mode === 'file';
  const activeFile = React.useMemo(
    () => (activeTab?.mode === 'file' && activeTab.targetPath ? { id: activeTab.id, path: activeTab.targetPath } : null),
    [activeTab],
  );

  const closeContextPanelTabs = useUIStore((state) => state.closeContextPanelTabs);
  const hideFilesSurface = useUIStore((state) => state.hideFilesSurface);
  // Ids in the zone strip are surfaces. Closing Files there hides the surface
  // and keeps its files; only a file's own close button closes a file.
  const closeWorkspaceStripTabs = React.useCallback((ids: readonly string[]) => {
    if (!directoryKey) return;
    const { tabIds, hidesFiles } = splitWorkspaceStripClose(ids);
    closeContextPanelTabs(directoryKey, tabIds);
    if (hidesFiles) hideFilesSurface(directoryKey);
  }, [closeContextPanelTabs, directoryKey, hideFilesSurface]);

  const renderTabContextMenu = React.useCallback(
    (args: { id: string; index: number; allIds: string[]; close: () => void }): React.ReactNode => {
      if (!directoryKey) {
        return null;
      }
      const { id } = args;
      const surfaceId = id === MAIN_CHAT_TAB_ID
        ? 'chat'
        : surfaceIdForMode(stripEntryMode(id, tabs));
      return (
        <>
          <WorkspaceMoveMenuItems surfaceId={surfaceId} currentZone={zone} />
          <ContextMenuSeparator />
          <TabCloseMenuItems {...args} closeIds={closeWorkspaceStripTabs} />
        </>
      );
    },
    [closeWorkspaceStripTabs, directoryKey, tabs, zone],
  );

  const labelSurfaceId = activeTab ? surfaceIdForMode(activeTab.mode) : showsMainChat ? 'chat' : null;

  const header = !showsHeader ? null : (
    <header className="flex h-10 items-stretch border-b border-border">
      {showsTabStrip ? (
        <SortableTabsStrip
          items={tabItems}
          activeId={workspaceActiveId}
          onSelect={(tabID) => {
            if (!directoryKey) {
              return;
            }
            if (tabID === MAIN_CHAT_TAB_ID) {
              focusMainChat(directoryKey);
              return;
            }
            if (tabID === FILES_SURFACE_TAB_ID) {
              const fileTab = fileTabToActivate(tabs);
              if (fileTab) setActiveContextPanelTab(directoryKey, fileTab.id);
              return;
            }
            setActiveContextPanelTab(directoryKey, tabID);
          }}
          onClose={(tabID) => closeWorkspaceStripTabs([tabID])}
          onReorder={(activeTabID, overTabID) => {
            if (!directoryKey) {
              return;
            }
            const move = reorderForStripDrag(activeTabID, overTabID, tabs);
            if (move) reorderContextPanelTabs(directoryKey, move[0], move[1]);
          }}
          layoutMode="scrollable"
          variant="default"
          tabContextMenu={renderTabContextMenu}
        />
      ) : (
        // A lone surface shows its name instead of a tab strip; right-clicking
        // the name offers the same docking menu a tab would.
        <ContextMenu>
          <ContextMenuTrigger render={<div className="flex min-w-0 flex-1 items-center gap-1.5 px-3" />}>
            {activeTab?.mode === 'file' ? FILES_SURFACE_ICON : activeTab ? getTabIcon(activeTab, faviconByOrigin) : null}
            <span className="truncate typography-ui-label text-foreground">
              {activeTab ? getModeLabel(activeTab.mode, t) : showsMainChat ? t('layout.mainTab.chat') : null}
            </span>
          </ContextMenuTrigger>
          {!labelSurfaceId ? null : (
            <ContextMenuContent>
              <WorkspaceMoveMenuItems surfaceId={labelSurfaceId} currentZone={zone} />
            </ContextMenuContent>
          )}
        </ContextMenu>
      )}
      <div className="flex items-center gap-1 px-1.5">
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
        {/* Expand-over-the-chat belongs to the right panel: it grows leftwards
            over the center, which a left or bottom zone cannot do, and the
            center is already the widest thing on screen. */}
        {canExpand && !isTreeOnly ? (
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
        {/* The center holds whatever is left after the others, and the zone
            with the conversation in it is the main content wherever it sits;
            collapsing either would leave the user with nowhere to work. */}
        {closesSurfaceNotZone && activeTab && workspaceActiveId ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => closeWorkspaceStripTabs([workspaceActiveId])}
            className="h-7 w-7 p-0"
            title={t('contextPanel.tab.closeTabAria', { label: getModeLabel(activeTab.mode, t) })}
            aria-label={t('contextPanel.tab.closeTabAria', { label: getModeLabel(activeTab.mode, t) })}
          >
            <Icon name="close" className="h-3.5 w-3.5" />
          </Button>
        ) : isPermanentZone ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleClose}
            className="h-7 w-7 p-0"
            title={t('workspace.zone.collapse')}
            aria-label={t('workspace.zone.collapse')}
          >
            <Icon name="close" className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </header>
  );

  // Everything the zone draws. Hoisted out of the return so the right zone
  // can keep its animated, self-sizing shell while the other zones are a
  // plain box their WorkspaceZone parent sizes.
  const content = (
    <>
      {header}
        <div className={cn('relative min-h-0 flex-1 overflow-hidden', isResizing && 'pointer-events-none')}>
          {hasFileTabs && directoryKey ? (
            <FilesSurface
              directoryKey={directoryKey}
              fileTabItems={fileTabItems}
              activeFile={activeFile}
              shown={isFileTabActive}
              zoneOpen={isOpen}
              hasOpenFile={hasOpenEditorFile}
              showsEditor={showsEditor}
              treeVisible={contextEditorTreeVisible}
              onKeyDownCapture={handlePanelKeyDownCapture}
            />
          ) : null}
          {activeChatTab && activeChatSessionID && activeChatSrc ? (
            <iframe
              key={activeChatTab.id}
              ref={(node) => {
                if (!node) {
                  chatFrameRefs.current.delete(activeChatTab.id);
                  return;
                }
                chatFrameRefs.current.set(activeChatTab.id, node);
              }}
              src={activeChatSrc}
              title={t('contextPanel.iframe.sessionChatTitle', { sessionID: activeChatSessionID })}
              className="absolute inset-0 h-full w-full border-0 bg-background"
              onLoad={() => {
                postThemeSyncToEmbeddedChat();
                postChatSettingsSyncToEmbeddedChat();
                postEmbeddedVisibilityToChats();
              }}
            />
          ) : null}
          {browserTabs.map((tab) => (
            <div
              key={tab.id}
              // Invisible rather than display:none, so a background tab the agent
              // is working keeps its layout and its snapshots read a real page.
              className={cn(
                'absolute inset-0',
                activeTab?.id !== tab.id && 'invisible pointer-events-none'
              )}
              aria-hidden={activeTab?.id !== tab.id || undefined}
            >
              <BrowserPane initialUrl={tab.targetPath ?? ''} directory={directoryKey} tabID={tab.id} />
            </div>
          ))}
          {diffTabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                'absolute inset-0',
                activeTab?.id !== tab.id && 'hidden'
              )}
            >
              <React.Suspense fallback={null}>
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
              </React.Suspense>
            </div>
          ))}
          {terminalTab ? (
            <div className={cn('absolute inset-0', activeTab?.mode === 'terminal' ? 'block' : 'hidden')}>
              <TerminalView visible={isOpen && activeTab?.mode === 'terminal'} directory={terminalTab.targetDirectory} />
            </div>
          ) : null}
          {hasWalkthroughTab ? (
            <div className={cn('absolute inset-0', activeTab?.mode === 'walkthrough' ? 'block' : 'hidden')}>
              <React.Suspense fallback={null}>
                <WalkthroughView directory={effectiveDirectory} visible={isOpen && activeTab?.mode === 'walkthrough'} />
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
                      <div
                        className={cn('shrink-0', DOCK_LAYOUT[docking.dock].page)}
                        style={DOCK_LAYOUT[docking.dock].vertical ? { height: docking.size } : { width: docking.size }}
                      >
                        <PluginPane mode={tab.mode} />
                      </div>
                      <div className="min-h-0 min-w-0 flex-1">
                        {surfaceMounted ? <GuestSurfacePane mode={tab.mode} /> : null}
                      </div>
                    </div>
                  )}
                </React.Suspense>
              </div>
            );
          })}
          {activeTab && activeTab.mode !== 'chat' && !isFileTabActive && activeTab.mode !== 'browser' && activeTab.mode !== 'diff' && activeTab.mode !== 'terminal' && activeTab.mode !== 'walkthrough' && !isPluginContextPanelMode(activeTab.mode) ? activeNonChatContent : null}
          {/* The session conversation. Kept mounted while another tab of this
              zone is in front so its scroll position and composer survive a
              switch, the same as the panes above. */}
          {mainChat ? (
            <div
              className={cn('absolute inset-0', showsMainChat ? 'block' : 'hidden')}
              // Outside the center the conversation's width is this zone's, so
              // the work-status panel inside it measures here rather than the
              // whole row (the center row carries the marker itself).
              data-chat-area={zone === 'center' ? undefined : 'true'}
            >
              {mainChat}
            </div>
          ) : null}
        </div>
    </>
  );

  if (zone !== 'right') {
    return (
      <section
        ref={panelRef}
        data-context-panel="true"
        data-workspace-zone={zone}
        tabIndex={-1}
        aria-label={zoneLabel}
        // A collapsed zone stays mounted so its panes keep their state (a
        // loaded page, the editor, the terminal); it just takes no input.
        inert={!isOpen || undefined}
        aria-hidden={!isOpen || undefined}
        className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background"
        onKeyDownCapture={handlePanelKeyDownCapture}
      >
        {content}
      </section>
    );
  }

  // width/min/max stay interpolable across open/close (no instant min/max
  // jumps) so the 200ms width transition matches the sidebars.
  const panelStyle: React.CSSProperties = !isOpen
    ? {
        ['--oc-context-panel-width' as string]: `${width}px`,
        width: 0,
        maxWidth: '100%',
        overflowX: 'clip',
      }
    : isExpanded
      ? {
          // px, not '100%': px↔% width changes do not interpolate, which
          // would make the expand/collapse width snap instead of animating.
          ['--oc-context-panel-width' as string]: availablePanelAreaWidth !== null ? `${availablePanelAreaWidth}px` : '100%',
          width: availablePanelAreaWidth !== null ? `${availablePanelAreaWidth}px` : '100%',
          maxWidth: '100%',
        }
      : {
          width: 'min(var(--oc-context-panel-width), 100%)',
          maxWidth: '100%',
          overflowX: 'clip',
          ['--oc-context-panel-width' as string]: `${width}px`,
        };

  return (
    <aside
      ref={panelRef}
      data-context-panel="true"
      tabIndex={-1}
      inert={!isOpen || undefined}
      className={cn(
        'flex min-h-0 flex-col overflow-hidden bg-background',
        // Right-anchored while expanded: `inset-0` would teleport the left
        // edge instantly (position does not transition), so only the width
        // animates and the panel grows leftwards from its docked position.
        isExpanded
          ? 'absolute inset-y-0 right-0 z-20 min-w-0'
          : 'relative h-full flex-shrink-0',
        !isOpen && 'pointer-events-none',
        'will-change-[width] motion-reduce:transition-none',
        'transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]'
      )}
      onKeyDownCapture={handlePanelKeyDownCapture}
      style={panelStyle}
    >
      {/* Painted divider instead of border-l: a real border eats 1px of the
          content box only while collapsed, shifting the header controls by
          1px between the collapsed and expanded states. */}
      {isOpen && !isExpanded && (
        <div aria-hidden="true" className="absolute left-0 top-0 z-40 h-full w-px bg-border" />
      )}
      {/* Divider between the panel and the icon rail on its right. */}
      {isOpen && (
        <div aria-hidden="true" className="absolute right-0 top-0 z-40 h-full w-px bg-border" />
      )}
      {!isExpanded && (
        <div
          className={cn(
            'absolute left-0 top-0 z-50 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
            isResizing && 'bg-[var(--interactive-border)]'
          )}
          onPointerDown={handleResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('contextPanel.actions.resizePanelAria')}
        />
      )}
      <div
        className={cn(
          'relative z-10 flex h-full min-h-0 shrink-0 flex-col duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          // Width animates in sync with the panel (surface switches, resize
          // release); during the drag itself nothing resizes — only the ghost
          // guide line moves.
          'transition-[width,opacity]',
          !isOpen && 'pointer-events-none select-none opacity-0'
        )}
        // px in the expanded state too: px↔% width changes cannot interpolate,
        // so the header controls would snap instead of riding the animation.
        style={{
          width: isExpanded
            ? (availablePanelAreaWidth !== null ? `${availablePanelAreaWidth}px` : '100%')
            : 'var(--oc-context-panel-width)',
        }}
        aria-hidden={!isOpen}
      >
      {content}
      </div>
    </aside>
  );
};

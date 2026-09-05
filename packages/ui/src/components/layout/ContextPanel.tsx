import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { DiffViewIcon } from '@/components/icons/DiffIcon';
import { Button } from '@/components/ui/button';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { PullRequestView } from '@/components/views/PullRequestView';
import { TerminalView } from '@/components/views/TerminalView';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { useGitDiffTabsStore } from '@/stores/useGitDiffTabsStore';

// Heavy views stay on-demand (same as MainLayout): importing DiffView/FilesView
// or the walkthrough statically pulls the CodeMirror and @pierre/diffs stacks
// into the eager startup graph even when no such tab is open.
const WalkthroughView = lazyWithChunkRecovery(() => import('@/components/views/walkthrough/WalkthroughView').then((m) => ({ default: m.WalkthroughView })));
const DiffView = lazyWithChunkRecovery(() => import('@/components/views/DiffView').then((m) => ({ default: m.DiffView })));
const FilesView = lazyWithChunkRecovery(() => import('@/components/views/FilesView').then((m) => ({ default: m.FilesView })));
const GitView = lazyWithChunkRecovery(() => import('@/components/views/GitView').then((m) => ({ default: m.GitView })));
// The Linear rail icon stays hidden until a workspace is connected, so most
// users never render this panel; keep it out of the main bundle.
const LinearIssuesView = lazyWithChunkRecovery(() => import('@/components/views/LinearIssuesView').then((m) => ({ default: m.LinearIssuesView })));
const PlanView = lazyWithChunkRecovery(() => import('@/components/views/PlanView').then((m) => ({ default: m.PlanView })));
import { ProjectContextPanel } from './RightSidebarTabs';
import { SidebarFilesTree } from './SidebarFilesTree';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useBrowserFaviconStore } from '@/stores/useBrowserFaviconStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore, type ContextPanelMode, type PendingDiffScope } from '@/stores/useUIStore';
import { markSessionViewed } from '@/sync/notification-store';
import { setExternallyViewedSession, useDirectoryStore } from '@/sync/sync-context';
import { ContextPanelContent } from './ContextSidebarTab';
import { BrowserPane } from '@/components/browser/BrowserPane';
import { browserUrlLabel } from '@/lib/browser/url';
import { registerBrowserOpener } from '@/lib/browser/controlClient';
import { getRuntimeBearerTokenSync, getRuntimeExtraHeadersSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';
import { getActiveRelayDescriptor } from '@/lib/relay/runtime-tunnel';
import { Icon } from "@/components/icon/Icon";
import { GitDiffTabsPane } from './GitDiffTabsPane';
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
import { getContextSurfaceWidthFraction } from '@/lib/surfaces/registry';
import { isTerminalEventTarget } from '@/lib/terminalFocus';

const CONTEXT_PANEL_MIN_WIDTH = 380;
const CONTEXT_PANEL_MAX_WIDTH = 1400;
const CONTEXT_PANEL_DEFAULT_WIDTH = 600;
const RESIZE_FOLLOW_INTERVAL_MS = 100;
const CONTEXT_TAB_LABEL_MAX_CHARS = 24;
type TranslateFn = ReturnType<typeof useI18n>['t'];
const EMPTY_SESSION_TITLE_MAP = new Map<string, string>();
// Stable fallback so the selector returns a referentially equal snapshot for
// directories with no open diff tabs (an inline [] would re-render forever).
const EMPTY_GIT_DIFF_TABS: readonly never[] = Object.freeze([]);



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

const clampWidth = (width: number): number => {
  if (!Number.isFinite(width)) {
    return CONTEXT_PANEL_DEFAULT_WIDTH;
  }

  return Math.min(CONTEXT_PANEL_MAX_WIDTH, Math.max(CONTEXT_PANEL_MIN_WIDTH, Math.round(width)));
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

const EDITOR_TREE_MIN_WIDTH = 200;
const EDITOR_TREE_MAX_WIDTH = 480;

// The editor surface's file-tree column: docked on the right, resizable from
// its left edge, and animated open/closed like the app sidebars.
const EditorTreeColumn: React.FC<{ visible: boolean }> = ({ visible }) => {
  const { t } = useI18n();
  const width = useUIStore((state) => state.contextEditorTreeWidth);
  const setWidth = useUIStore((state) => state.setContextEditorTreeWidth);
  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const liveWidthRef = React.useRef<number | null>(null);
  const pointerIDRef = React.useRef<number | null>(null);
  const columnRef = React.useRef<HTMLDivElement | null>(null);

  const clampTreeWidth = React.useCallback((value: number) => {
    return Math.min(EDITOR_TREE_MAX_WIDTH, Math.max(EDITOR_TREE_MIN_WIDTH, Math.round(value)));
  }, []);

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
    const nextWidth = clampTreeWidth(startWidthRef.current + delta);
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
    const finalWidth = clampTreeWidth(liveWidthRef.current ?? width);
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
        'relative h-full flex-shrink-0 overflow-hidden border-l border-border bg-background will-change-[width] motion-reduce:transition-none',
        !visible && 'border-l-0',
      )}
      style={{
        width: `${isResizing ? (liveWidthRef.current ?? appliedWidth) : appliedWidth}px`,
        ['--oc-editor-tree-width' as string]: `${isResizing ? (liveWidthRef.current ?? width) : width}px`,
        overflowX: 'clip',
        transitionProperty: isResizing ? 'none' : 'width',
        transitionDuration: '200ms',
        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      aria-hidden={!visible}
    >
      {visible && (
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
        style={{ width: 'var(--oc-editor-tree-width)' }}
        aria-hidden={!visible}
      >
        <SidebarFilesTree />
      </div>
    </div>
  );
};

// Split-mode divider between the diff region and the git pane. Dragging it
// resizes the GIT pane (the diff region keeps its own persisted width), so the
// committed value is the same widthByMode['git'] the panel uses in git-only
// mode — the git surface therefore keeps one width everywhere. During the drag
// the git pane follows via the row's --oc-git-pane-width and the panel total
// follows via --oc-context-panel-width on the panel root, with no re-renders.
const GitDiffSeparator: React.FC<{
  directoryKey: string;
  gitPaneWidth: number;
  diffRegionWidth: number;
}> = ({ directoryKey, gitPaneWidth, diffRegionWidth }) => {
  const { t } = useI18n();
  const setContextPanelWidth = useUIStore((state) => state.setContextPanelWidth);
  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(gitPaneWidth);
  const liveWidthRef = React.useRef<number | null>(null);
  const pointerIDRef = React.useRef<number | null>(null);
  const maxGitWidthRef = React.useRef(900);
  const separatorRef = React.useRef<HTMLDivElement | null>(null);

  const clampGitWidth = React.useCallback((value: number) => {
    return Math.min(maxGitWidthRef.current, Math.max(CONTEXT_PANEL_MIN_WIDTH, Math.round(value)));
  }, []);

  const applyLiveWidths = React.useCallback((nextGitWidth: number) => {
    const separator = separatorRef.current;
    if (!separator) {
      return;
    }
    separator.parentElement?.style.setProperty('--oc-git-pane-width', `${nextGitWidth}px`);
    const root = separator.closest('[data-context-panel="true"]');
    if (root instanceof HTMLElement) {
      root.style.setProperty('--oc-context-panel-width', `${nextGitWidth + diffRegionWidth}px`);
    }
  }, [diffRegionWidth]);

  const handlePointerDown = (event: React.PointerEvent) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    const root = separatorRef.current?.closest('[data-context-panel="true"]');
    const available = getAvailablePanelWidth(root instanceof HTMLElement ? root : null);
    // Measure once per drag: the git pane may grow until the split total
    // (git + diff region) fills the available area.
    maxGitWidthRef.current = Math.max(
      CONTEXT_PANEL_MIN_WIDTH,
      Math.min(900, (available ?? Number.MAX_SAFE_INTEGER) - diffRegionWidth),
    );
    pointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = gitPaneWidth;
    liveWidthRef.current = gitPaneWidth;
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!isResizing || pointerIDRef.current !== event.pointerId) {
      return;
    }
    // The git pane is docked right of the handle: dragging left widens it.
    const delta = startXRef.current - event.clientX;
    const nextWidth = clampGitWidth(startWidthRef.current + delta);
    if (liveWidthRef.current === nextWidth) {
      return;
    }
    liveWidthRef.current = nextWidth;
    applyLiveWidths(nextWidth);
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
    const finalWidth = clampGitWidth(liveWidthRef.current ?? gitPaneWidth);
    pointerIDRef.current = null;
    liveWidthRef.current = null;
    setIsResizing(false);
    setContextPanelWidth(directoryKey, 'git', finalWidth);
  };

  return (
    <div
      ref={separatorRef}
      className={cn(
        'relative z-20 h-full w-[3px] shrink-0 cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
        isResizing && 'bg-[var(--interactive-border)]'
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('gitView.preview.resizeAria')}
    />
  );
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


export const ContextPanel: React.FC = () => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const directoryKey = React.useMemo(() => normalizeDirectoryKey(effectiveDirectory), [effectiveDirectory]);

  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const closeContextPanelTab = useUIStore((state) => state.closeContextPanelTab);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const toggleContextPanelExpanded = useUIStore((state) => state.toggleContextPanelExpanded);
  const setContextPanelWidth = useUIStore((state) => state.setContextPanelWidth);
  const setActiveContextPanelTab = useUIStore((state) => state.setActiveContextPanelTab);
  const openContextBrowser = useUIStore((state) => state.openContextBrowser);

  // Lets an agent's browser.open create the tab it needs when none is open yet.
  // Registered from the panel because opening a tab is panel state, not
  // something the browser view itself can do before it exists. Reveal the
  // panel so Electron gives the webview a composited surface; capturePage()
  // cannot capture the zero-width webview inside a closed panel.
  React.useEffect(() => {
    if (!effectiveDirectory) return;
    return registerBrowserOpener((url) => openContextBrowser(effectiveDirectory, url));
  }, [effectiveDirectory, openContextBrowser]);
  const reorderContextPanelTabs = useUIStore((state) => state.reorderContextPanelTabs);
  const setSelectedFilePath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const contextEditorTreeVisible = useUIStore((state) => state.contextEditorTreeVisible);
  const toggleContextEditorTree = useUIStore((state) => state.toggleContextEditorTree);
  const openNewContextBrowserTab = useUIStore((state) => state.openNewContextBrowserTab);
  const faviconByOrigin = useBrowserFaviconStore((state) => state.byOrigin);
  const allowPromptingSubagentSessions = useUIStore((state) => state.allowPromptingSubagentSessions);
  const { themeMode, setThemeMode, lightThemeId, darkThemeId, currentTheme } = useThemeSystem();
  const contextGitSplitDiffWidth = useUIStore((state) => state.contextGitSplitDiffWidth);
  const setContextGitSplitDiffWidth = useUIStore((state) => state.setContextGitSplitDiffWidth);

  const tabs = React.useMemo(() => panelState?.tabs ?? [], [panelState?.tabs]);
  const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? tabs[tabs.length - 1] ?? null;
  const diffTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'diff'),
    [tabs],
  );
  const innerDiffTabs = useGitDiffTabsStore(
    (state) => (directoryKey ? state.byDirectory[directoryKey]?.tabs ?? EMPTY_GIT_DIFF_TABS : EMPTY_GIT_DIFF_TABS),
  );
  const isOpen = Boolean(panelState?.isOpen && activeTab);
  const isExpanded = Boolean(isOpen && panelState?.expanded);
  const [availablePanelAreaWidth, setAvailablePanelAreaWidth] = React.useState<number | null>(null);
  const panelRef = React.useRef<HTMLElement | null>(null);
  const activeModeForWidth = activeTab?.mode ?? null;
  const manualWidth = activeModeForWidth ? panelState?.widthByMode?.[activeModeForWidth] : undefined;
  const widthFraction = activeModeForWidth ? getContextSurfaceWidthFraction(activeModeForWidth) : 0.5;
  const widthFallbackBase = availablePanelAreaWidth
    ?? (typeof window !== 'undefined' ? window.innerWidth : CONTEXT_PANEL_DEFAULT_WIDTH * 2);
  const width = clampWidth(manualWidth ?? Math.round(widthFraction * widthFallbackBase));

  // The git pane keeps exactly the width the panel has in git-only mode, so
  // opening or closing the split never resizes the git surface. Same math as
  // the panel's own `width` for activeMode 'git' — kept in one place so the
  // two cannot drift.
  const gitPaneWidth = React.useMemo(() => {
    const gitModeWidth = panelState?.widthByMode?.['git'];
    return clampWidth(gitModeWidth ?? Math.round(getContextSurfaceWidthFraction('git') * widthFallbackBase));
  }, [panelState?.widthByMode, widthFallbackBase]);

  // In split mode, total panel width = gitPaneWidth + contextGitSplitDiffWidth
  const splitTotalWidth = React.useMemo(() => {
    if (activeTab?.mode !== 'git' || innerDiffTabs.length === 0) {
      return width;
    }
    const total = gitPaneWidth + contextGitSplitDiffWidth;
    const available = getAvailablePanelWidth(panelRef.current);
    return available === null ? total : Math.min(total, available);
  }, [activeTab?.mode, innerDiffTabs.length, gitPaneWidth, contextGitSplitDiffWidth, width]);

  const panelWidthForLayout = activeTab?.mode === 'git' && innerDiffTabs.length > 0 ? splitTotalWidth : width;

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
  const chatFrameRefs = React.useRef<Map<string, HTMLIFrameElement>>(new Map());
  const chatFrameSrcByTabIDRef = React.useRef<Map<string, EmbeddedSessionChatURLCacheEntry>>(new Map());
  const wasOpenRef = React.useRef(false);

  // Tracks the panel area width so fraction-based surface defaults stay
  // proportional as the window resizes; manual widths remain fixed px.
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
    const isSplitMode = activeTab?.mode === 'git' && innerDiffTabs.length > 0;
    if (isSplitMode) {
      // The split total (git pane + diff region) is bounded by the available
      // area only — the 1400px single-surface cap does not apply here.
      const minTotal = CONTEXT_PANEL_MIN_WIDTH + 360;
      const available = resizeAvailableWidthRef.current;
      const maxTotal = Math.max(minTotal, available ?? Number.MAX_SAFE_INTEGER);
      return Math.min(maxTotal, Math.max(minTotal, Math.round(nextWidth)));
    }
    const clamped = clampWidth(nextWidth);
    const available = resizeAvailableWidthRef.current;
    return available === null ? clamped : Math.min(clamped, Math.max(1, available));
  }, [activeTab?.mode, innerDiffTabs.length]);

  const handleResizeStart = React.useCallback((event: React.PointerEvent) => {
    if (!isOpen || isExpanded || !directoryKey) {
      return;
    }

    const isSplitMode = activeTab?.mode === 'git' && innerDiffTabs.length > 0;
    const startingWidth = isSplitMode ? splitTotalWidth : width;

    activeResizePointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = startingWidth;
    resizingWidthRef.current = startingWidth;
    // Measure once per drag; no layout reads happen during pointermove.
    resizeAvailableWidthRef.current = getAvailablePanelWidth(panelRef.current);
    document.documentElement.style.cursor = 'col-resize';
    event.preventDefault();
  }, [directoryKey, isExpanded, isOpen, width, activeTab?.mode, innerDiffTabs.length, splitTotalWidth]);

  const finishResize = React.useCallback(() => {
    // Apply the final width once, letting the regular 200ms width transition
    // carry the panel to the release position.
    const isSplitMode = activeTab?.mode === 'git' && innerDiffTabs.length > 0;
    const startingWidth = isSplitMode ? splitTotalWidth : width;
    const finalWidth = clampWidthForDrag(resizingWidthRef.current ?? startingWidth);
    resizingWidthRef.current = null;
    resizeAvailableWidthRef.current = null;
    if (resizeFollowTimerRef.current !== null) {
      clearTimeout(resizeFollowTimerRef.current);
      resizeFollowTimerRef.current = null;
    }
    document.documentElement.style.cursor = '';
    if (directoryKey && activeModeForWidth) {
      if (isSplitMode) {
        // In split mode, write the diff region width, not the total width
        setContextGitSplitDiffWidth(finalWidth - gitPaneWidth);
      } else {
        setContextPanelWidth(directoryKey, activeModeForWidth, finalWidth);
      }
    }
    setIsResizing(false);
    activeResizePointerIDRef.current = null;
  }, [activeTab?.mode, innerDiffTabs.length, clampWidthForDrag, directoryKey, setContextPanelWidth, splitTotalWidth, width, gitPaneWidth, setContextGitSplitDiffWidth, activeModeForWidth]);

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
    closeContextPanel(directoryKey);
  }, [closeContextPanel, directoryKey]);

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

    // Terminal owns Escape so the PTY receives it (e.g. Vim Normal mode).
    // ghostty-web listens in the bubble phase; stopping capture here would
    // swallow the key before the terminal ever sees it (issue #2644).
    if (isTerminalEventTarget(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    handleClose();
  }, [handleClose]);

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

  // Legacy seed: a persisted 'diff' panel tab from before the inner tab store
  // existed still carries its target on the descriptor. Seed the inner store
  // from it once per directory so the tab keeps showing its diff.
  const legacySeededDirectoriesRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    if (!directoryKey || innerDiffTabs.length > 0 || legacySeededDirectoriesRef.current.has(directoryKey)) {
      return;
    }
    const diffTab = diffTabs[0];
    if (!diffTab || (!diffTab.commitDiffTarget && !diffTab.targetPath)) {
      return;
    }
    legacySeededDirectoriesRef.current.add(directoryKey);

    if (diffTab.commitDiffTarget) {
      useGitDiffTabsStore.getState().openTab(directoryKey, {
        kind: 'commit',
        target: diffTab.commitDiffTarget,
      });
    } else if (diffTab.targetPath) {
      useGitDiffTabsStore.getState().openTab(directoryKey, {
        kind: 'working',
        path: diffTab.targetPath,
        scope: diffTab.diffScope ?? (diffTab.stagedDiff ? 'staged' : 'working'),
      });
    }
  }, [directoryKey, innerDiffTabs.length, diffTabs]);

  // Empty-tabs cleanup: when the LAST inner diff tab is closed, retire the
  // singleton 'diff' panel tab too. Guarded on the non-empty -> empty
  // transition so a persisted legacy tab is not closed on mount before the
  // seed effect above has a chance to read it. Keyed by directory so a switch
  // to a different directory never misreads the previous directory's count.
  const prevInnerDiffTabCountRef = React.useRef<{ directory: string; count: number } | null>(null);
  React.useEffect(() => {
    if (!directoryKey) {
      prevInnerDiffTabCountRef.current = null;
      return;
    }
    const previous = prevInnerDiffTabCountRef.current;
    const previousCount = previous?.directory === directoryKey ? previous.count : 0;
    prevInnerDiffTabCountRef.current = { directory: directoryKey, count: innerDiffTabs.length };
    if (innerDiffTabs.length > 0 || previousCount === 0) {
      return;
    }
    if (diffTabs.length > 0) {
      closeContextPanelTab(directoryKey, diffTabs[0].id);
    }
  }, [directoryKey, innerDiffTabs.length, diffTabs, closeContextPanelTab]);

  // Scope switching for the targetless diff fallback (the rail-opened diff
  // surface with no file). Inner-store working tabs own their scope changes
  // inside GitDiffTabsPane.
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

  // The rail switches between surfaces (modes); the in-panel strip only lists
  // instances of the active multi-instance surface (open files, split chats,
  // browser targets).
  const isMultiInstanceMode = activeTab?.mode === 'file' || activeTab?.mode === 'chat' || activeTab?.mode === 'browser';
  const activeModeTabs = React.useMemo(
    () => (activeTab ? tabs.filter((tab) => tab.mode === activeTab.mode) : []),
    [activeTab, tabs],
  );

  const tabItems = React.useMemo(() => activeModeTabs.map((tab) => {
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
  }), [activeModeTabs, effectiveDirectory, faviconByOrigin, sessionTitleById, t]);

  const activeNonChatContent = activeTab?.mode === 'context'
        ? <ContextPanelContent />
        : activeTab?.mode === 'git'
            ? innerDiffTabs.length > 0 && directoryKey
              ? (
                  <div
                    className="flex h-full min-h-0"
                    style={{ ['--oc-git-pane-width' as string]: `${gitPaneWidth}px` }}
                  >
                    <div className="h-full min-w-0 flex-1 overflow-hidden">
                      <GitDiffTabsPane directory={directoryKey} />
                    </div>
                    <GitDiffSeparator
                      directoryKey={directoryKey}
                      gitPaneWidth={gitPaneWidth}
                      diffRegionWidth={Math.max(360, splitTotalWidth - gitPaneWidth)}
                    />
                    <div
                      className="h-full shrink-0 overflow-hidden border-l border-border"
                      style={{ width: 'var(--oc-git-pane-width)' }}
                    >
                      <React.Suspense fallback={null}><GitView isActive={isOpen} /></React.Suspense>
                    </div>
                  </div>
                )
              : <React.Suspense fallback={null}><GitView isActive={isOpen} /></React.Suspense>
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
  const hasFileTabs = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file'),
    [tabs],
  );
  const hasOpenEditorFile = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file' && tab.targetPath),
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
    <header className="flex h-10 items-stretch border-b border-border">
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
          layoutMode="scrollable"
          variant="default"
          tabContextMenu={renderTabContextMenu}
        />
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-3">
          {activeTab ? getTabIcon(activeTab, faviconByOrigin) : null}
          <span className="truncate typography-ui-label text-foreground">
            {activeTab ? getModeLabel(activeTab.mode, t) : null}
          </span>
        </div>
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

  // width/min/max stay interpolable across open/close (no instant min/max
  // jumps) so the 200ms width transition matches the sidebars.
  const panelStyle: React.CSSProperties = !isOpen
    ? {
        ['--oc-context-panel-width' as string]: `${panelWidthForLayout}px`,
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
          ['--oc-context-panel-width' as string]: `${panelWidthForLayout}px`,
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
          : 'relative z-20 h-full flex-shrink-0',
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
      {header}
      <div className={cn('relative min-h-0 flex-1 overflow-hidden', isResizing && 'pointer-events-none')}>
        {hasFileTabs ? (
          <div className={cn('absolute inset-0 flex', isFileTabActive ? 'flex' : 'hidden')}>
            <div className="h-full min-w-0 flex-1">
              {hasOpenEditorFile ? (
                <React.Suspense fallback={null}><FilesView mode="editor-only" /></React.Suspense>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                  <Icon name="file-code" className="h-12 w-12 text-muted-foreground/50" />
                  <div className="typography-ui-header text-foreground">{t('contextPanel.editorEmpty.title')}</div>
                  <div className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.editorEmpty.description')}</div>
                </div>
              )}
            </div>
            <EditorTreeColumn visible={contextEditorTreeVisible} />
          </div>
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
            className={cn(
              'absolute inset-0',
              activeTab?.id !== tab.id && 'hidden'
            )}
          >
            <BrowserPane initialUrl={tab.targetPath ?? ''} directory={directoryKey} tabID={tab.id} />
          </div>
        ))}
        {activeTab?.mode === 'diff' && directoryKey ? (
          <div className="absolute inset-0">
            {innerDiffTabs.length > 0 ? (
              <GitDiffTabsPane directory={directoryKey} />
            ) : (
              // A targetless diff tab (opened from the rail with no file) keeps
              // its pre-split behavior: the full working-tree stacked diff.
              <React.Suspense fallback={null}>
                <DiffView
                  hideStackedFileSidebar
                  stackedDefaultCollapsedAll
                  pinSelectedFileHeaderToTopOnNavigate
                  showOpenInEditorAction
                  diffScope={activeTab.diffScope ?? (activeTab.stagedDiff ? 'staged' : 'working')}
                  onDiffScopeChange={handleDiffScopeChange}
                  targetFilePath={activeTab.targetPath}
                  flushContent
                />
              </React.Suspense>
            )}
          </div>
        ) : null}
        {terminalTab ? (
          <div className={cn('absolute inset-0', activeTab?.mode === 'terminal' ? 'block' : 'hidden')}>
            <TerminalView visible={isOpen && activeTab?.mode === 'terminal'} directory={terminalTab.targetDirectory} />
          </div>
        ) : null}
        {hasWalkthroughTab ? (
          <div className={cn('absolute inset-0', activeTab?.mode === 'walkthrough' ? 'block' : 'hidden')}>
            <React.Suspense fallback={null}>
              <WalkthroughView directory={effectiveDirectory} visible={activeTab?.mode === 'walkthrough'} />
            </React.Suspense>
          </div>
        ) : null}
        {activeTab?.mode !== 'chat' && !isFileTabActive && activeTab?.mode !== 'browser' && activeTab?.mode !== 'diff' && activeTab?.mode !== 'terminal' && activeTab?.mode !== 'walkthrough' ? activeNonChatContent : null}
      </div>
      </div>
    </aside>
  );
};

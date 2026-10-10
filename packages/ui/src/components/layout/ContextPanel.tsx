import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { DiffViewIcon } from '@/components/icons/DiffIcon';
import { Button } from '@/components/ui/button';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { PullRequestView } from '@/components/views/PullRequestView';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

// Heavy views stay on-demand (same as MainLayout): importing GitView or the
// plan statically pulls their stacks into the eager startup graph even when
// no such tab is open. The keep-alive surfaces load in ContextSurfacePanes.
const GitView = lazyWithChunkRecovery(() => import('@/components/views/GitView').then((m) => ({ default: m.GitView })));
// The Linear rail icon stays hidden until a workspace is connected, so most
// users never render this panel; keep it out of the main bundle.
const PlanView = lazyWithChunkRecovery(() => import('@/components/views/PlanView').then((m) => ({ default: m.PlanView })));
import { areTitleMapsEqual, buildSessionTitleMap, EMPTY_SESSION_TITLE_MAP, getSessionIDFromDedupeKey } from './contextPanelSessionTitles';
import { ProjectContextPanel } from './RightSidebarTabs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRepositoryReferenceProvider } from '@/components/references/referenceSources';
import { useGuestSurfaces } from '@/hooks/useGuestSurfaces';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useBrowserFaviconStore } from '@/stores/useBrowserFaviconStore';
import { clampContextEditorTreeWidth, useUIStore, type ContextPanelMode } from '@/stores/useUIStore';
import { useChildStoreManager } from '@/sync/sync-context';
import { ContextPanelContent } from './ContextSidebarTab';
import { browserUrlLabel } from '@/lib/browser/url';
import { Icon } from "@/components/icon/Icon";
import { GuestIcon } from './GuestRailIcon';
import { useGuestsStore } from '@/lib/guests/store';
import { FALLBACK_GUEST_ICON } from '@/lib/guests/icon';
import { isPluginContextPanelMode, pluginIdFromMode } from '@/lib/surfaces/modes';
import { getContextSurfaceDefaultWidth } from '@/lib/surfaces/registry';
import { beginLayoutAnimation, cancelWhenLayoutSettled, LAYOUT_ANIMATION_EASING, LAYOUT_ANIMATION_MS, runWhenLayoutSettled } from '@/lib/layoutAnimation';
import { WORK_STATUS_COLUMN_WIDTH } from '@/components/chat/work-status/useWorkStatusVisibility';
import { setWorkStatusHost, useRightSlotStore } from './rightSlot';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { ContextPanelHeaderSlotProvider } from './contextPanelHeaderSlot';
import { CLOSED_ZONE_VIEW, getZoneView, isZoneShown, resolveZoneActiveTab, type ContextZone } from '@/lib/workspace/zones';
import { closeZoneOnEscape } from './zoneEscape';
import { ZoneMoveMenuItems } from './ZoneMoveMenuItems';
import { beginZoneDrag, cancelZoneDrag, finishZoneDrag, startZoneDragGesture, updateZoneDrag } from './zoneDrag';
import { setZoneBody, setZoneHeaderSlot } from './zoneHosts';
import { useOpenUntilSettled } from './useOpenUntilSettled';

const CONTEXT_PANEL_MIN_WIDTH = 320;
const CONTEXT_PANEL_DEFAULT_WIDTH = 600;
// The panel has no absolute pixel ceiling: on large monitors the user may
// want it nearly full-width (side-by-side diffs with the chat open). The
// only limit during a drag is leaving the chat column this much width.
const CONTEXT_CHAT_MIN_WIDTH = 400;
const RESIZE_FOLLOW_INTERVAL_MS = 100;
const CONTEXT_TAB_LABEL_MAX_CHARS = 24;
type TranslateFn = ReturnType<typeof useI18n>['t'];

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


// Dragging a header moves its surface once the pointer has travelled this far.
const HEADER_DRAG_DISTANCE_PX = 8;
const HEADER_DRAG_EXCLUDED = 'button, a, input, textarea, select, label, [role="button"], [role="tab"], [role="combobox"], [role="switch"], [role="slider"], [data-sortable-tab-id], [contenteditable="true"]';

// Surfaces rendered by the zone itself and remounted on every switch; the
// rest stay alive in ContextSurfacePanes.
const isRemountedSurface = (mode: ContextPanelMode): boolean => (
  mode === 'context' || mode === 'git' || mode === 'pr' || mode === 'notes' || mode === 'plan'
);

const CONTEXT_PANEL_DEFAULT_HEIGHT = 320;
const CONTEXT_PANEL_MIN_HEIGHT = 160;
// The bottom zone leaves the chat at least this much height.
const CONTEXT_CHAT_MIN_HEIGHT = 200;

/**
 * Where a zone sits and how it grows. The left and right zones are columns
 * beside the chat and size by width; the bottom one sits under the chat
 * column and sizes by height. Gutters set the card apart from its neighbours
 * and leave its shadow room; the resize handle sits in the gutter facing the
 * chat.
 */
const ZONE_GEOMETRY = {
  right: {
    axis: 'x',
    gutter: 'pb-2 pl-2 pr-1.5',
    gutterSize: '0.875rem',
    expanded: 'absolute inset-y-0 right-0 z-20 min-w-0',
    handle: 'absolute bottom-2 left-1 top-0 z-50 w-2 cursor-col-resize',
    sizeVariable: '--oc-context-panel-width',
  },
  left: {
    axis: 'x',
    gutter: 'pb-2 pl-1.5 pr-2',
    gutterSize: '0.875rem',
    expanded: 'absolute inset-y-0 left-0 z-20 min-w-0',
    handle: 'absolute bottom-2 right-1 top-0 z-50 w-2 cursor-col-resize',
    sizeVariable: '--oc-context-panel-width',
  },
  bottom: {
    axis: 'y',
    gutter: 'pb-2 pt-2',
    gutterSize: '1rem',
    expanded: 'absolute inset-x-0 bottom-0 z-20 min-h-0',
    handle: 'absolute inset-x-0 top-1 z-50 h-2 cursor-row-resize',
    sizeVariable: '--oc-context-panel-height',
  },
} as const;

const clampHeight = (height: number, maxHeight: number): number => {
  if (!Number.isFinite(height)) {
    return CONTEXT_PANEL_DEFAULT_HEIGHT;
  }

  return Math.min(maxHeight, Math.max(CONTEXT_PANEL_MIN_HEIGHT, Math.round(height)));
};

const maxPanelHeight = (availableHeight: number | null): number => {
  if (availableHeight === null) return Number.POSITIVE_INFINITY;
  return Math.max(CONTEXT_PANEL_MIN_HEIGHT, availableHeight - CONTEXT_CHAT_MIN_HEIGHT);
};

/**
 * One zone around the chat (`lib/workspace/zones.ts`): its frame, header,
 * size and the surfaces that remount on every switch. The keep-alive
 * surfaces are portalled into its body from `ContextSurfacePanes`.
 */
export const ContextPanel: React.FC<{ zone?: ContextZone }> = ({ zone = 'right' }) => {
  const geometry = ZONE_GEOMETRY[zone];
  const isVertical = geometry.axis === 'y';
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
  const placement = useUIStore((state) => state.contextSurfaceZones);
  const closeContextZone = useUIStore((state) => state.closeContextZone);
  const closeContextPanelTab = useUIStore((state) => state.closeContextPanelTab);
  const pinContextPanelTab = useUIStore((state) => state.pinContextPanelTab);
  const toggleContextPanelExpanded = useUIStore((state) => state.toggleContextPanelExpanded);
  const setContextPanelWidth = useUIStore((state) => state.setContextPanelWidth);
  const setContextPanelHeight = useUIStore((state) => state.setContextPanelHeight);
  const setActiveContextPanelTab = useUIStore((state) => state.setActiveContextPanelTab);
  const reorderContextPanelTabs = useUIStore((state) => state.reorderContextPanelTabs);
  const contextEditorTreeVisible = useUIStore((state) => state.contextEditorTreeVisible);
  const contextEditorTreeWidth = useUIStore((state) => state.contextEditorTreeWidth);
  const setContextEditorTreeWidth = useUIStore((state) => state.setContextEditorTreeWidth);
  const toggleContextEditorTree = useUIStore((state) => state.toggleContextEditorTree);
  const contextEditorVisible = useUIStore((state) => state.contextEditorVisible);
  const toggleContextEditor = useUIStore((state) => state.toggleContextEditor);
  const openNewContextBrowserTab = useUIStore((state) => state.openNewContextBrowserTab);
  const faviconByOrigin = useBrowserFaviconStore((state) => state.byOrigin);
  const [headerSlotEl, setHeaderSlotEl] = React.useState<HTMLDivElement | null>(null);
  const registerHeaderSlot = React.useCallback((element: HTMLDivElement | null) => {
    setHeaderSlotEl(element);
    setZoneHeaderSlot(zone, element);
  }, [zone]);
  const registerBody = React.useCallback((element: HTMLDivElement | null) => {
    setZoneBody(zone, element);
  }, [zone]);

  const tabs = React.useMemo(() => panelState?.tabs ?? [], [panelState?.tabs]);
  // This zone's tab: one of its own surfaces, never one placed elsewhere.
  const activeTab = panelState ? resolveZoneActiveTab(panelState, placement, zone) : null;
  const zoneView = panelState ? getZoneView(panelState, zone) : CLOSED_ZONE_VIEW;
  const workStatusReserved = useRightSlotStore((state) => state.workStatusReserved);
  const chatCovered = useRightSlotStore((state) => state.chatCovered);
  // The bottom zone belongs to the chat column: a page covering the chat
  // covers it too.
  const coveredByPage = zone === 'bottom' && chatCovered;
  const isOpen = Boolean(zoneView.isOpen && activeTab) && !coveredByPage;
  const hasOpenEditorFile = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file' && tab.targetPath),
    [tabs],
  );
  // The editor column is shown for an open file unless the user hid it; the
  // tree never hides alongside it, so a hidden tree forces the editor back.
  const showsEditor = hasOpenEditorFile && (contextEditorVisible || !contextEditorTreeVisible);
  const activeModeForWidth = activeTab?.mode ?? null;
  // A side zone without an editor shrinks to the tree; the bottom zone keeps
  // its full width either way.
  const isTreeOnly = !isVertical && activeModeForWidth === 'file' && !showsEditor;
  const isExpanded = Boolean(isOpen && zoneView.expanded && !isTreeOnly);
  // A fixed size in px: the one the user resized this surface to, else the
  // surface's default. It does not follow the chat area, so a sidebar toggle
  // or a window resize leaves it alone unless the chat would get too small.
  const manualSize = activeModeForWidth
    ? (isVertical ? panelState?.heightByMode?.[activeModeForWidth] : panelState?.widthByMode?.[activeModeForWidth])
    : undefined;
  const desiredSize = isTreeOnly
    ? contextEditorTreeWidth
    : isVertical
      ? clampHeight(manualSize ?? CONTEXT_PANEL_DEFAULT_HEIGHT, Number.POSITIVE_INFINITY)
      : clampWidth(manualSize ?? (activeModeForWidth ? getContextSurfaceDefaultWidth(activeModeForWidth) : CONTEXT_PANEL_DEFAULT_WIDTH), Number.POSITIVE_INFINITY);
  const clampSize = React.useCallback((next: number, available: number | null) => (
    isVertical ? clampHeight(next, maxPanelHeight(available)) : clampWidth(next, maxPanelWidth(available))
  ), [isVertical]);
  const chatMinimum = isVertical ? CONTEXT_CHAT_MIN_HEIGHT : CONTEXT_CHAT_MIN_WIDTH;

  // The area the zone shares with the chat, as state only while it decides
  // something: the zone is expanded over it, or the ceiling binds (the zone
  // would leave the chat less than its minimum). Otherwise it is null, so the
  // many size changes that cannot matter (every frame of a sidebar animation,
  // most window resizes) do not re-render the zone and everything in it.
  // Changes that arrive during a side-column animation are applied once it ends.
  const [areaSize, setAreaSize] = React.useState<number | null>(null);
  const measuredAreaSizeRef = React.useRef<number | null>(null);
  const areaDecidesRef = React.useRef<(areaSize: number) => boolean>(() => false);
  areaDecidesRef.current = (measured) => isExpanded || (!isTreeOnly && measured - chatMinimum < desiredSize);
  const applyAreaSize = React.useCallback(() => {
    const measured = measuredAreaSizeRef.current;
    setAreaSize(measured !== null && areaDecidesRef.current(measured) ? measured : null);
  }, []);
  const size = isTreeOnly ? desiredSize : clampSize(desiredSize, areaSize);
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
  const startPointerRef = React.useRef(0);
  const startSizeRef = React.useRef(size);
  const resizingSizeRef = React.useRef<number | null>(null);
  const activeResizePointerIDRef = React.useRef<number | null>(null);
  const panelRef = React.useRef<HTMLElement | null>(null);
  const wasOpenRef = React.useRef(false);

  React.useLayoutEffect(() => {
    const parent = panelRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      const measured = isVertical ? rect?.height : rect?.width;
      measuredAreaSizeRef.current = measured ? Math.round(measured) : null;
      runWhenLayoutSettled(applyAreaSize);
    });
    observer.observe(parent);
    measuredAreaSizeRef.current = (isVertical ? parent.clientHeight : parent.clientWidth) || null;
    applyAreaSize();

    return () => {
      observer.disconnect();
      cancelWhenLayoutSettled(applyAreaSize);
    };
  }, [applyAreaSize, isVertical]);

  // Expanding, or a surface wanting another size, may make the area matter.
  React.useLayoutEffect(() => {
    applyAreaSize();
  }, [applyAreaSize, desiredSize, isExpanded]);

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
  // so the zone follows the pointer lazily: the real size is re-applied at
  // most every RESIZE_FOLLOW_INTERVAL_MS and the size transition smooths each
  // step, VS Code-style.
  const resizeAvailableSizeRef = React.useRef<number | null>(null);
  const resizeFollowTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyFollowSize = React.useCallback(() => {
    resizeFollowTimerRef.current = null;
    const panel = panelRef.current;
    const next = resizingSizeRef.current;
    if (!panel || next === null) {
      return;
    }
    panel.style.setProperty(geometry.sizeVariable, `${next}px`);
  }, [geometry.sizeVariable]);

  React.useEffect(() => () => {
    if (resizeFollowTimerRef.current !== null) {
      clearTimeout(resizeFollowTimerRef.current);
    }
  }, []);

  const clampSizeForDrag = React.useCallback((nextSize: number) => {
    const available = resizeAvailableSizeRef.current;
    const clamped = isTreeOnly ? clampContextEditorTreeWidth(nextSize) : clampSize(nextSize, available);
    return available === null ? clamped : Math.min(clamped, Math.max(1, available));
  }, [clampSize, isTreeOnly]);

  const handleResizeStart = React.useCallback((event: React.PointerEvent) => {
    if (!isOpen || isExpanded || !directoryKey) {
      return;
    }

    activeResizePointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startPointerRef.current = isVertical ? event.clientY : event.clientX;
    startSizeRef.current = size;
    resizingSizeRef.current = size;
    // Measure once per drag; no layout reads happen during pointermove.
    const parent = panelRef.current?.parentElement;
    const available = isVertical ? parent?.clientHeight : parent?.clientWidth;
    resizeAvailableSizeRef.current = available && available > 0 ? available : null;
    document.documentElement.style.cursor = isVertical ? 'row-resize' : 'col-resize';
    event.preventDefault();
  }, [directoryKey, isExpanded, isOpen, isVertical, size]);

  const finishResize = React.useCallback(() => {
    // Apply the final size once, letting the size transition carry the zone
    // to the release position.
    const finalSize = clampSizeForDrag(resizingSizeRef.current ?? size);
    resizingSizeRef.current = null;
    resizeAvailableSizeRef.current = null;
    if (resizeFollowTimerRef.current !== null) {
      clearTimeout(resizeFollowTimerRef.current);
      resizeFollowTimerRef.current = null;
    }
    document.documentElement.style.cursor = '';
    if (isTreeOnly) {
      setContextEditorTreeWidth(finalSize);
    } else if (directoryKey && activeModeForWidth) {
      if (isVertical) setContextPanelHeight(directoryKey, activeModeForWidth, finalSize);
      else setContextPanelWidth(directoryKey, activeModeForWidth, finalSize);
    }
    setIsResizing(false);
    activeResizePointerIDRef.current = null;
  }, [activeModeForWidth, clampSizeForDrag, directoryKey, isTreeOnly, isVertical, setContextEditorTreeWidth, setContextPanelHeight, setContextPanelWidth, size]);

  // Window-level drag listeners: tracking the pointer via the thin handle and
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
      // The zone grows away from its window edge, toward the chat.
      const pointer = isVertical ? event.clientY : event.clientX;
      const delta = zone === 'left' ? pointer - startPointerRef.current : startPointerRef.current - pointer;
      const nextSize = clampSizeForDrag(startSizeRef.current + delta);
      if (resizingSizeRef.current === nextSize) {
        return;
      }
      resizingSizeRef.current = nextSize;
      if (resizeFollowTimerRef.current === null) {
        resizeFollowTimerRef.current = setTimeout(applyFollowSize, RESIZE_FOLLOW_INTERVAL_MS);
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
  }, [applyFollowSize, clampSizeForDrag, finishResize, isResizing, isVertical, zone]);

  React.useEffect(() => {
    if (!isResizing) {
      resizingSizeRef.current = null;
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
    toggleContextPanelExpanded(directoryKey, zone);
  }, [directoryKey, toggleContextPanelExpanded, zone]);

  const handlePanelKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    closeZoneOnEscape(event, isOpen, handleClose);
  }, [handleClose, isOpen]);

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
          {activeTab ? (
            <>
              <ContextMenuSeparator />
              {/* A tab moves its whole surface: placement is per surface. */}
              <ZoneMoveMenuItems mode={activeTab.mode} />
            </>
          ) : null}
        </>
      );
    },
    [activeTab, closeContextPanelTabs, directoryKey, t],
  );

  // A tab dragged out of the strip moves its whole surface to a zone.
  const handleTabDragOut = React.useCallback((tabId: string, isOutside: (point: { x: number; y: number }) => boolean) => {
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab) return null;
    const gesture = startZoneDragGesture({ mode: tab.mode, label: getModeLabel(tab.mode, tabT), from: zone }, isOutside);
    return { finish: () => gesture.finish(directoryKey), cancel: gesture.cancel };
  }, [directoryKey, tabT, tabs, zone]);

  // A zone is dragged by its header wherever nothing else takes the pointer:
  // buttons, tabs (a strip's own drag already moves its surface), fields.
  // A native listener, not a React one: a surface's toolbar is portalled into
  // the header, and React events from a portal never reach it.
  const [headerEl, setHeaderEl] = React.useState<HTMLElement | null>(null);
  const handleHeaderPointerDown = React.useCallback((event: PointerEvent) => {
    if (!activeTab || event.button !== 0 || event.pointerType === 'touch') return;
    if (event.target instanceof Element && event.target.closest(HEADER_DRAG_EXCLUDED)) return;
    const mode = activeTab.mode;
    const label = getModeLabel(mode, tabT);
    const start = { x: event.clientX, y: event.clientY };
    let dragging = false;
    const onMove = (moveEvent: PointerEvent) => {
      const point = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (!dragging) {
        if (Math.hypot(point.x - start.x, point.y - start.y) < HEADER_DRAG_DISTANCE_PX) return;
        dragging = beginZoneDrag({ mode, label, from: zone });
        if (!dragging) return;
      }
      updateZoneDrag(point);
    };
    const stop = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
    };
    const onUp = () => {
      stop();
      if (dragging) finishZoneDrag(directoryKey);
    };
    const onCancel = () => {
      stop();
      if (dragging) cancelZoneDrag();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
  }, [activeTab, directoryKey, tabT, zone]);
  React.useEffect(() => {
    if (!headerEl) return undefined;
    headerEl.addEventListener('pointerdown', handleHeaderPointerDown);
    return () => headerEl.removeEventListener('pointerdown', handleHeaderPointerDown);
  }, [handleHeaderPointerDown, headerEl]);

  const header = (
    <header
      ref={setHeaderEl}
      className="group/panel-header flex min-h-10 select-none items-stretch border-b border-border"
    >
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
          onTabDragOut={handleTabDragOut}
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
        <div ref={registerHeaderSlot} className="flex min-w-0 flex-1 items-stretch pl-1.5 empty:hidden" />
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

  // The right zone is the right slot: this aside holds the context panel and
  // the inline work-status card (rendered into the host below by
  // ChatContainer), and animates one width for both (rightSlot.ts). Closed,
  // it keeps the card's column when the card wants it and the chat is on
  // screen; open, it is the panel's width. Every value stays interpolable
  // across open/close (no instant min/max jumps).
  const workStatusColumn = zone === 'right' && workStatusReserved && !chatCovered;
  const expandedSize = areaSize !== null ? `${areaSize}px` : '100%';
  const slotSize = !isOpen
    ? (workStatusColumn ? `${WORK_STATUS_COLUMN_WIDTH}px` : '0px')
    : isExpanded
      // px, not '100%': px↔% size changes do not interpolate, which
      // would make the expand/collapse snap instead of animating.
      ? expandedSize
      : `min(var(${geometry.sizeVariable}), 100%)`;

  // The bottom card spans the chat column. Next to a card on either side it
  // gives up its own gutter on that side, so neighbours stand one gutter apart.
  const leftZoneShown = zone === 'bottom' && isZoneShown(panelState, placement, 'left');
  const rightSlotFilled = zone === 'bottom' && ((workStatusReserved && !chatCovered) || isZoneShown(panelState, placement, 'right'));

  // What the user changed, as opposed to the zone following the window: a
  // toggle, expanding, the card's column, another surface's or a dragged
  // size. Only these animate as an announced layout animation; the chat area
  // resizing (a window drag, a clamp) is tracked without one, so the work
  // that waits for an animation's end is not held back for the whole drag.
  const animationKey = `${isOpen}|${isExpanded}|${workStatusColumn}|${isOpen ? desiredSize : ''}`;
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

  // A closing zone's content fades out and only then leaves the
  // accessibility tree, in the same commit that takes the file editor's DOM
  // out (CodeMirrorEditor `detached`, driven by the same hook in
  // ContextSurfacePanes; both settle in one task). Hiding the editor from
  // accessibility while it is still in the document costs Chrome a 200 to
  // 300 ms frame whenever an accessibility client is on (a screen reader, or
  // any app that reads other windows, common on macOS); removing it costs a
  // few ms. After the layout effect above, which begins the animation.
  const contentHidden = !useOpenUntilSettled(isOpen);

  const panelStyle: React.CSSProperties = {
    [geometry.sizeVariable]: isOpen && isExpanded ? expandedSize : `${size}px`,
    ...(isVertical
      ? { height: slotSize, maxHeight: '100%' }
      : { width: slotSize, maxWidth: '100%' }),
    transitionDuration: coverChanged ? '0ms' : `${LAYOUT_ANIMATION_MS}ms`,
    transitionTimingFunction: LAYOUT_ANIMATION_EASING,
  };

  // Less the gutters the aside reserves for the card. px in the expanded
  // state too: px↔% size changes cannot interpolate, so the header controls
  // would snap instead of riding the animation.
  const cardSize = isExpanded
    ? (areaSize !== null ? `calc(${areaSize}px - ${geometry.gutterSize})` : '100%')
    : `calc(var(${geometry.sizeVariable}) - ${geometry.gutterSize})`;

  return (
    <aside
      ref={panelRef}
      data-context-panel="true"
      data-context-zone={zone}
      data-right-slot={zone === 'right' ? '' : undefined}
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
        // the resize handle sits in the one facing the chat.
        'box-border flex min-h-0 flex-col overflow-clip bg-background',
        // An empty closed zone takes no room at all: its gutters close with it.
        slotSize === '0px' ? 'p-0' : [
          geometry.gutter,
          zone === 'bottom' && (leftZoneShown ? 'pl-0' : 'pl-2'),
          zone === 'bottom' && (rightSlotFilled ? 'pr-0' : 'pr-1.5'),
        ],
        // Anchored to its window edge while expanded: `inset-0` would teleport
        // the far edge instantly (position does not transition), so only the
        // size animates and the zone grows toward the chat from where it docks.
        isExpanded
          ? geometry.expanded
          : isVertical ? 'relative w-full flex-shrink-0' : 'relative h-full flex-shrink-0',
        isVertical ? 'transition-[height,padding]' : 'transition-[width,padding]',
        'motion-reduce:transition-none',
      )}
      onKeyDownCapture={handlePanelKeyDownCapture}
      style={panelStyle}
    >
      {/* The inline work-status card's host, right-anchored under the panel:
          the card fades out while the panel fades in over it, and back. */}
      {zone === 'right' ? (
        <div ref={setWorkStatusHost} className={cn('absolute inset-y-0 right-0 z-0 flex', chatCovered && 'invisible')} />
      ) : null}
      {isOpen && !isExpanded && (
        // In the gutter facing the chat, along the card's edge. Nothing paints
        // on hover or drag: the cursor says it is draggable, and the card edge
        // itself moves on release.
        <div
          className={geometry.handle}
          onPointerDown={handleResizeStart}
          role="separator"
          aria-orientation={isVertical ? 'horizontal' : 'vertical'}
          aria-label={t('contextPanel.actions.resizePanelAria')}
        />
      )}
      <div
        data-zone-card=""
        className={cn(
          'relative z-10 flex min-h-0 shrink-0 flex-col motion-reduce:transition-none',
          isVertical ? 'w-full' : 'h-full',
          // A framed card, inset from the chat: its own border and radius rather
          // than a divider running the length of the window.
          // The dropdown's hairline ring (`oc-panel-edge`), shared with the
          // work-status card.
          'oc-panel-edge overflow-hidden rounded-[10px] bg-background',
          // Size animates in sync with the zone (surface switches, resize
          // release).
          isVertical ? 'transition-[height,opacity]' : 'transition-[width,opacity]',
          !isOpen && 'pointer-events-none select-none opacity-0'
        )}
        style={{
          ...(isVertical ? { height: cardSize } : { width: cardSize }),
          transitionDuration: `${LAYOUT_ANIMATION_MS}ms`,
          transitionTimingFunction: LAYOUT_ANIMATION_EASING,
        }}
        aria-hidden={contentHidden}
        inert={contentHidden || undefined}
      >
      {header}
      {/* Keep-alive surfaces (ContextSurfacePanes) are portalled in here. */}
      <div ref={registerBody} className={cn('relative min-h-0 flex-1 overflow-hidden', isResizing && 'pointer-events-none')}>
        {activeTab && isRemountedSurface(activeTab.mode) ? activeNonChatContent : null}
      </div>
      </div>
    </aside>
  );
};

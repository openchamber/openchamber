import React from 'react';
import { ReceivedPagesTab } from '@/components/chat/sharePages/received/ReceivedPagesTab';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatShortcutForDisplay } from '@/lib/shortcuts';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { DiffViewIcon } from '@/components/icons/DiffIcon';
import { Button } from '@/components/ui/button';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { PullRequestView } from '@/components/views/PullRequestView';
import { TrackerItemView } from '@/components/views/TrackerItemView';
import { trackerTargetOfUrl } from '@/components/sourceBoard/openTrackerItem';
import { type RepositoryUrlMatcher, useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { type TrackerUrlMatcher, useTrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';
import { trackerPresentation } from '@/lib/trackers/presentation';
import { isBrowserClientRuntime, isDesktopShell } from '@/lib/desktop';
import { getDisambiguatingFolders } from '@/lib/path-utils';
import { getRelativePathLabel } from './contextPanelPaths';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { toast } from '@/components/ui';

import { areTitleMapsEqual, buildSessionTitleMap, EMPTY_SESSION_TITLE_MAP, getSessionIDFromDedupeKey } from './contextPanelSessionTitles';
import { ProjectContextPanel } from './RightSidebarTabs';
import { WorkflowsPanel } from '@/components/chat/workflows/WorkflowsPanel';
import { SubagentsPanel } from '@/components/chat/subagents/SubagentsPanel';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRepositoryReferenceProvider } from '@/components/references/referenceSources';
import { useGuestSurfaces, useGuestTabsInScope } from '@/hooks/useGuestSurfaces';
import { cn, getRevealLabelKey } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useBrowserFaviconStore } from '@/stores/useBrowserFaviconStore';
import { useTrackedRecords } from '@/stores/useTrackedItemsStore';
import { repositoryStateLook } from '@/components/references/referencePickerItems';
import { repositoryThread, workItem } from '@/lib/trackedItems/fromLinks';
import { useTrackedItems } from '@/lib/trackedItems/interest';
import type { TrackedItem, TrackedItemState } from '@/lib/trackedItems/model';
import { trackerStateGlyph } from '@/lib/trackers/stateLook';
import { clampContextEditorTreeWidth, isTrackerBranchTab, useUIStore, type ContextPanelMode } from '@/stores/useUIStore';
import { useContextZoneCloseAction } from './useContextZoneCloseAction';
import { useGitStatus } from '@/stores/useGitStore';
import { useChildStoreManager } from '@/sync/sync-context';
import { useSessionTurnActivity } from '@/sync/global-session-status';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { ContextPanelContent } from './ContextSidebarTab';
import { browserUrlLabel } from '@/lib/browser/url';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { GuestIcon } from './GuestRailIcon';
import { useGuestsStore } from '@/lib/guests/store';
import { FALLBACK_GUEST_ICON } from '@/lib/guests/icon';
import { isPluginContextPanelMode, pluginIdFromMode } from '@/lib/surfaces/modes';
import { CONTEXT_SURFACES } from '@/lib/surfaces/registry';
import { beginLayoutAnimation, cancelWhenLayoutSettled, holdLayoutAnimation, LAYOUT_ANIMATION_EASING, runWhenLayoutSettled } from '@/lib/layoutAnimation';
import { useLayoutAnimationMs } from '@/hooks/useLayoutAnimationMs';
import { WORK_STATUS_COLUMN_WIDTH } from '@/components/chat/work-status/useWorkStatusVisibility';
import { setWorkStatusHost, useRightSlotStore } from './rightSlot';
import { sidebarPendingWidth } from './sidebarPendingWidth';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { useChangeRequestTerm } from '@/lib/source-control/providers/registry';
import { ContextPanelHeaderSlotProvider } from './contextPanelHeaderSlot';
import { CLOSED_ZONE_VIEW, CONTEXT_ZONE_DEFAULT_WIDTH, getZoneView, isZoneShown, resolveZoneActiveTab, sideZoneWidth, type ContextZone } from '@/lib/workspace/zones';
import { registerCloseTabTarget } from '@/lib/closeTabTarget';
import { useClosingZoneTab } from './useClosingZoneTab';
import { ZoneMoveMenuItems } from './ZoneMoveMenuItems';
import { beginZoneDrag, cancelZoneDrag, finishZoneDrag, startZoneDragGesture, updateZoneDrag } from './zoneDrag';
import { setZoneBody, setZoneHeaderSlot } from './zoneHosts';
import { useOpenUntilSettled, useOpenWhenSettled } from './useOpenUntilSettled';
import { isZoneExposed } from './zoneInteractiveContext';
import { DockedPanelSurfaceContext } from '@/hooks/usePageColors';
import { ContextZoneWindowButtons } from './ContextZoneWindowButtons';
import { REPOSITORY_KIND_ICONS } from '@/components/references/referencePickerItems';

const CONTEXT_PANEL_MIN_WIDTH = 320;
const CONTEXT_CHAT_MIN_WIDTH = 320;
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
    return CONTEXT_ZONE_DEFAULT_WIDTH;
  }

  return Math.min(maxWidth, Math.max(CONTEXT_PANEL_MIN_WIDTH, Math.round(width)));
};

const maxPanelWidth = (availableWidth: number | null): number => {
  if (availableWidth === null) return Number.POSITIVE_INFINITY;
  return Math.max(CONTEXT_PANEL_MIN_WIDTH, availableWidth - CONTEXT_CHAT_MIN_WIDTH);
};

const getModeLabel = (
  mode: ContextPanelMode,
  t: TranslateFn
): string => {
  if (isPluginContextPanelMode(mode)) {
    const guest = useGuestsStore.getState().guests.find((entry) => entry.id === pluginIdFromMode(mode));
    return guest?.name ?? t('contextRail.surface.plugin');
  }
  return t(CONTEXT_SURFACES.find((surface) => surface.mode === mode)?.labelKey ?? 'contextPanel.mode.context');
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

const ChatTabIcon: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const activity = useSessionTurnActivity(sessionId);
  return activity
    ? <SessionActivityIndicator state={activity} className="h-3.5 w-3.5" />
    : <Icon name="chat-4" className="h-3.5 w-3.5" />;
};

const NO_TRACKED: TrackedItem[] = [];

const trackedItemOfLink = (url: string, urls: RepositoryUrlMatcher, trackerUrls: TrackerUrlMatcher): TrackedItem | null => {
  const tracker = trackerUrls(url);
  if (tracker) return workItem(tracker.provider, tracker.identifier);
  const thread = urls.match(url);
  return thread ? repositoryThread(thread.kind, thread) : null;
};

const trackedStateLook = (record: TrackedItemState | null): { icon: IconName; color: string } | null => {
  switch (record?.type) {
    case 'pull':
      return record.state ? repositoryStateLook({ kind: 'pull', state: record.state.state, draft: record.state.draft }, record.state) : null;
    case 'issue':
      return record.state ? repositoryStateLook({ kind: 'issue', state: record.state.state }, null) : null;
    case 'discussion':
      return record.state ? repositoryStateLook({ kind: 'discussion', state: record.state.state, answered: record.state.answered }, null) : null;
    case 'work-item':
      return record.state ? trackerStateGlyph(record.state.state.category) : null;
    default:
      return null;
  }
};

const TrackerTabIcon: React.FC<{ url: string | null; active: boolean; visible: boolean }> = ({ url, active, visible }) => {
  const urls = useRepositoryUrlMatcher();
  const trackerUrls = useTrackerUrlMatcher();
  const tracked = React.useMemo(() => (url ? trackedItemOfLink(url, urls, trackerUrls) : null), [trackerUrls, url, urls]);
  const followed = React.useMemo(() => (tracked ? [tracked] : []), [tracked]);
  useTrackedItems(visible ? followed : NO_TRACKED);
  const look = trackedStateLook(useTrackedRecords(followed)[0] ?? null);
  const target = url ? trackerTargetOfUrl(url, urls, trackerUrls) : null;
  if (target && look) {
    return <Icon name={look.icon} className="h-3.5 w-3.5" style={active ? undefined : { color: look.color }} />;
  }
  const name: IconName = !target ? 'git-branch'
    : target.source === 'tracker' ? trackerPresentation(target.provider).icon
      : REPOSITORY_KIND_ICONS[target.kind];
  return <Icon name={name} className="h-3.5 w-3.5" />;
};

const getTabIcon = (
  tab: { mode: ContextPanelMode; targetPath: string | null; dedupeKey?: string },
  faviconByOrigin: Record<string, string> = {},
  active = true,
  visible = true,
): React.ReactNode | undefined => {
  if (tab.mode === 'file') {
    return tab.targetPath
      ? <FileTypeIcon filePath={tab.targetPath} className="h-3.5 w-3.5" />
      : undefined;
  }

  if (tab.mode === 'diff') {
    return <DiffViewIcon className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'pr') {
    return <TrackerTabIcon url={tab.targetPath} active={active} visible={visible} />;
  }

  if (tab.mode === 'notes') {
    return <Icon name="sticky-note" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'chat') {
    const sessionId = getSessionIDFromDedupeKey(tab.dedupeKey);
    return sessionId
      ? <ChatTabIcon sessionId={sessionId} />
      : <Icon name="chat-4" className="h-3.5 w-3.5" />;
  }

  if (isPluginContextPanelMode(tab.mode)) {
    return <ContextGuestIcon mode={tab.mode} />;
  }

  if (tab.mode === 'browser') {
    const icon = browserFaviconFor(tab.targetPath ?? '', faviconByOrigin);
    return icon
      ? <img src={icon} alt="" aria-hidden="true" className="h-3.5 w-3.5 rounded-[3px] object-contain" />
      : <Icon name="global" className="h-3.5 w-3.5" />;
  }

  const surface = CONTEXT_SURFACES.find((entry) => entry.mode === tab.mode);
  return surface ? <Icon name={surface.icon} className="h-3.5 w-3.5" /> : undefined;
};


const browserFaviconFor = (url: string, faviconByOrigin: Record<string, string>): string => {
  try {
    return faviconByOrigin[new URL(url).origin] ?? '';
  } catch {
    return '';
  }
};

const useSessionTitleMap = (sessionIDs: readonly string[]): ReadonlyMap<string, string> => {
  const childStores = useChildStoreManager();
  const snapshotRef = React.useRef<ReadonlyMap<string, string>>(EMPTY_SESSION_TITLE_MAP);
  const sessionIDsRef = React.useRef<readonly string[]>(sessionIDs);

  sessionIDsRef.current = sessionIDs;
  const wanted = sessionIDs.length > 0;

  return React.useSyncExternalStore(
    React.useCallback(
      (notify: () => void) => (wanted ? childStores.subscribeAllSelected((state) => state.session, notify) : () => undefined),
      [childStores, wanted],
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


const HEADER_DRAG_DISTANCE_PX = 8;
const HEADER_DRAG_EXCLUDED = 'button, a, input, textarea, select, label, [role="button"], [role="tab"], [role="combobox"], [role="switch"], [role="slider"], [data-sortable-tab-id], [contenteditable="true"]';

const isRemountedSurface = (mode: ContextPanelMode): boolean => (
  mode === 'context' || mode === 'pr' || mode === 'notes' || mode === 'workflows'
);

const CONTEXT_PANEL_DEFAULT_HEIGHT = 320;
const CONTEXT_PANEL_MIN_HEIGHT = 160;
const CONTEXT_CHAT_MIN_HEIGHT = 200;

const ZONE_GEOMETRY = {
  right: {
    axis: 'x',
    gutter: 'mb-2 ms-2 me-1.5',
    gutterSize: '0.875rem',
    handle: 'absolute bottom-2 inset-s-1 top-0 z-50 w-2 cursor-col-resize',
  },
  left: {
    axis: 'x',
    gutter: 'mb-2 ms-1.5 me-2',
    gutterSize: '0.875rem',
    handle: 'absolute bottom-2 inset-e-1 top-0 z-50 w-2 cursor-col-resize',
  },
  bottom: {
    axis: 'y',
    gutter: 'mb-2 mt-2',
    gutterSize: '1rem',
    handle: 'absolute inset-x-0 top-1 z-50 h-2 cursor-row-resize',
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

export const ContextPanel: React.FC<{ zone?: ContextZone; variant?: 'center' | 'side' }> = ({ zone = 'right', variant }) => {
  const geometry = ZONE_GEOMETRY[zone];
  const layoutAnimationMs = useLayoutAnimationMs();
  const isVertical = geometry.axis === 'y';
  const { t, direction } = useI18n();
  const { files, runtime } = useRuntimeAPIs();
  const isRtl = direction === 'rtl';
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const changeRequestTerm = useChangeRequestTerm(useRepositoryReferenceProvider(effectiveDirectory || null));
  const tabT = React.useCallback<TranslateFn>(
    (key, params) => t(changeRequestCopy(key, changeRequestTerm), params),
    [changeRequestTerm, t],
  );
  const directoryKey = React.useMemo(() => normalizeDirectoryKey(effectiveDirectory), [effectiveDirectory]);

  const panelState = useGuestTabsInScope(useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined)));
  const placement = useUIStore((state) => state.contextSurfaceZones);
  const closeContextPanelTab = useUIStore((state) => state.closeContextPanelTab);
  const pinContextPanelTab = useUIStore((state) => state.pinContextPanelTab);
  const toggleContextPanelExpanded = useUIStore((state) => state.toggleContextPanelExpanded);
  const setContextZoneSize = useUIStore((state) => state.setContextZoneSize);
  const setContextZoneExpandedChatSize = useUIStore((state) => state.setContextZoneExpandedChatSize);
  const setActiveContextPanelTab = useUIStore((state) => state.setActiveContextPanelTab);
  const reorderContextPanelTabs = useUIStore((state) => state.reorderContextPanelTabs);
  const contextEditorTreeVisible = useUIStore((state) => state.contextEditorTreeVisible);
  const contextEditorTreeWidth = useUIStore((state) => state.contextEditorTreeWidth);
  const setContextEditorTreeWidth = useUIStore((state) => state.setContextEditorTreeWidth);
  const toggleContextEditorTree = useUIStore((state) => state.toggleContextEditorTree);
  const contextEditorVisible = useUIStore((state) => state.contextEditorVisible);
  const toggleContextEditor = useUIStore((state) => state.toggleContextEditor);
  const fileTreeSide = useUIStore((state) => state.fileTreeSide);
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
  const storedActiveTab = panelState ? resolveZoneActiveTab(panelState, placement, zone) : null;
  const zoneView = panelState ? getZoneView(panelState, zone) : CLOSED_ZONE_VIEW;
  const workStatusReserved = useRightSlotStore((state) => state.workStatusReserved);
  const workStatusBesidePanel = useRightSlotStore((state) => state.workStatusBesidePanel);
  const chatCovered = useRightSlotStore((state) => state.chatCovered);
  const coveredByPage = zone === 'bottom' && chatCovered;
  const isOpen = Boolean(zoneView.isOpen && storedActiveTab) && !coveredByPage;
  const activeTab = useClosingZoneTab(storedActiveTab, isOpen);
  const hasOpenEditorFile = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file' && tab.targetPath),
    [tabs],
  );
  const showsEditor = hasOpenEditorFile && (contextEditorVisible || !contextEditorTreeVisible);
  const isTreeOnly = !isVertical && activeTab?.mode === 'file' && !showsEditor;
  const isExpanded = Boolean(isOpen && zoneView.expanded && !isTreeOnly && !variant);
  const manualSize = useUIStore((state) => state.contextZoneSizes[zone]);
  const desiredSize = isTreeOnly
    ? contextEditorTreeWidth
    : isVertical
      ? clampHeight(manualSize ?? CONTEXT_PANEL_DEFAULT_HEIGHT, Number.POSITIVE_INFINITY)
      : clampWidth(manualSize ?? CONTEXT_ZONE_DEFAULT_WIDTH, Number.POSITIVE_INFINITY);
  const clampSize = React.useCallback((next: number, available: number | null) => (
    isVertical ? clampHeight(next, maxPanelHeight(available)) : clampWidth(next, maxPanelWidth(available))
  ), [isVertical]);
  const chatMinimum = isVertical ? CONTEXT_CHAT_MIN_HEIGHT : CONTEXT_CHAT_MIN_WIDTH;
  const sidebarWidth = useUIStore((state) => (isVertical ? 0 : state.sidebarWidth));
  const expandedChatManual = useUIStore((state) => state.contextZoneExpandedChatSizes[zone]);
  const expandedChatSize = Math.max(
    chatMinimum,
    expandedChatManual ?? (isVertical ? CONTEXT_CHAT_MIN_HEIGHT : sidebarWidth),
  );

  const otherSide = zone === 'right' ? 'left' : zone === 'left' ? 'right' : null;
  const otherSideWidth = useUIStore((state) => {
    if (!otherSide || !directoryKey) return 0;
    const panel = state.contextPanelByDirectory[directoryKey];
    const tab = panel && isZoneShown(panel, state.contextSurfaceZones, otherSide)
      ? resolveZoneActiveTab(panel, state.contextSurfaceZones, otherSide)
      : null;
    return panel && tab ? sideZoneWidth(panel, tab, otherSide, state) : 0;
  });
  const otherSideReserved = otherSide === 'right' && workStatusReserved && !chatCovered && otherSideWidth === 0
    ? WORK_STATUS_COLUMN_WIDTH
    : otherSideWidth;
  const workStatusColumn = zone === 'right' && workStatusReserved && !chatCovered;
  const cardBesidePanel = workStatusColumn && workStatusBesidePanel && !isExpanded;
  const [measuredArea, setMeasuredArea] = React.useState<number | null>(null);
  const measuredAreaSizeRef = React.useRef<number | null>(null);
  const otherSideRef = React.useRef(otherSideReserved);
  otherSideRef.current = otherSideReserved;
  const isOpenRef = React.useRef(isOpen);
  isOpenRef.current = isOpen;
  const areaDecidesRef = React.useRef<(measured: number) => boolean>(() => false);
  areaDecidesRef.current = (measured) => isExpanded || (!isTreeOnly && measured - otherSideRef.current - chatMinimum < desiredSize);
  const applyAreaSize = React.useCallback(() => {
    let measured = measuredAreaSizeRef.current;
    if (measured !== null && !isVertical && isOpenRef.current) measured += sidebarPendingWidth();
    setMeasuredArea(measured !== null && areaDecidesRef.current(measured) ? measured : null);
  }, [isVertical]);
  const areaSize = measuredArea !== null ? measuredArea - otherSideReserved : null;
  const size = isTreeOnly
    ? desiredSize
    : isExpanded && areaSize !== null
      ? (isVertical ? Math.max(CONTEXT_PANEL_MIN_HEIGHT, areaSize - expandedChatSize) : Math.max(CONTEXT_PANEL_MIN_WIDTH, areaSize - expandedChatSize))
      : clampSize(desiredSize, areaSize);
  const showsChatTabs = isOpen && activeTab?.mode === 'chat';
  const chatSessionIDs = React.useMemo(() => {
    const ids: string[] = [];
    if (!showsChatTabs) return ids;
    for (const tab of tabs) {
      if (tab.mode !== 'chat') continue;
      const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
      if (sessionID && !ids.includes(sessionID)) ids.push(sessionID);
    }
    return ids;
  }, [showsChatTabs, tabs]);
  const sessionTitleById = useSessionTitleMap(chatSessionIDs);

  const [isResizing, setIsResizing] = React.useState(false);
  const startPointerRef = React.useRef(0);
  const startSizeRef = React.useRef(size);
  const resizingSizeRef = React.useRef<number | null>(null);
  const activeResizePointerIDRef = React.useRef<number | null>(null);
  const panelRef = React.useRef<HTMLElement | null>(null);
  const focusSinkRef = React.useRef<HTMLDivElement | null>(null);
  const wasOpenRef = React.useRef(false);

  React.useLayoutEffect(() => {
    const parent = isVertical
      ? panelRef.current?.parentElement
      : panelRef.current?.closest<HTMLElement>('[data-workspace-row]');
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

  const sidebarMovesZone = !isVertical && isOpen && (isExpanded || measuredArea !== null);
  const sidebarOpen = useUIStore((state) => sidebarMovesZone && state.isSidebarOpen);
  React.useLayoutEffect(() => {
    applyAreaSize();
  }, [applyAreaSize, desiredSize, isExpanded, isOpen, otherSideReserved, sidebarOpen]);

  React.useEffect(() => {
    if (!isOpen || wasOpenRef.current) {
      wasOpenRef.current = isOpen;
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      focusSinkRef.current?.focus({ preventScroll: true });
    });

    wasOpenRef.current = true;
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  const resizeAvailableSizeRef = React.useRef<number | null>(null);
  const resizeFrameRef = React.useRef<number | null>(null);
  const releaseResizeHoldRef = React.useRef<(() => void) | null>(null);
  const dragShieldRef = React.useRef<HTMLDivElement | null>(null);
  const sizeFromDragRef = React.useRef(false);

  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const besidePanelRef = React.useRef(false);
  const writeDragSize = React.useCallback((next: number) => {
    const panel = panelRef.current;
    const card = cardRef.current;
    if (!panel || !card) return;
    const property = isVertical ? 'height' : 'width';
    panel.style[property] = besidePanelRef.current ? `${next + WORK_STATUS_COLUMN_WIDTH}px` : `min(${next}px, 100%)`;
    card.style[property] = `calc(${next}px - ${geometry.gutterSize})`;
  }, [geometry.gutterSize, isVertical]);

  const applyResizeSize = React.useCallback(() => {
    resizeFrameRef.current = null;
    const next = resizingSizeRef.current;
    if (next !== null) writeDragSize(next);
  }, [writeDragSize]);

  React.useEffect(() => () => {
    if (resizeFrameRef.current !== null) {
      cancelAnimationFrame(resizeFrameRef.current);
    }
    releaseResizeHoldRef.current?.();
    releaseResizeHoldRef.current = null;
    dragShieldRef.current?.remove();
    dragShieldRef.current = null;
  }, []);

  const clampSizeForDrag = React.useCallback((nextSize: number) => {
    const available = resizeAvailableSizeRef.current;
    const clamped = isTreeOnly ? clampContextEditorTreeWidth(nextSize) : clampSize(nextSize, available);
    return available === null ? clamped : Math.min(clamped, Math.max(1, available));
  }, [clampSize, isTreeOnly]);

  const handleResizeStart = React.useCallback((event: React.PointerEvent) => {
    if (!isOpen || !directoryKey) {
      return;
    }

    activeResizePointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startPointerRef.current = isVertical ? event.clientY : event.clientX;
    startSizeRef.current = size;
    resizingSizeRef.current = size;
    const available = isVertical
      ? panelRef.current?.parentElement?.clientHeight
      : (panelRef.current?.closest<HTMLElement>('[data-workspace-row]')?.clientWidth ?? 0) - otherSideRef.current
        - (cardBesidePanel ? WORK_STATUS_COLUMN_WIDTH : 0);
    resizeAvailableSizeRef.current = available && available > 0 ? available : null;
    dragShieldRef.current?.remove();
    const shield = document.createElement('div');
    shield.style.cssText = `position:fixed;inset:0;z-index:2147483647;cursor:${isVertical ? 'row-resize' : 'col-resize'}`;
    document.body.appendChild(shield);
    dragShieldRef.current = shield;
    releaseResizeHoldRef.current?.();
    releaseResizeHoldRef.current = holdLayoutAnimation(isVertical ? 'height' : 'width');
    event.preventDefault();
  }, [cardBesidePanel, directoryKey, isOpen, isVertical, size]);

  const finishResize = React.useCallback(() => {
    const finalSize = clampSizeForDrag(resizingSizeRef.current ?? size);
    const available = resizeAvailableSizeRef.current;
    if (resizeFrameRef.current !== null) {
      cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
    const panel = panelRef.current;
    const card = cardRef.current;
    if (isOpenRef.current) {
      writeDragSize(finalSize);
    } else if (panel && card) {
      const property = isVertical ? 'height' : 'width';
      panel.style[property] = slotSizeRef.current;
      card.style[property] = cardSizeRef.current;
    }
    resizingSizeRef.current = null;
    resizeAvailableSizeRef.current = null;
    sizeFromDragRef.current = true;
    dragShieldRef.current?.remove();
    dragShieldRef.current = null;
    if (isTreeOnly) {
      setContextEditorTreeWidth(finalSize);
    } else if (isExpanded) {
      if (available !== null) setContextZoneExpandedChatSize(zone, available - finalSize);
    } else {
      setContextZoneSize(zone, finalSize);
    }
    setIsResizing(false);
    activeResizePointerIDRef.current = null;
    releaseResizeHoldRef.current?.();
    releaseResizeHoldRef.current = null;
  }, [clampSizeForDrag, isExpanded, isTreeOnly, isVertical, setContextEditorTreeWidth, setContextZoneExpandedChatSize, setContextZoneSize, size, writeDragSize, zone]);

  React.useEffect(() => {
    if (!isResizing) {
      return;
    }

    const handleMove = (event: PointerEvent) => {
      if (activeResizePointerIDRef.current !== event.pointerId) {
        return;
      }
      const pointer = isVertical ? event.clientY : event.clientX;
      const towardChat = zone === 'left' ? pointer - startPointerRef.current : startPointerRef.current - pointer;
      const delta = !isVertical && isRtl ? -towardChat : towardChat;
      const nextSize = clampSizeForDrag(startSizeRef.current + delta);
      if (resizingSizeRef.current === nextSize) {
        return;
      }
      resizingSizeRef.current = nextSize;
      if (resizeFrameRef.current === null) {
        resizeFrameRef.current = requestAnimationFrame(applyResizeSize);
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
  }, [applyResizeSize, clampSizeForDrag, finishResize, isResizing, isRtl, isVertical, zone]);

  React.useEffect(() => {
    if (!isResizing) {
      resizingSizeRef.current = null;
      dragShieldRef.current?.remove();
      dragShieldRef.current = null;
    }
  }, [isResizing]);

  const { label: closeButtonLabel, onClose: handleClose } = useContextZoneCloseAction(directoryKey, zone, panelState, placement, getModeLabel, tabT);

  const handleToggleExpanded = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    toggleContextPanelExpanded(directoryKey, zone);
  }, [directoryKey, toggleContextPanelExpanded, zone]);

  const isMultiInstanceMode = activeTab?.mode === 'file' || activeTab?.mode === 'chat' || activeTab?.mode === 'browser' || activeTab?.mode === 'pr' || activeTab?.mode === 'pages';
  const activeModeTabs = React.useMemo(() => {
    if (!activeTab) return [];
    const modeTabs = tabs.filter((tab) => tab.mode === activeTab.mode);
    return activeTab.mode === 'pr'
      ? [...modeTabs.filter(isTrackerBranchTab), ...modeTabs.filter((tab) => !isTrackerBranchTab(tab))]
      : modeTabs;
  }, [activeTab, tabs]);
  const trackerBranch = useGitStatus(activeTab?.mode === 'pr' && directoryKey ? directoryKey : null)?.current ?? null;

  const activeTabId = activeTab?.id;
  const tabItems = React.useMemo(() => {
    const fileFolders = getDisambiguatingFolders(activeModeTabs
      .filter((tab) => tab.mode === 'file')
      .map((tab) => getRelativePathLabel(tab.targetPath, effectiveDirectory)));
    return activeModeTabs.map((tab) => {
      const branchTab = isTrackerBranchTab(tab);
      const rawLabel = branchTab ? trackerBranch || t('contextPanel.tracker.branchTab') : getTabLabel(tab, sessionTitleById, tabT);
      const label = truncateTabLabel(rawLabel, CONTEXT_TAB_LABEL_MAX_CHARS);
      const tabPathLabel = getRelativePathLabel(tab.targetPath, effectiveDirectory);
      return {
        id: tab.id,
        label,
        labelFolder: tab.mode === 'file' ? fileFolders.get(tabPathLabel) : undefined,
        icon: getTabIcon(tab, faviconByOrigin, tab.id === activeTabId, isOpen),
        title: tabPathLabel ? `${rawLabel}: ${tabPathLabel}` : rawLabel,
        closeLabel: t('contextPanel.tab.closeTabAria', { label }),
        closeShortcut: tab.id === activeTabId && isDesktopShell() ? formatShortcutForDisplay('mod+w', '') : undefined,
        closable: !branchTab,
        preview: tab.preview,
      };
    });
  }, [activeModeTabs, activeTabId, effectiveDirectory, faviconByOrigin, isOpen, sessionTitleById, t, tabT, trackerBranch]);

  const activeNonChatContent = activeTab?.mode === 'context'
        ? <ContextPanelHeaderSlotProvider value={headerSlotEl}><ContextPanelContent /></ContextPanelHeaderSlotProvider>
        : activeTab?.mode === 'pr'
                ? (activeTab.targetPath
                    ? (
                      <TrackerItemView
                        key={activeTab.id}
                        url={activeTab.targetPath}
                        directory={activeTab.targetDirectory ?? effectiveDirectory}
                        panelDirectory={effectiveDirectory}
                        tabId={activeTab.id}
                        foreign={Boolean(activeTab.targetDirectory)}
                        visible={isOpen}
                      />
                    )
                    : <PullRequestView />)
            : activeTab?.mode === 'notes'
                ? <ContextPanelHeaderSlotProvider value={headerSlotEl}><ProjectContextPanel visible={isOpen} /></ContextPanelHeaderSlotProvider>
            : activeTab?.mode === 'workflows'
                ? <ContextPanelHeaderSlotProvider value={headerSlotEl}><WorkflowsPanel directory={effectiveDirectory || null} /></ContextPanelHeaderSlotProvider>
            : activeTab?.mode === 'pages' && !activeTab.targetPath
                ? <ReceivedPagesTab />
        : null;

  const isFileTabActive = activeTab?.mode === 'file';

  const editorClosesTab = isFileTabActive && Boolean(activeTab?.targetPath) && showsEditor;
  const shortcutClosableTabId = isOpen && activeTab && isMultiInstanceMode && !editorClosesTab && !isTrackerBranchTab(activeTab)
    ? activeTab.id
    : null;
  React.useEffect(() => {
    if (!directoryKey || !shortcutClosableTabId) return;
    return registerCloseTabTarget(() => closeContextPanelTab(directoryKey, shortcutClosableTabId), panelRef);
  }, [closeContextPanelTab, directoryKey, shortcutClosableTabId]);

  const closeContextPanelTabs = useUIStore((state) => state.closeContextPanelTabs);
  const renderTabContextMenu = React.useCallback(
    (args: { id: string; index: number; allIds: string[]; close: () => void }): React.ReactNode => {
      if (!directoryKey) {
        return null;
      }
      const { id, index, allIds, close } = args;
      const filePath = tabs.find((tab) => tab.id === id && tab.mode === 'file')?.targetPath;
      const copyPath = (value: string, relative: boolean) => {
        void copyTextToClipboard(value).then((result) => {
          if (result.ok) {
            toast.success(t(relative ? 'filesView.toast.relativePathCopied' : 'sidebarFilesTree.toast.pathCopied'));
          } else {
            toast.error(t('sidebarFilesTree.toast.copyFailed'));
          }
        });
      };
      const closeOthers = () => closeContextPanelTabs(directoryKey, allIds.filter((tabId) => tabId !== id));
      const before = allIds.slice(0, index);
      const after = allIds.slice(index + 1);
      const closeToLeft = () => closeContextPanelTabs(directoryKey, isRtl ? after : before);
      const closeToRight = () => closeContextPanelTabs(directoryKey, isRtl ? before : after);
      const closeAll = () => closeContextPanelTabs(directoryKey, allIds);
      const hasOthers = allIds.length > 1;
      const nothingToLeft = isRtl ? index === allIds.length - 1 : index === 0;
      const nothingToRight = isRtl ? index === 0 : index === allIds.length - 1;
      return (
        <>
          {filePath && (
            <>
              <ContextMenuItem onClick={() => copyPath(filePath, false)}>
                <Icon name="link" className="me-2 size-4" /> {t('sidebarFilesTree.menu.copyPath')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => copyPath(getRelativePathLabel(filePath, effectiveDirectory), true)}>
                <Icon name="file-copy-2" className="me-2 size-4" /> {t('filesView.tree.menu.copyRelativePath')}
              </ContextMenuItem>
              {files.revealPath && !isBrowserClientRuntime(runtime.platform) && (
                <ContextMenuItem onClick={() => {
                  void files.revealPath?.(filePath).catch(() => toast.error(t('sidebarFilesTree.toast.revealFailed')));
                }}>
                  <Icon name="folder-received" className="me-2 size-4" /> {t(getRevealLabelKey())}
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onClick={close}>
            <Icon name="close" className="me-2 size-4" />
            {t('contextPanel.tab.menu.close')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={closeOthers} disabled={!hasOthers}>
            <Icon name="expand-horizontal" className="me-2 size-4" />
            {t('contextPanel.tab.menu.closeOthers')}
          </ContextMenuItem>
          <ContextMenuItem onClick={closeToLeft} disabled={nothingToLeft}>
            <Icon name="expand-left" className="me-2 size-4" />
            {t('contextPanel.tab.menu.closeToLeft')}
          </ContextMenuItem>
          <ContextMenuItem onClick={closeToRight} disabled={nothingToRight}>
            <Icon name="expand-right" className="me-2 size-4" />
            {t('contextPanel.tab.menu.closeToRight')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={closeAll} disabled={!hasOthers}>
            <Icon name="close-circle" className="me-2 size-4" />
            {t('contextPanel.tab.menu.closeAll')}
          </ContextMenuItem>
          {activeTab ? (
            <>
              <ContextMenuSeparator />
              <ZoneMoveMenuItems mode={activeTab.mode} />
            </>
          ) : null}
        </>
      );
    },
    [activeTab, closeContextPanelTabs, directoryKey, effectiveDirectory, files, isRtl, runtime.platform, t, tabs],
  );

  const handleTabDragOut = React.useCallback((tabId: string, isOutside: (point: { x: number; y: number }) => boolean) => {
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab) return null;
    const gesture = startZoneDragGesture({ mode: tab.mode, label: getModeLabel(tab.mode, tabT), from: zone }, isOutside);
    return { finish: () => gesture.finish(directoryKey), cancel: gesture.cancel };
  }, [directoryKey, tabT, tabs, zone]);

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
          scrollWithWheel={isFileTabActive}
          variant="default"
          tabContextMenu={renderTabContextMenu}
          onTabDragOut={handleTabDragOut}
        />
      ) : (
        <>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-3 group-has-[[data-context-panel-toolbar]]/panel-header:hidden">
          {activeTab ? getTabIcon(activeTab, faviconByOrigin) : null}
          <span className="truncate typography-ui-label text-foreground">
            {activeTab ? getModeLabel(activeTab.mode, tabT) : null}
          </span>
        </div>
        <div ref={registerHeaderSlot} className="flex min-w-0 flex-1 items-stretch ps-1.5 empty:hidden" />
        </>
      )}
      <div className="flex h-10 shrink-0 items-center gap-1 self-start px-1.5">
        {activeTab?.mode === 'browser' ? (
          <Tooltip>
          <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (!directoryKey) return;
              openNewContextBrowserTab(directoryKey);
            }}
            className="h-7 w-7 p-0"
            aria-label={t('contextPanel.browser.newTab')}
          >
            <Icon name="add" className="h-3.5 w-3.5" />
          </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{t('contextPanel.browser.newTab')}</TooltipContent>
          </Tooltip>
        ) : null}
        {isFileTabActive ? (['left', 'right'] as const).map((side) => {
          const isTree = side === fileTreeSide;
          if (!isTree && !hasOpenEditorFile) return null;
          const label = isTree ? t('contextRail.editorTree.toggle') : t('contextRail.editor.toggle');
          const shown = isTree ? contextEditorTreeVisible : showsEditor;
          const tooltip = isTree
            ? t(shown ? 'contextTooltips.panel.hideFileTree' : 'contextTooltips.panel.showFileTree')
            : t(shown ? 'contextTooltips.panel.hideFileEditor' : 'contextTooltips.panel.showFileEditor');
          return (
            <Tooltip key={side}>
            <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={isTree ? toggleContextEditorTree : toggleContextEditor}
              className="h-7 w-7 p-0"
              aria-label={label}
              aria-pressed={shown}
            >
              <Icon name={side === 'left' ? 'layout-left' : 'layout-right'} className="h-3.5 w-3.5" />
            </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{tooltip}</TooltipContent>
            </Tooltip>
          );
        }) : null}
        <ContextZoneWindowButtons expandable={!isTreeOnly && !variant} expanded={isExpanded} onToggleExpanded={handleToggleExpanded} />
        <Tooltip>
        <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleClose}
          className="h-7 w-7 p-0"
          aria-label={closeButtonLabel}
        >
          <Icon name="close" className="h-3.5 w-3.5" />
        </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>{closeButtonLabel}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );

  const slotSize = !isOpen
    ? (workStatusColumn ? `${WORK_STATUS_COLUMN_WIDTH}px` : '0px')
    : cardBesidePanel
      ? `${size + WORK_STATUS_COLUMN_WIDTH}px`
      : `min(${size}px, 100%)`;
  const panelOffset = cardBesidePanel ? `${WORK_STATUS_COLUMN_WIDTH}px` : '0px';
  besidePanelRef.current = cardBesidePanel;

  const leftZoneShown = zone === 'bottom' && isZoneShown(panelState, placement, 'left');
  const rightSlotFilled = zone === 'bottom' && ((workStatusReserved && !chatCovered) || isZoneShown(panelState, placement, 'right'));

  const animationKey = `${isOpen}|${isExpanded}|${workStatusColumn}|${isOpen && cardBesidePanel}|${isOpen ? desiredSize : ''}`;
  const animationKeyRef = React.useRef(animationKey);
  const coveredRef = React.useRef(chatCovered);
  const coverChanged = coveredRef.current !== chatCovered;
  React.useLayoutEffect(() => {
    coveredRef.current = chatCovered;
  }, [chatCovered]);
  React.useLayoutEffect(() => {
    if (animationKeyRef.current === animationKey) return;
    animationKeyRef.current = animationKey;
    const draggedSize = sizeFromDragRef.current;
    if (!coverChanged && !draggedSize) beginLayoutAnimation(layoutAnimationMs);
  }, [animationKey, coverChanged, layoutAnimationMs]);
  React.useLayoutEffect(() => {
    sizeFromDragRef.current = false;
  });

  const contentHidden = !isZoneExposed(isOpen, useOpenWhenSettled(isOpen), activeTab?.mode);
  const contentShown = useOpenUntilSettled(isOpen);
  const panelStyle: React.CSSProperties = {
    ...(variant === 'center' ? null : isVertical
      ? { height: slotSize, maxHeight: '100%' }
      : { width: slotSize, maxWidth: '100%' }),
    transitionDuration: coverChanged || isResizing ? '0ms' : `${layoutAnimationMs}ms`,
    transitionTimingFunction: LAYOUT_ANIMATION_EASING,
  };

  const cardSize = `calc(${size}px - ${geometry.gutterSize})`;
  const slotSizeRef = React.useRef(slotSize);
  slotSizeRef.current = slotSize;
  const cardSizeRef = React.useRef(cardSize);
  cardSizeRef.current = cardSize;

  return (
    <aside
      ref={panelRef}
      data-context-panel="true"
      data-context-zone={zone}
      data-right-slot={zone === 'right' ? '' : undefined}
      data-context-panel-open={isOpen ? 'true' : 'false'}
      data-zone-size={size}
      data-zone-axis={variant === 'center' ? undefined : isVertical ? 'height' : 'width'}
      tabIndex={-1}
      className={cn(
        // external: https://developer.mozilla.org/en-US/docs/Web/CSS/overflow A hidden axis also makes clip on the other axis compute to hidden.
        'flex min-h-0 flex-col overflow-clip bg-background',
        'isolate',
        variant === 'center' ? 'relative min-h-0 w-full flex-1' : isVertical ? 'relative w-full flex-shrink-0' : 'relative h-full flex-shrink-0',
        variant === 'center' ? null : isVertical ? 'transition-[height]' : 'transition-[width]',
        'motion-reduce:transition-none',
      )}
      style={panelStyle}
    >
      <div ref={focusSinkRef} tabIndex={-1} className="absolute size-0 overflow-hidden outline-none" />
      {zone === 'right' ? (
        <div ref={setWorkStatusHost} className={cn('absolute inset-y-0 z-0 flex', cardBesidePanel ? 'inset-s-0' : 'inset-e-0', chatCovered && 'invisible')} />
      ) : null}
      {isOpen && variant !== 'center' && (
        <div
          className={geometry.handle}
          style={{ marginInlineStart: panelOffset }}
          onPointerDown={handleResizeStart}
          role="separator"
          aria-orientation={isVertical ? 'horizontal' : 'vertical'}
          aria-label={t('contextPanel.actions.resizePanelAria')}
        />
      )}
      <div
        ref={cardRef}
        data-zone-card=""
        className={cn(
          'relative z-10 flex min-h-0 shrink-0 flex-col motion-reduce:transition-none',
          variant === 'center' ? 'mb-2' : geometry.gutter,
          zone === 'bottom' && (leftZoneShown ? 'ms-0' : 'ms-2'),
          zone === 'bottom' && (rightSlotFilled ? 'me-0' : 'me-1.5'),
          isVertical ? null : 'h-[calc(100%-0.5rem)]',
          'oc-panel-edge overflow-hidden rounded-[10px] bg-background',
          isVertical ? 'transition-[height,opacity]' : 'transition-[width,opacity,margin-inline-start]',
          !isOpen && 'opacity-0',
          contentHidden && 'pointer-events-none select-none'
        )}
        style={{
          ...(isVertical
            ? { height: variant === 'center' ? 'calc(100% - 0.5rem)' : cardSize, width: `calc(100% - ${(leftZoneShown ? 0 : 0.5) + (rightSlotFilled ? 0 : 0.375)}rem)` }
            : { width: cardSize }),
          ...(zone === 'right' ? { marginInlineStart: `calc(0.5rem + ${panelOffset})` } : null),
          transitionDuration: isResizing ? '0ms' : `${layoutAnimationMs}ms`,
          transitionTimingFunction: LAYOUT_ANIMATION_EASING,
        }}
        inert={contentHidden || undefined}
      >
      <DockedPanelSurfaceContext.Provider value>
      {header}
      <div ref={registerBody} className="relative min-h-0 flex-1 overflow-hidden">
        {activeTab?.mode === 'subagents' ? (contentShown ? <SubagentsPanel directory={effectiveDirectory || null} /> : null)
          : activeTab && (isRemountedSurface(activeTab.mode) || (activeTab.mode === 'pages' && !activeTab.targetPath)) ? activeNonChatContent : null}
      </div>
      </DockedPanelSurfaceContext.Provider>
      </div>
    </aside>
  );
};

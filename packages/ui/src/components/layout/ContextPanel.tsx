import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { DiffViewIcon } from '@/components/icons/DiffIcon';
import { Button } from '@/components/ui/button';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { PullRequestView } from '@/components/views/PullRequestView';
import { TrackerItemView } from '@/components/views/TrackerItemView';
import { trackerTargetOfUrl } from '@/components/sourceBoard/openTrackerItem';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { useTrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';
import { trackerPresentation } from '@/lib/trackers/presentation';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { getDisambiguatingFolders } from '@/lib/path-utils';

// Heavy views stay on-demand (same as MainLayout): importing GitView or the
// plan statically pulls their stacks into the eager startup graph even when
// no such tab is open. The keep-alive surfaces load in ContextSurfacePanes.
const GitView = lazyWithChunkRecovery(() => import('@/components/views/GitView').then((m) => ({ default: m.GitView })));
import { areTitleMapsEqual, buildSessionTitleMap, EMPTY_SESSION_TITLE_MAP, getSessionIDFromDedupeKey } from './contextPanelSessionTitles';
import { ProjectContextPanel } from './RightSidebarTabs';
import { WorkflowsPanel } from '@/components/chat/workflows/WorkflowsPanel';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRepositoryReferenceProvider } from '@/components/references/referenceSources';
import { useGuestSurfaces } from '@/hooks/useGuestSurfaces';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useBrowserFaviconStore } from '@/stores/useBrowserFaviconStore';
import { clampContextEditorTreeWidth, isTrackerBranchTab, useUIStore, type ContextPanelMode } from '@/stores/useUIStore';
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
import { beginLayoutAnimation, cancelWhenLayoutSettled, LAYOUT_ANIMATION_EASING, runWhenLayoutSettled } from '@/lib/layoutAnimation';
import { useLayoutAnimationMs } from '@/hooks/useLayoutAnimationMs';
import { WORK_STATUS_COLUMN_WIDTH } from '@/components/chat/work-status/useWorkStatusVisibility';
import { setWorkStatusHost, useRightSlotStore } from './rightSlot';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { useChangeRequestTerm } from '@/lib/source-control/providers/registry';
import { ContextPanelHeaderSlotProvider } from './contextPanelHeaderSlot';
import { CLOSED_ZONE_VIEW, CONTEXT_ZONE_DEFAULT_WIDTH, getZoneView, isZoneShown, resolveZoneActiveTab, sideZoneWidth, type ContextZone } from '@/lib/workspace/zones';
import { closeZoneOnEscape } from './zoneEscape';
import { ZoneMoveMenuItems } from './ZoneMoveMenuItems';
import { beginZoneDrag, cancelZoneDrag, finishZoneDrag, startZoneDragGesture, updateZoneDrag } from './zoneDrag';
import { setZoneBody, setZoneHeaderSlot } from './zoneHosts';
import { useOpenWhenSettled } from './useOpenUntilSettled';
import { isZoneExposed } from './zoneInteractiveContext';
import { DockedPanelSurfaceContext } from '@/hooks/usePageColors';
import { REPOSITORY_KIND_ICONS } from '@/components/references/referencePickerItems';

const CONTEXT_PANEL_MIN_WIDTH = 320;
// The panel has no absolute pixel ceiling: on large monitors the user may
// want it nearly full-width (side-by-side diffs with the chat open). The
// only limit during a drag is leaving the chat column this much width.
const CONTEXT_CHAT_MIN_WIDTH = 320;
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
    return CONTEXT_ZONE_DEFAULT_WIDTH;
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
  if (mode === 'browser') return t('contextPanel.mode.browser');
  if (mode === 'git') return t('layout.rightSidebar.git');
  if (mode === 'pr') return t('contextPanel.mode.pr');
  if (mode === 'notes') return t('contextRail.surface.notes');
  if (mode === 'terminal') return t('layout.mainTab.terminal');
  if (mode === 'workflows') return t('contextPanel.mode.workflows');
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

// A chat tab shows its session's live activity in place of the chat icon, so a
// strip of many subagent chats tells the running ones from the idle ones.
const ChatTabIcon: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const activity = useSessionTurnActivity(sessionId);
  return activity
    ? <SessionActivityIndicator state={activity} className="h-3.5 w-3.5" />
    : <Icon name="chat-4" className="h-3.5 w-3.5" />;
};

// The branch's own tab, then what each item is.
const TrackerTabIcon: React.FC<{ url: string | null }> = ({ url }) => {
  const urls = useRepositoryUrlMatcher();
  const trackerUrls = useTrackerUrlMatcher();
  const target = url ? trackerTargetOfUrl(url, urls, trackerUrls) : null;
  const name: IconName = !target ? 'git-branch'
    : target.source === 'tracker' ? trackerPresentation(target.provider).icon
      : REPOSITORY_KIND_ICONS[target.kind];
  return <Icon name={name} className="h-3.5 w-3.5" />;
};

const getTabIcon = (
  tab: { mode: ContextPanelMode; targetPath: string | null; dedupeKey?: string },
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
    return <TrackerTabIcon url={tab.targetPath} />;
  }

  if (tab.mode === 'notes') {
    return <Icon name="sticky-note" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'terminal') {
    return <Icon name="terminal-box" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'context') {
    return <Icon name="donut-chart-fill" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'workflows') {
    return <Icon name="flow-chart" className="h-3.5 w-3.5" />;
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
  // No titles wanted, no subscription: every session update would wake it.
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


// Dragging a header moves its surface once the pointer has travelled this far.
const HEADER_DRAG_DISTANCE_PX = 8;
const HEADER_DRAG_EXCLUDED = 'button, a, input, textarea, select, label, [role="button"], [role="tab"], [role="combobox"], [role="switch"], [role="slider"], [data-sortable-tab-id], [contenteditable="true"]';

// Surfaces rendered by the zone itself and remounted on every switch; the
// rest stay alive in ContextSurfacePanes.
const isRemountedSurface = (mode: ContextPanelMode): boolean => (
  mode === 'context' || mode === 'git' || mode === 'pr' || mode === 'notes' || mode === 'workflows'
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
    gutter: 'mb-2 ms-2 me-1.5',
    gutterSize: '0.875rem',
    handle: 'absolute bottom-2 inset-s-1 top-0 z-50 w-2 cursor-col-resize',
    sizeVariable: '--oc-context-panel-width',
  },
  left: {
    axis: 'x',
    gutter: 'mb-2 ms-1.5 me-2',
    gutterSize: '0.875rem',
    handle: 'absolute bottom-2 inset-e-1 top-0 z-50 w-2 cursor-col-resize',
    sizeVariable: '--oc-context-panel-width',
  },
  bottom: {
    axis: 'y',
    gutter: 'mb-2 mt-2',
    gutterSize: '1rem',
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
  const layoutAnimationMs = useLayoutAnimationMs();
  const isVertical = geometry.axis === 'y';
  const { t, direction } = useI18n();
  const isRtl = direction === 'rtl';
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const changeRequestTerm = useChangeRequestTerm(useRepositoryReferenceProvider(effectiveDirectory || null));
  // Tab names in this repository's words: a GitLab project's change request tab is a merge request.
  const tabT = React.useCallback<TranslateFn>(
    (key, params) => t(changeRequestCopy(key, changeRequestTerm), params),
    [changeRequestTerm, t],
  );
  const directoryKey = React.useMemo(() => normalizeDirectoryKey(effectiveDirectory), [effectiveDirectory]);

  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const placement = useUIStore((state) => state.contextSurfaceZones);
  const closeContextZone = useUIStore((state) => state.closeContextZone);
  const closeContextPanelTab = useUIStore((state) => state.closeContextPanelTab);
  const pinContextPanelTab = useUIStore((state) => state.pinContextPanelTab);
  const toggleContextPanelExpanded = useUIStore((state) => state.toggleContextPanelExpanded);
  const setContextZoneSize = useUIStore((state) => state.setContextZoneSize);
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
  // This zone's tab: one of its own surfaces, never one placed elsewhere.
  const activeTab = panelState ? resolveZoneActiveTab(panelState, placement, zone) : null;
  const zoneView = panelState ? getZoneView(panelState, zone) : CLOSED_ZONE_VIEW;
  const workStatusReserved = useRightSlotStore((state) => state.workStatusReserved);
  const workStatusBesidePanel = useRightSlotStore((state) => state.workStatusBesidePanel);
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
  // A side zone without an editor shrinks to the tree; the bottom zone keeps
  // its full width either way.
  const isTreeOnly = !isVertical && activeTab?.mode === 'file' && !showsEditor;
  const isExpanded = Boolean(isOpen && zoneView.expanded && !isTreeOnly);
  // A fixed size in px: the one the user resized this zone to, else the
  // default, whatever surface or folder it shows, so switching either leaves
  // its edge in place. It does not follow the chat area, so a sidebar toggle or a
  // window resize leaves it alone unless the chat would get too small.
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
  // Expanded, the zone takes everything but a chat column about as wide as
  // the session sidebar it folds away (ZoneFitArbiter), never under the
  // minimum, so the chat stays on screen beside it.
  const sidebarWidth = useUIStore((state) => (isVertical ? 0 : state.sidebarWidth));
  const expandedChatSize = isVertical ? CONTEXT_CHAT_MIN_HEIGHT : Math.max(CONTEXT_CHAT_MIN_WIDTH, sidebarWidth);

  // The area the zone shares with the chat, as state only while it decides
  // something: the zone is expanded across it, or the ceiling binds (the zone
  // would leave the chat less than its minimum). Otherwise it is null, so the
  // many size changes that cannot matter (every frame of a sidebar animation,
  // most window resizes) do not re-render the zone and everything in it.
  // Changes that arrive during a side-column animation are applied once it ends.
  //
  // A side zone measures the whole workspace row, which no zone animation
  // moves, and takes off what the other side will hold by the store, not by
  // the DOM. A surface moved from one side to the other opens at its own
  // width at once: measuring the chat area instead, it saw the side it left
  // still in place, opened clamped, and widened again after that side closed.
  const otherSide = zone === 'right' ? 'left' : zone === 'left' ? 'right' : null;
  const otherSideWidth = useUIStore((state) => {
    if (!otherSide || !directoryKey) return 0;
    const panel = state.contextPanelByDirectory[directoryKey];
    const tab = panel && isZoneShown(panel, state.contextSurfaceZones, otherSide)
      ? resolveZoneActiveTab(panel, state.contextSurfaceZones, otherSide)
      : null;
    return panel && tab ? sideZoneWidth(panel, tab, otherSide, state) : 0;
  });
  // The closed right zone still holds the work-status card's column. Beside
  // the open panel the card claims no room from this zone: it yields first,
  // as the chat area narrows, and only stays while the chat keeps more than
  // its minimum, so this zone is never clamped while the card is there.
  const otherSideReserved = otherSide === 'right' && workStatusReserved && !chatCovered && otherSideWidth === 0
    ? WORK_STATUS_COLUMN_WIDTH
    : otherSideWidth;
  // The same column in this zone, when it is the right one.
  const workStatusColumn = zone === 'right' && workStatusReserved && !chatCovered;
  // Beside the panel the card holds the slot's start and the panel its end.
  // Decided while closed too: the panel then already sits past the card's
  // column, so opening slides it in from the edge beside the card, and the
  // card rides along with the chat's edge rather than fading out.
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
    // The session sidebar beside the row may have just been told to fold or
    // unfold (expanding folds it) and still be at its old width: the row is
    // taken as it will be once the sidebar arrives at the width it was set
    // to, so the zone moves once, together with the sidebar, instead of again
    // after it. Settled, the two widths are equal and this adds nothing. A
    // closed zone shows nothing that could move, so it forces no layout read.
    if (measured !== null && !isVertical && isOpenRef.current) {
      const sidebar = document.querySelector<HTMLElement>('[data-left-sidebar]');
      if (sidebar) measured += Math.round(sidebar.getBoundingClientRect().width - (Number.parseFloat(sidebar.style.width) || 0));
    }
    setMeasuredArea(measured !== null && areaDecidesRef.current(measured) ? measured : null);
  }, [isVertical]);
  // What the zone shares with the chat: the row less the other side.
  const areaSize = measuredArea !== null ? measuredArea - otherSideReserved : null;
  const size = isTreeOnly
    ? desiredSize
    : isExpanded && areaSize !== null
      ? (isVertical ? Math.max(CONTEXT_PANEL_MIN_HEIGHT, areaSize - expandedChatSize) : Math.max(CONTEXT_PANEL_MIN_WIDTH, areaSize - expandedChatSize))
      : clampSize(desiredSize, areaSize);
  // Titles are for this zone's chat tab strip only; a zone that is closed or
  // shows another surface subscribes to none.
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

  // Opening, expanding, a surface wanting another size, the other side
  // opening or closing, or the session sidebar folding or unfolding beside
  // the row may make the area matter. Applied in this commit, not after the animation:
  // these change what the zone animates to.
  // Only while the area decides the size: otherwise a sidebar toggle neither
  // re-renders the zone nor reads layout, and the row's observer covers it.
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

    // Focus lands on an empty element of the zone, not on the zone itself:
    // stylesheet rules of the form `:focus-visible *` (Tailwind's group
    // variants) restyle the whole subtree of the element whose focus changes,
    // and on the zone that cost 40 ms in the animation's first frame with a
    // large file tree open.
    const frame = window.requestAnimationFrame(() => {
      focusSinkRef.current?.focus({ preventScroll: true });
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
    // The same area the ceiling uses: the row less the other side, and less
    // the work-status card beside this panel. The drag stops where the chat
    // would drop under its minimum next to the card; the card yields to a
    // panel released wider than it fits beside.
    const available = isVertical
      ? panelRef.current?.parentElement?.clientHeight
      : (panelRef.current?.closest<HTMLElement>('[data-workspace-row]')?.clientWidth ?? 0) - otherSideRef.current
        - (cardBesidePanel ? WORK_STATUS_COLUMN_WIDTH : 0);
    resizeAvailableSizeRef.current = available && available > 0 ? available : null;
    document.documentElement.style.cursor = isVertical ? 'row-resize' : 'col-resize';
    event.preventDefault();
  }, [cardBesidePanel, directoryKey, isExpanded, isOpen, isVertical, size]);

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
    } else {
      setContextZoneSize(zone, finalSize);
    }
    setIsResizing(false);
    activeResizePointerIDRef.current = null;
  }, [clampSizeForDrag, isTreeOnly, setContextEditorTreeWidth, setContextZoneSize, size, zone]);

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
      // A side zone's handle faces the chat, so in RTL, where the zones swap
      // sides, the same drag direction means the opposite width change.
      const towardChat = zone === 'left' ? pointer - startPointerRef.current : startPointerRef.current - pointer;
      const delta = !isVertical && isRtl ? -towardChat : towardChat;
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
  }, [applyFollowSize, clampSizeForDrag, finishResize, isResizing, isRtl, isVertical, zone]);

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
  const isMultiInstanceMode = activeTab?.mode === 'file' || activeTab?.mode === 'chat' || activeTab?.mode === 'browser' || activeTab?.mode === 'pr';
  const activeModeTabs = React.useMemo(() => {
    if (!activeTab) return [];
    const modeTabs = tabs.filter((tab) => tab.mode === activeTab.mode);
    // The Tracker's branch tab always comes first.
    return activeTab.mode === 'pr'
      ? [...modeTabs.filter(isTrackerBranchTab), ...modeTabs.filter((tab) => !isTrackerBranchTab(tab))]
      : modeTabs;
  }, [activeTab, tabs]);
  // The branch tab is named after the branch checked out here.
  const trackerBranch = useGitStatus(activeTab?.mode === 'pr' && directoryKey ? directoryKey : null)?.current ?? null;

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
        icon: getTabIcon(tab, faviconByOrigin),
        title: tabPathLabel ? `${rawLabel}: ${tabPathLabel}` : rawLabel,
        closeLabel: t('contextPanel.tab.closeTabAria', { label }),
        closable: !branchTab,
        preview: tab.preview,
      };
    });
  }, [activeModeTabs, effectiveDirectory, faviconByOrigin, sessionTitleById, t, tabT, trackerBranch]);

  const activeNonChatContent = activeTab?.mode === 'context'
        ? <ContextPanelHeaderSlotProvider value={headerSlotEl}><ContextPanelContent /></ContextPanelHeaderSlotProvider>
        : activeTab?.mode === 'git'
            ? <React.Suspense fallback={null}><ContextPanelHeaderSlotProvider value={headerSlotEl}><GitView isActive={isOpen} /></ContextPanelHeaderSlotProvider></React.Suspense>
            : activeTab?.mode === 'pr'
                ? (activeTab.targetPath
                    ? (
                      <TrackerItemView
                        key={activeTab.id}
                        url={activeTab.targetPath}
                        // The folder as the views behind Changes and the walkthrough key it.
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
      // "Left" and "right" name the screen sides; in RTL the earlier tabs are on the right.
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
              {/* A tab moves its whole surface: placement is per surface. */}
              <ZoneMoveMenuItems mode={activeTab.mode} />
            </>
          ) : null}
        </>
      );
    },
    [activeTab, closeContextPanelTabs, directoryKey, isRtl, t],
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
          {activeTab ? getTabIcon(activeTab, faviconByOrigin) : null}
          <span className="truncate typography-ui-label text-foreground">
            {activeTab ? getModeLabel(activeTab.mode, tabT) : null}
          </span>
        </div>
        {/* The active surface's own toolbar lands here (contextPanelHeaderSlot). */}
        <div ref={registerHeaderSlot} className="flex min-w-0 flex-1 items-stretch ps-1.5 empty:hidden" />
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
        {/* Each icon toggles the column on its side: the editor and the tree
            swap sides with the file tree side setting, the icons stay put. */}
        {isFileTabActive ? (['left', 'right'] as const).map((side) => {
          const isTree = side === fileTreeSide;
          if (!isTree && !hasOpenEditorFile) return null;
          const label = isTree ? t('contextRail.editorTree.toggle') : t('contextRail.editor.toggle');
          return (
            <Button
              key={side}
              type="button"
              variant="ghost"
              size="sm"
              onClick={isTree ? toggleContextEditorTree : toggleContextEditor}
              className="h-7 w-7 p-0"
              title={label}
              aria-label={label}
              aria-pressed={isTree ? contextEditorTreeVisible : showsEditor}
            >
              <Icon name={side === 'left' ? 'layout-left' : 'layout-right'} className="h-3.5 w-3.5" />
            </Button>
          );
        }) : null}
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
  // screen; open, it is the panel's width, plus the card's column when the
  // card stays beside the panel. Every value stays interpolable across
  // open/close (no instant min/max jumps).
  const slotSize = !isOpen
    ? (workStatusColumn ? `${WORK_STATUS_COLUMN_WIDTH}px` : '0px')
    : cardBesidePanel
      ? `calc(var(${geometry.sizeVariable}) + ${WORK_STATUS_COLUMN_WIDTH}px)`
      : `min(var(${geometry.sizeVariable}), 100%)`;
  const panelOffset = cardBesidePanel ? `${WORK_STATUS_COLUMN_WIDTH}px` : '0px';

  // The bottom card spans the chat column. Next to a card on either side it
  // gives up its own gutter on that side, so neighbours stand one gutter apart.
  const leftZoneShown = zone === 'bottom' && isZoneShown(panelState, placement, 'left');
  const rightSlotFilled = zone === 'bottom' && ((workStatusReserved && !chatCovered) || isZoneShown(panelState, placement, 'right'));

  // What the user changed, as opposed to the zone following the window: a
  // toggle, expanding, the card's column, another surface's or a dragged
  // size. Only these animate as an announced layout animation; the chat area
  // resizing (a window drag, a clamp) is tracked without one, so the work
  // that waits for an animation's end is not held back for the whole drag.
  const animationKey = `${isOpen}|${isExpanded}|${workStatusColumn}|${isOpen && cardBesidePanel}|${isOpen ? desiredSize : ''}`;
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
    if (!coverChanged) beginLayoutAnimation(layoutAnimationMs);
  }, [animationKey, coverChanged, layoutAnimationMs]);

  // The zone's content becomes inert and unclickable only once the animation
  // has settled, and for most surfaces stops being so only then too
  // (`isZoneExposed` says which and why); just its opacity follows a toggle
  // at once. `inert`, `pointer-events` and `user-select` are inherited, so
  // flipping them restyles the whole surface, and with an accessibility
  // client on adds it to the tree. Surfaces that focus themselves wait for it
  // (`useZoneInteractive`). A closing zone leaves the accessibility tree in
  // the same commit that takes the file editor's DOM out (CodeMirrorEditor `detached`,
  // driven by `useOpenUntilSettled` in ContextSurfacePanes; both settle in one
  // task). Hiding the editor from accessibility while it is still in the
  // document costs Chrome a 200 to 300 ms frame whenever an accessibility
  // client is on (a screen reader, or any app that reads other windows,
  // common on macOS); removing it costs a few ms. After the layout effect
  // above, which begins the animation.
  const contentHidden = !isZoneExposed(isOpen, useOpenWhenSettled(isOpen), activeTab?.mode);
  const panelStyle: React.CSSProperties = {
    [geometry.sizeVariable]: `${size}px`,
    ...(isVertical
      ? { height: slotSize, maxHeight: '100%' }
      : { width: slotSize, maxWidth: '100%' }),
    transitionDuration: coverChanged ? '0ms' : `${layoutAnimationMs}ms`,
    transitionTimingFunction: LAYOUT_ANIMATION_EASING,
  };

  // Less the gutters the aside reserves for the card.
  const cardSize = `calc(var(${geometry.sizeVariable}) - ${geometry.gutterSize})`;

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
        // No padding: the card's own margins are the gutter (see the card),
        // so a closed zone at zero size clips them away with the card and only
        // the size ever animates.
        'flex min-h-0 flex-col overflow-clip bg-background',
        // Its own stacking context: the resize handle's z-50 orders it above
        // the card only, and the session sidebar shown over the chat on hover
        // (z-25) covers the zone handle and all.
        'isolate',
        // Expanded too: the zone stays in the layout at its largest size, so
        // the chat keeps a column beside it rather than being covered.
        isVertical ? 'relative w-full flex-shrink-0' : 'relative h-full flex-shrink-0',
        isVertical ? 'transition-[height]' : 'transition-[width]',
        'motion-reduce:transition-none',
      )}
      onKeyDownCapture={handlePanelKeyDownCapture}
      style={panelStyle}
    >
      {/* Where focus goes as the zone opens (see the open effect). Outside
          the card, which is still inert then. */}
      <div ref={focusSinkRef} tabIndex={-1} className="absolute size-0 overflow-hidden outline-none" />
      {/* The inline work-status card's host, right-anchored under the panel:
          the card fades out while the panel fades in over it, and back.
          Beside the panel it sits at the slot's start instead, ahead of the
          panel. Closed, the slot is the card's column, so both anchors put the
          card in the same place and switching between them moves nothing. */}
      {zone === 'right' ? (
        <div ref={setWorkStatusHost} className={cn('absolute inset-y-0 z-0 flex', cardBesidePanel ? 'inset-s-0' : 'inset-e-0', chatCovered && 'invisible')} />
      ) : null}
      {isOpen && !isExpanded && (
        // In the gutter facing the chat, along the card's edge. Nothing paints
        // on hover or drag: the cursor says it is draggable, and the card edge
        // itself moves on release.
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
        data-zone-card=""
        className={cn(
          'relative z-10 flex min-h-0 shrink-0 flex-col motion-reduce:transition-none',
          // The gutter sets the card apart from the chat and leaves its shadow
          // room on every side the aside clips; the resize handle sits in the
          // one facing the chat.
          geometry.gutter,
          zone === 'bottom' && (leftZoneShown ? 'ms-0' : 'ms-2'),
          zone === 'bottom' && (rightSlotFilled ? 'me-0' : 'me-1.5'),
          isVertical ? null : 'h-[calc(100%-0.5rem)]',
          // A framed card, inset from the chat: its own border and radius rather
          // than a divider running the length of the window.
          // The dropdown's hairline ring (`oc-panel-edge`), shared with the
          // work-status card.
          'oc-panel-edge overflow-hidden rounded-[10px] bg-background',
          // Size animates in sync with the zone (surface switches, resize
          // release).
          // The offset past the card's column moves with the slot's width, so
          // the panel's edge stays put when the card comes or goes beside it.
          isVertical ? 'transition-[height,opacity]' : 'transition-[width,opacity,margin-inline-start]',
          !isOpen && 'opacity-0',
          contentHidden && 'pointer-events-none select-none'
        )}
        style={{
          ...(isVertical
            ? { height: cardSize, width: `calc(100% - ${(leftZoneShown ? 0 : 0.5) + (rightSlotFilled ? 0 : 0.375)}rem)` }
            : { width: cardSize }),
          // Past the card's column beside it, in addition to the gutter's ms-2.
          ...(zone === 'right' ? { marginInlineStart: `calc(0.5rem + ${panelOffset})` } : null),
          transitionDuration: `${layoutAnimationMs}ms`,
          transitionTimingFunction: LAYOUT_ANIMATION_EASING,
        }}
        // inert alone: it already takes the subtree out of the accessibility
        // tree, and aria-hidden on top cost a second pass when it flipped.
        inert={contentHidden || undefined}
      >
      <DockedPanelSurfaceContext.Provider value>
      {header}
      {/* Keep-alive surfaces (ContextSurfacePanes) are portalled in here and
          take the docked surface from their own pane (ZonePane). */}
      <div ref={registerBody} className={cn('relative min-h-0 flex-1 overflow-hidden', isResizing && 'pointer-events-none')}>
        {activeTab && isRemountedSurface(activeTab.mode) ? activeNonChatContent : null}
      </div>
      </DockedPanelSurfaceContext.Provider>
      </div>
    </aside>
  );
};

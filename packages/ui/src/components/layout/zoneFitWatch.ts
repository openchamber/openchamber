import { planZoneFit } from '@/lib/workspace/zoneFit';
import { canZoneExpand, CONTEXT_ZONE_DEFAULT_WIDTH, CONTEXT_ZONES, getZoneView, isZoneShown, resolveZoneActiveTab } from '@/lib/workspace/zones';
import { useUIStore } from '@/stores/useUIStore';

type Side = 'left' | 'right';
export type SidebarFoldReason = Side | 'expanded';
type UIState = ReturnType<typeof useUIStore.getState>;

type ZoneFitWatch = {
  directoryKey: string;
  folded: { current: SidebarFoldReason | null };
  readRowWidth: () => number | undefined;
};

const displacedZones = new Set<string>();
const displacedKey = (directoryKey: string, zone: string) => `${directoryKey}\0${zone}`;

export const isZoneDisplaced = (directoryKey: string, zone: string): boolean =>
  displacedZones.has(displacedKey(directoryKey, zone));

export const watchZoneFit = ({ directoryKey, folded, readRowWidth }: ZoneFitWatch): (() => void) => {
  const sidesShown = (state: UIState) => {
    const panel = state.contextPanelByDirectory[directoryKey];
    return {
      left: isZoneShown(panel, state.contextSurfaceZones, 'left'),
      right: isZoneShown(panel, state.contextSurfaceZones, 'right'),
    };
  };
  const shownWidth = (state: UIState, side: Side, shown: boolean): number => {
    const panel = state.contextPanelByDirectory[directoryKey];
    const tab = shown && panel ? resolveZoneActiveTab(panel, state.contextSurfaceZones, side) : null;
    if (!tab) return 0;
    return state.contextZoneSizes[side] ?? CONTEXT_ZONE_DEFAULT_WIDTH;
  };
  const anyZoneExpanded = (state: UIState): boolean => {
    const panel = state.contextPanelByDirectory[directoryKey];
    if (!panel) return false;
    return CONTEXT_ZONES.some((zone) => getZoneView(panel, zone).expanded && canZoneExpand(panel, state, zone));
  };

  let displaced: { side: Side; by: Side; tabId: string } | null = null;
  const setDisplaced = (next: typeof displaced) => {
    if (displaced) displacedZones.delete(displacedKey(directoryKey, displaced.side));
    displaced = next;
    if (next) displacedZones.add(displacedKey(directoryKey, next.side));
  };
  let settingSidebar = false;
  let previous = sidesShown(useUIStore.getState());
  let previousExpanded = anyZoneExpanded(useUIStore.getState());

  const setFoldReason = (reason: SidebarFoldReason | null) => {
    folded.current = reason;
    useUIStore.getState().setSidebarFoldedForExpandedZone(reason === 'expanded');
  };
  const setSidebar = (open: boolean) => {
    settingSidebar = true;
    useUIStore.getState().setSidebarOpen(open);
    settingSidebar = false;
  };
  const unfoldSidebar = () => {
    setFoldReason(null);
    if (!useUIStore.getState().isSidebarOpen) setSidebar(true);
  };

  if (!folded.current && useUIStore.getState().sidebarFoldedForExpandedZone) {
    folded.current = 'expanded';
  }
  const foldedFor = folded.current;
  if (foldedFor && !(foldedFor === 'expanded' ? previousExpanded : previous[foldedFor])) {
    unfoldSidebar();
  }
  if (!folded.current && previousExpanded && useUIStore.getState().isSidebarOpen) {
    setFoldReason('expanded');
    setSidebar(false);
  }

  const makeRoom = (state: UIState, opening: Side, shown: Record<Side, boolean>) => {
    const rowWidth = readRowWidth();
    if (!rowWidth) return;
    const foldedForExpanded = folded.current === 'expanded';
    const plan = planZoneFit({
      rowWidth: foldedForExpanded ? rowWidth - state.sidebarWidth : rowWidth,
      leftWidth: shownWidth(state, 'left', shown.left),
      rightWidth: shownWidth(state, 'right', shown.right),
      sidebarWidth: state.isSidebarOpen || foldedForExpanded ? state.sidebarWidth : null,
      opening,
    });
    if (plan.displace) {
      const tabId = getZoneView(state.contextPanelByDirectory[directoryKey], plan.displace).activeTabId;
      if (tabId) setDisplaced({ side: plan.displace, by: opening, tabId });
    }
    if (plan.collapseSidebar) {
      setFoldReason(opening);
      if (state.isSidebarOpen) setSidebar(false);
    }
    if (plan.displace) state.closeContextZone(directoryKey, plan.displace);
  };

  const giveBack = (closed: Side) => {
    if (displaced?.side === closed) {
      if (folded.current === closed) setFoldReason(displaced.by);
      return;
    }
    const restore = displaced?.by === closed ? displaced : null;
    if (restore) setDisplaced(null);
    if (folded.current === closed) {
      if (restore) {
        setFoldReason(restore.side);
      } else {
        unfoldSidebar();
      }
    }
    if (restore) useUIStore.getState().setActiveContextPanelTab(directoryKey, restore.tabId);
  };

  const unsubscribe = useUIStore.subscribe((state, prevState) => {
    if (state.isSidebarOpen !== prevState.isSidebarOpen && !settingSidebar) setFoldReason(null);
    const shown = sidesShown(state);
    const expanded = anyZoneExpanded(state);
    const before = previous;
    const expandedBefore = previousExpanded;
    previous = shown;
    previousExpanded = expanded;
    const sides = ['left', 'right'] as const;
    const opened = sides.filter((side) => shown[side] && !before[side]);
    const closed = sides.filter((side) => !shown[side] && before[side]);
    for (const side of closed) {
      const opposite = side === 'left' ? 'right' : 'left';
      if (!opened.includes(opposite)) continue;
      if (folded.current === side) setFoldReason(opposite);
      if (displaced?.by === side) setDisplaced(null);
    }
    for (const side of closed) giveBack(side);
    for (const side of opened) makeRoom(state, side, shown);
    if (expanded && !expandedBefore && state.isSidebarOpen) {
      setFoldReason('expanded');
      setSidebar(false);
    } else if (!expanded && expandedBefore && folded.current === 'expanded') {
      unfoldSidebar();
    }
  });
  return () => {
    unsubscribe();
    setDisplaced(null);
  };
};

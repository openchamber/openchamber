import { planZoneFit } from '@/lib/workspace/zoneFit';
import { CONTEXT_ZONE_DEFAULT_WIDTH, CONTEXT_ZONES, getZoneView, isZoneShown, resolveZoneActiveTab } from '@/lib/workspace/zones';
import { useUIStore } from '@/stores/useUIStore';

type Side = 'left' | 'right';
/** Why the session sidebar was folded: a side zone that needed its room, or a zone expanded. */
export type SidebarFoldReason = Side | 'expanded';
type UIState = ReturnType<typeof useUIStore.getState>;

type ZoneFitWatch = {
  directoryKey: string;
  /** What was folded and why, kept across calls so a project switch can undo it. */
  folded: { current: SidebarFoldReason | null };
  /** The workspace row's width now: left zone, chat and right zone. */
  readRowWidth: () => number | undefined;
};

/**
 * Keeps the chat usable for one project's zones (`ZoneFitArbiter`): a side
 * zone that opens without room folds the session sidebar, then closes the
 * zone on the other side (`planZoneFit`), and both come back when it closes,
 * the sidebar only if the user has not toggled it since. An expanded zone
 * folds the sidebar too and gives it back on collapse. Returns the
 * unsubscribe.
 */
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
  // A zone shown expanded, as ContextPanel draws it: a side zone showing
  // only the file tree does not expand.
  const anyZoneExpanded = (state: UIState): boolean => {
    const panel = state.contextPanelByDirectory[directoryKey];
    if (!panel) return false;
    const editorShown = panel.tabs.some((tab) => tab.mode === 'file' && tab.targetPath)
      && (state.contextEditorVisible || !state.contextEditorTreeVisible);
    return CONTEXT_ZONES.some((zone) => {
      if (!getZoneView(panel, zone).expanded) return false;
      const tab = isZoneShown(panel, state.contextSurfaceZones, zone)
        ? resolveZoneActiveTab(panel, state.contextSurfaceZones, zone)
        : null;
      return Boolean(tab) && (zone === 'bottom' || tab?.mode !== 'file' || editorShown);
    });
  };

  let displaced: { side: Side; by: Side; tabId: string } | null = null;
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

  // A fold for an expanded zone saved before a restart.
  if (!folded.current && useUIStore.getState().sidebarFoldedForExpandedZone) {
    folded.current = 'expanded';
  }
  // The project switched to may not show what the sidebar folded for: the
  // reason is gone, so the sidebar comes back.
  const foldedFor = folded.current;
  if (foldedFor && !(foldedFor === 'expanded' ? previousExpanded : previous[foldedFor])) {
    unfoldSidebar();
  }
  // A zone shown expanded there takes the sidebar's room.
  if (!folded.current && previousExpanded && useUIStore.getState().isSidebarOpen) {
    setFoldReason('expanded');
    setSidebar(false);
  }

  const makeRoom = (state: UIState, opening: Side, shown: Record<Side, boolean>) => {
    const rowWidth = readRowWidth();
    if (!rowWidth) return;
    // A sidebar folded only for an expanded zone comes back on collapse: the
    // row is planned as it will be then, the sidebar room this zone may take.
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
      if (tabId) displaced = { side: plan.displace, by: opening, tabId };
    }
    if (plan.collapseSidebar) {
      // Taken over from an expanded zone, the sidebar is already closed and
      // stays so when that zone collapses.
      setFoldReason(opening);
      if (state.isSidebarOpen) setSidebar(false);
    }
    if (plan.displace) state.closeContextZone(directoryKey, plan.displace);
  };

  const giveBack = (closed: Side) => {
    // The zone this arbiter closed to make room: the room stays taken, now
    // by the zone that displaced it.
    if (displaced?.side === closed) {
      if (folded.current === closed) setFoldReason(displaced.by);
      return;
    }
    const restore = displaced?.by === closed ? displaced : null;
    if (restore) displaced = null;
    if (folded.current === closed) {
      // A zone coming back takes the room over: the sidebar stays folded
      // for it. Unfolding first would let it measure a row the sidebar
      // has not given back yet.
      if (restore) {
        setFoldReason(restore.side);
      } else {
        unfoldSidebar();
      }
    }
    if (restore) useUIStore.getState().setActiveContextPanelTab(directoryKey, restore.tabId);
  };

  return useUIStore.subscribe((state, prevState) => {
    // The user's own sidebar toggle is theirs to keep.
    if (state.isSidebarOpen !== prevState.isSidebarOpen && !settingSidebar) setFoldReason(null);
    const shown = sidesShown(state);
    const expanded = anyZoneExpanded(state);
    const before = previous;
    const expandedBefore = previousExpanded;
    // Updated first: the actions below notify this listener again.
    previous = shown;
    previousExpanded = expanded;
    const sides = ['left', 'right'] as const;
    const opened = sides.filter((side) => shown[side] && !before[side]);
    const closed = sides.filter((side) => !shown[side] && before[side]);
    // A surface moved from one side to the other closes one and opens the
    // other in this one notification. The room the closing side held goes
    // to the opening one: the sidebar stays folded, and nothing it had
    // displaced comes back into the side the surface now takes.
    for (const side of closed) {
      const opposite = side === 'left' ? 'right' : 'left';
      if (!opened.includes(opposite)) continue;
      if (folded.current === side) setFoldReason(opposite);
      if (displaced?.by === side) displaced = null;
    }
    // Closes first, so a give-back never lands after a fold it would undo.
    for (const side of closed) giveBack(side);
    for (const side of opened) makeRoom(state, side, shown);
    // In the same notification as the expand, so the sidebar folds while
    // the zone grows and both animate together.
    if (expanded && !expandedBefore && state.isSidebarOpen) {
      setFoldReason('expanded');
      setSidebar(false);
    } else if (!expanded && expandedBefore && folded.current === 'expanded') {
      unfoldSidebar();
    }
  });
};

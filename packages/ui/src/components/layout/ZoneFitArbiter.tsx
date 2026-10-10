import React from 'react';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { getContextSurfaceDefaultWidth } from '@/lib/surfaces/registry';
import { planZoneFit } from '@/lib/workspace/zoneFit';
import { getZoneView, isZoneShown, resolveZoneActiveTab } from '@/lib/workspace/zones';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

type Side = 'left' | 'right';
type UIState = ReturnType<typeof useUIStore.getState>;

/**
 * Keeps the chat usable when a side zone opens in a narrow window: the
 * session sidebar folds first, then the zone on the other side closes
 * (`planZoneFit`). Both come back when the zone that took their room closes,
 * the sidebar only if the user has not toggled it since. Renders nothing and
 * reads the store outside React, so it re-renders nothing either.
 */
export const ZoneFitArbiter: React.FC = () => {
  const effectiveDirectory = useEffectiveDirectory();
  const directoryKey = effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : '';

  // What this arbiter did, so it can undo exactly that. Memory only. The
  // folded sidebar outlives a project switch (the sidebar is not per project);
  // a displaced zone belongs to its project and is dropped with it.
  const sidebarFoldedByRef = React.useRef<Side | null>(null);

  React.useEffect(() => {
    if (!directoryKey) return undefined;

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
      return panel?.widthByMode[tab.mode] ?? getContextSurfaceDefaultWidth(tab.mode);
    };

    let displaced: { side: Side; by: Side; tabId: string } | null = null;
    let settingSidebar = false;
    let previous = sidesShown(useUIStore.getState());

    const setSidebar = (open: boolean) => {
      settingSidebar = true;
      useUIStore.getState().setSidebarOpen(open);
      settingSidebar = false;
    };

    // The project switched to may not show the side the sidebar folded for:
    // the reason is gone, so the sidebar comes back.
    const foldedFor = sidebarFoldedByRef.current;
    if (foldedFor && !previous[foldedFor]) {
      sidebarFoldedByRef.current = null;
      if (!useUIStore.getState().isSidebarOpen) setSidebar(true);
    }

    const makeRoom = (state: UIState, opening: Side, shown: Record<Side, boolean>) => {
      const rowWidth = document.querySelector<HTMLElement>('[data-workspace-row]')?.clientWidth;
      if (!rowWidth) return;
      const plan = planZoneFit({
        rowWidth,
        leftWidth: shownWidth(state, 'left', shown.left),
        rightWidth: shownWidth(state, 'right', shown.right),
        sidebarWidth: state.isSidebarOpen ? state.sidebarWidth : null,
        opening,
      });
      if (plan.displace) {
        const tabId = getZoneView(state.contextPanelByDirectory[directoryKey], plan.displace).activeTabId;
        if (tabId) displaced = { side: plan.displace, by: opening, tabId };
      }
      if (plan.collapseSidebar) {
        sidebarFoldedByRef.current = opening;
        setSidebar(false);
      }
      if (plan.displace) state.closeContextZone(directoryKey, plan.displace);
    };

    const giveBack = (closed: Side) => {
      // The zone this arbiter closed to make room: the room stays taken, now
      // by the zone that displaced it.
      if (displaced?.side === closed) {
        if (sidebarFoldedByRef.current === closed) sidebarFoldedByRef.current = displaced.by;
        return;
      }
      const restore = displaced?.by === closed ? displaced : null;
      if (restore) displaced = null;
      if (sidebarFoldedByRef.current === closed) {
        // A zone coming back takes the room over: the sidebar stays folded
        // for it. Unfolding first would let it measure a row the sidebar
        // has not given back yet.
        if (restore) {
          sidebarFoldedByRef.current = restore.side;
        } else {
          sidebarFoldedByRef.current = null;
          if (!useUIStore.getState().isSidebarOpen) setSidebar(true);
        }
      }
      if (restore) useUIStore.getState().setActiveContextPanelTab(directoryKey, restore.tabId);
    };

    return useUIStore.subscribe((state, prevState) => {
      // The user's own sidebar toggle is theirs to keep.
      if (state.isSidebarOpen !== prevState.isSidebarOpen && !settingSidebar) sidebarFoldedByRef.current = null;
      const shown = sidesShown(state);
      const before = previous;
      // Updated first: the actions below notify this listener again.
      previous = shown;
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
        if (sidebarFoldedByRef.current === side) sidebarFoldedByRef.current = opposite;
        if (displaced?.by === side) displaced = null;
      }
      // Closes first, so a give-back never lands after a fold it would undo.
      for (const side of closed) giveBack(side);
      for (const side of opened) makeRoom(state, side, shown);
    });
  }, [directoryKey]);

  return null;
};

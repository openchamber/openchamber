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

    // What this arbiter did, so it can undo exactly that. Memory only.
    let sidebarFoldedBy: Side | null = null;
    let displaced: { side: Side; by: Side; tabId: string } | null = null;
    let settingSidebar = false;
    let previous = sidesShown(useUIStore.getState());

    const setSidebar = (open: boolean) => {
      settingSidebar = true;
      useUIStore.getState().setSidebarOpen(open);
      settingSidebar = false;
    };

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
        sidebarFoldedBy = opening;
        setSidebar(false);
      }
      if (plan.displace) state.closeContextZone(directoryKey, plan.displace);
    };

    const giveBack = (closed: Side) => {
      // The zone this arbiter closed to make room: the room stays taken, now
      // by the zone that displaced it.
      if (displaced?.side === closed) {
        if (sidebarFoldedBy === closed) sidebarFoldedBy = displaced.by;
        return;
      }
      const restore = displaced?.by === closed ? displaced : null;
      if (restore) displaced = null;
      if (sidebarFoldedBy === closed) {
        // A zone coming back takes the room over: the sidebar stays folded
        // for it. Unfolding first would let it measure a row the sidebar
        // has not given back yet.
        if (restore) {
          sidebarFoldedBy = restore.side;
        } else {
          sidebarFoldedBy = null;
          if (!useUIStore.getState().isSidebarOpen) setSidebar(true);
        }
      }
      if (restore) useUIStore.getState().setActiveContextPanelTab(directoryKey, restore.tabId);
    };

    return useUIStore.subscribe((state, prevState) => {
      // The user's own sidebar toggle is theirs to keep.
      if (state.isSidebarOpen !== prevState.isSidebarOpen && !settingSidebar) sidebarFoldedBy = null;
      const shown = sidesShown(state);
      const before = previous;
      // Updated first: the actions below notify this listener again.
      previous = shown;
      for (const side of ['left', 'right'] as const) {
        if (shown[side] && !before[side]) makeRoom(state, side, shown);
        else if (!shown[side] && before[side]) giveBack(side);
      }
    });
  }, [directoryKey]);

  return null;
};

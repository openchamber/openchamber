import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useUIStore } from '@/stores/useUIStore';
import { watchZoneFit, type SidebarFoldReason } from './zoneFitWatch';

const directory = '/repo';
let rowWidth = 1600;
let stops: Array<() => void> = [];

const watch = (folded: { current: SidebarFoldReason | null } = { current: null }) => {
  stops.push(watchZoneFit({ directoryKey: directory, folded, readRowWidth: () => rowWidth }));
  return folded;
};
const store = () => useUIStore.getState();
const sidebar = () => ({ open: store().isSidebarOpen, foldedForExpanded: store().sidebarFoldedForExpandedZone });
const toggleExpanded = (zone: 'left' | 'right' = 'right') => store().toggleContextPanelExpanded(directory, zone);

beforeEach(() => {
  rowWidth = 1600;
  useUIStore.setState({
    contextPanelByDirectory: {},
    contextSurfaceZones: {},
    isSidebarOpen: true,
    sidebarFoldedForExpandedZone: false,
    sidebarWidth: 280,
  });
  store().openContextPanelTab(directory, { mode: 'git' });
});

afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

describe('watchZoneFit with an expanded zone', () => {
  test('expanding folds the sidebar and collapsing brings it back', () => {
    watch();
    toggleExpanded();
    expect(sidebar()).toEqual({ open: false, foldedForExpanded: true });
    toggleExpanded();
    expect(sidebar()).toEqual({ open: true, foldedForExpanded: false });
  });

  test('a sidebar the user toggled in between stays as they left it', () => {
    watch();
    toggleExpanded();
    store().setSidebarOpen(true);
    store().setSidebarOpen(false);
    expect(sidebar()).toEqual({ open: false, foldedForExpanded: false });
    toggleExpanded();
    expect(sidebar().open).toBe(false);
  });

  test('closing the expanded zone brings the sidebar back too', () => {
    watch();
    toggleExpanded();
    store().closeContextZone(directory, 'right');
    expect(sidebar()).toEqual({ open: true, foldedForExpanded: false });
  });

  test('after a restart the saved fold still comes back on collapse', () => {
    watch();
    toggleExpanded();
    for (const stop of stops) stop();
    stops = [];

    // A new window: nothing in memory, the zone still expanded.
    watch();
    expect(sidebar()).toEqual({ open: false, foldedForExpanded: true });
    toggleExpanded();
    expect(sidebar()).toEqual({ open: true, foldedForExpanded: false });
  });

  test('a side zone that needs the sidebar room keeps it folded after the collapse', () => {
    store().moveContextSurfaceToZone('terminal', 'left');
    watch();
    toggleExpanded();
    // Folded, the row has the sidebar's room: 1600 px now, 1320 once it is back.
    store().openContextPanelTab(directory, { mode: 'terminal' });
    toggleExpanded();
    expect(sidebar()).toEqual({ open: false, foldedForExpanded: false });
  });

  test('a side zone that fits beside the returning sidebar lets it come back', () => {
    rowWidth = 1900;
    store().moveContextSurfaceToZone('terminal', 'left');
    watch();
    toggleExpanded();
    store().openContextPanelTab(directory, { mode: 'terminal' });
    toggleExpanded();
    expect(sidebar()).toEqual({ open: true, foldedForExpanded: false });
  });
});

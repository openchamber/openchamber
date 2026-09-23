/**
 * What the workspace actually puts on screen.
 *
 * These drive the real store and then ask the same two functions the layout
 * components ask — `isWorkspaceZoneVisible` for whether a zone is drawn at all,
 * and `activeContextTabForZone` for which surface it shows — so a regression in
 * either decision fails here rather than only in the browser.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from '@/stores/useUIStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { followWorkspaceLayoutOfOtherWindows, selectContextZoneTab, selectVisibleContextZoneTab } from '@/stores/useUIStore';
import {
  createDefaultWorkspaceLayout,
  mainChatZone,
  moveSurfaceToZone,
  zoneOfSurface,
  type WorkspaceLayout,
  type WorkspaceZone,
} from '@/lib/workspace/layout';
import { isWorkspaceZoneVisible, occupiedZones, type WorkspaceZonesView } from './useWorkspaceZones';

const directory = '/repo';

const view = (): WorkspaceZonesView => {
  const state = useUIStore.getState();
  const layout: WorkspaceLayout = state.workspaceLayout;
  const panel = state.contextPanelByDirectory[directory];
  const occupied = occupiedZones(layout, panel);
  return { directoryKey: directory, layout, panel, occupied };
};

const visibleZones = (): WorkspaceZone[] => {
  const current = view();
  return (['left', 'center', 'right', 'bottom'] as const).filter((zone) => isWorkspaceZoneVisible(current, zone));
};

/** The surface a zone shows right now, or null when the zone draws nothing. */
const shownMode = (zone: WorkspaceZone): string | null => {
  const state = useUIStore.getState();
  if (!isWorkspaceZoneVisible(view(), zone)) return null;
  const tab = selectVisibleContextZoneTab(state, directory, zone);
  if (tab) return tab.mode;
  // The chat's zone resolves to no tab precisely when the conversation is what
  // it is showing.
  return mainChatZone(state.workspaceLayout) === zone ? 'main-chat' : null;
};

beforeEach(() => {
  useUIStore.setState({
    contextPanelByDirectory: {},
    contextRailOrder: [],
    workspaceLayout: createDefaultWorkspaceLayout(),
  });
  useTerminalStore.getState().clearAll();
});

describe('default layout', () => {
  test('draws the conversation in the center and nothing else', () => {
    expect(visibleZones()).toEqual(['center']);
    expect(shownMode('center')).toBe('main-chat');
  });

  test('an empty zone is not drawn, so it consumes no space', () => {
    expect(isWorkspaceZoneVisible(view(), 'left')).toBe(false);
    expect(isWorkspaceZoneVisible(view(), 'bottom')).toBe(false);
    expect(isWorkspaceZoneVisible(view(), 'right')).toBe(false);
  });

  test('opening a surface reveals its zone beside the conversation', () => {
    useUIStore.getState().openContextSurface(directory, 'git');

    expect(visibleZones()).toEqual(['center', 'right']);
    expect(shownMode('center')).toBe('main-chat');
    expect(shownMode('right')).toBe('git');
  });
});

describe('several zones at once', () => {
  test('files left, conversation center and terminal bottom coexist', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('editor', 'left');
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.openContextSurface(directory, 'file');
    store.openContextSurface(directory, 'terminal');

    expect(visibleZones()).toEqual(['left', 'center', 'bottom']);
    expect(shownMode('left')).toBe('file');
    expect(shownMode('center')).toBe('main-chat');
    expect(shownMode('bottom')).toBe('terminal');
  });

  test('a bottom terminal coexists with the center conversation', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.openContextSurface(directory, 'terminal');

    expect(shownMode('bottom')).toBe('terminal');
    expect(shownMode('center')).toBe('main-chat');
  });

  test('activating git does not hide a surface in another zone', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.openContextSurface(directory, 'terminal');
    store.openContextSurface(directory, 'git');

    expect(shownMode('bottom')).toBe('terminal');
    expect(shownMode('right')).toBe('git');
    expect(shownMode('center')).toBe('main-chat');
  });

  test('two surfaces in one zone are tabs: activating one replaces the other there only', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.moveWorkspaceSurface('git', 'bottom');
    store.openContextSurface(directory, 'terminal');
    store.openContextSurface(directory, 'git');

    expect(shownMode('bottom')).toBe('git');
    expect(visibleZones()).toEqual(['center', 'bottom']);

    useUIStore.getState().openContextSurface(directory, 'terminal');
    expect(shownMode('bottom')).toBe('terminal');
  });
});

// Maintainer feedback (discussion #3844): choosing a zone for a panel in Rail
// panels opened it. Placement and open state are separate: setting where a
// closed panel will appear must not open, focus or activate it; a panel that
// is on screen moves and stays on screen.
describe('placement does not open a closed surface', () => {
  const panel = () => useUIStore.getState().contextPanelByDirectory[directory];

  test('a surface that was never opened only changes placement', () => {
    useUIStore.getState().moveWorkspaceSurface('git', 'bottom');

    expect(zoneOfSurface(useUIStore.getState().workspaceLayout, 'git')).toBe('bottom');
    expect(visibleZones()).toEqual(['center']);
    expect(panel()?.tabs ?? []).toEqual([]);
    expect(panel()?.openZones ?? []).toEqual([]);
  });

  test('a closed surface stays closed, inactive and unfocused', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'git');
    store.closeContextZone(directory, 'right');
    const before = panel();

    useUIStore.getState().moveWorkspaceSurface('git', 'bottom');

    const after = panel();
    expect(zoneOfSurface(useUIStore.getState().workspaceLayout, 'git')).toBe('bottom');
    expect(after?.openZones).toEqual([]);
    expect(isWorkspaceZoneVisible(view(), 'bottom')).toBe(false);
    expect(after?.activeTabId).toBe(before?.activeTabId ?? null);
    expect(after?.activeTabIdByZone.bottom).toBeUndefined();
    expect(after?.tabs).toEqual(before?.tabs);
  });

  test('a background tab does not open its new zone or come to the front', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'git');
    store.openContextSurface(directory, 'terminal');

    useUIStore.getState().moveWorkspaceSurface('git', 'bottom');

    expect(isWorkspaceZoneVisible(view(), 'bottom')).toBe(false);
    expect(shownMode('right')).toBe('terminal');
  });

  test('the rail still opens it later, in its configured zone', () => {
    useUIStore.getState().moveWorkspaceSurface('git', 'bottom');
    useUIStore.getState().openContextSurface(directory, 'git');

    expect(shownMode('bottom')).toBe('git');
    expect(isWorkspaceZoneVisible(view(), 'right')).toBe(false);
  });

  test('the placement persists without persisting an open zone', () => {
    useUIStore.getState().moveWorkspaceSurface('git', 'bottom');
    useUIStore.getState().moveWorkspaceSurface('editor', 'left');
    const persisted = JSON.parse(JSON.stringify(useUIStore.persist.getOptions().partialize?.(useUIStore.getState())));

    expect(persisted.workspaceLayout.bottom).toContain('git');
    expect(persisted.workspaceLayout.left).toContain('editor');
    expect(persisted.contextPanelByDirectory[directory]?.openZones ?? []).toEqual([]);
  });
});

describe('moving a surface that is on screen', () => {
  const panel = () => useUIStore.getState().contextPanelByDirectory[directory];

  test('it moves at once and stays open; the emptied zone collapses', () => {
    useUIStore.getState().openContextSurface(directory, 'git');
    useUIStore.getState().moveWorkspaceSurface('git', 'bottom');

    expect(shownMode('bottom')).toBe('git');
    expect(isWorkspaceZoneVisible(view(), 'right')).toBe(false);
    expect(panel()?.openZones).toEqual(['bottom']);
  });

  test('a terminal keeps its tab (and so its session) when it moves', () => {
    useUIStore.getState().openContextSurface(directory, 'terminal');
    const tabsBefore = panel()?.tabs;

    useUIStore.getState().moveWorkspaceSurface('terminal', 'bottom');

    expect(shownMode('bottom')).toBe('terminal');
    expect(panel()?.tabs).toEqual(tabsBefore);
  });

  test('it joins a zone that already has tabs without replacing them', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.openContextSurface(directory, 'terminal');
    useUIStore.getState().openContextSurface(directory, 'git');

    useUIStore.getState().moveWorkspaceSurface('git', 'bottom');

    const layout = useUIStore.getState().workspaceLayout;
    expect(layout.bottom).toEqual(['terminal', 'git']);
    expect(shownMode('bottom')).toBe('git');
    expect(panel()?.tabs.map((tab) => tab.mode).sort()).toEqual(['git', 'terminal']);
    // Its old zone had nothing else and collapses.
    expect(isWorkspaceZoneVisible(view(), 'right')).toBe(false);
  });

  test('its old zone keeps showing what is left there', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'terminal');
    useUIStore.getState().openContextSurface(directory, 'git');

    useUIStore.getState().moveWorkspaceSurface('git', 'bottom');

    expect(shownMode('bottom')).toBe('git');
    expect(shownMode('right')).toBe('terminal');
  });

  test('moving the chat brings it in front of a tab already in that zone', () => {
    useUIStore.getState().openContextSurface(directory, 'git');
    useUIStore.getState().moveWorkspaceSurface('chat', 'right');

    expect(shownMode('right')).toBe('main-chat');
  });
});

describe('moving the conversation', () => {
  test('moving chat to the right draws it there and frees the center', () => {
    useUIStore.getState().moveWorkspaceSurface('chat', 'right');

    expect(visibleZones()).toEqual(['right']);
    expect(shownMode('right')).toBe('main-chat');
  });

  test('the conversation keeps its zone open even when nothing else is docked there', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('chat', 'right');
    store.closeContextZone(directory, 'right');

    // Collapsing must never leave the user without the session they are in.
    expect(isWorkspaceZoneVisible(view(), 'right')).toBe(true);
  });

  test('a surface sharing the conversation zone can be brought forward and dismissed', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('chat', 'right');
    store.openContextSurface(directory, 'git');

    expect(shownMode('right')).toBe('git');

    useUIStore.getState().focusMainChat(directory);
    expect(shownMode('right')).toBe('main-chat');
    // The git tab is still there, just behind the conversation.
    expect(selectContextZoneTab(useUIStore.getState(), directory, 'right')).toBe(null);
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.tabs.some((tab) => tab.mode === 'git')).toBe(true);
  });
});

describe('per-zone selection', () => {
  test('a split session opens beside the conversation, not over it', () => {
    useUIStore.getState().openContextPanelTab(directory, { mode: 'chat', dedupeKey: 'session:other' });

    expect(shownMode('center')).toBe('main-chat');
    expect(shownMode('right')).toBe('chat');
  });

  test('working in another zone keeps the conversation in front of its own', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('chat', 'right');
    store.openContextSurface(directory, 'git');
    useUIStore.getState().focusMainChat(directory);
    useUIStore.getState().moveWorkspaceSurface('terminal', 'bottom');
    useUIStore.getState().openContextSurface(directory, 'terminal');

    expect(shownMode('right')).toBe('main-chat');
    expect(shownMode('bottom')).toBe('terminal');
  });

  test('closing the tab a zone shows falls back to another tab in that zone', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'git');
    store.openContextSurface(directory, 'terminal');
    const terminalTab = useUIStore.getState().contextPanelByDirectory[directory]?.tabs.find((tab) => tab.mode === 'terminal');
    useUIStore.getState().closeContextPanelTab(directory, terminalTab?.id ?? '');

    expect(shownMode('right')).toBe('git');
  });
});

describe('presets', () => {
  test('a surface on screen stays on screen in its new zone', () => {
    useUIStore.getState().openContextSurface(directory, 'terminal');
    useUIStore.getState().applyWorkspaceLayoutPreset('developer');

    expect(shownMode('bottom')).toBe('terminal');
  });

  test('reset brings a moved surface back on screen', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.openContextSurface(directory, 'terminal');
    useUIStore.getState().resetWorkspaceLayout();

    expect(shownMode('right')).toBe('terminal');
  });
});

describe('collapsing a zone', () => {
  test('a collapsed zone is not drawn but keeps its tabs for reopening', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'git');
    store.closeContextZone(directory, 'right');

    expect(isWorkspaceZoneVisible(view(), 'right')).toBe(false);
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.tabs.some((tab) => tab.mode === 'git')).toBe(true);

    useUIStore.getState().openContextZone(directory, 'right');
    expect(shownMode('right')).toBe('git');
  });

  test('collapsing one zone leaves the others alone', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.openContextSurface(directory, 'terminal');
    store.openContextSurface(directory, 'git');
    store.closeContextZone(directory, 'right');

    expect(shownMode('bottom')).toBe('terminal');
    expect(shownMode('center')).toBe('main-chat');
    expect(isWorkspaceZoneVisible(view(), 'right')).toBe(false);
  });
});

describe('persistence', () => {
  test('zone assignment, sizes and open zones survive a round trip', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.setWorkspaceZoneSize('bottom', 320);
    store.setWorkspaceZoneSize('left', 300);
    store.openContextSurface(directory, 'terminal');

    const snapshot = JSON.parse(JSON.stringify({
      workspaceLayout: useUIStore.getState().workspaceLayout,
      workspaceZoneSizes: useUIStore.getState().workspaceZoneSizes,
      openZones: useUIStore.getState().contextPanelByDirectory[directory]?.openZones,
    }));

    expect(snapshot.workspaceLayout.bottom).toContain('terminal');
    expect(snapshot.workspaceZoneSizes).toEqual({ left: 300, right: 420, bottom: 320 });
    expect(snapshot.openZones).toEqual(['bottom']);
  });

  test('a zone size never drops below its usable minimum', () => {
    useUIStore.getState().setWorkspaceZoneSize('bottom', 10);
    expect(useUIStore.getState().workspaceZoneSizes.bottom).toBe(160);

    useUIStore.getState().setWorkspaceZoneSize('left', 10);
    expect(useUIStore.getState().workspaceZoneSizes.left).toBe(240);
  });
});

// Every window of the app shares one persisted store and writes all of it on
// any change. A window must adopt a layout change made in another one, or its
// next unrelated write puts the old layout back.
describe('another window changes the layout', () => {
  type StorageEventFields = Pick<StorageEvent, 'storageArea' | 'key' | 'newValue'>;
  type SavedState = { workspaceLayout?: WorkspaceLayout; workspaceZoneSizes?: { left?: number; right?: number; bottom?: number }; theme?: string };
  const localStorageStandIn: Storage = {
    length: 0,
    clear: () => undefined,
    getItem: () => null,
    key: () => null,
    removeItem: () => undefined,
    setItem: () => undefined,
  };
  let listener: ((event: StorageEventFields) => void) | null = null;
  let stop: () => void = () => undefined;
  const savedWindow = globalThis.window;

  beforeEach(() => {
    Object.assign(globalThis, {
      window: {
        localStorage: localStorageStandIn,
        addEventListener: (_type: string, handler: (event: StorageEventFields) => void) => { listener = handler; },
        removeEventListener: () => { listener = null; },
      },
    });
    stop = followWorkspaceLayoutOfOtherWindows();
  });

  afterEach(() => {
    stop();
    Object.assign(globalThis, { window: savedWindow });
  });

  const otherWindowSaves = (state: SavedState) => {
    listener?.({ storageArea: localStorageStandIn, key: 'ui-store', newValue: JSON.stringify({ state, version: 22 }) });
  };

  test('adopts the new placement and keeps what this window shows on screen', () => {
    useUIStore.getState().openContextSurface(directory, 'git');
    const moved = moveSurfaceToZone(useUIStore.getState().workspaceLayout, 'git', 'bottom');

    otherWindowSaves({ workspaceLayout: moved, workspaceZoneSizes: { bottom: 300 } });

    expect(zoneOfSurface(useUIStore.getState().workspaceLayout, 'git')).toBe('bottom');
    expect(shownMode('bottom')).toBe('git');
    expect(useUIStore.getState().workspaceZoneSizes.bottom).toBe(300);
  });

  test('ignores a write without a layout', () => {
    useUIStore.getState().moveWorkspaceSurface('git', 'left');
    otherWindowSaves({ theme: 'dark' });

    expect(zoneOfSurface(useUIStore.getState().workspaceLayout, 'git')).toBe('left');
  });

  test('changes nothing when the layout is already the same', () => {
    const before = useUIStore.getState();
    otherWindowSaves({ workspaceLayout: before.workspaceLayout, workspaceZoneSizes: before.workspaceZoneSizes });

    expect(useUIStore.getState()).toBe(before);
  });
});

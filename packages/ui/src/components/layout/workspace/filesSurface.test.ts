/**
 * Files is one workspace surface; open files are its own tabs.
 *
 * These drive the real store and read the zone strip the way ContextPanel
 * builds it (`workspaceStripEntries` over the tabs docked in the zone), so a
 * file leaking back into the zone strip fails here rather than only on screen.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { selectContextZoneTab, selectVisibleContextZoneTab, useUIStore } from '@/stores/useUIStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { createDefaultWorkspaceLayout, moveSurfaceToZone, zoneOfMode, type WorkspaceZone } from '@/lib/workspace/layout';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { isWorkspaceZoneVisible, occupiedZones } from './useWorkspaceZones';
import {
  FILES_SURFACE_TAB_ID,
  filesEditorMounted,
  fileTabToActivate,
  mountedFileTabs,
  reorderForStripDrag,
  splitWorkspaceStripClose,
  stripEntryMode,
  workspaceStripEntries,
} from './filesSurfaceTabs';

const directory = '/repo';

const panel = () => useUIStore.getState().contextPanelByDirectory[directory];

/** What the zone's workspace strip lists: surface ids, Files once. */
const stripOf = (zone: WorkspaceZone): string[] => {
  const layout = useUIStore.getState().workspaceLayout;
  const tabs = (panel()?.tabs ?? []).filter((tab) => zoneOfMode(layout, tab.mode) === zone);
  return workspaceStripEntries(tabs).map((entry) => (entry === FILES_SURFACE_TAB_ID ? 'Files' : entry.mode));
};

/** The files Files lists in its own strip. */
const openFiles = (): string[] => (panel()?.tabs ?? [])
  .filter((tab) => tab.mode === 'file' && tab.targetPath)
  .map((tab) => tab.targetPath ?? '');

const shownMode = (zone: WorkspaceZone): string | null =>
  selectVisibleContextZoneTab(useUIStore.getState(), directory, zone)?.mode ?? null;

const tabId = (path: string): string => panel()?.tabs.find((tab) => tab.targetPath === path)?.id ?? '';

/** What the zone strip's × (or its close menu) does with these strip ids. */
const closeFromZoneStrip = (ids: readonly string[]) => {
  const { tabIds, hidesFiles } = splitWorkspaceStripClose(ids);
  useUIStore.getState().closeContextPanelTabs(directory, tabIds);
  if (hidesFiles) useUIStore.getState().hideFilesSurface(directory);
};

const activeFile = (zone: WorkspaceZone): string | null =>
  selectVisibleContextZoneTab(useUIStore.getState(), directory, zone)?.targetPath ?? null;

const initialState = useUIStore.getState();
const initialPersistOptions = useUIStore.persist.getOptions();

beforeEach(() => {
  useUIStore.setState({
    contextPanelByDirectory: {},
    contextRailOrder: [],
    workspaceLayout: createDefaultWorkspaceLayout(),
  });
  useTerminalStore.getState().clearAll();
});

afterEach(() => {
  useUIStore.persist.setOptions(initialPersistOptions);
  useUIStore.setState(initialState, true);
});

describe('the zone strip lists Files once', () => {
  test('several open files are one Files tab', () => {
    const store = useUIStore.getState();
    store.openContextFile(directory, '/repo/foo.ts');
    store.openContextFile(directory, '/repo/bar.ts');

    expect(stripOf('right')).toEqual(['Files']);
    expect(openFiles()).toEqual(['/repo/foo.ts', '/repo/bar.ts']);
  });

  test('opening another file adds a file inside Files, not a zone tab', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'git');
    store.openContextFile(directory, '/repo/foo.ts');
    const before = stripOf('right');

    store.openContextFile(directory, '/repo/bar.ts');

    expect(stripOf('right')).toEqual(before);
    expect(stripOf('right')).toEqual(['git', 'Files']);
    expect(openFiles()).toEqual(['/repo/foo.ts', '/repo/bar.ts']);
    expect(shownMode('right')).toBe('file');
  });

  test('Files and Terminal share a zone as two tabs while the files stay inside Files', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.moveWorkspaceSurface('editor', 'bottom');
    store.openContextFile(directory, '/repo/foo.ts');
    store.openContextFile(directory, '/repo/bar.ts');
    store.openContextSurface(directory, 'terminal');

    expect(stripOf('bottom')).toEqual(['Files', 'terminal']);
    expect(shownMode('bottom')).toBe('terminal');
  });

  test('explorer-only Files is a zone tab with no file open', () => {
    useUIStore.getState().openContextSurface(directory, 'file');

    expect(stripOf('right')).toEqual(['Files']);
    expect(openFiles()).toEqual([]);
    expect(shownMode('right')).toBe('file');
    expect(useUIStore.getState().contextEditorTreeVisible).toBe(true);
  });
});

describe('closing', () => {
  test('closing one file leaves Files open on the other', () => {
    const store = useUIStore.getState();
    store.openContextFile(directory, '/repo/foo.ts');
    store.openContextFile(directory, '/repo/bar.ts');

    store.closeContextPanelTab(directory, tabId('/repo/foo.ts'));

    expect(openFiles()).toEqual(['/repo/bar.ts']);
    expect(stripOf('right')).toEqual(['Files']);
    expect(shownMode('right')).toBe('file');
  });

  test('closing the last file leaves Files open in explorer-only mode', () => {
    const store = useUIStore.getState();
    store.openContextFile(directory, '/repo/foo.ts');
    useUIStore.setState({ contextEditorTreeVisible: false });

    store.closeContextPanelTab(directory, tabId('/repo/foo.ts'));

    expect(openFiles()).toEqual([]);
    expect(stripOf('right')).toEqual(['Files']);
    expect(shownMode('right')).toBe('file');
    expect(useUIStore.getState().contextEditorTreeVisible).toBe(true);
  });

  test('the last file closes to the explorer even after working in another zone', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('editor', 'left');
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.openContextFile(directory, '/repo/foo.ts');
    store.openContextSurface(directory, 'terminal');

    store.closeContextPanelTab(directory, tabId('/repo/foo.ts'));

    expect(shownMode('left')).toBe('file');
    expect(stripOf('left')).toEqual(['Files']);
    expect(shownMode('bottom')).toBe('terminal');
  });

  test('closing the Files tab removes Files from its zone', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'git');
    store.openContextFile(directory, '/repo/foo.ts');
    store.openContextFile(directory, '/repo/bar.ts');

    closeFromZoneStrip([FILES_SURFACE_TAB_ID]);

    expect(stripOf('right')).toEqual(['git']);
    expect(shownMode('right')).toBe('git');
    expect(openFiles()).toEqual([]);
  });

  test('reopening Files from the rail brings back the same files and active file', () => {
    const store = useUIStore.getState();
    let clock = 1_000;
    const now = spyOn(Date, 'now').mockImplementation(() => clock);
    store.openContextSurface(directory, 'git');
    store.openContextFile(directory, '/repo/foo.ts');
    store.openContextFile(directory, '/repo/bar.ts');
    // The user comes back to foo a moment later; "used last" is by time.
    clock = 2_000;
    store.setActiveContextPanelTab(directory, tabId('/repo/foo.ts'));
    closeFromZoneStrip([FILES_SURFACE_TAB_ID]);

    store.openContextSurface(directory, 'file');
    now.mockRestore();

    expect(stripOf('right')).toEqual(['git', 'Files']);
    expect(openFiles()).toEqual(['/repo/foo.ts', '/repo/bar.ts']);
    expect(activeFile('right')).toBe('/repo/foo.ts');
  });

  test('closing Files leaves the editor and tree state alone', () => {
    const store = useUIStore.getState();
    store.openContextFile(directory, '/repo/foo.ts');
    useFilesViewTabsStore.getState().addOpenPath(directory, '/repo/foo.ts');
    useFilesViewTabsStore.getState().expandPath(directory, '/repo/src');

    closeFromZoneStrip([FILES_SURFACE_TAB_ID]);

    const files = useFilesViewTabsStore.getState().byRoot[directory];
    expect(files?.openPaths).toContain('/repo/foo.ts');
    expect(files?.expandedPaths).toContain('/repo/src');
  });

  test('closing a file still closes it for good', () => {
    const store = useUIStore.getState();
    store.openContextFile(directory, '/repo/foo.ts');
    store.openContextFile(directory, '/repo/bar.ts');
    store.closeContextPanelTab(directory, tabId('/repo/foo.ts'));
    closeFromZoneStrip([FILES_SURFACE_TAB_ID]);

    store.openContextSurface(directory, 'file');

    expect(openFiles()).toEqual(['/repo/bar.ts']);
  });

  test('explorer-only Files reopens explorer-only', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'file');
    closeFromZoneStrip([FILES_SURFACE_TAB_ID]);
    expect(panel()?.tabs ?? []).toEqual([]);
    expect(panel()?.openZones).toEqual([]);

    store.openContextSurface(directory, 'file');

    expect(stripOf('right')).toEqual(['Files']);
    expect(openFiles()).toEqual([]);
    expect(shownMode('right')).toBe('file');
  });

  test('opening a file while Files is closed brings the other files back with it', () => {
    const store = useUIStore.getState();
    store.openContextFile(directory, '/repo/foo.ts');
    closeFromZoneStrip([FILES_SURFACE_TAB_ID]);

    store.openContextFile(directory, '/repo/bar.ts');

    expect(openFiles()).toEqual(['/repo/foo.ts', '/repo/bar.ts']);
    expect(activeFile('right')).toBe('/repo/bar.ts');
  });

  test('"close others" on Terminal closes Files the same way, keeping its files', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.moveWorkspaceSurface('editor', 'bottom');
    store.openContextFile(directory, '/repo/foo.ts');
    store.openContextSurface(directory, 'terminal');

    closeFromZoneStrip([FILES_SURFACE_TAB_ID]);
    expect(stripOf('bottom')).toEqual(['terminal']);
    store.openContextSurface(directory, 'file');

    // Like any reopened surface, Files comes back at the end of its zone.
    expect(stripOf('bottom')).toEqual(['terminal', 'Files']);
    expect(activeFile('bottom')).toBe('/repo/foo.ts');
  });

  test('collapsing the zone hides Files and keeps its files for reopening', () => {
    const store = useUIStore.getState();
    store.openContextFile(directory, '/repo/foo.ts');
    store.openContextFile(directory, '/repo/bar.ts');

    store.closeContextZone(directory, 'right');
    expect(shownMode('right')).toBeNull();
    store.openContextSurface(directory, 'file');

    expect(openFiles()).toEqual(['/repo/foo.ts', '/repo/bar.ts']);
    expect(selectVisibleContextZoneTab(useUIStore.getState(), directory, 'right')?.targetPath).toBe('/repo/bar.ts');
  });
});

// The editor keeps unsaved edits only in its mounted component, so hiding
// Files must never unmount it. FilesView itself cannot mount under bun (its
// imports include a Vite worker URL); these pin what keeps it mounted: its
// zone stays mounted and its container keeps file tabs through hide and reopen.
describe('a hidden Files stays mounted, so unsaved edits survive', () => {
  const zoneState = (zone: WorkspaceZone) => {
    const state = useUIStore.getState();
    const view = { directoryKey: directory, layout: state.workspaceLayout, panel: panel(), occupied: occupiedZones(state.workspaceLayout, panel()) };
    return { mounted: view.occupied.has(zone), visible: isWorkspaceZoneVisible(view, zone) };
  };
  /** The file tabs a zone's Files container is mounted for, as ContextPanel computes it. */
  const filesContainer = (zone: WorkspaceZone): string[] => {
    const state = useUIStore.getState();
    const zoneTabs = (panel()?.tabs ?? []).filter((tab) => zoneOfMode(state.workspaceLayout, tab.mode) === zone);
    return mountedFileTabs(zoneTabs, panel()?.hiddenFileTabs ?? [], zoneOfMode(state.workspaceLayout, 'file') === zone)
      .map((tab) => tab.targetPath ?? '');
  };

  test('alone in its zone: the zone collapses but stays mounted with the editor in it', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('editor', 'bottom');
    store.openContextFile(directory, '/repo/foo.ts');
    const before = filesContainer('bottom');

    closeFromZoneStrip([FILES_SURFACE_TAB_ID]);

    expect(zoneState('bottom')).toEqual({ mounted: true, visible: false });
    expect(stripOf('bottom')).toEqual([]);
    expect(filesContainer('bottom')).toEqual(before);
  });

  test('sharing a zone: the zone shows Terminal while the Files container stays mounted', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.moveWorkspaceSurface('editor', 'bottom');
    store.openContextFile(directory, '/repo/foo.ts');
    store.openContextSurface(directory, 'terminal');

    closeFromZoneStrip([FILES_SURFACE_TAB_ID]);

    expect(zoneState('bottom')).toEqual({ mounted: true, visible: true });
    expect(shownMode('bottom')).toBe('terminal');
    expect(filesContainer('bottom')).toEqual(['/repo/foo.ts']);
  });

  test('the container never empties between hide and reopen, so the editor is never remounted', () => {
    const store = useUIStore.getState();
    store.openContextFile(directory, '/repo/foo.ts');
    const mounted: boolean[] = [filesContainer('right').length > 0];
    const unsubscribe = useUIStore.subscribe(() => mounted.push(filesContainer('right').length > 0));

    closeFromZoneStrip([FILES_SURFACE_TAB_ID]);
    store.openContextSurface(directory, 'file');
    unsubscribe();

    expect(mounted.every(Boolean)).toBe(true);
    expect(activeFile('right')).toBe('/repo/foo.ts');
  });

  test('the one Files editor stays mounted while Files has an open file, shown or hidden', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'file');
    expect(filesEditorMounted(panel())).toBe(false);

    store.openContextFile(directory, '/repo/foo.ts');
    expect(filesEditorMounted(panel())).toBe(true);
    closeFromZoneStrip([FILES_SURFACE_TAB_ID]);
    expect(filesEditorMounted(panel())).toBe(true);
    store.moveWorkspaceSurface('editor', 'left');
    expect(filesEditorMounted(panel())).toBe(true);

    store.openContextSurface(directory, 'file');
    store.closeContextPanelTab(directory, tabId('/repo/foo.ts'));
    expect(filesEditorMounted(panel())).toBe(false);
  });

  test('hidden files mount only in the zone Files is placed in', () => {
    const tab = (mode: 'file' | 'terminal') => ({ id: mode, mode, touchedAt: 0 });
    expect(mountedFileTabs([tab('terminal')], [tab('file')], true)).toHaveLength(1);
    expect(mountedFileTabs([tab('terminal')], [tab('file')], false)).toHaveLength(0);
  });
});

describe('moving Files', () => {
  test('moves the whole surface with every open file and the one in front', () => {
    const store = useUIStore.getState();
    store.openContextFile(directory, '/repo/foo.ts');
    store.openContextFile(directory, '/repo/bar.ts');
    store.setActiveContextPanelTab(directory, tabId('/repo/foo.ts'));

    store.moveWorkspaceSurface('editor', 'bottom');

    expect(stripOf('bottom')).toEqual(['Files']);
    expect(stripOf('right')).toEqual([]);
    expect(openFiles()).toEqual(['/repo/foo.ts', '/repo/bar.ts']);
    expect(selectVisibleContextZoneTab(useUIStore.getState(), directory, 'bottom')?.targetPath).toBe('/repo/foo.ts');
  });

  test('Files left, Terminal bottom and Git right show at once, the conversation in the center', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('editor', 'left');
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.openContextFile(directory, '/repo/foo.ts');
    store.openContextFile(directory, '/repo/bar.ts');
    store.openContextSurface(directory, 'terminal');
    store.openContextSurface(directory, 'git');

    expect(shownMode('left')).toBe('file');
    expect(shownMode('bottom')).toBe('terminal');
    expect(shownMode('right')).toBe('git');
    expect(shownMode('center')).toBeNull();
    expect(stripOf('left')).toEqual(['Files']);
  });
});

describe('reload', () => {
  const reload = async (change: () => void) => {
    let saved: Parameters<NonNullable<typeof initialPersistOptions.storage>['setItem']>[1] = {
      state: useUIStore.getInitialState(),
      version: initialPersistOptions.version,
    };
    useUIStore.persist.setOptions({ storage: {
      getItem: () => saved,
      setItem: (_name, value) => { saved = value; },
      removeItem: () => undefined,
    } });
    change();
    // Read-only from here, so wiping the live state does not save over it.
    useUIStore.persist.setOptions({ storage: { getItem: () => saved, setItem: () => undefined, removeItem: () => undefined } });
    useUIStore.setState({ contextPanelByDirectory: {}, workspaceLayout: createDefaultWorkspaceLayout() });
    await useUIStore.persist.rehydrate();
  };

  test('saved file tabs come back inside one Files tab in its zone', async () => {
    await reload(() => {
      const store = useUIStore.getState();
      store.moveWorkspaceSurface('editor', 'bottom');
      store.openContextFile(directory, '/repo/foo.ts');
      store.openContextFile(directory, '/repo/bar.ts');
    });

    expect(stripOf('bottom')).toEqual(['Files']);
    expect(openFiles()).toEqual(['/repo/foo.ts', '/repo/bar.ts']);
    expect(shownMode('bottom')).toBe('file');
  });

  test('a closed Files keeps its files across a reload', async () => {
    await reload(() => {
      const store = useUIStore.getState();
      store.openContextFile(directory, '/repo/foo.ts');
      store.openContextFile(directory, '/repo/bar.ts');
      closeFromZoneStrip([FILES_SURFACE_TAB_ID]);
    });
    expect(stripOf('right')).toEqual([]);

    useUIStore.getState().openContextSurface(directory, 'file');

    expect(openFiles()).toEqual(['/repo/foo.ts', '/repo/bar.ts']);
    expect(activeFile('right')).toBe('/repo/bar.ts');
  });

  test('explorer-only Files survives a reload', async () => {
    await reload(() => {
      useUIStore.getState().openContextSurface(directory, 'file');
    });

    expect(stripOf('right')).toEqual(['Files']);
    expect(openFiles()).toEqual([]);
    expect(shownMode('right')).toBe('file');
  });
});

describe('strip helpers', () => {
  const tab = (id: string, mode: 'file' | 'terminal' | 'git', touchedAt = 0) => ({ id, mode, touchedAt });

  test('Files takes the place of its first file', () => {
    const entries = workspaceStripEntries([tab('git', 'git'), tab('file:/a', 'file'), tab('terminal', 'terminal'), tab('file:/b', 'file')]);
    expect(entries.map((entry) => (entry === FILES_SURFACE_TAB_ID ? 'Files' : entry.id))).toEqual(['git', 'Files', 'terminal']);
  });

  test('Files comes to the front on the file used last', () => {
    expect(fileTabToActivate([tab('file:/a', 'file', 5), tab('git', 'git', 9), tab('file:/b', 'file', 3)])?.id).toBe('file:/a');
    expect(fileTabToActivate([tab('git', 'git')])).toBeNull();
  });

  test('dragging Files moves the neighbour across the whole group', () => {
    const tabs = [tab('git', 'git'), tab('file:/a', 'file'), tab('file:/b', 'file'), tab('terminal', 'terminal')];
    // Files dropped on git (to its left): git goes after the last file.
    expect(reorderForStripDrag(FILES_SURFACE_TAB_ID, 'git', tabs)).toEqual(['git', 'file:/b']);
    // Files dropped on terminal (to its right): terminal goes before the first file.
    expect(reorderForStripDrag(FILES_SURFACE_TAB_ID, 'terminal', tabs)).toEqual(['terminal', 'file:/a']);
    expect(reorderForStripDrag('terminal', FILES_SURFACE_TAB_ID, tabs)).toEqual(['terminal', 'file:/a']);
    expect(reorderForStripDrag('git', 'terminal', tabs)).toEqual(['git', 'terminal']);
  });
});

describe('file tabs carry no placement', () => {
  test('the Files entry moves the Files surface, and no file is a zone entry of its own', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'git');
    store.openContextFile(directory, '/repo/foo.ts');
    store.openContextFile(directory, '/repo/bar.ts');
    const tabs = panel()?.tabs ?? [];

    const entries = workspaceStripEntries(tabs).map((entry) => (entry === FILES_SURFACE_TAB_ID ? entry : entry.id));
    expect(entries).toEqual(['git', FILES_SURFACE_TAB_ID]);
    expect(entries.map((id) => stripEntryMode(id, tabs))).toEqual(['git', 'file']);
  });
});

describe('Files keeps its place among the other surfaces', () => {
  const setUp = () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'git');
    store.openContextFile(directory, '/repo/foo.ts');
    store.openContextSurface(directory, 'terminal');
    expect(stripOf('right')).toEqual(['git', 'Files', 'terminal']);
    return store;
  };

  test('opening and closing files leaves Git | Files | Terminal as it was', () => {
    const store = setUp();
    store.openContextFile(directory, '/repo/bar.ts');
    store.closeContextPanelTab(directory, tabId('/repo/foo.ts'));

    expect(stripOf('right')).toEqual(['git', 'Files', 'terminal']);
    expect(openFiles()).toEqual(['/repo/bar.ts']);
  });

  test('reordering files inside Files leaves the zone order alone', () => {
    const store = setUp();
    store.openContextFile(directory, '/repo/bar.ts');
    store.reorderContextPanelTabs(directory, tabId('/repo/bar.ts'), tabId('/repo/foo.ts'));

    expect(openFiles()).toEqual(['/repo/bar.ts', '/repo/foo.ts']);
    expect(stripOf('right')).toEqual(['git', 'Files', 'terminal']);
  });

  test('switching files leaves the zone order alone', () => {
    const store = setUp();
    store.openContextFile(directory, '/repo/bar.ts');
    store.setActiveContextPanelTab(directory, tabId('/repo/foo.ts'));

    expect(stripOf('right')).toEqual(['git', 'Files', 'terminal']);
  });

  test('closing the last file keeps the explorer where Files was, and a new file takes its place', () => {
    const store = setUp();
    store.closeContextPanelTab(directory, tabId('/repo/foo.ts'));
    expect(stripOf('right')).toEqual(['git', 'Files', 'terminal']);

    store.openContextFile(directory, '/repo/baz.ts');
    expect(stripOf('right')).toEqual(['git', 'Files', 'terminal']);
    expect(openFiles()).toEqual(['/repo/baz.ts']);
  });

  test('Files first or last in its zone stays first or last', () => {
    const store = useUIStore.getState();
    store.openContextFile(directory, '/repo/foo.ts');
    store.openContextSurface(directory, 'git');
    store.openContextFile(directory, '/repo/bar.ts');
    store.closeContextPanelTab(directory, tabId('/repo/foo.ts'));
    expect(stripOf('right')).toEqual(['Files', 'git']);

    useUIStore.setState({ contextPanelByDirectory: {} });
    store.openContextSurface(directory, 'git');
    store.openContextFile(directory, '/repo/foo.ts');
    store.openContextFile(directory, '/repo/bar.ts');
    store.closeContextPanelTab(directory, tabId('/repo/bar.ts'));
    expect(stripOf('right')).toEqual(['git', 'Files']);
  });

  test('file tabs saved apart before this come back as one group, where the first one was', async () => {
    const saved = JSON.parse(JSON.stringify(useUIStore.getState().contextPanelByDirectory));
    const store = setUp();
    store.openContextFile(directory, '/repo/bar.ts');
    // Recreate the old scattered order a previous version could save.
    const current = panel();
    if (!current) throw new Error('no panel');
    const byId = new Map(current.tabs.map((tab) => [tab.id, tab]));
    const scattered = ['git', tabId('/repo/foo.ts'), 'terminal', tabId('/repo/bar.ts')].map((id) => byId.get(id));
    useUIStore.setState({ contextPanelByDirectory: { ...saved, [directory]: { ...current, tabs: scattered } } });

    const persisted = { state: { contextPanelByDirectory: useUIStore.getState().contextPanelByDirectory }, version: initialPersistOptions.version };
    useUIStore.persist.setOptions({ storage: {
      getItem: () => persisted,
      setItem: () => undefined,
      removeItem: () => undefined,
    } });
    useUIStore.setState({ contextPanelByDirectory: {} });
    await useUIStore.persist.rehydrate();

    // Drawn as one entry at once; the first change stores them grouped.
    expect(stripOf('right')).toEqual(['git', 'Files', 'terminal']);
    useUIStore.getState().closeContextPanelTab(directory, tabId('/repo/foo.ts'));
    expect(stripOf('right')).toEqual(['git', 'Files', 'terminal']);
    expect(openFiles()).toEqual(['/repo/bar.ts']);
  });
});

describe('a surface in a center without the conversation can be closed', () => {
  const centerShows = () => selectContextZoneTab(useUIStore.getState(), directory, 'center')?.mode ?? null;
  const dockInCenter = (surfaceId: string) => {
    const layout = moveSurfaceToZone(moveSurfaceToZone(createDefaultWorkspaceLayout(), 'chat', 'right'), surfaceId, 'center');
    useUIStore.setState({ workspaceLayout: layout });
  };

  test('the rail toggles Git off in the center', () => {
    dockInCenter('git');
    useUIStore.getState().openContextSurface(directory, 'git');
    expect(centerShows()).toBe('git');

    useUIStore.getState().openContextSurface(directory, 'git');

    expect(centerShows()).toBeNull();
    expect(panel()?.tabs.some((tab) => tab.mode === 'git')).toBe(false);
    useUIStore.getState().openContextSurface(directory, 'git');
    expect(centerShows()).toBe('git');
  });

  test('the rail toggles Terminal off in the center', () => {
    dockInCenter('terminal');
    useUIStore.getState().openContextSurface(directory, 'terminal');

    useUIStore.getState().openContextSurface(directory, 'terminal');

    expect(centerShows()).toBeNull();
  });

  test('toggling Files off in the center hides it with its files, and it comes back', () => {
    dockInCenter('editor');
    const store = useUIStore.getState();
    store.openContextFile(directory, '/repo/foo.ts');
    store.openContextFile(directory, '/repo/bar.ts');

    store.openContextSurface(directory, 'file');
    expect(centerShows()).toBeNull();
    expect((panel()?.hiddenFileTabs ?? []).map((tab) => tab.targetPath)).toEqual(['/repo/foo.ts', '/repo/bar.ts']);

    store.openContextSurface(directory, 'file');
    expect(centerShows()).toBe('file');
    expect(openFiles()).toEqual(['/repo/foo.ts', '/repo/bar.ts']);
  });

  test('another surface in the center comes to the front when the shown one is toggled off', () => {
    dockInCenter('git');
    useUIStore.setState({ workspaceLayout: moveSurfaceToZone(useUIStore.getState().workspaceLayout, 'terminal', 'center') });
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'terminal');
    store.openContextSurface(directory, 'git');

    store.openContextSurface(directory, 'git');

    expect(centerShows()).toBe('terminal');
  });

  test('with the conversation in the center, the right zone still collapses and keeps its tab', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'git');
    store.openContextSurface(directory, 'git');

    expect(panel()?.openZones).toEqual([]);
    expect(panel()?.tabs.some((tab) => tab.mode === 'git')).toBe(true);
  });
});

// The workspace tabs own which files are open; the editor's own list
// (`useFilesViewTabsStore.openPaths`) follows closes. Hiding and moving Files
// touch neither, so reopening can never bring back a file that was closed.
describe('open files stay in step with the editor', () => {
  const editorOpenPaths = () => useFilesViewTabsStore.getState().byRoot[directory]?.openPaths ?? [];
  const openInBoth = (path: string) => {
    useUIStore.getState().openContextFile(directory, path);
    // What ContextPanel does when the file becomes active.
    useFilesViewTabsStore.getState().setSelectedPath(directory, path);
  };

  beforeEach(() => {
    useFilesViewTabsStore.setState({ byRoot: {} });
  });

  test('closing files, one, others or the last, closes them in the editor too', () => {
    openInBoth('/repo/a.ts');
    openInBoth('/repo/b.ts');
    openInBoth('/repo/c.ts');

    useUIStore.getState().closeContextPanelTab(directory, tabId('/repo/a.ts'));
    expect(editorOpenPaths()).toEqual(['/repo/b.ts', '/repo/c.ts']);

    useUIStore.getState().closeContextPanelTabs(directory, [tabId('/repo/b.ts')]);
    expect(editorOpenPaths()).toEqual(['/repo/c.ts']);

    useUIStore.getState().closeContextPanelTab(directory, tabId('/repo/c.ts'));
    expect(editorOpenPaths()).toEqual([]);
    expect(openFiles()).toEqual([]);
  });

  test('hiding, moving and resetting the layout keep both lists as they were', () => {
    openInBoth('/repo/a.ts');
    openInBoth('/repo/b.ts');

    closeFromZoneStrip([FILES_SURFACE_TAB_ID]);
    useUIStore.getState().moveWorkspaceSurface('editor', 'left');
    useUIStore.getState().resetWorkspaceLayout();
    expect(editorOpenPaths()).toEqual(['/repo/a.ts', '/repo/b.ts']);
    expect(filesEditorMounted(panel())).toBe(true);

    useUIStore.getState().openContextSurface(directory, 'file');
    expect(openFiles()).toEqual(['/repo/a.ts', '/repo/b.ts']);
    expect(editorOpenPaths()).toEqual(['/repo/a.ts', '/repo/b.ts']);
    expect(zoneOfMode(useUIStore.getState().workspaceLayout, 'file')).toBe('right');
  });

  test('a hidden file is never listed twice when it is opened again', () => {
    openInBoth('/repo/a.ts');
    closeFromZoneStrip([FILES_SURFACE_TAB_ID]);

    useUIStore.getState().openContextFile(directory, '/repo/a.ts');

    expect(openFiles()).toEqual(['/repo/a.ts']);
    expect(panel()?.hiddenFileTabs).toEqual([]);
  });
});

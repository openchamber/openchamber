import { beforeEach, describe, expect, test } from 'bun:test';
import { CONTEXT_SURFACES, sortContextSurfaces } from '../lib/surfaces/registry';
import { normalizeContextPanelDirectoryKey, useUIStore } from './useUIStore';

beforeEach(() => {
  useUIStore.setState({ contextPanelByDirectory: {}, contextRailOrder: [] });
});

describe('useUIStore context panel tabs', () => {
  test('updates readOnly when an existing chat tab is reopened', () => {
    const directory = '/repo';

    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: 'session:ses_1',
      label: 'Session',
      readOnly: true,
    });

    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: 'session:ses_1',
      label: 'Session',
      readOnly: false,
    });

    const tabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.readOnly).toBe(false);
  });
});

describe('useUIStore openContextSurface', () => {
  const directory = '/repo';

  test('opens a fresh singleton tab when none of that mode exists', () => {
    useUIStore.getState().openContextSurface(directory, 'diff');

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.isOpen).toBe(true);
    expect(state?.tabs.map((tab) => tab.mode)).toEqual(['diff']);
  });

  test('activates the existing tab of the requested mode instead of duplicating it', () => {
    useUIStore.getState().openContextPanelTab(directory, { mode: 'diff' });
    useUIStore.getState().openContextPanelTab(directory, { mode: 'file', targetPath: '/repo/a.ts' });

    useUIStore.getState().openContextSurface(directory, 'diff');

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.tabs.filter((tab) => tab.mode === 'diff')).toHaveLength(1);
    expect(state?.activeTabId).toBe('diff');
    expect(state?.isOpen).toBe(true);
  });

  test('toggles the panel closed when the requested mode is already active and open', () => {
    useUIStore.getState().openContextSurface(directory, 'diff');
    useUIStore.getState().openContextSurface(directory, 'diff');

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.isOpen).toBe(false);
    expect(state?.tabs.map((tab) => tab.mode)).toEqual(['diff']);
  });

  test('uses one canonical key and closes an active surface across path variants', () => {
    const pathVariant = '  \\repo\\nested///  ';
    const canonicalDirectory = '/repo/nested';

    useUIStore.getState().openContextSurface(pathVariant, 'diff');

    expect(normalizeContextPanelDirectoryKey(pathVariant)).toBe(canonicalDirectory);
    expect(useUIStore.getState().contextPanelByDirectory[canonicalDirectory]?.isOpen).toBe(true);
    expect(Object.keys(useUIStore.getState().contextPanelByDirectory)).toEqual([canonicalDirectory]);

    useUIStore.getState().openContextSurface(canonicalDirectory, 'diff');

    expect(useUIStore.getState().contextPanelByDirectory[canonicalDirectory]?.isOpen).toBe(false);
    expect(Object.keys(useUIStore.getState().contextPanelByDirectory)).toEqual([canonicalDirectory]);
  });

  test('normalizes Windows drive casing into the shared context-panel key', () => {
    const pathVariant = ' c:\\repo\\nested/// ';
    const canonicalDirectory = 'C:/repo/nested';

    useUIStore.getState().openContextFile(pathVariant, 'C:/repo/nested/a.ts');

    expect(normalizeContextPanelDirectoryKey(pathVariant)).toBe(canonicalDirectory);
    expect(useUIStore.getState().contextPanelByDirectory[canonicalDirectory]?.tabs[0]?.targetPath)
      .toBe('C:/repo/nested/a.ts');
  });

  test('does nothing for content-driven modes without existing content', () => {
    useUIStore.getState().openContextSurface(directory, 'preview');
    useUIStore.getState().openContextSurface(directory, 'chat');

    expect(useUIStore.getState().contextPanelByDirectory[directory]).toBe(undefined);
  });

  test('opens an empty editor tab that a real file later replaces', () => {
    useUIStore.getState().openContextSurface(directory, 'file');

    let state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.isOpen).toBe(true);
    expect(state?.tabs.map((tab) => tab.mode)).toEqual(['file']);
    expect(state?.tabs[0]?.targetPath).toBe(null);

    useUIStore.getState().openContextFile(directory, '/repo/a.ts');

    state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.tabs.filter((tab) => tab.mode === 'file')).toHaveLength(1);
    expect(state?.tabs.find((tab) => tab.mode === 'file')?.targetPath).toBe('/repo/a.ts');
  });

  test('activates the most recently touched tab of a content-driven mode', () => {
    useUIStore.getState().openContextFile(directory, '/repo/a.ts');
    useUIStore.getState().openContextFile(directory, '/repo/b.ts');
    useUIStore.getState().openContextPanelTab(directory, { mode: 'diff' });

    useUIStore.getState().openContextSurface(directory, 'file');

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId);
    expect(activeTab?.mode).toBe('file');
    expect(activeTab?.targetPath).toBe('/repo/b.ts');
  });
});

describe('useUIStore context-panel persistence migration', () => {
  test('registers the canonical-key migration after persisted version 13', () => {
    expect(useUIStore.persist.getOptions().version).toBe(14);
  });

  test('rehydrates a version-13 snapshot through the version-14 canonical-key migration', async () => {
    const originalStorage = useUIStore.persist.getOptions().storage;
    const persistedState = {
      contextPanelByDirectory: {
        ' c:\\repo\\ ': {
          isOpen: true,
          expanded: false,
          tabs: [{ mode: 'diff', touchedAt: 20 }],
          activeTabId: 'diff',
          widthByMode: { diff: 640 },
          touchedAt: 20,
        },
      },
    };

    useUIStore.persist.setOptions({
      storage: {
        getItem: () => ({ state: persistedState, version: 13 }),
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    });

    try {
      await useUIStore.persist.rehydrate();

      expect(Object.keys(useUIStore.getState().contextPanelByDirectory)).toEqual(['C:/repo']);
      expect(useUIStore.getState().contextPanelByDirectory['C:/repo']).toEqual({
        isOpen: true,
        expanded: false,
        tabs: [{
          id: 'diff',
          mode: 'diff',
          targetPath: null,
          dedupeKey: 'diff',
          label: null,
          sessionTitleFallback: null,
          readOnly: false,
          stagedDiff: false,
          diffScope: 'working',
          touchedAt: 20,
        }],
        activeTabId: 'diff',
        widthByMode: { diff: 640 },
        touchedAt: 20,
      });
    } finally {
      useUIStore.persist.setOptions({ storage: originalStorage });
      useUIStore.setState({ contextPanelByDirectory: {}, contextRailOrder: [] });
    }
  });

  test('merges historical keys that canonicalize to the same directory', async () => {
    const migrate = useUIStore.persist.getOptions().migrate;
    expect(typeof migrate).toBe('function');

    const migrated = await migrate?.({
      contextPanelByDirectory: {
        ' c:\\repo\\ ': {
          isOpen: false,
          expanded: false,
          tabs: [{ mode: 'file', targetPath: 'C:/repo/a.ts', touchedAt: 10 }],
          activeTabId: 'file:C:/repo/a.ts',
          widthByMode: { file: 600, diff: 500 },
          touchedAt: 10,
        },
        'C:/repo///': {
          isOpen: true,
          expanded: true,
          tabs: [
            { mode: 'file', targetPath: 'C:/repo/b.ts', touchedAt: 20 },
            { mode: 'diff', touchedAt: 20 },
          ],
          activeTabId: 'diff',
          widthByMode: { diff: 800 },
          touchedAt: 20,
        },
      },
    }, 13) as { contextPanelByDirectory?: Record<string, {
      isOpen: boolean;
      expanded: boolean;
      tabs: Array<{ id: string; mode: string; targetPath: string | null }>;
      activeTabId: string | null;
      widthByMode: Record<string, number>;
      touchedAt: number;
    }> } | undefined;

    const byDirectory = migrated?.contextPanelByDirectory ?? {};
    expect(Object.keys(byDirectory)).toEqual(['C:/repo']);
    expect({
      isOpen: byDirectory['C:/repo']?.isOpen,
      expanded: byDirectory['C:/repo']?.expanded,
      activeTabId: byDirectory['C:/repo']?.activeTabId,
      widthByMode: byDirectory['C:/repo']?.widthByMode,
      touchedAt: byDirectory['C:/repo']?.touchedAt,
    }).toEqual({
      isOpen: true,
      expanded: true,
      activeTabId: 'diff',
      widthByMode: { file: 600, diff: 800 },
      touchedAt: 20,
    });
    expect(byDirectory['C:/repo']?.tabs.map((tab) => [tab.mode, tab.targetPath])).toEqual([
      ['file', 'C:/repo/a.ts'],
      ['file', 'C:/repo/b.ts'],
      ['diff', null],
    ]);
  });

  test('merges equal-timestamp key collisions independently of persisted key order', async () => {
    const migrate = useUIStore.persist.getOptions().migrate;
    expect(typeof migrate).toBe('function');

    const legacyState = {
      isOpen: false,
      expanded: false,
      tabs: [{ mode: 'diff', label: 'Legacy', touchedAt: 20 }],
      activeTabId: 'diff',
      widthByMode: { diff: 500 },
      touchedAt: 20,
    };
    const canonicalState = {
      isOpen: true,
      expanded: true,
      tabs: [{ mode: 'diff', label: 'Canonical', touchedAt: 20 }],
      activeTabId: 'diff',
      widthByMode: { diff: 800 },
      touchedAt: 20,
    };

    const migrateCollision = async (entries: Array<[string, object]>) => {
      const migrated = await migrate?.({
        contextPanelByDirectory: Object.fromEntries(entries),
      }, 13) as { contextPanelByDirectory?: Record<string, {
        isOpen: boolean;
        expanded: boolean;
        tabs: Array<{ label: string | null }>;
        widthByMode: Record<string, number>;
      }> } | undefined;

      return migrated?.contextPanelByDirectory?.['C:/repo'];
    };

    const legacyFirst = await migrateCollision([
      [' c:\\repo\\ ', legacyState],
      ['C:/repo///', canonicalState],
    ]);
    const canonicalFirst = await migrateCollision([
      ['C:/repo///', canonicalState],
      [' c:\\repo\\ ', legacyState],
    ]);

    expect(canonicalFirst).toEqual(legacyFirst);
    expect({
      isOpen: legacyFirst?.isOpen,
      expanded: legacyFirst?.expanded,
      tabLabels: legacyFirst?.tabs.map((tab) => tab.label),
      widthByMode: legacyFirst?.widthByMode,
    }).toEqual({
      isOpen: true,
      expanded: true,
      tabLabels: ['Canonical'],
      widthByMode: { diff: 800 },
    });
  });
});

describe('useUIStore closeContextPanelTab surface stability', () => {
  const directory = '/repo';

  test('closing an active file tab activates another file tab, not another surface', () => {
    useUIStore.getState().openContextPanelTab(directory, { mode: 'terminal' });
    useUIStore.getState().openContextFile(directory, '/repo/a.ts');
    useUIStore.getState().openContextFile(directory, '/repo/b.ts');

    const stateBefore = useUIStore.getState().contextPanelByDirectory[directory];
    const activeTabId = stateBefore?.activeTabId as string;
    useUIStore.getState().closeContextPanelTab(directory, activeTabId);

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId);
    expect(activeTab?.mode).toBe('file');
    expect(activeTab?.targetPath).toBe('/repo/a.ts');
    expect(state?.isOpen).toBe(true);
  });

  test('closing the last tab of the active surface closes the panel', () => {
    useUIStore.getState().openContextPanelTab(directory, { mode: 'terminal' });
    useUIStore.getState().openContextFile(directory, '/repo/a.ts');

    const stateBefore = useUIStore.getState().contextPanelByDirectory[directory];
    useUIStore.getState().closeContextPanelTab(directory, stateBefore?.activeTabId as string);

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.isOpen).toBe(false);
    expect(state?.tabs.map((tab) => tab.mode)).toEqual(['terminal']);
  });

  test('closing an inactive tab keeps the active tab untouched', () => {
    useUIStore.getState().openContextFile(directory, '/repo/a.ts');
    useUIStore.getState().openContextPanelTab(directory, { mode: 'terminal' });

    const state0 = useUIStore.getState().contextPanelByDirectory[directory];
    const fileTab = state0?.tabs.find((tab) => tab.mode === 'file');
    useUIStore.getState().closeContextPanelTab(directory, fileTab?.id as string);

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.activeTabId).toBe('terminal');
    expect(state?.isOpen).toBe(true);
  });
});

describe('useUIStore per-surface panel widths', () => {
  const directory = '/repo';

  test('setContextPanelWidth stores a clamped manual width for one mode only', () => {
    useUIStore.getState().openContextPanelTab(directory, { mode: 'diff' });
    useUIStore.getState().setContextPanelWidth(directory, 'diff', 700);
    useUIStore.getState().setContextPanelWidth(directory, 'git', 100);

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.widthByMode.diff).toBe(700);
    expect(state?.widthByMode.git).toBe(380);
    expect(state?.widthByMode.browser).toBe(undefined);
  });
});

describe('useUIStore contextRailOrder', () => {
  test('setContextRailOrder drops empty and duplicate ids', () => {
    useUIStore.getState().setContextRailOrder(['diff', 'diff', '', 'editor']);
    expect(useUIStore.getState().contextRailOrder).toEqual(['diff', 'editor']);
  });

  test('sortContextSurfaces applies persisted order and appends missing surfaces', () => {
    const ordered = sortContextSurfaces(['browser', 'unknown-id', 'diff']);
    const ids = ordered.map((surface) => surface.id);

    expect(ids.slice(0, 2)).toEqual(['browser', 'diff']);
    // Assert against the registry itself so this test cannot go stale when a
    // surface is added or removed.
    expect(new Set(ids)).toEqual(new Set(CONTEXT_SURFACES.map((surface) => surface.id)));
    expect(ids).toHaveLength(CONTEXT_SURFACES.length);
  });
});

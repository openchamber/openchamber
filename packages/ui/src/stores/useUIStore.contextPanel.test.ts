import { beforeEach, describe, expect, test } from 'bun:test';
import { CONTEXT_SURFACES, sortContextSurfaces } from '../lib/surfaces/registry';
import { sanitizeContextPanelByDirectory, useUIStore } from './useUIStore';

beforeEach(() => {
  useUIStore.setState({ contextPanelByDirectory: {}, contextRailOrder: [], contextPanelDock: 'right' });
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

describe('useUIStore per-surface panel heights', () => {
  const directory = '/repo';

  test('setContextPanelHeight stores a clamped manual height for one mode only', () => {
    useUIStore.getState().openContextPanelTab(directory, { mode: 'terminal' });
    useUIStore.getState().setContextPanelHeight(directory, 'terminal', 300);
    // Below CONTEXT_PANEL_MIN_HEIGHT (120) and above CONTEXT_PANEL_MAX_HEIGHT (1200).
    useUIStore.getState().setContextPanelHeight(directory, 'git', 10);
    useUIStore.getState().setContextPanelHeight(directory, 'diff', 5000);

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.heightByMode.terminal).toBe(300);
    expect(state?.heightByMode.git).toBe(120);
    expect(state?.heightByMode.diff).toBe(1200);
    expect(state?.heightByMode.browser).toBe(undefined);
  });

  test('heights use the height clamp, not the 380px width minimum', () => {
    useUIStore.getState().setContextPanelHeight(directory, 'terminal', 200);

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    // 200 would have been raised to 380 by clampContextPanelWidth.
    expect(state?.heightByMode.terminal).toBe(200);
  });

  test('width and height maps do not bleed into each other', () => {
    useUIStore.getState().setContextPanelWidth(directory, 'terminal', 900);
    useUIStore.getState().setContextPanelHeight(directory, 'terminal', 240);

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.widthByMode.terminal).toBe(900);
    expect(state?.heightByMode.terminal).toBe(240);
  });
});

describe('sanitizeContextPanelByDirectory size maps', () => {
  const directory = '/repo';

  test('round-trips both size maps independently', () => {
    const sanitized = sanitizeContextPanelByDirectory({
      [directory]: {
        isOpen: true,
        tabs: [{ mode: 'terminal' }],
        activeTabId: 'terminal',
        widthByMode: { terminal: 900 },
        heightByMode: { terminal: 240 },
      },
    });

    expect(sanitized[directory]?.widthByMode).toEqual({ terminal: 900 });
    expect(sanitized[directory]?.heightByMode).toEqual({ terminal: 240 });
  });

  test('defaults heightByMode to empty for snapshots written before the dock setting', () => {
    const sanitized = sanitizeContextPanelByDirectory({
      [directory]: {
        isOpen: true,
        tabs: [{ mode: 'terminal' }],
        widthByMode: { terminal: 900 },
      },
    });

    // No migration: an older snapshot keeps its widths and simply starts with no
    // manual heights, rather than reinterpreting widths as heights.
    expect(sanitized[directory]?.widthByMode).toEqual({ terminal: 900 });
    expect(sanitized[directory]?.heightByMode).toEqual({});
  });

  test('drops malformed and unknown-mode height entries instead of storing them', () => {
    const sanitized = sanitizeContextPanelByDirectory({
      [directory]: {
        isOpen: true,
        tabs: [{ mode: 'terminal' }],
        heightByMode: {
          terminal: 240,
          git: '300',
          pr: Number.NaN,
          diff: null,
          notARealMode: 400,
        },
      },
    });

    expect(sanitized[directory]?.heightByMode).toEqual({ terminal: 240 });
  });

  test('clamps persisted heights on read', () => {
    const sanitized = sanitizeContextPanelByDirectory({
      [directory]: {
        isOpen: true,
        tabs: [{ mode: 'terminal' }],
        heightByMode: { terminal: 5, diff: 9000 },
      },
    });

    expect(sanitized[directory]?.heightByMode).toEqual({ terminal: 120, diff: 1200 });
  });
});

describe('useUIStore contextPanelDock', () => {
  const directory = '/repo';

  test('defaults to right', () => {
    expect(useUIStore.getState().contextPanelDock).toBe('right');
  });

  test('accepts bottom', () => {
    useUIStore.getState().setContextPanelDock('bottom');
    expect(useUIStore.getState().contextPanelDock).toBe('bottom');
  });

  test('resolves anything that is not bottom to right', () => {
    useUIStore.getState().setContextPanelDock('bottom');
    // Out-of-contract values can reach the store from persisted snapshots and
    // remote desktop settings.
    useUIStore.getState().setContextPanelDock('sideways' as 'right');
    expect(useUIStore.getState().contextPanelDock).toBe('right');

    useUIStore.getState().setContextPanelDock('bottom');
    useUIStore.getState().setContextPanelDock(undefined as unknown as 'right');
    expect(useUIStore.getState().contextPanelDock).toBe('right');
  });

  test('switching dock does not mutate either size map', () => {
    useUIStore.getState().setContextPanelWidth(directory, 'terminal', 900);
    useUIStore.getState().setContextPanelHeight(directory, 'terminal', 240);

    const before = useUIStore.getState().contextPanelByDirectory[directory];
    useUIStore.getState().setContextPanelDock('bottom');
    useUIStore.getState().setContextPanelDock('right');
    const after = useUIStore.getState().contextPanelByDirectory[directory];

    expect(after?.widthByMode).toEqual({ terminal: 900 });
    expect(after?.heightByMode).toEqual({ terminal: 240 });
    // The dock is global state; per-directory panel state keeps its reference.
    expect(after).toBe(before);
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

import { beforeEach, describe, expect, test } from 'bun:test';
import { CONTEXT_SURFACES, sortContextSurfaces } from '../lib/surfaces/registry';
import { useUIStore } from './useUIStore';

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

  test('keeps a plan tab that carries its owning project', () => {
    const directory = '/repo';
    const projectRef = { id: 'proj_1', path: '/repo' };

    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'plan',
      projectPlanId: 'plan-1',
      projectPlanRef: projectRef,
      dedupeKey: `plan:${projectRef.id}:plan-1`,
      label: 'My plan',
    });

    const tabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.projectPlanId).toBe('plan-1');
    expect(tabs[0]?.projectPlanRef).toEqual(projectRef);
  });

  test('dedupes plan tabs by owner and plan id, not by plan id alone', () => {
    const directory = '/repo';

    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'plan',
      projectPlanId: 'plan-1',
      projectPlanRef: { id: 'proj_1', path: '/repo' },
      dedupeKey: 'plan:proj_1:plan-1',
    });
    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'plan',
      projectPlanId: 'plan-1',
      projectPlanRef: { id: 'proj_1', path: '/repo' },
      dedupeKey: 'plan:proj_1:plan-1',
    });

    const tabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];
    expect(tabs).toHaveLength(1);
  });

  test('drops persisted plan tabs whose owner is missing instead of guessing it', () => {
    const directory = '/repo';
    const persisted = {
      contextPanelByDirectory: {
        [directory]: {
          isOpen: true,
          expanded: false,
          widthByMode: {},
          touchedAt: 1,
          activeTabId: 'plan:plan-1',
          tabs: [
            // Pre-owner tab: has an id but no projectPlanRef.
            {
              id: 'plan:plan-1',
              mode: 'plan',
              targetPath: null,
              projectPlanId: 'plan-1',
              projectPlanRef: null,
              dedupeKey: 'plan:plan-1',
              label: 'Old plan',
              sessionTitleFallback: null,
              readOnly: false,
              stagedDiff: false,
              diffScope: null,
              touchedAt: 1,
            },
          ],
        },
      },
    };

    // SAFETY: the object mirrors the persisted context-panel shape exactly;
    // setState bypasses the persist middleware's typing, not its migration.
    useUIStore.setState(persisted as never);
    // Sanitization runs whenever panel state is touched; opening a valid tab
    // is the ordinary touch that would flush stale persisted tabs out.
    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'plan',
      projectPlanId: 'plan-2',
      projectPlanRef: { id: 'proj_1', path: '/repo' },
      dedupeKey: 'plan:proj_1:plan-2',
    });

    const tabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.projectPlanId).toBe('plan-2');
  });

  test('keeps a generic filesystem plan tab that has no saved-plan identity', () => {
    const directory = '/repo';
    useUIStore.getState().openContextSurface(directory, 'plan');
    // A later touch runs the same sanitizer rehydrate uses.
    useUIStore.getState().openContextPanelTab(directory, { mode: 'diff' });

    const tabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];
    const planTab = tabs.find((tab) => tab.mode === 'plan');
    expect(planTab).toBeDefined();
    expect(planTab?.projectPlanId).toBeNull();
    expect(planTab?.projectPlanRef).toBeNull();
  });

  test('keeps a persisted generic plan tab through rehydration-like touches', () => {
    const directory = '/repo';
    const persisted = {
      contextPanelByDirectory: {
        [directory]: {
          isOpen: true,
          expanded: false,
          widthByMode: {},
          touchedAt: 1,
          activeTabId: 'plan',
          tabs: [
            {
              id: 'plan',
              mode: 'plan',
              targetPath: null,
              projectPlanId: null,
              projectPlanRef: null,
              dedupeKey: 'plan',
              label: 'Plan',
              sessionTitleFallback: null,
              readOnly: false,
              stagedDiff: false,
              diffScope: null,
              touchedAt: 1,
            },
          ],
        },
      },
    };

    // SAFETY: the object mirrors the persisted context-panel shape exactly;
    // setState bypasses the persist middleware's typing, not its migration.
    useUIStore.setState(persisted as never);
    useUIStore.getState().openContextPanelTab(directory, { mode: 'diff' });

    const tabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];
    expect(tabs.some((tab) => tab.mode === 'plan')).toBe(true);
  });

  test('drops a persisted saved-plan tab carrying an owner but no plan id', () => {
    const directory = '/repo';
    const persisted = {
      contextPanelByDirectory: {
        [directory]: {
          isOpen: true,
          expanded: false,
          widthByMode: {},
          touchedAt: 1,
          activeTabId: null,
          tabs: [
            {
              id: 'plan:proj_1:plan-1',
              mode: 'plan',
              targetPath: null,
              projectPlanId: null,
              projectPlanRef: { id: 'proj_1', path: '/repo' },
              dedupeKey: 'plan:proj_1:plan-1',
              label: 'Half-identified',
              sessionTitleFallback: null,
              readOnly: false,
              stagedDiff: false,
              diffScope: null,
              touchedAt: 1,
            },
          ],
        },
      },
    };

    // SAFETY: the object mirrors the persisted context-panel shape exactly;
    // setState bypasses the persist middleware's typing, not its migration.
    useUIStore.setState(persisted as never);
    useUIStore.getState().openContextPanelTab(directory, { mode: 'diff' });

    const tabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];
    expect(tabs.some((tab) => tab.mode === 'plan')).toBe(false);
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

describe('context panel tab limits', () => {
  test('a surface filling up never evicts another surface tab', () => {
    const directory = '/repo';
    useUIStore.getState().openContextDiff(directory, 'src/app.ts');

    for (let index = 0; index < 20; index += 1) {
      useUIStore.getState().openContextPreview(directory, `http://localhost:${3000 + index}/`);
    }

    const tabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];
    // The diff tab is not on screen while browsing, so losing it would be a
    // disappearance the user never saw happen.
    expect(tabs.some((tab) => tab.mode === 'diff')).toBe(true);
    expect(tabs.filter((tab) => tab.mode === 'browser').length).toBeLessThan(20);
  });

  test('keeps the tab that was just opened', () => {
    const directory = '/repo';
    for (let index = 0; index < 20; index += 1) {
      useUIStore.getState().openContextPreview(directory, `http://localhost:${3000 + index}/`);
    }

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    const tabs = state?.tabs ?? [];
    expect(tabs.some((tab) => tab.id === state?.activeTabId)).toBe(true);
    expect(tabs.some((tab) => tab.targetPath === 'http://localhost:3019/')).toBe(true);
  });
});

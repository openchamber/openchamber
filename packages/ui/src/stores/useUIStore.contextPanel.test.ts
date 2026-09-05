import { beforeEach, describe, expect, test } from 'bun:test';
import { CONTEXT_SURFACES, sortContextSurfaces } from '../lib/surfaces/registry';
import { useTerminalStore } from './useTerminalStore';
import { useUIStore } from './useUIStore';

const getContextPanelTabs = (directory: string) => useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];

const getTerminalTab = (directory: string) => getContextPanelTabs(directory).find((tab) => tab.mode === 'terminal');

beforeEach(() => {
  useUIStore.setState({ contextPanelByDirectory: {}, contextRailOrder: [] });
  useTerminalStore.getState().clearAll();
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

  test('stores a terminal target under the host directory without creating a target root', () => {
    useUIStore.getState().openContextPanelTab('/repo-worktree', {
      mode: 'terminal',
      targetDirectory: '/repo',
    });

    const worktreeState = useUIStore.getState().contextPanelByDirectory['/repo-worktree'];
    const terminalTab = getTerminalTab('/repo-worktree');

    expect(worktreeState?.activeTabId).toBe('terminal');
    expect(worktreeState?.tabs).toHaveLength(1);
    expect(terminalTab?.targetDirectory).toBe('/repo');
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toBe(undefined);
  });

  test('normalizes terminal targets and canonicalizes same-host targets to null', () => {
    useUIStore.getState().openContextPanelTab('/repo-worktree//', {
      mode: 'terminal',
      targetDirectory: ' \\repo\\nested\\ ',
    });

    let terminalTab = getTerminalTab('/repo-worktree');
    expect(terminalTab?.targetDirectory).toBe('/repo/nested');

    useUIStore.getState().openContextPanelTab('/repo-worktree//', {
      mode: 'terminal',
      targetDirectory: '/repo-worktree',
    });

    terminalTab = getTerminalTab('/repo-worktree');
    expect(terminalTab?.targetDirectory).toBe(null);
  });

  test('reopening a terminal tab with null clears a previous target directory', () => {
    useUIStore.getState().openContextPanelTab('/repo-worktree', {
      mode: 'terminal',
      targetDirectory: '/repo',
    });
    useUIStore.getState().openContextPanelTab('/repo-worktree', {
      mode: 'terminal',
      targetDirectory: null,
    });

    const terminalTab = getTerminalTab('/repo-worktree');
    expect(terminalTab?.targetDirectory).toBe(null);
  });

  test('legacy terminal tabs without a target directory sanitize to null on touch', () => {
    // SAFETY: the object mirrors the persisted context-panel shape exactly;
    // setState bypasses the persist middleware's typing, not its migration.
    useUIStore.setState({
      contextPanelByDirectory: {
        '/repo-worktree': {
          isOpen: true,
          expanded: false,
          widthByMode: {},
          touchedAt: 1,
          activeTabId: 'terminal',
          tabs: [
            {
              id: 'terminal',
              mode: 'terminal',
              targetPath: null,
              dedupeKey: 'terminal',
              label: null,
              sessionTitleFallback: null,
              readOnly: false,
              stagedDiff: false,
              diffScope: null,
              touchedAt: 1,
            },
          ],
        },
      },
    } as never);

    useUIStore.getState().openContextPanelTab('/repo-worktree', { mode: 'diff' });

    const terminalTab = getTerminalTab('/repo-worktree');
    expect(terminalTab?.targetDirectory).toBe(null);
  });

  test('persisted terminal tabs keep a normalized target through a rehydration-like touch', () => {
    // SAFETY: the object mirrors the persisted context-panel shape exactly;
    // setState bypasses the persist middleware's typing, not its migration.
    useUIStore.setState({
      contextPanelByDirectory: {
        '/repo-worktree': {
          isOpen: true,
          expanded: false,
          widthByMode: {},
          touchedAt: 1,
          activeTabId: 'terminal',
          tabs: [
            {
              id: 'terminal',
              mode: 'terminal',
              targetPath: null,
              targetDirectory: ' \\repo\\nested\\ ',
              dedupeKey: 'terminal',
              label: null,
              sessionTitleFallback: null,
              readOnly: false,
              stagedDiff: false,
              diffScope: null,
              touchedAt: 1,
            },
          ],
        },
      },
    } as never);

    useUIStore.getState().openContextPanelTab('/repo-worktree', { mode: 'diff' });

    const terminalTab = getTerminalTab('/repo-worktree');
    expect(terminalTab?.targetDirectory).toBe('/repo/nested');
  });

  test('ignores targetDirectory on non-terminal descriptors and sanitized tabs', () => {
    useUIStore.getState().openContextPanelTab('/repo-worktree', {
      mode: 'diff',
      targetDirectory: '/repo',
    });

    const diffTab = getContextPanelTabs('/repo-worktree').find((tab) => tab.mode === 'diff');
    expect(diffTab?.targetDirectory).toBe(null);

    // SAFETY: the object mirrors the persisted context-panel shape exactly;
    // setState bypasses the persist middleware's typing, not its migration.
    useUIStore.setState({
      contextPanelByDirectory: {
        '/repo-worktree': {
          isOpen: true,
          expanded: false,
          widthByMode: {},
          touchedAt: 1,
          activeTabId: 'diff',
          tabs: [
            {
              id: 'diff',
              mode: 'diff',
              targetPath: '/repo/file.ts',
              targetDirectory: '/stale',
              dedupeKey: 'diff',
              label: null,
              sessionTitleFallback: null,
              readOnly: false,
              stagedDiff: false,
              diffScope: 'working',
              touchedAt: 1,
            },
          ],
        },
      },
    } as never);

    useUIStore.getState().openContextPanelTab('/repo-worktree', { mode: 'terminal' });

    const sanitizedDiffTab = getContextPanelTabs('/repo-worktree').find((tab) => tab.mode === 'diff');
    expect(sanitizedDiffTab?.targetDirectory).toBe(null);
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

  test('opening the terminal surface clears a stale target on the singleton tab', () => {
    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'terminal',
      targetDirectory: '/repo-target',
    });

    useUIStore.getState().openContextSurface(directory, 'terminal');

    const terminalTab = getTerminalTab(directory);
    expect(terminalTab?.targetDirectory).toBe(null);
  });

  test('opening the terminal surface retains the target when the target directory still has a running project action', () => {
    // Revisit design: manual terminal open no longer clears a still-live
    // project-action target just to force the host shell back into view.
    useTerminalStore.getState().ensureDirectory('/repo-target');
    const targetTabId = useTerminalStore.getState().getDirectoryState('/repo-target')!.tabs[0]!.id;
    useTerminalStore.getState().setTabPurpose('/repo-target', targetTabId, {
      type: 'project-action',
      actionId: 'build',
      executionId: 'exec-1',
    });
    useTerminalStore.getState().setTabLifecycle('/repo-target', targetTabId, 'running', { expectedExecutionId: 'exec-1' });

    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'terminal',
      targetDirectory: '/repo-target',
    });
    useUIStore.getState().openContextPanelTab(directory, { mode: 'diff' });

    useUIStore.getState().openContextSurface(directory, 'terminal');

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    const terminalTab = getTerminalTab(directory);
    expect(state?.activeTabId).toBe('terminal');
    expect(state?.isOpen).toBe(true);
    expect(terminalTab?.targetDirectory).toBe('/repo-target');
  });

  test('opening the terminal surface retains the target for a hydrated idle project-action placeholder', () => {
    useTerminalStore.getState().ensureDirectory('/repo-target');
    const targetTabId = useTerminalStore.getState().getDirectoryState('/repo-target')!.tabs[0]!.id;
    useTerminalStore.getState().setTabPurpose('/repo-target', targetTabId, {
      type: 'project-action',
      actionId: 'build',
      executionId: null,
    });

    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'terminal',
      targetDirectory: '/repo-target',
    });

    useUIStore.getState().openContextSurface(directory, 'terminal');

    const terminalTab = getTerminalTab(directory);
    expect(terminalTab?.targetDirectory).toBe('/repo-target');
  });

  test('opening the terminal surface clears the target when every action tab in the target directory is exited', () => {
    useTerminalStore.getState().ensureDirectory('/repo-target');
    const firstTargetTabId = useTerminalStore.getState().getDirectoryState('/repo-target')!.tabs[0]!.id;
    useTerminalStore.getState().setTabPurpose('/repo-target', firstTargetTabId, {
      type: 'project-action',
      actionId: 'build',
      executionId: 'exec-1',
    });
    useTerminalStore.getState().setTabLifecycle('/repo-target', firstTargetTabId, 'exited', { expectedExecutionId: 'exec-1' });
    const secondTargetTabId = useTerminalStore.getState().createTab('/repo-target');
    useTerminalStore.getState().setTabPurpose('/repo-target', secondTargetTabId, {
      type: 'project-action',
      actionId: 'test',
      executionId: 'exec-2',
    });
    useTerminalStore.getState().setTabLifecycle('/repo-target', secondTargetTabId, 'exited', { expectedExecutionId: 'exec-2' });

    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'terminal',
      targetDirectory: '/repo-target',
    });

    useUIStore.getState().openContextSurface(directory, 'terminal');

    const terminalTab = getTerminalTab(directory);
    expect(terminalTab?.targetDirectory).toBe(null);
  });

  test('opening the terminal surface clears the target when the target directory has no terminal state', () => {
    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'terminal',
      targetDirectory: '/repo-target',
    });

    useUIStore.getState().openContextSurface(directory, 'terminal');

    const terminalTab = getTerminalTab(directory);
    expect(terminalTab?.targetDirectory).toBe(null);
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

describe('useUIStore closeContextPanelTabs bulk', () => {
  const directory = '/repo';

  test('closing every tab of the only surface closes the panel', () => {
    useUIStore.getState().openContextBrowser(directory, 'https://a.test');
    useUIStore.getState().openContextBrowser(directory, 'https://b.test');
    useUIStore.getState().openContextBrowser(directory, 'https://c.test');

    const state0 = useUIStore.getState().contextPanelByDirectory[directory];
    const ids = state0?.tabs.map((tab) => tab.id) ?? [];
    useUIStore.getState().closeContextPanelTabs(directory, ids);

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.tabs).toHaveLength(0);
    expect(state?.isOpen).toBe(false);
  });

  test('closing all tabs of the active surface closes the panel but keeps other surfaces in state', () => {
    useUIStore.getState().openContextPanelTab(directory, { mode: 'terminal' });
    useUIStore.getState().openContextFile(directory, '/repo/a.ts');
    useUIStore.getState().openContextFile(directory, '/repo/b.ts');

    const state0 = useUIStore.getState().contextPanelByDirectory[directory];
    const fileIds = state0?.tabs.filter((tab) => tab.mode === 'file').map((tab) => tab.id) ?? [];
    useUIStore.getState().closeContextPanelTabs(directory, fileIds);

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.tabs.map((tab) => tab.mode)).toEqual(['terminal']);
    expect(state?.activeTabId).toBe('terminal');
    // Matches the single-close rule: emptying the active surface closes the panel.
    expect(state?.isOpen).toBe(false);
  });

  test('closing only inactive-mode tabs leaves the active tab and panel intact', () => {
    useUIStore.getState().openContextFile(directory, '/repo/a.ts');
    useUIStore.getState().openContextPanelTab(directory, { mode: 'terminal' });

    const state0 = useUIStore.getState().contextPanelByDirectory[directory];
    const fileTab = state0?.tabs.find((tab) => tab.mode === 'file');
    useUIStore.getState().closeContextPanelTabs(directory, [fileTab?.id as string]);

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.activeTabId).toBe('terminal');
    expect(state?.isOpen).toBe(true);
  });

  test('closing a subset of the active surface including the active tab keeps a remaining same-mode tab', () => {
    useUIStore.getState().openContextPanelTab(directory, { mode: 'terminal' });
    useUIStore.getState().openContextFile(directory, '/repo/a.ts');
    useUIStore.getState().openContextFile(directory, '/repo/b.ts');
    useUIStore.getState().openContextFile(directory, '/repo/c.ts');

    const state0 = useUIStore.getState().contextPanelByDirectory[directory];
    const fileTabs = state0?.tabs.filter((tab) => tab.mode === 'file') ?? [];
    const keptFile = fileTabs.find((tab) => tab.targetPath === '/repo/a.ts');
    const closedIds = fileTabs.filter((tab) => tab.id !== keptFile?.id).map((tab) => tab.id);
    expect(state0?.tabs.find((tab) => tab.id === state0.activeTabId)?.targetPath).toBe('/repo/c.ts');

    useUIStore.getState().closeContextPanelTabs(directory, closedIds);

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId);
    expect(activeTab?.mode).toBe('file');
    expect(activeTab?.targetPath).toBe('/repo/a.ts');
    expect(state?.isOpen).toBe(true);
    expect(state?.tabs.some((tab) => tab.mode === 'terminal')).toBe(true);
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

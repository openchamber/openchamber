import { beforeEach, describe, expect, test } from 'bun:test';
import type { GitCommitChangedFile } from '@/lib/api/types';
import { CONTEXT_SURFACES, sortContextSurfaces } from '../lib/surfaces/registry';
import { useTerminalStore } from './useTerminalStore';
import { useUIStore, type GitCommitDiffTarget } from './useUIStore';
import { useGitDiffTabsStore } from './useGitDiffTabsStore';

const buildCommitChangedFile = (overrides: Partial<GitCommitChangedFile> = {}): GitCommitChangedFile => ({
  path: 'src/new-name.ts',
  originalPath: 'src/old-name.ts',
  status: 'R',
  kind: 'file',
  originalObjectId: '1'.repeat(64),
  objectId: '2'.repeat(64),
  insertions: 7,
  deletions: 3,
  isBinary: false,
  ...overrides,
});

const buildCommitDiffTarget = (overrides: Partial<GitCommitDiffTarget> = {}): GitCommitDiffTarget => ({
  commitHash: 'a'.repeat(40),
  parentHash: null,
  file: buildCommitChangedFile(),
  ...overrides,
});

const getContextPanelTabs = (directory: string) => useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];

const getTerminalTab = (directory: string) => getContextPanelTabs(directory).find((tab) => tab.mode === 'terminal');

beforeEach(() => {
  useUIStore.setState({
    contextPanelByDirectory: {},
    contextRailOrder: [],
    gitRepositoryPaneStates: {},
    gitGraphPaneCollapsed: true,
    gitGraphPaneHeight: 280,
  });
  useTerminalStore.getState().clearAll();
  useGitDiffTabsStore.setState({ byDirectory: {} });
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

  test('openContextCommitDiff stores a normalized historical diff target and keeps diff tabs singleton', () => {
    const directory = '/repo';
    const firstTarget = buildCommitDiffTarget();
    const secondTarget = buildCommitDiffTarget({
      commitHash: 'b'.repeat(40),
      parentHash: 'c'.repeat(40),
      file: buildCommitChangedFile({
        path: 'src/second.ts',
        originalPath: 'src/first.ts',
        status: 'R',
        objectId: 'd'.repeat(40),
        originalObjectId: 'e'.repeat(40),
      }),
    });

    useUIStore.getState().openContextCommitDiff(directory, firstTarget);

    let panel = useUIStore.getState().contextPanelByDirectory[directory];
    expect(panel?.isOpen).toBe(true);
    expect(panel?.activeTabId).toBe('diff');
    expect(panel?.tabs).toHaveLength(1);
    expect(panel?.tabs[0]?.targetPath).toBe('src/new-name.ts');
    expect(panel?.tabs[0]?.commitDiffTarget).toEqual(firstTarget);

    useUIStore.getState().openContextCommitDiff(directory, secondTarget);

    panel = useUIStore.getState().contextPanelByDirectory[directory];
    expect(panel?.tabs).toHaveLength(1);
    expect(panel?.tabs[0]?.id).toBe('diff');
    expect(panel?.tabs[0]?.targetPath).toBe('src/second.ts');
    expect(panel?.tabs[0]?.commitDiffTarget).toEqual(secondTarget);
  });

  test('migrate retains valid historical diff targets and clears malformed ones', () => {
    const migrate = useUIStore.persist.getOptions().migrate;
    const migrated = migrate?.({
      contextPanelByDirectory: {
        '/repo-valid': {
          isOpen: true,
          tabs: [{
            mode: 'diff',
            targetPath: 'src/valid.ts',
            commitDiffTarget: buildCommitDiffTarget({
              commitHash: 'f'.repeat(64),
              parentHash: 'a'.repeat(40),
              file: buildCommitChangedFile({
                path: 'src/valid.ts',
                originalPath: 'src/valid-before.ts',
                kind: 'symlink',
                originalObjectId: 'b'.repeat(40),
                objectId: 'c'.repeat(64),
              }),
            }),
          }],
          activeTabId: 'diff',
        },
        '/repo-bad-commit': {
          isOpen: true,
          tabs: [{ mode: 'diff', targetPath: 'src/invalid-commit.ts', commitDiffTarget: buildCommitDiffTarget({ commitHash: 'not-a-hash' }) }],
          activeTabId: 'diff',
        },
        '/repo-bad-parent': {
          isOpen: true,
          tabs: [{ mode: 'diff', targetPath: 'src/invalid-parent.ts', commitDiffTarget: buildCommitDiffTarget({ parentHash: 'xyz' }) }],
          activeTabId: 'diff',
        },
        '/repo-bad-counts': {
          isOpen: true,
          tabs: [{ mode: 'diff', targetPath: 'src/invalid-counts.ts', commitDiffTarget: buildCommitDiffTarget({ file: buildCommitChangedFile({ insertions: -1 }) }) }],
          activeTabId: 'diff',
        },
        '/repo-bad-status': {
          isOpen: true,
          tabs: [{ mode: 'diff', targetPath: 'src/invalid-status.ts', commitDiffTarget: buildCommitDiffTarget({ file: buildCommitChangedFile({ status: 'X' as GitCommitChangedFile['status'] }) }) }],
          activeTabId: 'diff',
        },
        '/repo-bad-kind': {
          isOpen: true,
          tabs: [{ mode: 'diff', targetPath: 'src/invalid-kind.ts', commitDiffTarget: buildCommitDiffTarget({ file: buildCommitChangedFile({ kind: 'folder' as GitCommitChangedFile['kind'] }) }) }],
          activeTabId: 'diff',
        },
        '/repo-bad-path': {
          isOpen: true,
          tabs: [{ mode: 'diff', targetPath: 'src/invalid-path.ts', commitDiffTarget: buildCommitDiffTarget({ file: buildCommitChangedFile({ path: '   ' }) }) }],
          activeTabId: 'diff',
        },
        '/repo-bad-object': {
          isOpen: true,
          tabs: [{ mode: 'diff', targetPath: 'src/invalid-object.ts', commitDiffTarget: buildCommitDiffTarget({ file: buildCommitChangedFile({ objectId: 'oops' }) }) }],
          activeTabId: 'diff',
        },
        '/repo-bad-binary': {
          isOpen: true,
          tabs: [{ mode: 'diff', targetPath: 'src/invalid-binary.ts', commitDiffTarget: buildCommitDiffTarget({ file: buildCommitChangedFile({ isBinary: 'true' as unknown as boolean }) }) }],
          activeTabId: 'diff',
        },
      },
    }, 16);

    const state = JSON.parse(JSON.stringify(migrated ?? {})) as {
      contextPanelByDirectory?: Record<string, { tabs?: Array<{ commitDiffTarget?: GitCommitDiffTarget | null }> }>;
    };

    expect(state.contextPanelByDirectory?.['/repo-valid']?.tabs?.[0]?.commitDiffTarget).toEqual({
      commitHash: 'f'.repeat(64),
      parentHash: 'a'.repeat(40),
      file: {
        path: 'src/valid.ts',
        originalPath: 'src/valid-before.ts',
        status: 'R',
        kind: 'symlink',
        originalObjectId: 'b'.repeat(40),
        objectId: 'c'.repeat(64),
        insertions: 7,
        deletions: 3,
        isBinary: false,
      },
    });
    expect(state.contextPanelByDirectory?.['/repo-bad-commit']?.tabs?.[0]?.commitDiffTarget ?? null).toBeNull();
    expect(state.contextPanelByDirectory?.['/repo-bad-parent']?.tabs?.[0]?.commitDiffTarget ?? null).toBeNull();
    expect(state.contextPanelByDirectory?.['/repo-bad-counts']?.tabs?.[0]?.commitDiffTarget ?? null).toBeNull();
    expect(state.contextPanelByDirectory?.['/repo-bad-status']?.tabs?.[0]?.commitDiffTarget ?? null).toBeNull();
    expect(state.contextPanelByDirectory?.['/repo-bad-kind']?.tabs?.[0]?.commitDiffTarget ?? null).toBeNull();
    expect(state.contextPanelByDirectory?.['/repo-bad-path']?.tabs?.[0]?.commitDiffTarget ?? null).toBeNull();
    expect(state.contextPanelByDirectory?.['/repo-bad-object']?.tabs?.[0]?.commitDiffTarget ?? null).toBeNull();
    expect(state.contextPanelByDirectory?.['/repo-bad-binary']?.tabs?.[0]?.commitDiffTarget ?? null).toBeNull();
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

describe('useUIStore contextGitSplitDiffWidth', () => {
  test('contextGitSplitDiffWidth clamps to [360, 1200]', () => {
    useUIStore.getState().setContextGitSplitDiffWidth(100);
    expect(useUIStore.getState().contextGitSplitDiffWidth).toBe(360);

    useUIStore.getState().setContextGitSplitDiffWidth(800);
    expect(useUIStore.getState().contextGitSplitDiffWidth).toBe(800);

    useUIStore.getState().setContextGitSplitDiffWidth(1500);
    expect(useUIStore.getState().contextGitSplitDiffWidth).toBe(1200);
  });

  test('contextGitSplitDiffWidth ignores NaN and non-finite values', () => {
    const initial = useUIStore.getState().contextGitSplitDiffWidth;

    useUIStore.getState().setContextGitSplitDiffWidth(NaN);
    expect(useUIStore.getState().contextGitSplitDiffWidth).toBe(initial);

    useUIStore.getState().setContextGitSplitDiffWidth(Infinity);
    expect(useUIStore.getState().contextGitSplitDiffWidth).toBe(initial);
  });
});

describe('useUIStore openContextDiff and openContextCommitDiff with git tab', () => {
  test('openContextDiff seeds the inner git diff tabs store', () => {
    const directory = '/repo';
    const path = 'src/file.ts';
    const scope = 'working' as const;

    useUIStore.getState().openContextDiff(directory, path, false, scope);

    const diffStoreState = useGitDiffTabsStore.getState();
    const dirState = diffStoreState.byDirectory[directory];

    expect(dirState?.tabs).toHaveLength(1);
    const tab = dirState?.tabs[0];
    if (tab?.kind !== 'working') {
      throw new Error(`Expected a working tab, got ${tab?.kind}`);
    }
    expect(tab.path).toBe(path);
    expect(tab.scope).toBe(scope);
  });

  test('openContextCommitDiff seeds the inner git diff tabs store', () => {
    const directory = '/repo';
    const target = buildCommitDiffTarget();

    useUIStore.getState().openContextCommitDiff(directory, target);

    const diffStoreState = useGitDiffTabsStore.getState();
    const dirState = diffStoreState.byDirectory[directory];

    expect(dirState?.tabs).toHaveLength(1);
    const tab = dirState?.tabs[0];
    if (tab?.kind !== 'commit') {
      throw new Error(`Expected a commit tab, got ${tab?.kind}`);
    }
    expect(tab.target).toEqual(target);
  });

  test('no-steal-focus: when git tab is active, diff tabs update inner store but activeTabId stays git', () => {
    const directory = '/repo';

    // Open git surface first
    useUIStore.getState().openContextSurface(directory, 'git');

    const panelBefore = useUIStore.getState().contextPanelByDirectory[directory];
    const activeIdBefore = panelBefore?.activeTabId;
    expect(activeIdBefore).toBe('git');
    expect(panelBefore?.isOpen).toBe(true);

    // Open a diff while git tab is active
    useUIStore.getState().openContextDiff(directory, 'src/file.ts', false, 'working');

    const panelAfter = useUIStore.getState().contextPanelByDirectory[directory];
    expect(panelAfter?.activeTabId).toBe('git');
    expect(panelAfter?.isOpen).toBe(true);

    // The singleton diff panel tab is created in the background (not active),
    // so the rail/strip still shows the diff surface entry.
    expect(panelAfter?.tabs.some((tab) => tab.mode === 'diff')).toBe(true);

    // And the diff itself lands in the inner store for the split pane.
    const diffStoreState = useGitDiffTabsStore.getState();
    const dirState = diffStoreState.byDirectory[directory];
    expect(dirState?.tabs).toHaveLength(1);
  });

  test('steal-as-today: when git tab is not active, diff tab becomes active as it does today', () => {
    const directory = '/repo';

    // Open some other tab first
    useUIStore.getState().openContextFile(directory, 'src/other.ts');

    const panelBefore = useUIStore.getState().contextPanelByDirectory[directory];
    const activeIdBefore = panelBefore?.activeTabId;
    expect(activeIdBefore).toBeTruthy();
    expect(typeof activeIdBefore === 'string' && activeIdBefore.startsWith('file:')).toBe(true);

    // Open a diff
    useUIStore.getState().openContextDiff(directory, 'src/file.ts', false, 'working');

    const panelAfter = useUIStore.getState().contextPanelByDirectory[directory];
    const activeIdAfter = panelAfter?.activeTabId;
    expect(activeIdAfter).toBe('diff');
    expect(panelAfter?.isOpen).toBe(true);
  });
});

describe('useUIStore git repository pane state', () => {
  test('stores graph layout once globally and keeps repository pane filters scoped by runtime and normalized directory', () => {
    useUIStore.getState().setGitGraphPaneCollapsed(false);
    useUIStore.getState().setGitGraphPaneHeight(999);
    useUIStore.getState().setGitRepositoryPaneState('/repo///', {
      graphFilterMode: 'manual',
      graphManualRefIds: ['refs/tags/v1', 'refs/tags/v1', ' refs/heads/main '],
    }, 'runtime-a');

    const runtimeA = useUIStore.getState().getGitRepositoryPaneState('/repo', 'runtime-a');
    const runtimeB = useUIStore.getState().getGitRepositoryPaneState('/repo', 'runtime-b');

    expect(useUIStore.getState().gitGraphPaneCollapsed).toBe(false);
    expect(useUIStore.getState().gitGraphPaneHeight).toBe(720);
    expect('previewWidth' in runtimeA).toBe(false);
    expect(runtimeA.graphFilterMode).toBe('manual');
    expect(runtimeA.graphManualRefIds).toEqual(['refs/heads/main', 'refs/tags/v1']);
    expect(runtimeB).toEqual({
      changesCollapsed: false,
      graphFilterMode: 'auto',
      graphManualRefIds: [],
    });
  });

  test('clamps persisted global graph height and includes global graph layout in the persistence projection', () => {
    useUIStore.getState().setGitGraphPaneCollapsed(false);
    useUIStore.getState().setGitGraphPaneHeight(10);
    expect(useUIStore.getState().gitGraphPaneHeight).toBe(180);

    useUIStore.getState().setGitGraphPaneHeight(999);

    const persisted = useUIStore.persist.getOptions().partialize?.(useUIStore.getState());
    const persistedGraphLayout = Object.fromEntries(
      Object.entries(persisted ?? {}).filter(([key]) => key === 'gitGraphPaneCollapsed' || key === 'gitGraphPaneHeight')
    );

    expect(useUIStore.getState().gitGraphPaneHeight).toBe(720);
    expect(persistedGraphLayout).toEqual({
      gitGraphPaneCollapsed: false,
      gitGraphPaneHeight: 720,
    });
  });

  test('sanitizes persisted global graph layout during migration and discards legacy repository graph fields', () => {
    const migrated = useUIStore.persist.getOptions().migrate?.({
      gitGraphPaneCollapsed: 'nope',
      gitGraphPaneHeight: 'bad-height',
      gitRepositoryPaneStates: {
        '["runtime-a","/repo"]': {
          graphCollapsed: false,
          graphHeight: 10,
          previewWidth: 10,
          graphFilterMode: 'manual',
          graphManualRefIds: ['refs/tags/v1', '', 'refs/tags/v1'],
        },
      },
    }, 15);

    const migratedState = JSON.parse(JSON.stringify(migrated));
    const paneStates = migratedState.gitRepositoryPaneStates;

    expect(migratedState.gitGraphPaneCollapsed).toBe(true);
    expect(migratedState.gitGraphPaneHeight).toBe(280);
    expect(paneStates).toEqual({
        '["runtime-a","/repo"]': {
          changesCollapsed: false,
          graphFilterMode: 'manual',
          graphManualRefIds: ['refs/tags/v1'],
          },
    });
    expect('previewWidth' in paneStates['["runtime-a","/repo"]']).toBe(false);
    expect('graphCollapsed' in paneStates['["runtime-a","/repo"]']).toBe(false);
    expect('graphHeight' in paneStates['["runtime-a","/repo"]']).toBe(false);
  });
});

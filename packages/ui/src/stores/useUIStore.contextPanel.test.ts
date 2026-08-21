import { beforeEach, describe, expect, test } from 'bun:test';
import type { GitCommitChangedFile } from '@/lib/api/types';
import { CONTEXT_SURFACES, sortContextSurfaces } from '../lib/surfaces/registry';
import { useUIStore, type GitCommitDiffTarget } from './useUIStore';

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

beforeEach(() => {
  useUIStore.setState({ contextPanelByDirectory: {}, contextRailOrder: [], gitRepositoryPaneStates: {} });
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

describe('useUIStore git repository pane state', () => {
  test('stores repository-scoped pane state by runtime and normalized directory', () => {
    useUIStore.getState().setGitRepositoryPaneState('/repo///', {
      graphCollapsed: false,
      graphHeight: 999,
      graphFilterMode: 'manual',
      graphManualRefIds: ['refs/tags/v1', 'refs/tags/v1', ' refs/heads/main '],
    }, 'runtime-a');

    const runtimeA = useUIStore.getState().getGitRepositoryPaneState('/repo', 'runtime-a');
    const runtimeB = useUIStore.getState().getGitRepositoryPaneState('/repo', 'runtime-b');

    expect(runtimeA.graphCollapsed).toBe(false);
    expect(runtimeA.graphHeight).toBe(720);
    expect('previewWidth' in runtimeA).toBe(false);
    expect(runtimeA.graphFilterMode).toBe('manual');
    expect(runtimeA.graphManualRefIds).toEqual(['refs/heads/main', 'refs/tags/v1']);
    expect(runtimeB).toEqual({
      changesCollapsed: false,
      graphCollapsed: true,
      graphHeight: 280,
      graphFilterMode: 'auto',
      graphManualRefIds: [],
    });
  });

  test('sanitizes persisted repository pane state during migration and discards legacy preview width', () => {
    const migrated = useUIStore.persist.getOptions().migrate?.({
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

    const paneStates = JSON.parse(JSON.stringify(migrated)).gitRepositoryPaneStates;

    expect(paneStates).toEqual({
        '["runtime-a","/repo"]': {
          changesCollapsed: false,
          graphCollapsed: false,
          graphHeight: 180,
          graphFilterMode: 'manual',
          graphManualRefIds: ['refs/tags/v1'],
          },
    });
    expect('previewWidth' in paneStates['["runtime-a","/repo"]']).toBe(false);
  });
});

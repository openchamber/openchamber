import { beforeEach, describe, expect, test } from 'bun:test';
import type { GitCommitChangedFile } from '@/lib/api/types';
import { useGitDiffTabsStore, type DirectoryState } from './useGitDiffTabsStore';
import type { GitCommitDiffTarget } from './useUIStore';

const buildCommitChangedFile = (overrides: Partial<GitCommitChangedFile> = {}): GitCommitChangedFile => ({
  path: 'src/file.ts',
  originalPath: 'src/old-file.ts',
  status: 'M',
  kind: 'file',
  originalObjectId: '1'.repeat(64),
  objectId: '2'.repeat(64),
  insertions: 5,
  deletions: 2,
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
  useGitDiffTabsStore.setState({ byDirectory: {} });
});

describe('useGitDiffTabsStore', () => {
  test('openTab creates a new working tab', () => {
    const directory = '/repo';
    const path = 'src/index.ts';
    const scope = 'working';

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path,
      scope,
    });

    const state = useGitDiffTabsStore.getState().byDirectory[directory];
    expect(state).toBeDefined();
    expect(state?.tabs).toHaveLength(1);

    const tab = state?.tabs[0];
    expect(tab?.kind).toBe('working');
    if (tab?.kind === 'working') {
      expect(tab.path).toBe(path);
      expect(tab.scope).toBe(scope);
    }
    expect(state?.activeTabId).toBe(tab?.id);
  });

  test('openTab creates a new commit tab', () => {
    const directory = '/repo';
    const target = buildCommitDiffTarget();

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'commit',
      target,
    });

    const state = useGitDiffTabsStore.getState().byDirectory[directory];
    expect(state?.tabs).toHaveLength(1);

    const tab = state?.tabs[0];
    expect(tab?.kind).toBe('commit');
    if (tab?.kind === 'commit') {
      expect(tab.target).toEqual(target);
    }
    expect(state?.activeTabId).toBe(tab?.id);
  });

  test('openTab deduplicates working tabs by path', () => {
    const directory = '/repo';
    const path = 'src/index.ts';

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path,
      scope: 'working',
    });

    const firstTab = useGitDiffTabsStore.getState().byDirectory[directory]?.tabs[0];
    const firstId = firstTab?.id;

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path,
      scope: 'staged',
    });

    const state = useGitDiffTabsStore.getState().byDirectory[directory];
    expect(state?.tabs).toHaveLength(1);

    const tab = state?.tabs[0];
    expect(tab?.id).toBe(firstId);
    if (tab?.kind === 'working') {
      expect(tab.scope).toBe('staged');
    }
    expect(state?.activeTabId).toBe(firstId);
  });

  test('openTab deduplicates commit tabs by commitHash and filePath', () => {
    const directory = '/repo';
    const target = buildCommitDiffTarget();

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'commit',
      target,
    });

    const firstTab = useGitDiffTabsStore.getState().byDirectory[directory]?.tabs[0];
    const firstId = firstTab?.id;

    const updatedTarget = buildCommitDiffTarget({ parentHash: 'p'.repeat(40) });
    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'commit',
      target: updatedTarget,
    });

    const state = useGitDiffTabsStore.getState().byDirectory[directory];
    expect(state?.tabs).toHaveLength(1);

    const tab = state?.tabs[0];
    expect(tab?.id).toBe(firstId);
    if (tab?.kind === 'commit') {
      expect(tab.target).toEqual(updatedTarget);
    }
    expect(state?.activeTabId).toBe(firstId);
  });

  test('openTab appends new tab and sets it active', () => {
    const directory = '/repo';

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path: 'src/a.ts',
      scope: 'working',
    });

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path: 'src/b.ts',
      scope: 'working',
    });

    const state = useGitDiffTabsStore.getState().byDirectory[directory];
    expect(state?.tabs).toHaveLength(2);

    const tab1 = state?.tabs[1];
    if (tab1?.kind === 'working') {
      expect(tab1.path).toBe('src/b.ts');
    }
    expect(state?.activeTabId).toBe(tab1?.id);
  });

  test('closeTab removes a tab', () => {
    const directory = '/repo';

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path: 'src/index.ts',
      scope: 'working',
    });

    const tabId = useGitDiffTabsStore.getState().byDirectory[directory]?.tabs[0]?.id;
    expect(tabId).toBeDefined();

    useGitDiffTabsStore.getState().closeTab(directory, tabId!);

    const state = useGitDiffTabsStore.getState().byDirectory[directory];
    expect(state?.tabs).toHaveLength(0);
  });

  test('closeTab activates most recent remaining tab by touchedAt', () => {
    const directory = '/repo';

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path: 'src/a.ts',
      scope: 'working',
    });

    const firstTabId = useGitDiffTabsStore.getState().byDirectory[directory]?.tabs[0]?.id;

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path: 'src/b.ts',
      scope: 'working',
    });

    const secondTabId = useGitDiffTabsStore.getState().byDirectory[directory]?.tabs[1]?.id;

    useGitDiffTabsStore.getState().closeTab(directory, secondTabId!);

    const state = useGitDiffTabsStore.getState().byDirectory[directory];
    expect(state?.tabs).toHaveLength(1);
    expect(state?.activeTabId).toBe(firstTabId);
  });

  test('closeTab when closing non-active tab leaves active tab unchanged', () => {
    const directory = '/repo';

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path: 'src/a.ts',
      scope: 'working',
    });

    const firstTabId = useGitDiffTabsStore.getState().byDirectory[directory]?.tabs[0]?.id;

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path: 'src/b.ts',
      scope: 'working',
    });

    const secondTabId = useGitDiffTabsStore.getState().byDirectory[directory]?.tabs[1]?.id;

    const beforeClose = useGitDiffTabsStore.getState().byDirectory[directory]?.activeTabId;
    expect(beforeClose).toBe(secondTabId);

    useGitDiffTabsStore.getState().closeTab(directory, firstTabId!);

    const state = useGitDiffTabsStore.getState().byDirectory[directory];
    expect(state?.tabs).toHaveLength(1);
    expect(state?.activeTabId).toBe(secondTabId);
  });

  test('setActiveTab changes active tab', () => {
    const directory = '/repo';

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path: 'src/a.ts',
      scope: 'working',
    });

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path: 'src/b.ts',
      scope: 'working',
    });

    const firstTabId = useGitDiffTabsStore.getState().byDirectory[directory]?.tabs[0]?.id;

    useGitDiffTabsStore.getState().setActiveTab(directory, firstTabId!);

    const state = useGitDiffTabsStore.getState().byDirectory[directory];
    expect(state?.activeTabId).toBe(firstTabId);
  });

  test('reorderTabs swaps active and over items', () => {
    const directory = '/repo';

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path: 'src/a.ts',
      scope: 'working',
    });

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path: 'src/b.ts',
      scope: 'working',
    });

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path: 'src/c.ts',
      scope: 'working',
    });

    const tabs = useGitDiffTabsStore.getState().byDirectory[directory]?.tabs ?? [];
    const aId = tabs[0]?.id;
    const cId = tabs[2]?.id;

    useGitDiffTabsStore.getState().reorderTabs(directory, aId!, cId!);

    const state = useGitDiffTabsStore.getState().byDirectory[directory];
    const reorderedTabs = state?.tabs ?? [];
    expect(reorderedTabs[0]?.id).toBe(cId);
    expect(reorderedTabs[2]?.id).toBe(aId);
  });

  test('updateWorkingScope updates scope of working tab', () => {
    const directory = '/repo';
    const path = 'src/index.ts';

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path,
      scope: 'working',
    });

    const tabId = useGitDiffTabsStore.getState().byDirectory[directory]?.tabs[0]?.id;

    useGitDiffTabsStore.getState().updateWorkingScope(directory, tabId!, 'staged');

    const state = useGitDiffTabsStore.getState().byDirectory[directory];
    const tab = state?.tabs[0];
    if (tab?.kind === 'working') {
      expect(tab.scope).toBe('staged');
    }
  });

  test('max 12 tabs per directory, drops oldest by touchedAt', () => {
    const directory = '/repo';

    for (let i = 0; i < 15; i += 1) {
      useGitDiffTabsStore.getState().openTab(directory, {
        kind: 'working',
        path: `src/file${i}.ts`,
        scope: 'working',
      });
    }

    const state = useGitDiffTabsStore.getState().byDirectory[directory];
    expect(state?.tabs).toHaveLength(12);
  });

  test('clamp preserves the newly active tab when timestamps tie', () => {
    const directory = '/repo';
    const originalDateNow = Date.now;
    Date.now = () => 0;

    try {
      for (let i = 0; i < 13; i += 1) {
        useGitDiffTabsStore.getState().openTab(directory, {
          kind: 'working',
          path: `src/file${i}.ts`,
          scope: 'working',
        });
      }

      const state = useGitDiffTabsStore.getState().byDirectory[directory];
      expect(state?.tabs).toHaveLength(12);
      expect(state?.tabs.some((tab) => tab.id === state.activeTabId)).toBe(true);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test('max 20 directories, drops oldest by touchedAt', () => {
    for (let i = 0; i < 25; i += 1) {
      const directory = `/repo${i}`;
      useGitDiffTabsStore.getState().openTab(directory, {
        kind: 'working',
        path: 'src/file.ts',
        scope: 'working',
      });
    }

    const state = useGitDiffTabsStore.getState();
    expect(Object.keys(state.byDirectory)).toHaveLength(20);
  });

  test('clearDirectory removes all tabs for a directory', () => {
    const directory = '/repo';

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path: 'src/a.ts',
      scope: 'working',
    });

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path: 'src/b.ts',
      scope: 'working',
    });

    useGitDiffTabsStore.getState().clearDirectory(directory);

    const state = useGitDiffTabsStore.getState().byDirectory[directory];
    expect(state?.tabs).toHaveLength(0);
  });

  test('sanitizes persisted data on rehydrate, dropping invalid entries', () => {
    const migrate = useGitDiffTabsStore.persist.getOptions().migrate;
    const migrated = migrate?.({
      byDirectory: {
        '/repo-valid': {
          tabs: [{
            id: 'working:/repo-valid/src/valid.ts',
            kind: 'working',
            path: 'src/valid.ts',
            scope: 'working',
            touchedAt: Date.now(),
          }],
          activeTabId: 'working:/repo-valid/src/valid.ts',
        },
        '/repo-invalid': {
          tabs: [
            null, // invalid: null entry
            { id: '', kind: 'working', path: '', scope: 'working', touchedAt: NaN }, // invalid: malformed
          ],
          activeTabId: null,
        },
      },
    }, 1);

    const state = migrated && typeof migrated === 'object' ? migrated as { byDirectory?: Record<string, DirectoryState> } : {};
    const byDirectory = state.byDirectory as Record<string, DirectoryState>;
    const validDir = byDirectory['/repo-valid'];
    const invalidDir = byDirectory['/repo-invalid'];

    expect(validDir?.tabs).toHaveLength(1);

    const validTab = validDir?.tabs[0];
    if (validTab?.kind === 'working') {
      expect(validTab.path).toBe('src/valid.ts');
    }
    expect(invalidDir).toBe(undefined);
  });

  test('normalizes directory paths (removes trailing slashes)', () => {
    const directory = '/repo///';

    useGitDiffTabsStore.getState().openTab(directory, {
      kind: 'working',
      path: 'src/file.ts',
      scope: 'working',
    });

    const state = useGitDiffTabsStore.getState().byDirectory;
    const keys = Object.keys(state);
    expect(keys).toContain('/repo');
  });

  test('preserves UNC share prefix for Windows network paths', () => {
    useGitDiffTabsStore.getState().openTab('\\\\server\\share\\repo', {
      kind: 'working',
      path: 'src/file.ts',
      scope: 'working',
    });

    const state = useGitDiffTabsStore.getState().byDirectory;
    const keys = Object.keys(state);
    expect(keys).toContain('//server/share/repo');
  });
});

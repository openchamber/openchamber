import { createJSONStorage } from 'zustand/middleware';
import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'window');
const testWindow = new Window();
Object.defineProperty(globalThis, 'window', { configurable: true, value: testWindow });
const { migrateSessionDisplayState, sessionRowDisplaySchema, useSessionDisplayStore } = await import('./useSessionDisplayStore');
afterAll(() => {
  testWindow.close();
  if (previousStorage) Object.defineProperty(globalThis, 'window', previousStorage);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('useSessionDisplayStore worktree sorting', () => {
  test('defaults to manual ordering', () => {
    expect(useSessionDisplayStore.getState().worktreeSortOrder).toBe('manual');
  });

  test('v8→v9 starts existing users on manual ordering', () => {
    expect(migrateSessionDisplayState({}, 8).worktreeSortOrder).toBe('manual');
  });
});

describe('useSessionDisplayStore project sorting', () => {
  test('defaults to manual ordering', () => {
    expect(useSessionDisplayStore.getState().projectSortOrder).toBe('manual');
  });

  test('migrates the v2 recent default to manual', () => {
    const migrated = migrateSessionDisplayState({ projectSortOrder: 'recent' }, 2);

    expect(migrated.projectSortOrder).toBe('manual');
  });

  for (const projectSortOrder of ['manual', 'a-z', 'z-a', 'date-added'] as const) {
    test(`preserves the v2 ${projectSortOrder} sort order`, () => {
      const migrated = migrateSessionDisplayState({ projectSortOrder }, 2);

      expect(migrated.projectSortOrder).toBe(projectSortOrder);
    });
  }

  test('v3→v4 drops the removed displayMode key and keeps the rest', () => {
    const migrated = migrateSessionDisplayState(
      { displayMode: 'default', projectSortOrder: 'a-z', showArchivedSessions: true },
      3,
    );

    expect('displayMode' in migrated).toBe(false);
    expect(migrated.projectSortOrder).toBe('a-z');
    expect(migrated.showArchivedSessions).toBe(true);
  });
});

describe('useSessionDisplayStore project display', () => {
  test('defaults to showing all projects without a selected single project', () => {
    expect(useSessionDisplayStore.getState().projectDisplayMode).toBe('all');
    expect(useSessionDisplayStore.getState().singleProjectId).toBeNull();
  });

  test('stores the single-project mode independently from the view mode', () => {
    useSessionDisplayStore.getState().setProjectDisplayMode('single');
    useSessionDisplayStore.getState().setSingleProjectId('project-alpha');
    useSessionDisplayStore.getState().setSidebarViewMode('projects');

    expect(useSessionDisplayStore.getState().projectDisplayMode).toBe('single');
    expect(useSessionDisplayStore.getState().singleProjectId).toBe('project-alpha');
    expect(useSessionDisplayStore.getState().sidebarViewMode).toBe('projects');

    useSessionDisplayStore.setState({
      projectDisplayMode: 'all',
      singleProjectId: null,
      sidebarViewMode: 'timeline',
    });
  });
});

describe('useSessionDisplayStore view mode', () => {
  test('starts new installs on the timeline view', () => {
    expect(useSessionDisplayStore.getState().sidebarViewMode).toBe('timeline');
  });

  test('v9→v10 drops the removed Recent toggle and keeps the rest', () => {
    const migrated = migrateSessionDisplayState({ showRecentSection: true, projectSortOrder: 'a-z' }, 9);

    expect('showRecentSection' in migrated).toBe(false);
    expect(migrated.projectSortOrder).toBe('a-z');
  });

  test('v5→v6 drops the removed grouping key and keeps the rest', () => {
    const migrated = migrateSessionDisplayState(
      { sessionGroupingMode: 'flat', projectSortOrder: 'a-z' },
      5,
    );

    expect('sessionGroupingMode' in migrated).toBe(false);
    expect(migrated.projectSortOrder).toBe('a-z');
  });
});


describe('useSessionDisplayStore animated activity', () => {
  test('hydrates existing v8 data with motion off and retains saved choices', async () => {
    const initialState = useSessionDisplayStore.getState();
    const originalStorage = useSessionDisplayStore.persist.getOptions().storage;
    let stored = JSON.stringify({ version: 8, state: { sidebarViewMode: 'timeline', showRecentSection: false } });
    const storage = createJSONStorage<Partial<ReturnType<typeof useSessionDisplayStore.getState>>>(() => ({
      getItem: () => stored,
      setItem: (_name, value) => { stored = value; },
      removeItem: () => { stored = ''; },
    }));
    useSessionDisplayStore.persist.setOptions({ storage });
    try {
      await useSessionDisplayStore.persist.rehydrate();
      expect(useSessionDisplayStore.getState().animatedActivityIndicators).toBe(false);
      expect(useSessionDisplayStore.getState().sidebarViewMode).toBe('timeline');
      expect(useSessionDisplayStore.persist.getOptions().version).toBe(13);
      useSessionDisplayStore.getState().setAnimatedActivityIndicators(true);
      const enabledSnapshot = stored;
      useSessionDisplayStore.setState({ animatedActivityIndicators: false });
      stored = enabledSnapshot;
      await useSessionDisplayStore.persist.rehydrate();
      expect(useSessionDisplayStore.getState().animatedActivityIndicators).toBe(true);
      expect('showRecentSection' in useSessionDisplayStore.getState()).toBe(false);
    } finally {
      useSessionDisplayStore.persist.setOptions({ storage: originalStorage });
      useSessionDisplayStore.setState(initialState);
    }
  });
});

describe('useSessionDisplayStore sidebar layout', () => {
  const merge = (persisted: Parameters<NonNullable<ReturnType<typeof useSessionDisplayStore.persist.getOptions>['merge']>>[0]) => {
    const mergeOption = useSessionDisplayStore.persist.getOptions().merge;
    if (!mergeOption) throw new Error('the store merges hydrated state');
    return mergeOption(persisted, useSessionDisplayStore.getState());
  };

  test('starts on the default layout', () => {
    expect(useSessionDisplayStore.getState().sidebarLayout.attention).toBe('separate');
    expect(useSessionDisplayStore.getState().sidebarLayout.holdOpenSession).toBe(true);
  });

  test('leaves a missing layout to the default at hydration', () => {
    const current = useSessionDisplayStore.getState();
    expect(merge({ showChatsSection: false }).sidebarLayout).toBe(current.sidebarLayout);
  });

  test('keeps what it understands of a stored layout and defaults the rest', () => {
    const merged = merge({ sidebarLayout: { attention: 'blocked', afterLeave: 'teleport', sectionOrder: ['projects', 'nope', 'chats'] } });
    expect(merged.sidebarLayout.attention).toBe('blocked');
    expect(merged.sidebarLayout.afterLeave).toBe('hold');
    expect(merged.sidebarLayout.sectionOrder.filter((key) => key === 'projects' || key === 'chats')).toEqual(['projects', 'chats']);
  });

  test('drops a stored layout that is not a layout', () => {
    const current = useSessionDisplayStore.getState();
    expect(merge({ sidebarLayout: 'tree' }).sidebarLayout).toBe(current.sidebarLayout);
  });
});

describe('useSessionDisplayStore session row display', () => {
  test('defaults to one-line Tree zone rows with every element shown', () => {
    expect(useSessionDisplayStore.getState().sessionRowDisplay).toEqual({
      zoneLines: 'one',
      listLines: 'two',
      chatsLines: 'one',
      projectLines: 'one',
      showBranch: true,
      showPrBadge: true,
      showProviderLogo: true,
      showProjectIcon: true,
      showGoal: true,
      showTime: true,
      showPinnedMarker: true,
      showDoneHint: true,
      showDirectoryIndicator: true,
    });
  });

  test('v11→v12 folds detailed rows into the zone line count and drops the old key', () => {
    expect(migrateSessionDisplayState({ detailedZoneRows: true }, 11).sessionRowDisplay?.zoneLines).toBe('two');
    expect(migrateSessionDisplayState({ detailedZoneRows: false }, 11).sessionRowDisplay?.zoneLines).toBe('one');
    expect(migrateSessionDisplayState({}, 11).sessionRowDisplay?.zoneLines).toBe('one');
    const migrated = migrateSessionDisplayState({ detailedZoneRows: true }, 11);
    expect('detailedZoneRows' in migrated).toBe(false);
  });

  test('v11→v12 keeps a stored row display and completes it with the defaults', () => {
    const migrated = migrateSessionDisplayState({ sessionRowDisplay: { zoneLines: 'two', showBranch: false } }, 11);
    expect(migrated.sessionRowDisplay).toMatchObject({ zoneLines: 'two', showBranch: false, showPrBadge: true });
  });

  test('v12→v13 folds the List one-line layout option into listLines', () => {
    expect(migrateSessionDisplayState({ sidebarLayout: { timelineCompactRows: true } }, 12).sessionRowDisplay?.listLines).toBe('one');
    expect(migrateSessionDisplayState({ sidebarLayout: { timelineCompactRows: false } }, 12).sessionRowDisplay?.listLines).toBe('two');
    expect(migrateSessionDisplayState({}, 12).sessionRowDisplay?.listLines).toBe('two');
    // A row display that already carries listLines keeps its own value.
    expect(migrateSessionDisplayState({ sidebarLayout: { timelineCompactRows: true }, sessionRowDisplay: { listLines: 'two' } }, 12).sessionRowDisplay?.listLines).toBe('two');
  });

  test('a display saved before the pin, done and directory toggles keeps them shown', () => {
    const parsed = sessionRowDisplaySchema.parse({ zoneLines: 'two', showBranch: false });
    expect(parsed).toEqual({
      zoneLines: 'two',
      listLines: 'two',
      chatsLines: 'one',
      projectLines: 'one',
      showBranch: false,
      showPrBadge: true,
      showProviderLogo: true,
      showProjectIcon: true,
      showGoal: true,
      showTime: true,
      showPinnedMarker: true,
      showDoneHint: true,
      showDirectoryIndicator: true,
    });
  });
});

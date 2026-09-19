import { describe, expect, test } from 'bun:test';
import { migrateSessionDisplayState, useSessionDisplayStore } from './useSessionDisplayStore';

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
      { displayMode: 'default', projectSortOrder: 'a-z', showRecentSection: false, showArchivedSessions: true },
      3,
    );

    expect('displayMode' in migrated).toBe(false);
    expect(migrated.projectSortOrder).toBe('a-z');
    expect(migrated.showRecentSection).toBe(false);
    expect(migrated.showArchivedSessions).toBe(true);
  });
});

describe('useSessionDisplayStore project display', () => {
  test('defaults to showing all projects without a selected single project', () => {
    expect(useSessionDisplayStore.getState().projectDisplayMode).toBe('all');
    expect(useSessionDisplayStore.getState().singleProjectId).toBeNull();
  });

  test('stores the single-project mode independently from session grouping', () => {
    useSessionDisplayStore.getState().setProjectDisplayMode('single');
    useSessionDisplayStore.getState().setSingleProjectId('project-alpha');
    useSessionDisplayStore.getState().setSessionGroupingMode('flat');

    expect(useSessionDisplayStore.getState().projectDisplayMode).toBe('single');
    expect(useSessionDisplayStore.getState().singleProjectId).toBe('project-alpha');
    expect(useSessionDisplayStore.getState().sessionGroupingMode).toBe('flat');

    useSessionDisplayStore.setState({
      projectDisplayMode: 'all',
      singleProjectId: null,
      sessionGroupingMode: 'by-worktree',
    });
  });
});

describe('useSessionDisplayStore animated activity indicators', () => {
  test('defaults to static indicators', () => {
    expect(useSessionDisplayStore.getState().animatedActivityIndicators).toBe(false);
  });

  test('v5→v6 adds the animatedActivityIndicators default without touching other keys', () => {
    const migrated = migrateSessionDisplayState(
      { projectSortOrder: 'a-z', stickyZoneHeaders: false },
      5,
    );

    expect(migrated.animatedActivityIndicators).toBe(false);
    expect(migrated.projectSortOrder).toBe('a-z');
    expect(migrated.stickyZoneHeaders).toBe(false);
  });

  test('v6 state preserves an enabled preference', () => {
    const migrated = migrateSessionDisplayState({ animatedActivityIndicators: true }, 6);

    expect(migrated.animatedActivityIndicators).toBe(true);
  });
});

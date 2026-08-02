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

describe('migrateSessionDisplayState', () => {
  test('v4 state gains mobileLandingMode last-session default', () => {
    const migrated = migrateSessionDisplayState({ showRecentSection: true }, 4);

    expect(migrated.mobileLandingMode).toBe('last-session');
  });

  test('v4 state preserves recents and normalizes an invalid mobile landing mode', () => {
    // Given: v4 can re-persist the v5 field after a v5→v4→v5 round trip.
    const persistedRecents = { mobileLandingMode: 'recents' };
    const persistedGarbage = { mobileLandingMode: 'garbage' };

    // When: each v4 payload migrates to v5.
    const migratedRecents = migrateSessionDisplayState(persistedRecents, 4);
    const migratedGarbage = migrateSessionDisplayState(persistedGarbage, 4);

    // Then: valid data is preserved while invalid data uses the canonical default.
    expect(migratedRecents.mobileLandingMode).toBe('recents');
    expect(migratedGarbage.mobileLandingMode).toBe('last-session');
  });

  test('v5 state keeps a persisted recents preference', () => {
    const migrated = migrateSessionDisplayState({ mobileLandingMode: 'recents' }, 5);

    expect(migrated.mobileLandingMode).toBe('recents');
  });
});

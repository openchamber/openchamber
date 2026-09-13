import { describe, expect, test } from 'bun:test';
import { buildMobileSessionActionItems } from './mobileSessionActions';

describe('buildMobileSessionActionItems', () => {
  const ids = (items: ReturnType<typeof buildMobileSessionActionItems>) => items.map((item) => item.id);

  test('offers pin for an unpinned active session', () => {
    const items = buildMobileSessionActionItems({
      isPinned: false,
      confirmDelete: false,
      title: 'Deploy release',
    });

    expect(ids(items)).toEqual(['pin', 'rename', 'archive', 'delete']);
    expect(items[0].labelKey).toBe('sessions.sidebar.session.menu.pin');
    expect(items[2].labelKey).toBe('sessions.sidebar.bulkActions.archive');
    expect(items[3].labelKey).toBe('sessions.sidebar.bulkActions.delete');
    expect(items[3].destructive).toBe(true);
  });

  test('relabels delete with the session title while confirming', () => {
    const items = buildMobileSessionActionItems({
      isPinned: false,
      confirmDelete: true,
      title: 'Deploy release',
    });

    const remove = items.find((item) => item.id === 'delete');
    expect(remove?.labelKey).toBe('mobile.sessions.confirmDeleteSessionAria');
    expect(remove?.labelParams).toEqual({ title: 'Deploy release' });
    expect(remove?.destructive).toBe(true);
  });
});
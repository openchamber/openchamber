import { describe, expect, test } from 'bun:test';
import { DEFAULT_NOTIFICATION_INBOX_FILTER } from '@/lib/notificationInboxFilter';
import { countInboxUnread, selectInboxNotifications, stabilizeInboxOrder } from './notification-inbox';
import type { NotificationRecord } from './notification-record';

const row = (overrides: Partial<NotificationRecord>): NotificationRecord => ({
  id: overrides.id ?? 'id',
  runtimeKey: overrides.runtimeKey ?? 'local',
  time: overrides.time ?? 1,
  read: overrides.read ?? false,
  title: overrides.title ?? 'Title',
  body: overrides.body ?? '',
  severity: overrides.severity ?? 'info',
  source: overrides.source ?? 'toast',
  dedupeKey: overrides.dedupeKey ?? 'key',
  count: overrides.count ?? 1,
  ...overrides,
});

describe('inbox filter', () => {
  test('hides disabled kinds from the list and unread badge while keeping stored rows', () => {
    const stored = [
      row({ id: 'success', severity: 'success', source: 'toast', title: 'Copied', time: 3 }),
      row({ id: 'info', severity: 'info', source: 'toast', title: 'Saved', time: 2 }),
      row({ id: 'error', severity: 'error', source: 'toast', title: 'Failed', time: 1 }),
    ];
    const visible = selectInboxNotifications(stored, DEFAULT_NOTIFICATION_INBOX_FILTER);
    expect(visible.map((item) => item.id)).toEqual(['error']);
    expect(countInboxUnread(stored, DEFAULT_NOTIFICATION_INBOX_FILTER)).toBe(1);
    expect(stored).toHaveLength(3);

    const allOn = {
      ...DEFAULT_NOTIFICATION_INBOX_FILTER,
      info: true,
      success: true,
    };
    expect(selectInboxNotifications(stored, allOn).map((item) => item.id)).toEqual([
      'success',
      'info',
      'error',
    ]);
    expect(countInboxUnread(stored, allOn)).toBe(3);
  });

  test('hides subtask rows until the inbox checkbox is on', () => {
    const stored = [
      row({ id: 'parent', source: 'session', severity: 'info', time: 2 }),
      row({ id: 'child', source: 'subtask', severity: 'info', time: 1 }),
    ];
    expect(selectInboxNotifications(stored, DEFAULT_NOTIFICATION_INBOX_FILTER).map((item) => item.id))
      .toEqual(['parent']);
    expect(countInboxUnread(stored, DEFAULT_NOTIFICATION_INBOX_FILTER)).toBe(1);
    const withSubtasks = { ...DEFAULT_NOTIFICATION_INBOX_FILTER, sessionSubtask: true };
    expect(selectInboxNotifications(stored, withSubtasks).map((item) => item.id))
      .toEqual(['parent', 'child']);
  });

  test('hides every row when in-app history is off', () => {
    const stored = [
      row({ id: 'error', severity: 'error', source: 'toast', title: 'Failed', time: 1 }),
    ];
    expect(selectInboxNotifications(stored, DEFAULT_NOTIFICATION_INBOX_FILTER, false)).toEqual([]);
    expect(countInboxUnread(stored, DEFAULT_NOTIFICATION_INBOX_FILTER, false)).toBe(0);
  });

  test('sorts unread ahead of read', () => {
    const stored = [
      row({ id: 'old-unread', read: false, severity: 'error', time: 1 }),
      row({ id: 'new-read', read: true, severity: 'error', time: 9 }),
    ];
    expect(selectInboxNotifications(stored, DEFAULT_NOTIFICATION_INBOX_FILTER).map((item) => item.id))
      .toEqual(['old-unread', 'new-read']);
  });

  test('keeps an open-list order when rows become read', () => {
    const unreadFirst = [
      row({ id: 'old-unread', read: false, severity: 'error', time: 1 }),
      row({ id: 'new-read', read: true, severity: 'error', time: 9 }),
    ];
    const afterMarkAll = [
      row({ id: 'new-read', read: true, severity: 'error', time: 9 }),
      row({ id: 'old-unread', read: true, severity: 'error', time: 1 }),
    ];
    const openOrder = unreadFirst.map((item) => item.id);
    expect(stabilizeInboxOrder(openOrder, afterMarkAll).map((item) => item.id))
      .toEqual(['old-unread', 'new-read']);
  });
});

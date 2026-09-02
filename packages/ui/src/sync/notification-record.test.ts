import { describe, expect, test } from 'bun:test';
import {
  formatSessionNotificationContext,
  inboxKindOf,
  mergeDedupedNotification,
  normalizeNotificationAppend,
  parseNotificationRecord,
  pruneNotifications,
  sanitizeNotificationText,
  MAX_NOTIFICATIONS,
  NOTIFICATION_DEDUPE_WINDOW_MS,
  NOTIFICATION_TTL_MS,
  type NotificationRecord,
} from './notification-record';

const record = (overrides: Partial<NotificationRecord> = {}): NotificationRecord => ({
  id: overrides.id ?? 'id-1',
  runtimeKey: overrides.runtimeKey ?? 'local',
  time: overrides.time ?? 1_700_000_000_000,
  read: overrides.read ?? false,
  title: overrides.title ?? 'Copied',
  body: overrides.body ?? '',
  severity: overrides.severity ?? 'success',
  source: overrides.source ?? 'toast',
  dedupeKey: overrides.dedupeKey ?? 'toast:success:::/Copied:',
  count: overrides.count ?? 1,
  ...overrides,
});

describe('sanitizeNotificationText', () => {
  test('drops non-strings and redacts credentials', () => {
    expect(sanitizeNotificationText(null)).toBe('');
    expect(sanitizeNotificationText(false)).toBe('');
    expect(sanitizeNotificationText('Bearer secret-token-value')).toBe('Bearer [REDACTED]');
    expect(sanitizeNotificationText('key sk-abcdefghijklmnopqrstuvwxyz')).toBe('key [REDACTED]');
    expect(sanitizeNotificationText('https://user:pass@example.com/path')).toBe('https://example.com/path');
  });
});

describe('normalizeNotificationAppend', () => {
  test('maps legacy session attention into a durable record', () => {
    const next = normalizeNotificationAppend({
      type: 'error',
      session: 's1',
      directory: '/project',
      viewed: false,
      error: { message: 'boom', code: 'E' },
    }, 'local');
    expect(next.source).toBe('session');
    expect(next.severity).toBe('error');
    expect(next.session).toBe('s1');
    expect(next.body).toBe('boom');
    expect(next.error).toEqual({ name: null, message: 'boom' });
    expect(next.read).toBe(false);
    expect(next.action).toEqual({ type: 'open-session', sessionId: 's1', directory: '/project' });
    expect(inboxKindOf(next)).toBe('sessionError');
  });

  test('puts session title and project in the body', () => {
    const next = normalizeNotificationAppend({
      type: 'turn-complete',
      session: 's1',
      directory: '/project',
      sessionTitle: 'Fix login',
      projectLabel: 'openchamber',
    }, 'local');
    expect(next.source).toBe('session');
    expect(next.body).toBe('Fix login · openchamber');
    expect(inboxKindOf(next)).toBe('sessionFinished');
  });

  test('maps a child session to a hidden-by-default subtask kind', () => {
    const next = normalizeNotificationAppend({
      type: 'error',
      session: 'child',
      directory: '/project',
      sessionTitle: 'Lint',
      projectLabel: 'openchamber',
      subtask: true,
      error: { message: 'boom' },
    }, 'local');
    expect(next.source).toBe('subtask');
    expect(next.title).toBe('Subtask error');
    expect(next.body).toBe('Lint · openchamber\nboom');
    expect(inboxKindOf(next)).toBe('sessionSubtask');
  });
});

describe('formatSessionNotificationContext', () => {
  test('joins distinct title and project', () => {
    expect(formatSessionNotificationContext('Fix login', 'openchamber')).toBe('Fix login · openchamber');
    expect(formatSessionNotificationContext('openchamber', 'openchamber')).toBe('openchamber');
    expect(formatSessionNotificationContext('Fix login', '')).toBe('Fix login');
    expect(formatSessionNotificationContext(undefined, 'openchamber')).toBe('openchamber');
    expect(formatSessionNotificationContext(
      'Можливості асистента',
      'session-54b733e2-6a69-45d1-98a9-4666816d3f9e',
    )).toBe('Можливості асистента');
  });
});

describe('parseNotificationRecord', () => {
  test('treats malformed payloads as missing', () => {
    expect(parseNotificationRecord(null, 'local')).toBeNull();
    expect(parseNotificationRecord({ title: 'x' }, 'local')).toBeNull();
    expect(parseNotificationRecord({
      source: 'toast',
      severity: 'info',
      title: { message: 'nope' },
      time: Date.now(),
    }, 'local')).toBeNull();
  });

  test('migrates viewed to read', () => {
    const parsed = parseNotificationRecord({
      id: 'n1',
      source: 'toast',
      severity: 'error',
      title: 'Failed',
      time: 10,
      viewed: true,
    }, 'local');
    expect(parsed?.read).toBe(true);
  });

  test('rebuilds open-session action from session fields', () => {
    const parsed = parseNotificationRecord({
      type: 'turn-complete',
      session: 's1',
      directory: '/proj',
      time: 10,
      viewed: false,
    }, 'local');
    expect(parsed?.source).toBe('session');
    expect(parsed?.action).toEqual({ type: 'open-session', sessionId: 's1', directory: '/proj' });
  });

  test('rebuilds open-session action for a persisted subtask row', () => {
    const parsed = parseNotificationRecord({
      source: 'subtask',
      severity: 'info',
      title: 'Subtask finished',
      session: 'child',
      directory: '/proj',
      time: 10,
    }, 'local');
    expect(parsed?.source).toBe('subtask');
    expect(parsed?.action).toEqual({ type: 'open-session', sessionId: 'child', directory: '/proj' });
  });
});

describe('dedup and prune', () => {
  test('collapses unread repeats inside the window', () => {
    const first = record({ id: 'a', time: 1000, dedupeKey: 'same' });
    const second = record({ id: 'b', time: 1000 + NOTIFICATION_DEDUPE_WINDOW_MS - 1, dedupeKey: 'same', title: 'Copied again' });
    const merged = mergeDedupedNotification([first], second);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.count).toBe(2);
    expect(merged[0]?.title).toBe('Copied again');
  });

  test('does not collapse a read row', () => {
    const first = record({ id: 'a', read: true, dedupeKey: 'same' });
    const second = record({ id: 'b', dedupeKey: 'same' });
    expect(mergeDedupedNotification([first], second)).toHaveLength(2);
  });

  test('mints a new id when a reused caller id is appended after the window', () => {
    const first = record({ id: 'small-model-unavailable', time: 1000, dedupeKey: 'same' });
    const second = record({
      id: 'small-model-unavailable',
      time: 1000 + NOTIFICATION_DEDUPE_WINDOW_MS + 1,
      dedupeKey: 'same',
      title: 'Again',
    });
    const merged = mergeDedupedNotification([first], second);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.id).toBe('small-model-unavailable');
    expect(merged[1]?.id).not.toBe('small-model-unavailable');
    expect(merged[1]?.title).toBe('Again');
  });

  test('remints colliding persisted ids while pruning', () => {
    const now = Date.now();
    const pruned = pruneNotifications([
      record({ id: 'dup', time: now - 2, title: 'First' }),
      record({ id: 'dup', time: now - 1, title: 'Second' }),
    ]);
    expect(pruned).toHaveLength(2);
    expect(pruned[0]?.id).toBe('dup');
    expect(pruned[1]?.id).not.toBe(pruned[0]?.id);
    expect(pruned[1]?.title).toBe('Second');
  });

  test('keeps the newest records when over cap', () => {
    const now = Date.now();
    const list = Array.from({ length: MAX_NOTIFICATIONS + 5 }, (_, index) => record({
      id: `n-${index}`,
      time: now - (MAX_NOTIFICATIONS + 5 - index),
      title: `n-${index}`,
    }));
    const pruned = pruneNotifications(list);
    expect(pruned).toHaveLength(MAX_NOTIFICATIONS);
    expect(pruned[0]?.id).toBe('n-5');
  });

  test('drops records older than the TTL', () => {
    const now = Date.now();
    const pruned = pruneNotifications([
      record({ id: 'old', time: now - NOTIFICATION_TTL_MS - 1 }),
      record({ id: 'fresh', time: now }),
    ]);
    expect(pruned.map((item) => item.id)).toEqual(['fresh']);
  });
});

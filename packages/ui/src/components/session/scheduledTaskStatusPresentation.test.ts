import { describe, expect, test } from 'bun:test';

import { dict as enDict } from '@/lib/i18n/messages/en';
import { formatMessage, type I18nKey, type I18nParams } from '@/lib/i18n';
import type { ScheduledTaskStatus } from '@/lib/scheduledTasksApi';
import { STATUS_META, getScheduledTaskStatusLabel } from './scheduledTaskStatusPresentation';

const t = (key: I18nKey, params?: I18nParams): string => formatMessage(enDict, key, params);

const ALL_STATUSES: ScheduledTaskStatus[] = ['idle', 'running', 'success', 'error', 'denied'];

describe('scheduledTaskStatusPresentation', () => {
  test('STATUS_META has a presentation entry for every ScheduledTaskStatus, including denied', () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_META[status]).toBeDefined();
    }
  });

  test('a denied task is presented with the error tone and a shield icon', () => {
    // Regression: a preflight-denied run previously had no STATUS_META
    // entry, so `meta.tone` crashed with a TypeError when rendering the
    // last-run row for a denied task.
    expect(STATUS_META.denied).toEqual({ tone: 'error', Icon: 'shield' });
  });

  test('getScheduledTaskStatusLabel resolves the denied status to its own label, not "Success"', () => {
    // Regression: the SSE parser used to coerce an unrecognized 'denied'
    // status to 'success'. This asserts the presentation layer keeps
    // 'denied' distinct once the status reaches the UI.
    expect(getScheduledTaskStatusLabel('denied', t)).toBe('Denied');
    expect(getScheduledTaskStatusLabel('denied', t)).not.toBe(getScheduledTaskStatusLabel('success', t));
  });

  test('getScheduledTaskStatusLabel resolves every other status to its matching label', () => {
    expect(getScheduledTaskStatusLabel('success', t)).toBe('Success');
    expect(getScheduledTaskStatusLabel('error', t)).toBe('Error');
    expect(getScheduledTaskStatusLabel('running', t)).toBe('Running');
    expect(getScheduledTaskStatusLabel('idle', t)).toBe('Idle');
  });
});

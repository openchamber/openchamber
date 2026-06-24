import { describe, expect, it } from 'vitest';
import { computeNextRunAt, expandScheduledTaskPlaceholders, formatScheduledSessionTitle, parseScheduledCommandPrompt } from './runtime.js';

describe('scheduled-tasks runtime helpers', () => {
  it('computes next daily run in timezone', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 8, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:30'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 30, 0));
  });

  it('computes weekly next run using weekdays', () => {
    // Monday 2025-01-06 10:00:00 UTC
    const nowUtc = Date.UTC(2025, 0, 6, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'weekly',
        times: ['09:00'],
        weekdays: [1, 3],
        timezone: 'UTC',
      },
    }, nowUtc);

    // Wednesday 2025-01-08 09:00:00 UTC
    expect(next).toBe(Date.UTC(2025, 0, 8, 9, 0, 0));
  });

  it('picks nearest time from multiple daily times', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 9, 20, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:15', '09:45', '18:00'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 45, 0));
  });

  it('computes one-time next run for future date', () => {
    const nowUtc = Date.UTC(2026, 3, 15, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2026, 3, 16, 13, 30, 0));
  });

  it('returns null for past one-time schedule', () => {
    const nowUtc = Date.UTC(2026, 3, 16, 14, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBeNull();
  });

  it('formats session title with timestamp suffix', () => {
    const title = formatScheduledSessionTitle({
      name: 'Morning Sync',
      schedule: { timezone: 'UTC' },
    }, Date.UTC(2025, 2, 10, 7, 5, 0));

    expect(title).toBe('Morning Sync 2025-03-10 07:05');
  });

  it('parses slash command prompt for scheduled command mode', () => {
    expect(parseScheduledCommandPrompt('/review src/components')).toEqual({
      command: 'review',
      arguments: 'src/components',
    });
  });

  it('returns null when prompt is not a slash command', () => {
    expect(parseScheduledCommandPrompt('Summarize open issues')).toBeNull();
    expect(parseScheduledCommandPrompt('/')).toBeNull();
  });
});

describe('expandScheduledTaskPlaceholders', () => {
  const scheduledTimeMs = Date.UTC(2025, 5, 15, 9, 30, 0);

  it('replaces {{scheduled_time}} with default format', () => {
    const result = expandScheduledTaskPlaceholders(
      'Review changes since {{scheduled_time}}',
      scheduledTimeMs,
      'UTC',
    );
    expect(result).toBe('Review changes since 2025-06-15T09:30:00.000Z');
  });

  it('replaces {{scheduled_time:yyyy-LL-dd}} with date only', () => {
    const result = expandScheduledTaskPlaceholders(
      'Generate report for {{scheduled_time:yyyy-LL-dd}}',
      scheduledTimeMs,
      'UTC',
    );
    expect(result).toBe('Generate report for 2025-06-15');
  });

  it('replaces {{scheduled_time:HH:mm}} with time only', () => {
    const result = expandScheduledTaskPlaceholders(
      'The task runs at {{scheduled_time:HH:mm}}',
      scheduledTimeMs,
      'UTC',
    );
    expect(result).toBe('The task runs at 09:30');
  });

  it('replaces multiple placeholders in one prompt', () => {
    const result = expandScheduledTaskPlaceholders(
      'Date={{scheduled_time:yyyy-LL-dd}} Time={{scheduled_time:HH:mm}}',
      scheduledTimeMs,
      'UTC',
    );
    expect(result).toBe('Date=2025-06-15 Time=09:30');
  });

  it('respects timezone for non-UTC zones', () => {
    const result = expandScheduledTaskPlaceholders(
      '{{scheduled_time:yyyy-LL-dd HH:mm}}',
      scheduledTimeMs,
      'America/New_York',
    );
    expect(result).toBe('2025-06-15 05:30');
  });

  it('returns original text when no placeholders present', () => {
    const text = 'No placeholders here';
    const result = expandScheduledTaskPlaceholders(text, scheduledTimeMs, 'UTC');
    expect(result).toBe(text);
  });

  it('returns original text when scheduledTimeMs is not finite', () => {
    const text = 'Hello {{scheduled_time}}';
    const result = expandScheduledTaskPlaceholders(text, NaN, 'UTC');
    expect(result).toBe(text);
  });

  it('returns original text when input is not a string', () => {
    const result = expandScheduledTaskPlaceholders(null, scheduledTimeMs, 'UTC');
    expect(result).toBeNull();
  });

  it('handles whitespace inside placeholders', () => {
    const result = expandScheduledTaskPlaceholders(
      '{{ scheduled_time: yyyy-LL-dd }}',
      scheduledTimeMs,
      'UTC',
    );
    expect(result).toBe('2025-06-15');
  });

  it('treats colon without format token as default format', () => {
    const result = expandScheduledTaskPlaceholders(
      '{{scheduled_time:}}',
      scheduledTimeMs,
      'UTC',
    );
    expect(result).toBe('2025-06-15T09:30:00.000Z');
  });
});

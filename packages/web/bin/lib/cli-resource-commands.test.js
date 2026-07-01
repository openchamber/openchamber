import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli-args.js';
import { truncate, formatRelativeTime, formatModel, formatSchedule, formatInstant } from './cli-format.js';
import { resolveScopeDirectory } from './cli-api-client.js';

describe('cli-format helpers', () => {
  it('truncates long strings with an ellipsis', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello world', 5)).toBe('hell…');
    expect(truncate(undefined, 5)).toBe('');
  });

  it('formats relative time buckets', () => {
    const now = 1_000_000_000_000;
    expect(formatRelativeTime(now, now)).toBe('0s ago');
    expect(formatRelativeTime(now - 5_000, now)).toBe('5s ago');
    expect(formatRelativeTime(now - 120_000, now)).toBe('2m ago');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatRelativeTime(0, now)).toBe('unknown');
  });

  it('formats provider/model identifiers', () => {
    expect(formatModel({ providerID: 'google', id: 'gemini' })).toBe('google/gemini');
    expect(formatModel({ providerID: 'google', modelID: 'gemini' })).toBe('google/gemini');
    expect(formatModel({ id: 'solo' })).toBe('solo');
    expect(formatModel(null)).toBe('');
  });

  it('formats schedule summaries for each kind', () => {
    expect(formatSchedule({ kind: 'daily', times: ['09:00', '17:30'], timezone: 'UTC' }))
      .toBe('daily at 09:00, 17:30 (UTC)');
    expect(formatSchedule({ kind: 'weekly', times: ['08:00'], weekdays: [1, 3, 5], timezone: 'UTC' }))
      .toBe('weekly on Mon, Wed, Fri at 08:00 (UTC)');
    expect(formatSchedule({ kind: 'once', date: '2026-04-16', time: '13:30', timezone: 'UTC' }))
      .toBe('once on 2026-04-16 13:30 (UTC)');
    expect(formatSchedule({ kind: 'cron', cron: '0 2 * * *', timezone: 'UTC' }))
      .toBe('cron "0 2 * * *" (UTC)');
    expect(formatSchedule(null)).toBe('unknown schedule');
  });

  it('formats instants in a timezone and guards empty values', () => {
    expect(formatInstant(Date.UTC(2026, 3, 16, 13, 30, 0), 'UTC')).toBe('2026-04-16 13:30');
    expect(formatInstant(0, 'UTC')).toBeNull();
    expect(formatInstant(undefined)).toBeNull();
  });
});

describe('cli-api-client helpers', () => {
  it('resolves an explicit directory over cwd', () => {
    expect(resolveScopeDirectory({ directory: '/explicit' })).toBe('/explicit');
    expect(resolveScopeDirectory({})).toBe(process.cwd());
  });
});

describe('parseArgs resource flags', () => {
  it('parses session list with directory and all flags into positionals', () => {
    const parsed = parseArgs(['session', 'list', '--directory', '/repo', '--all', '--json']);
    expect(parsed.command).toBe('session');
    expect(parsed.positionals).toEqual(['session', 'list']);
    expect(parsed.options.directory).toBe('/repo');
    expect(parsed.options.all).toBe(true);
    expect(parsed.options.json).toBe(true);
  });

  it('captures resource action and id positionals', () => {
    const parsed = parseArgs(['session', 'show', 'ses_abc']);
    expect(parsed.positionals).toEqual(['session', 'show', 'ses_abc']);
  });

  it('maps --yes to force', () => {
    const parsed = parseArgs(['session', 'delete', 'ses_abc', '--yes']);
    expect(parsed.options.force).toBe(true);
  });

  it('parses --command into commandStr (distinct from the command positional)', () => {
    const parsed = parseArgs(['mcp', 'create', 'fs', '--command', 'npx server']);
    expect(parsed.command).toBe('mcp');
    expect(parsed.options.commandStr).toBe('npx server');
  });

  it('parses schedule flags (project/kind/at/on/cron/timezone/disabled)', () => {
    const parsed = parseArgs([
      'schedule', 'create', 'Daily Standup',
      '--project', '/home/me/app',
      '--kind', 'weekly',
      '--at', '09:00,17:30',
      '--on', 'mon,wed',
      '--timezone', 'UTC',
      '--disabled',
    ]);
    expect(parsed.command).toBe('schedule');
    expect(parsed.positionals).toEqual(['schedule', 'create', 'Daily Standup']);
    expect(parsed.options.projectId).toBe('/home/me/app');
    expect(parsed.options.kind).toBe('weekly');
    expect(parsed.options.at).toBe('09:00,17:30');
    expect(parsed.options.on).toBe('mon,wed');
    expect(parsed.options.timezone).toBe('UTC');
    expect(parsed.options.disabled).toBe(true);
  });

  it('parses --cron and --tz alias for schedule', () => {
    const parsed = parseArgs(['schedule', 'create', 'nightly', '--cron', '0 2 * * *', '--tz', 'Europe/London']);
    expect(parsed.options.cron).toBe('0 2 * * *');
    expect(parsed.options.timezone).toBe('Europe/London');
  });

  it('parses scope, template, prompt, content, and description flags', () => {
    const parsed = parseArgs([
      'agent', 'create', 'rev',
      '--scope', 'user',
      '--prompt', 'be careful',
      '--description', 'reviewer',
    ]);
    expect(parsed.options.scope).toBe('user');
    expect(parsed.options.prompt).toBe('be careful');
    expect(parsed.options.description).toBe('reviewer');
  });
});

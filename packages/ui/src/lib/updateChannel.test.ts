import { describe, expect, test } from 'bun:test';

import { formatCanaryBuild, formatCanaryBuildDate, isUpdateChannel, parseCanaryVersion } from './updateChannel';

describe('parseCanaryVersion', () => {
  test('reads the release and the build day out of a Canary version', () => {
    const parsed = parseCanaryVersion('2.5.4-canary.20261030.123');
    expect(parsed?.release).toBe('2.5.4');
    expect(parsed?.builtOn.toISOString()).toBe('2026-10-30T00:00:00.000Z');
    expect(parseCanaryVersion('v2.5.4-canary.20261030')?.release).toBe('2.5.4');
  });

  test('is null for release and other versions', () => {
    for (const version of ['2.5.4', '2.5.4-beta.1', '2.5.4-canary.12', 'canary', '', null, undefined]) {
      expect(parseCanaryVersion(version)).toBeNull();
    }
  });
});

test('formatCanaryBuildDate names the day in the locale, unmoved by the time zone', () => {
  const builtOn = new Date(Date.UTC(2026, 9, 30));
  expect(formatCanaryBuildDate(builtOn, 'en-US')).toBe('Oct 30');
  expect(formatCanaryBuildDate(builtOn, 'en-GB')).toBe('30 Oct');
  expect(formatCanaryBuildDate(builtOn, 'uk')).toBe('30 жовт.');
});

test('formatCanaryBuild adds the build number only beside another build of the same day', () => {
  const morning = parseCanaryVersion('2.5.4-canary.20261030.123')!;
  const evening = parseCanaryVersion('2.5.4-canary.20261030.124')!;
  const nextDay = parseCanaryVersion('2.5.4-canary.20261031.125')!;
  expect(formatCanaryBuild(morning, 'en-US')).toBe('Oct 30');
  expect(formatCanaryBuild(morning, 'en-US', nextDay)).toBe('Oct 30');
  expect(formatCanaryBuild(morning, 'en-US', morning)).toBe('Oct 30');
  expect(formatCanaryBuild(morning, 'en-US', evening)).toBe('Oct 30 #123');
  expect(formatCanaryBuild(evening, 'en-US', morning)).toBe('Oct 30 #124');
});

test('isUpdateChannel accepts the two channels only', () => {
  expect(['stable', 'canary', 'beta', '', undefined].map(isUpdateChannel)).toEqual([true, true, false, false, false]);
});

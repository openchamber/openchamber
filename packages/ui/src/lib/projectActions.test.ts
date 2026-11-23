import { describe, expect, test } from 'bun:test';

import { isProjectActionForPlatform } from './projectActions';

describe('project actions for the server platform', () => {
  const windowsOnly = { platforms: ['windows' as const] };

  test('hides an action meant for another operating system than the server runs', () => {
    expect(isProjectActionForPlatform(windowsOnly, 'macos')).toBe(false);
    expect(isProjectActionForPlatform(windowsOnly, 'windows')).toBe(true);
    expect(isProjectActionForPlatform({ platforms: ['macos', 'linux'] }, 'linux')).toBe(true);
  });

  test('keeps an action without platforms everywhere', () => {
    expect(isProjectActionForPlatform({}, 'linux')).toBe(true);
    expect(isProjectActionForPlatform({ platforms: [] }, null)).toBe(true);
  });

  test('a server on another OS keeps only unrestricted actions; one that does not say keeps all', () => {
    expect(isProjectActionForPlatform(windowsOnly, null)).toBe(false);
    expect(isProjectActionForPlatform(windowsOnly, undefined)).toBe(true);
  });
});

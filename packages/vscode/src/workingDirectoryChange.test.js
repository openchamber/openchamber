import { describe, expect, test } from 'bun:test';
import { resolveWorkingDirectoryChange } from './workingDirectoryChange.ts';

describe('resolveWorkingDirectoryChange', () => {
  test('returns unchanged when the selected directory already matches', () => {
    expect(resolveWorkingDirectoryChange('/work/alpha', '/work/alpha')).toEqual({
      changed: false,
      path: '/work/alpha',
      restarted: false,
    });
  });

  test('updates the directory without requiring an OpenCode server restart', () => {
    expect(resolveWorkingDirectoryChange('/work/alpha', '/work/bravo')).toEqual({
      changed: true,
      path: '/work/bravo',
      restarted: false,
    });
  });

  test('trims the selected directory before comparing', () => {
    expect(resolveWorkingDirectoryChange('/work/alpha', '  /work/bravo  ')).toEqual({
      changed: true,
      path: '/work/bravo',
      restarted: false,
    });
  });
});

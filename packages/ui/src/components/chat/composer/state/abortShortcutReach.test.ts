import { describe, expect, test } from 'bun:test';

import { abortShortcutReachesComposer } from './abortShortcutReach';

describe('abortShortcutReachesComposer', () => {
  test('only a chat composer in a window wired to double Escape, used with a keyboard', () => {
    expect(abortShortcutReachesComposer({ surface: 'main', touch: false })).toBe(true);
    expect(abortShortcutReachesComposer({ surface: 'mini-chat', touch: false })).toBe(true);
    expect(abortShortcutReachesComposer({ surface: 'btw', touch: false })).toBe(false);
    expect(abortShortcutReachesComposer({ surface: 'unknown', touch: false })).toBe(false);
    expect(abortShortcutReachesComposer({ surface: 'main', touch: true })).toBe(false);
    expect(abortShortcutReachesComposer({ surface: 'mini-chat', touch: true })).toBe(false);
  });
});

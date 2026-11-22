import { describe, expect, test } from 'bun:test';

import { ALL_VISIBLE_SETTINGS, getAppearanceVisibleSettings } from './appearanceVisibleSettings';

// The pin compares against ALL_VISIBLE_SETTINGS — the runtime list the
// VisibleSetting type itself is derived from — so adding a gateable
// setting without adding it to the Appearance allowlist fails here.
const ALL_GATEABLE_SETTINGS = ALL_VISIBLE_SETTINGS;

describe('getAppearanceVisibleSettings', () => {
  test('includes sidebarRows so the session-row controls render on the Appearance page', () => {
    expect(getAppearanceVisibleSettings(false)).toContain('sidebarRows');
    expect(getAppearanceVisibleSettings(true)).toContain('sidebarRows');
  });

  test('covers every gateable visual setting outside VS Code, with no duplicates', () => {
    const settings = getAppearanceVisibleSettings(false);
    expect([...settings].sort()).toEqual([...ALL_GATEABLE_SETTINGS].sort());
    expect(new Set(settings).size).toBe(settings.length);
  });

  test('omits only weekStart in the VS Code runtime', () => {
    const settings = getAppearanceVisibleSettings(true);
    expect([...settings].sort()).toEqual(ALL_GATEABLE_SETTINGS.filter((s) => s !== 'weekStart').sort());
  });
});

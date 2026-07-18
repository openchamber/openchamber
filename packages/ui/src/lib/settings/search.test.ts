import { describe, expect, test } from 'bun:test';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
import type { I18nKey } from '@/lib/i18n/store';
import { buildSettingsSearchResults } from './search';

const baseRuntimeContext = {
  isVSCode: false,
  isWeb: true,
  isDesktop: false,
  isMobile: false,
  isDesktopLocalOrigin: false,
  isMac: false,
  isWindows: false,
};

describe('settings search', () => {
  test('indexes the global permission auto-accept sessions control', () => {
    const t = (key: I18nKey) => (settingsDict as Record<string, string>)[key] ?? key;
    const results = buildSettingsSearchResults({
      query: 'permission auto accept',
      runtimeCtx: baseRuntimeContext,
      t,
      getPageTitle: () => 'Sessions',
    });

    expect(results.some((result) => result.id === 'sessions.permission-auto-accept')).toBe(true);
  });

  test('keeps the global permission auto-accept sessions control searchable in VS Code', () => {
    const t = (key: I18nKey) => (settingsDict as Record<string, string>)[key] ?? key;
    const results = buildSettingsSearchResults({
      query: 'permission auto accept',
      runtimeCtx: { ...baseRuntimeContext, isVSCode: true },
      t,
      getPageTitle: () => 'Sessions',
    });

    expect(results.some((result) => result.id === 'sessions.permission-auto-accept')).toBe(true);
  });
});

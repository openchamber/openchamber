import { describe, expect, test } from 'bun:test';
import type { I18nKey } from '@/lib/i18n/store';
import { buildSettingsSearchResults } from './search';

const t = (key: I18nKey): string => key;

const runtimeCtx = {
  isVSCode: false,
  isWeb: true,
  isDesktop: false,
  isMobile: false,
  isDesktopLocalOrigin: false,
  isMac: false,
  isWindows: false,
  isLinux: false,
  isWindowsArm64: false,
};

describe('settings search', () => {
  test('finds Linear connect on the integrations page', () => {
    const results = buildSettingsSearchResults({
      query: 'linear',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'integrations.linear')).toBe(true);
    expect(results.some((result) => result.id === 'integrations.linear.add-workspace')).toBe(true);
    expect(results.some((result) => result.id === 'integrations.linear.mapping')).toBe(true);
  });

  test('hides Linear connect in VS Code', () => {
    const results = buildSettingsSearchResults({
      query: 'linear',
      runtimeCtx: { ...runtimeCtx, isVSCode: true },
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'integrations.linear')).toBe(false);
    expect(results.some((result) => result.id === 'integrations.linear.add-workspace')).toBe(false);
    expect(results.some((result) => result.id === 'integrations.linear.mapping')).toBe(false);
  });

  test('shows recent session cycling only where the switcher is available', () => {
    const search = (runtimeOverrides: Partial<typeof runtimeCtx> = {}) => buildSettingsSearchResults({
      query: 'mru',
      runtimeCtx: { ...runtimeCtx, ...runtimeOverrides },
      t,
      getPageTitle: (page) => page,
    });

    expect(search().some((result) => result.id === 'sessions.recent-session-cycling')).toBe(true);
    expect(search({ isMobile: true }).some((result) => result.id === 'sessions.recent-session-cycling')).toBe(false);
    expect(search({ isVSCode: true }).some((result) => result.id === 'sessions.recent-session-cycling')).toBe(false);
  });
});

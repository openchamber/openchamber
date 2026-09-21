import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { getDefaultTheme } from '@/lib/theme/themes';
import { resetEmbeddedSessionChatCache } from '@/components/layout/contextPanelEmbeddedChat';
import {
  getInitialSystemPreference,
  publishEmbeddedThemeBootstrap,
  readEmbeddedThemeBootstrap,
} from './theme-embedded-bootstrap';

const originalWindow = globalThis.window;

const installWindow = (search: string, matchMediaDark: boolean, parentTheme?: unknown) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        search,
      },
      matchMedia: () => ({ matches: matchMediaDark }),
      parent: parentTheme === undefined ? null : { __openchamberEmbeddedThemeBootstrap: parentTheme },
    },
  });
};

beforeEach(() => {
  installWindow('', false);
  resetEmbeddedSessionChatCache();
});

afterAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

describe('ThemeSystemProvider embedded bootstrap', () => {
  test('uses parent effective variant for embedded system theme before iframe matchMedia', () => {
    installWindow('?ocPanel=session-chat&themeMode=system&themeVariant=dark', false);
    resetEmbeddedSessionChatCache();

    expect(getInitialSystemPreference()).toBe(true);
  });

  test('uses a validated parent custom theme before first render', () => {
    const customTheme = {
      ...getDefaultTheme(true),
      metadata: {
        ...getDefaultTheme(true).metadata,
        id: 'custom-dark',
        name: 'Custom dark',
        variant: 'dark' as const,
      },
    };
    installWindow('?ocPanel=session-chat', false, customTheme);
    resetEmbeddedSessionChatCache();

    expect(readEmbeddedThemeBootstrap()).toBe(customTheme);
  });

  test('rejects an invalid parent theme bootstrap', () => {
    installWindow('?ocPanel=session-chat', false, { metadata: { id: 'invalid' } });
    resetEmbeddedSessionChatCache();

    expect(readEmbeddedThemeBootstrap()).toBeNull();
  });

  test('publishes the current parent theme without using the URL', () => {
    const currentTheme = getDefaultTheme(true);

    publishEmbeddedThemeBootstrap(currentTheme);

    expect((globalThis.window as unknown as { __openchamberEmbeddedThemeBootstrap?: unknown })
      .__openchamberEmbeddedThemeBootstrap).toBe(currentTheme);
  });
});

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { Theme } from '@/types/theme';
import {
  buildEmbeddedSessionChatURL,
  getOrCreateEmbeddedSessionChatURL,
  isEmbeddedSessionChatSearch,
  type EmbeddedSessionChatURLCacheEntry,
} from './contextPanelEmbeddedChat';

const originalWindow = globalThis.window;

const installWindowLocation = (href = 'http://127.0.0.1:5173/app') => {
  const url = new URL(href);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        href: url.toString(),
        origin: url.origin,
        pathname: url.pathname,
        search: url.search,
      },
    },
  });
};

const makeTheme = (id: string, variant: 'light' | 'dark'): Theme => ({
  ...getDefaultTheme(variant === 'dark'),
  metadata: {
    ...getDefaultTheme(variant === 'dark').metadata,
    id,
    name: id,
    variant,
  },
});

beforeEach(() => {
  installWindowLocation();
});

afterAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

describe('embedded session chat URL', () => {
  test('identifies only the session-chat panel URL', () => {
    expect(isEmbeddedSessionChatSearch('?ocPanel=session-chat&sessionId=ses_1')).toBe(true);
    expect(isEmbeddedSessionChatSearch('?ocPanel=preview')).toBe(false);
    expect(isEmbeddedSessionChatSearch('')).toBe(false);
  });

  test('includes parent effective system theme bootstrap data', () => {
    const currentTheme = makeTheme('custom-dark', 'dark');

    const src = buildEmbeddedSessionChatURL('ses_1', '/repo', false, {
      mode: 'system',
      lightThemeId: 'custom-light',
      darkThemeId: 'custom-dark',
      currentTheme,
    });

    const url = new URL(src);
    expect(url.searchParams.get('ocPanel')).toBe('session-chat');
    expect(url.searchParams.get('themeMode')).toBe('system');
    expect(url.searchParams.get('themeVariant')).toBe('dark');
    expect(url.searchParams.get('lightThemeId')).toBe('custom-light');
    expect(url.searchParams.get('darkThemeId')).toBe('custom-dark');
    expect(JSON.parse(url.searchParams.get('currentTheme') || '{}').metadata.id).toBe('custom-dark');
  });

  test('freezes bootstrap src per tab so live theme changes do not reload iframe', () => {
    const cache = new Map<string, EmbeddedSessionChatURLCacheEntry>();
    const first = getOrCreateEmbeddedSessionChatURL(cache, 'tab-1', 'ses_1', '/repo', false, {
      mode: 'system',
      lightThemeId: 'light-a',
      darkThemeId: 'dark-a',
      currentTheme: makeTheme('dark-a', 'dark'),
    });

    const second = getOrCreateEmbeddedSessionChatURL(cache, 'tab-1', 'ses_1', '/repo', false, {
      mode: 'light',
      lightThemeId: 'light-b',
      darkThemeId: 'dark-b',
      currentTheme: makeTheme('light-b', 'light'),
    });

    expect(second).toBe(first);
    expect(new URL(second).searchParams.get('themeVariant')).toBe('dark');
  });

  test('rebuilds cached src when readOnly changes for an existing tab', () => {
    const cache = new Map<string, EmbeddedSessionChatURLCacheEntry>();
    const theme = {
      mode: 'system' as const,
      lightThemeId: 'light-a',
      darkThemeId: 'dark-a',
      currentTheme: makeTheme('dark-a', 'dark'),
    };

    const writable = getOrCreateEmbeddedSessionChatURL(cache, 'tab-1', 'ses_1', '/repo', false, theme);
    const readOnly = getOrCreateEmbeddedSessionChatURL(cache, 'tab-1', 'ses_1', '/repo', true, theme);

    expect(readOnly).not.toBe(writable);
    expect(new URL(writable).searchParams.get('readOnly')).toBeNull();
    expect(new URL(readOnly).searchParams.get('readOnly')).toBe('1');
  });
});

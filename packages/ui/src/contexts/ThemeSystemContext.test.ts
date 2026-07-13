import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { getInitialSystemPreference } from './theme-embedded-bootstrap';

const originalWindow = globalThis.window;

const installWindow = (search: string, matchMediaDark: boolean) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        search,
      },
      matchMedia: () => ({ matches: matchMediaDark }),
    },
  });
};

beforeEach(() => {
  installWindow('', false);
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

    expect(getInitialSystemPreference()).toBe(true);
  });
});

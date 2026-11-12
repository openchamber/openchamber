import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { updateBrowserURL } from './serializeRoute';
import type { AppRouteState } from './serializeRoute';

const originalWindow = globalThis.window;

type HistoryStub = {
  state: unknown;
  lastURL: string | null;
  replaceState(state: unknown, _title: string, url?: string): void;
  pushState(state: unknown, _title: string, url?: string): void;
};

const installWindow = (href: string): HistoryStub => {
  const url = new URL(href);
  const history: HistoryStub = {
    state: null,
    lastURL: null,
    replaceState(state, _title, url) {
      this.state = state;
      this.lastURL = url ?? null;
    },
    pushState(state, _title, url) {
      this.state = state;
      this.lastURL = url ?? null;
    },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        href: url.toString(),
        origin: url.origin,
        pathname: url.pathname,
        search: url.search,
      },
      history,
    },
  });
  return history;
};

const historyOf = (): HistoryStub =>
  (globalThis.window as unknown as { history: HistoryStub }).history;

beforeEach(() => {
  installWindow('http://127.0.0.1:5173/app');
});

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

const sessionState = (sessionId: string): AppRouteState => ({
  sessionId,
  isSettingsOpen: false,
  settingsPath: '',
});

describe('updateBrowserURL', () => {
  test('rewrites the URL with the selected session', () => {
    installWindow('http://127.0.0.1:5173/app');

    updateBrowserURL(sessionState('ses_main'), { replace: true, force: true });

    const writtenURL = historyOf().lastURL ?? '';
    expect(writtenURL).toContain('session=ses_main');
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { updateBrowserURL } from './serializeRoute';
import type { AppRouteState } from './serializeRoute';
import { isEmbeddedSessionChat, resetEmbeddedSessionChatCache } from '@/components/layout/contextPanelEmbeddedChat';

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
  resetEmbeddedSessionChatCache();
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
  tab: 'chat',
  isSettingsOpen: false,
  settingsPath: '',
  diffFile: null,
});

describe('updateBrowserURL embedded-session-chat guard', () => {
  test('is a no-op in the embedded session-chat iframe (mirrors isVSCodeContext)', () => {
    // The embedded iframe's URL identity (ocPanel/sessionId/directory/
    // readOnly) must never be rewritten. updateBrowserURL rebuilds the
    // query string from scratch using only session/tab/settings/file —
    // which would strip ocPanel and break isEmbeddedSessionChat().
    // The guard prevents this, exactly like isVSCodeContext() does for
    // VS Code webviews.
    const history = installWindow(
      'http://127.0.0.1:5173/app?ocPanel=session-chat&sessionId=ses_child&directory=%2Frepo&readOnly=1',
    );

    updateBrowserURL(sessionState('ses_grandchild'), { replace: true, force: true });

    // No URL update happened — history was never touched.
    expect(history.lastURL).toBeNull();
  });

  test('rewrites the URL normally outside the embedded iframe', () => {
    installWindow('http://127.0.0.1:5173/app');

    updateBrowserURL(sessionState('ses_main'), { replace: true, force: true });

    const writtenURL = historyOf().lastURL ?? '';
    expect(writtenURL).toContain('session=ses_main');
  });
});

describe('isEmbeddedSessionChat caching', () => {
  test('caches the first result so URL rewrites cannot flip it (mirrors VS Code stable global)', () => {
    // VS Code detects its webview via the stable `window.__VSCODE_CONFIG__`
    // global — it never changes. The embedded iframe's identity is equally
    // fixed at mount (the parent builds the src); caching the first read
    // makes detection just as stable, surviving any URL rewrite.
    //
    // We need a fresh module cache for this test. Since the cache is
    // module-level, we test the invariant: once true, always true.
    installWindow(
      'http://127.0.0.1:5173/app?ocPanel=session-chat&sessionId=ses_child&directory=%2Frepo&readOnly=1',
    );

    // First read: caches true.
    expect(isEmbeddedSessionChat()).toBe(true);

    // Even if the URL were rewritten (the guard above prevents this, but
    // defense in depth), the cached value stays true.
    installWindow('http://127.0.0.1:5173/app?session=ses_grandchild');
    expect(isEmbeddedSessionChat()).toBe(true);
  });
});

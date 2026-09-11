import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createOpencodeClient, type ToolPart as ToolPartData } from '@opencode-ai/sdk/v2';
import { SyncProvider } from '@/sync/sync-context';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';

// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'tool-scroll-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const { default: ToolPart } = await import('./ToolPart');

const unexpectedThemeChange = (): never => { throw new Error('Scrolling must not change the theme'); };
const theme = getDefaultTheme(false);
const themeContext: ThemeContextValue = {
  currentTheme: theme,
  availableThemes: [theme],
  setTheme: unexpectedThemeChange,
  customThemesLoading: false,
  reloadCustomThemes: unexpectedThemeChange,
  isSystemPreference: false,
  setSystemPreference: unexpectedThemeChange,
  themeMode: 'light',
  setThemeMode: unexpectedThemeChange,
  lightThemeId: theme.metadata.id,
  darkThemeId: getDefaultTheme(true).metadata.id,
  setLightThemePreference: unexpectedThemeChange,
  setDarkThemePreference: unexpectedThemeChange,
};

test('expanded bash output follows growth until the reader scrolls up', async () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const globals = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    localStorage: happyWindow.localStorage,
    customElements: happyWindow.customElements,
    Node: happyWindow.Node,
    Text: happyWindow.Text,
    NodeList: happyWindow.NodeList,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    SVGElement: happyWindow.SVGElement,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    ResizeObserver: happyWindow.ResizeObserver,
    MutationObserver: happyWindow.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const sdk = createOpencodeClient({
    baseUrl: 'http://localhost',
    fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
  });
  const renderOutput = async (output: string, completed = false) => {
    const part: ToolPartData = {
      id: 'prt_bash_follow', sessionID: 'ses_bash_follow', messageID: 'msg_bash_follow',
      type: 'tool', tool: 'bash', callID: 'call_bash_follow',
      state: completed
        ? { status: 'completed', input: { command: 'bun test' }, output, title: 'Tests', metadata: {}, time: { start: 1, end: 2 } }
        : { status: 'running', input: { command: 'bun test' }, title: 'Tests', metadata: { output }, time: { start: 1 } },
    };
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="">
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <ToolPart part={part} isExpanded isMobile={false} onToggle={() => {}} />
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      );
    });
    // Let the real streaming throttle commit the latest snapshot.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
  };

  try {
    await renderOutput('Starting tests');
    const scroller = Array.from(container.querySelectorAll<HTMLElement>('.tool-output-surface'))
      .find((element) => element.textContent?.includes('Starting tests'));
    if (!scroller) throw new Error('Expected expanded bash output');
    let height = 800;
    let top = 0;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 320 },
      scrollHeight: { configurable: true, get: () => height },
      scrollTop: {
        configurable: true,
        get: () => Math.min(top, height - 320),
        set: (value: number) => { top = Math.max(0, Math.min(value, height - 320)); },
      },
    });
    await renderOutput('Starting tests\nFirst result');
    expect(scroller.scrollTop).toBe(480);

    // An automatic scroll event arrives after layout growth. It must not
    // release follow before the next streamed output commit catches up.
    for (height of [1100, 1800, 2600]) {
      await act(async () => { scroller.dispatchEvent(new window.Event('scroll')); });
      await renderOutput(`Test output at height ${height}`);
      expect(scroller.textContent).toContain(`Test output at height ${height}`);
      expect(scroller.scrollTop).toBe(height - 320);
    }

    // Rewritten output can shrink and clamp the browser's scroll position.
    height = 800;
    await act(async () => { scroller.dispatchEvent(new window.Event('scroll')); });
    await renderOutput('Shortened output');
    height = 1000;
    await renderOutput('Shortened output\nMore results');
    expect(scroller.scrollTop).toBe(680);

    // Scrollbar/keyboard scrolling emits scroll without a wheel event.
    await act(async () => {
      scroller.scrollTop = 120;
      scroller.dispatchEvent(new window.Event('scroll'));
    });
    height = 1400;
    await renderOutput('Reader is looking at earlier results');
    expect(scroller.scrollTop).toBe(120);

    await act(async () => {
      scroller.scrollTop = height - 320;
      scroller.dispatchEvent(new window.Event('scroll'));
    });
    height = 1800;
    await renderOutput('Following again');
    expect(scroller.scrollTop).toBe(1480);

    await act(async () => {
      scroller.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -80, bubbles: true }));
    });
    height = 2000;
    await renderOutput('Wheel pauses following before scroll arrives');
    expect(scroller.scrollTop).toBe(1480);
    await renderOutput('Final output', true);
    expect(scroller.isConnected).toBe(true);
    expect(scroller.textContent).toContain('Final output');
    expect(scroller.scrollTop).toBe(1480);
  } finally {
    await act(async () => { root.unmount(); });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

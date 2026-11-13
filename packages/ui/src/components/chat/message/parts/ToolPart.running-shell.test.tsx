import { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { ToolPart as ToolPartData } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { SyncProvider } from '@/sync/sync-context';
import { resetBackgroundShells, useBackgroundShellsStore } from '@/sync/background-shells';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';

// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'tool-running-shell-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const { default: ToolPart } = await import('./ToolPart');

const unexpectedThemeChange = (): never => { throw new Error('Rendering must not change the theme'); };
const theme = getDefaultTheme(false);
const themeContext: ThemeContextValue = {
  currentTheme: theme,
  availableThemes: [theme],
  setTheme: unexpectedThemeChange,
  customThemesLoading: false,
  reloadCustomThemes: unexpectedThemeChange,
  importTheme: unexpectedThemeChange,
  deleteImportedTheme: unexpectedThemeChange,
  customThemeIds: [],
  isSystemPreference: false,
  setSystemPreference: unexpectedThemeChange,
  themeMode: 'light',
  setThemeMode: unexpectedThemeChange,
  lightThemeId: theme.metadata.id,
  darkThemeId: getDefaultTheme(true).metadata.id,
  setLightThemePreference: unexpectedThemeChange,
  setDarkThemePreference: unexpectedThemeChange,
};

test('an expanded shell call the turn waits for shows the command output while it runs', async () => {
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
  const sdk = OpenCode.make({
    baseUrl: 'http://localhost',
    fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
  });
  // OpenCode's only progress update for a running shell call carries the command's id.
  const running: ToolPartData = {
    id: 'prt_ticks', sessionID: 'ses_ticks', messageID: 'msg_ticks',
    type: 'tool', tool: 'shell', callID: 'call_ticks',
    state: { status: 'running', input: { command: 'ticks' }, metadata: { shellID: 'sh_ticks' }, time: { start: 1 } },
  };
  useBackgroundShellsStore.setState({
    byId: new Map([['sh_ticks', {
      id: 'sh_ticks', sessionID: 'ses_ticks', command: 'ticks', file: '/tmp/sh_ticks', startedAt: 1, directory: '/repo', background: false,
    }]]),
  });
  const read = spyOn(opencodeClient, 'readShellOutput').mockResolvedValue({ output: 'tick 1 / 15\ntick 2 / 15\n', cursor: 24, skipped: false });

  const render = async (part: ToolPartData, isExpanded = true) => {
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="">
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <ToolPart part={part} isExpanded={isExpanded} isMobile={false} onToggle={() => {}} />
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      );
    });
    // Let the read settle and the streaming throttle commit it.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  };

  try {
    // A collapsed row shows no output, so it reads nothing.
    await render(running, false);
    expect(read.mock.calls).toHaveLength(0);

    await render(running);
    expect(read.mock.calls[0]).toEqual(['sh_ticks', '/repo', undefined]);
    expect(container.textContent).toContain('tick 2 / 15');

    await render({
      ...running,
      state: { status: 'completed', input: { command: 'ticks' }, output: 'tick 1 / 15\ntick 2 / 15\ntick 3 / 15', metadata: { exit: 0 }, time: { start: 1, end: 3 } },
    });
    expect(container.textContent).toContain('tick 3 / 15');
  } finally {
    read.mockRestore();
    resetBackgroundShells();
    await act(async () => { root.unmount(); });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

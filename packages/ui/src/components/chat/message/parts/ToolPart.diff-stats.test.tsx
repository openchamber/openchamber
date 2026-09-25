import { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Metadata, ToolPart as ToolPartData } from '@/lib/opencode/model';
import { SyncProvider } from '@/sync/sync-context';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useGuestsStore } from '@/lib/guests/store';

// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'tool-guest-worker-url',
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

test('edit and patch headers render v2 file diff counts as results arrive', async () => {
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

  try {
    useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
    const render = async (tool: string, metadata: Metadata, input = {}) => {
      const part: ToolPartData = {
        id: 'change', sessionID: 'session', messageID: 'message', type: 'tool',
        tool, callID: 'change',
        state: { status: 'completed', input, metadata, output: '', time: { start: 1, end: 2 } },
      };
      await act(async () => root.render(
        <SyncProvider sdk={sdk} directory="">
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <ToolPart part={part} isExpanded={false} isMobile={false} onToggle={() => {}} />
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      ));
    };

    for (const tool of ['patch', 'edit']) {
      await render(tool, {});
      expect(container.textContent).not.toContain('+7');
      await render(tool, { files: [{ file: 'src/example.ts', additions: 7, deletions: 3, status: 'modified' }] });
      expect(container.textContent).toContain('+7/-3');
      // Canonical counts win even when a legacy diff is also present.
      await render(tool, { files: [{ file: 'src/example.ts', additions: 0, deletions: 4, status: 'deleted' }], diff: '+wrong' });
      expect(container.textContent).toContain('+0/-4');
      expect(container.textContent).not.toContain('+7/-3');
      await render(tool, { files: [{ file: 'src/example.ts', additions: 0, deletions: 0, status: 'modified' }] });
      expect(container.textContent).toContain('+0/-0');
      await render(tool, { files: [{ file: 'src/example.ts', additions: 7 }] });
      expect(container.textContent).not.toContain('+7');
    }
    await render('patch', { files: [
      { file: 'src/one.ts', additions: 7, deletions: 3 },
      { file: 'src/two.ts', additions: 2, deletions: 0 },
    ] });
    expect(container.textContent).toContain('+7');
    expect(container.textContent).toContain('-3');
    expect(container.textContent).toContain('+2');

    await render('edit', { diff: '@@ -1 +1 @@\n-old\n+new\n+another' });
    expect(container.textContent).toContain('+2/-1');
    await render('write', {}, { path: 'new.ts', content: 'one\ntwo' });
    expect(container.textContent).toContain('+2');
  } finally {
    await act(async () => { root.unmount(); });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

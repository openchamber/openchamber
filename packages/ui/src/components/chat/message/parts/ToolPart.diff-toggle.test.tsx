import { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { ToolPart as ToolPartData } from '@/lib/opencode/model';
import { SyncProvider } from '@/sync/sync-context';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useGuestsStore } from '@/lib/guests/store';
import { TOOL_DIFF_PREVIEW_MAX_CHARS } from './toolDiffPreview';

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

const filePatch = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`;

test('the diff layout toggle sits in each diff entry header and switches every entry', async () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const globals = {
    window: happyWindow,
    Window: happyWindow.Window,
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
    const part: ToolPartData = {
      id: 'change', sessionID: 'session', messageID: 'message', type: 'tool',
      tool: 'patch', callID: 'change',
      state: {
        status: 'completed',
        input: {},
        metadata: {
          files: [
            { relativePath: 'src/one.ts', patch: filePatch('src/one.ts') },
            { relativePath: 'src/two.ts', patch: filePatch('src/two.ts') },
            // Too large for the visual preview: shown as plain text, with no layout to switch.
            { relativePath: 'src/big.ts', patch: `+${'x'.repeat(TOOL_DIFF_PREVIEW_MAX_CHARS)}` },
          ],
        },
        output: '',
        time: { start: 1, end: 2 },
      },
    };
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory="">
        <I18nProvider>
          <ThemeSystemContext.Provider value={themeContext}>
            <ToolPart part={part} isExpanded isMobile={false} onToggle={() => {}} />
          </ThemeSystemContext.Provider>
        </I18nProvider>
      </SyncProvider>,
    ));

    const isLayoutToggle = (button: Element) => button.getAttribute('aria-label') === 'Side-by-side view';
    const headerRows = Array.from(container.querySelectorAll('button[aria-label="Open file at first change"]'))
      .map((button) => button.parentElement);
    expect(headerRows).toHaveLength(3);
    const rowToggles = headerRows.map((row) => Array.from(row?.querySelectorAll('button') ?? []).filter(isLayoutToggle));
    expect(rowToggles.map((toggles) => toggles.length)).toEqual([1, 1, 0]);
    // No toggle outside the header rows.
    expect(Array.from(container.querySelectorAll('button')).filter(isLayoutToggle)).toHaveLength(2);

    const [first, second] = rowToggles.flat();
    const before = first.getAttribute('aria-pressed');
    expect(['true', 'false']).toContain(before);
    expect(second.getAttribute('aria-pressed')).toBe(before);
    await act(async () => { first.click(); });
    expect(first.getAttribute('aria-pressed')).toBe(before === 'true' ? 'false' : 'true');
    expect(second.getAttribute('aria-pressed')).toBe(first.getAttribute('aria-pressed'));
    expect(first.getAttribute('aria-label')).toBe('Side-by-side view');
    await act(async () => { second.click(); });
    expect(first.getAttribute('aria-pressed')).toBe(before);
    expect(second.getAttribute('aria-pressed')).toBe(before);
  } finally {
    await act(async () => { root.unmount(); });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

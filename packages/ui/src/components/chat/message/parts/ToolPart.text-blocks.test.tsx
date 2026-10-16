import { act } from 'react';
import { afterEach, expect, test } from 'bun:test';
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
import { useUIStore } from '@/stores/useUIStore';

// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'tool-text-blocks-worker-url',
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

// A finished shell call of the v2 contract: the output is the serialized text blocks
// (issue #5067). The text itself spans two lines.
const TEXT = 'skills-root /c/Users/Zephyrus/.claude/skills\nskills-root /c/Users/Zephyrus/.opencode/skills';
const textBlocks = (text: string) => JSON.stringify([{ type: 'text', text }]);

const completedShellPart = (output: string): ToolPartData => ({
  id: 'prt_shell_text', sessionID: 'ses_shell_text', messageID: 'msg_shell_text',
  type: 'tool', tool: 'shell', callID: 'call_shell_text',
  state: { status: 'completed', input: { command: 'find-skills' }, output, metadata: {}, time: { start: 1, end: 2 } },
});

const renderToolOutput = async (output: string, run: (container: HTMLElement) => Promise<void> | void) => {
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
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="">
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <ToolPart part={completedShellPart(output)} isExpanded isMobile={false} onToggle={() => {}} />
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      );
    });
    await run(container);
  } finally {
    await act(async () => { root.unmount(); });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

afterEach(() => {
  useUIStore.getState().setToolJsonViewMode('summary');
});

test('a text-block result shows the text itself, newlines intact, instead of a tree of the wrapper', async () => {
  await renderToolOutput(textBlocks(TEXT), (container) => {
    const code = container.querySelector('pre code');
    expect(code?.textContent).toBe(TEXT);
    expect(container.querySelector('details')).toBeNull();
  });
});

test('a result wrapped twice by the transport is unwrapped to the text', async () => {
  await renderToolOutput(textBlocks(textBlocks(TEXT)), (container) => {
    expect(container.querySelector('pre code')?.textContent).toBe(TEXT);
  });
});

test('long text output remains complete and wraps inside the code surface', async () => {
  const text = `first\n${'long output '.repeat(2000)}\nlast\n`;
  await renderToolOutput(textBlocks(text), (container) => {
    const code = container.querySelector('pre code');
    expect(code?.textContent).toBe(text);
    expect(code?.parentElement?.style.whiteSpace).toBe('pre-wrap');
    expect(code?.parentElement?.style.overflowWrap).toBe('break-word');
  });
});

test('mixed content keeps the summary tree', async () => {
  const output = JSON.stringify([{ type: 'text', text: 'caption' }, { type: 'image', data: 'image-data' }]);
  await renderToolOutput(output, (container) => {
    expect(container.querySelector('pre code')).toBeNull();
    expect(container.textContent).toContain('caption');
    expect(container.textContent).toContain('image-data');
  });
});

test('a genuinely structured result keeps the summary tree', async () => {
  await renderToolOutput(JSON.stringify({ command: 'ls', exit: 0 }), (container) => {
    expect(container.querySelector('pre code')).toBeNull();
    expect(container.textContent).toContain('Command');
    expect(container.textContent).toContain('ls');
  });
});

test('the formatted view still shows the JSON tree for text blocks', async () => {
  useUIStore.getState().setToolJsonViewMode('formatted');
  await renderToolOutput(textBlocks(TEXT), (container) => {
    expect(container.querySelector('pre code')).toBeNull();
    expect(container.textContent).toContain('type');
  });
});

test('the raw view still shows the original JSON string for text blocks', async () => {
  useUIStore.getState().setToolJsonViewMode('raw');
  await renderToolOutput(textBlocks(TEXT), (container) => {
    expect(container.querySelector('pre code')?.textContent).toBe(textBlocks(TEXT));
  });
});

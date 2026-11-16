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

const todoPart: ToolPartData = {
  id: 'prt_todo', sessionID: 'ses_todo', messageID: 'msg_todo',
  type: 'tool', tool: 'todowrite', callID: 'call_todo',
  state: {
    status: 'completed',
    input: { todos: [{ content: 'Ship the fix', status: 'in_progress' }] },
    output: JSON.stringify([
      { content: 'Write the test', status: 'completed', priority: 'high' },
      { content: 'Open the PR', status: 'pending', priority: 'low' },
      { content: 'Ship the fix', status: 'in_progress', priority: 'high' },
      { content: 'Old idea', status: 'cancelled' },
    ]),
    metadata: {},
    time: { start: 1, end: 2 },
  },
};

for (const tool of ['todowrite', 'todoread'] as const) test(`${tool} uses its current or legacy checklist presentation`, async () => {
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
    Event: happyWindow.Event,
    CustomEvent: happyWindow.CustomEvent,
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
  const render = async () => {
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="">
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <ToolPart part={{ ...todoPart, tool }} isExpanded isMobile={false} onToggle={() => {}} />
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      );
    });
  };

  try {
    useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
    await render();
    if (tool === 'todowrite') {
      // The upstream writer records the list this call set, in its input order.
      expect([...container.querySelectorAll('ul li')].map((item) => item.textContent)).toEqual(['Ship the fix']);
      expect(container.textContent).not.toContain('Open the PR');
      expect(container.querySelector('[data-todo-list]')).toBeNull();
    } else {
      const list = container.querySelector('[data-todo-list]');
      expect(list).not.toBeNull();
      const text = list?.textContent ?? '';
      expect(text).toContain('Total: 4');
      expect(text).toContain('In Progress: 1');
      expect(text).toContain('Pending: 1');
      expect(text).toContain('Completed: 1');
      expect(text).toContain('Cancelled: 1');
      // Groups come in status order, not in list order.
      expect(text.indexOf('Ship the fix')).toBeLessThan(text.indexOf('Open the PR'));
      expect(text.indexOf('Open the PR')).toBeLessThan(text.indexOf('Write the test'));
      expect(container.querySelector('.line-through')?.textContent).toBe('Old idea');
    }
    expect(container.querySelector('table')).toBeNull();
    // The input is the same list; it is not repeated as JSON above the result.
    expect(container.querySelector('.tool-input-text')).toBeNull();
    expect(container.textContent).not.toContain('"status"');
  } finally {
    await act(async () => { root.unmount(); });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

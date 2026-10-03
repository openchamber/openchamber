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
import type { InstalledGuest } from '@/lib/guests/types';

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

const tasksGuest: InstalledGuest = {
  id: 'tasks-demo',
  name: 'Tasks Demo',
  icon: 'task',
  entry: 'panel/index.html',
  capabilities: { requested: [], granted: [] },
  tools: [{
    match: 'mcp.tasks.*',
    name: 'Tasks',
    icon: 'checkbox-circle',
    title: 'Tasks for {input.project}',
    subtitle: '{output.total} open',
    output: 'table',
    columns: ['id', 'title', 'assignee.name'],
  }],
};

const part: ToolPartData = {
  id: 'prt_tasks_list', sessionID: 'ses_tasks', messageID: 'msg_tasks',
  type: 'tool', tool: 'mcp.tasks.list', callID: 'call_tasks_list',
  state: {
    status: 'completed',
    input: { project: 'DEMO' },
    output: JSON.stringify({ total: 2, items: [
      { id: 'DEMO-1', title: 'Write docs', assignee: { name: 'Ada' } },
      { id: 'DEMO-2', title: 'Ship it' },
    ] }),
    metadata: {},
    time: { start: 1, end: 2 },
  },
};

test('a declared tool rule sets the header, icon, and table body of a matching tool part', async () => {
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
  const render = async () => {
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
  };

  try {
    useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
    await render();
    // Without a rule the built-in path runs: generic wrench, formatted tool name, JSON views.
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('use[href="#oc-checkbox-circle"]')).toBeNull();
    expect(container.textContent).not.toContain('Tasks for DEMO');

    await act(async () => {
      useGuestsStore.getState().replaceCatalog([tasksGuest], 'test');
    });
    expect(container.textContent).toContain('Tasks for DEMO');
    expect(container.textContent).toContain('2 open');
    expect(container.querySelector('use[href="#oc-checkbox-circle"]')).not.toBeNull();
    const headers = Array.from(container.querySelectorAll('th')).map((cell) => cell.textContent);
    expect(headers).toEqual(['id', 'title', 'assignee.name']);
    const rows = Array.from(container.querySelectorAll('tbody tr')).map((row) => (
      Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)
    ));
    expect(rows).toEqual([
      ['DEMO-1', 'Write docs', 'Ada'],
      ['DEMO-2', 'Ship it', ''],
    ]);

    // Pausing the extension takes its presentation away again.
    await act(async () => {
      useGuestsStore.getState().replaceCatalog([{ ...tasksGuest, enabled: false }], 'test');
    });
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).not.toContain('Tasks for DEMO');
  } finally {
    await act(async () => { root.unmount(); });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

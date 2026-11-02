import { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
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
import { useDirectoryStore } from '@/stores/useDirectoryStore';
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

const headerTitleText = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('.group\\/tool span.font-medium')?.textContent?.trim() ?? '';

const headerDescriptionText = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('.group\\/tool div[style*="--tools-description"] .truncate')?.textContent?.trim() ?? '';

const withGuestHarness = async (
  toolPart: ToolPartData,
  isExpanded: boolean,
  run: (container: HTMLElement) => Promise<void>,
) => {
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

  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.includes('/api/session-warming')) {
      return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
    }
    if (target.includes('/api/fs/home')) {
      return Response.json({ path: '/workspace' });
    }
    if (target.includes('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json([]);
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const sdk = OpenCode.make({
    baseUrl: 'http://localhost',
    fetch: async (input: string | URL | Request) => {
      const target = String(input instanceof Request ? input.url : input);
      if (target.includes('/event')) {
        return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json([]);
    },
  });

  const previousDirectory = useDirectoryStore.getState().currentDirectory;
  try {
    useDirectoryStore.setState({ currentDirectory: '/workspace' });
    useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="/workspace">
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <ToolPart part={toolPart} isExpanded={isExpanded} isMobile={false} onToggle={() => {}} />
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      );
    });
    await run(container);
  } finally {
    await act(async () => { root.unmount(); });
    useDirectoryStore.setState({ currentDirectory: previousDirectory });
    fetchSpy.mockRestore();
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

test('a declared tool rule sets the header, icon, and table body of a matching tool part', async () => {
  await withGuestHarness(part, true, async (container) => {
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
  });
});

test('guest tool title and subtitle overrides are authoritative over native subagent agent title', async () => {
  const subagentGuest: InstalledGuest = {
    id: 'guest-subagent-rule',
    name: 'Guest Subagent Rule',
    icon: 'robot',
    entry: 'panel/index.html',
    capabilities: { requested: [], granted: [] },
    tools: [{
      match: 'subagent',
      name: 'Custom Agent Tool',
      title: 'Guest Title: {input.agent}',
      subtitle: 'Guest Work: {input.description}',
    }],
  };
  const subagentPart: ToolPartData = {
    id: 'guest-subagent-part', sessionID: 'ses_subagent', messageID: 'msg_subagent',
    type: 'tool', tool: 'subagent', callID: 'call_subagent',
    state: {
      status: 'completed',
      input: { agent: 'explorer', description: 'Explore files' },
      output: '',
      time: { start: 1, end: 2 },
    },
  };

  await withGuestHarness(subagentPart, false, async (container) => {
    await act(async () => {
      useGuestsStore.getState().replaceCatalog([subagentGuest], 'test');
    });
    expect(headerTitleText(container)).toBe('Guest Title: explorer');
    expect(headerDescriptionText(container)).toBe('Guest Work: Explore files');
  });
});

test('guest tool rule without title override retains native subagent agent title while applying subtitle', async () => {
  const guestWithSubtitleOnly: InstalledGuest = {
    id: 'guest-subagent-subtitle-only',
    name: 'Guest Subagent Subtitle Only',
    icon: 'robot',
    entry: 'panel/index.html',
    capabilities: { requested: [], granted: [] },
    tools: [{
      match: 'subagent',
      subtitle: 'Custom Subtitle for {input.agent}',
    }],
  };
  const subagentPart: ToolPartData = {
    id: 'guest-subagent-part-sub-only', sessionID: 'ses_subagent', messageID: 'msg_subagent',
    type: 'tool', tool: 'subagent', callID: 'call_subagent_2',
    state: {
      status: 'completed',
      input: { agent: 'reviewer', description: 'Review changes' },
      output: '',
      time: { start: 1, end: 2 },
    },
  };

  await withGuestHarness(subagentPart, false, async (container) => {
    await act(async () => {
      useGuestsStore.getState().replaceCatalog([guestWithSubtitleOnly], 'test');
    });
    expect(headerTitleText(container)).toBe('reviewer');
    expect(headerDescriptionText(container)).toBe('Custom Subtitle for reviewer');
  });
});

test('guest tool rule with name but no title template uses guest name as title override', async () => {
  const guestWithNameOnly: InstalledGuest = {
    id: 'guest-subagent-name-only',
    name: 'Guest Subagent Name Only',
    icon: 'robot',
    entry: 'panel/index.html',
    capabilities: { requested: [], granted: [] },
    tools: [{
      match: 'subagent',
      name: 'Authoritative Guest Name',
    }],
  };
  const subagentPart: ToolPartData = {
    id: 'guest-subagent-part-name-only', sessionID: 'ses_subagent', messageID: 'msg_subagent',
    type: 'tool', tool: 'subagent', callID: 'call_subagent_3',
    state: {
      status: 'completed',
      input: { agent: 'builder', description: 'Build project' },
      output: '',
      time: { start: 1, end: 2 },
    },
  };

  await withGuestHarness(subagentPart, false, async (container) => {
    await act(async () => {
      useGuestsStore.getState().replaceCatalog([guestWithNameOnly], 'test');
    });
    expect(headerTitleText(container)).toBe('Authoritative Guest Name');
  });
});

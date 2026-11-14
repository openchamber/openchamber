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

/** One mounted `ToolPart` in a fresh happy-dom window; `dispose` restores the globals. */
const mountToolPart = () => {
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
  const render = async (shown: ToolPartData) => {
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="">
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <ToolPart part={shown} isExpanded isMobile={false} onToggle={() => {}} />
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      );
    });
  };
  const dispose = async () => {
    await act(async () => { root.unmount(); });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
  return { container, render, dispose };
};

const tableRows = (container: HTMLElement) => Array.from(container.querySelectorAll('tbody tr')).map((row) => (
  Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)
));

test('a declared tool rule sets the header, icon, and table body of a matching tool part', async () => {
  const { container, render, dispose } = mountToolPart();

  try {
    useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
    await render(part);
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
    expect(tableRows(container)).toEqual([
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
    await dispose();
  }
});

// Code Mode hands every MCP call over as one `execute` part; the rule is
// written for the name a direct call has (`tasks_list`), the script calls
// `tasks.list`.
const directRuleGuest: InstalledGuest = {
  ...tasksGuest,
  tools: [{ ...tasksGuest.tools![0], match: 'tasks_list' }],
};

const tasksOutput = { total: 2, items: [
  { id: 'DEMO-1', title: 'Write docs', assignee: { name: 'Ada' } },
  { id: 'DEMO-2', title: 'Ship it' },
] };

type ScriptCall = { tool: string; status: string; input?: { [key: string]: string } };

const script = (calls: ScriptCall[], output: string, status: 'completed' | 'running' | 'failed' = 'completed'): ToolPartData => ({
  id: 'prt_script', sessionID: 'ses_tasks', messageID: 'msg_tasks',
  type: 'tool', tool: 'execute', callID: 'call_script',
  state: status === 'running'
    ? { status, input: { code: 'return await tools.tasks.list({ project: "DEMO" })' }, metadata: { toolCalls: calls }, time: { start: 1 } }
    // OpenCode finishes a script that threw as `completed`, with `error: true` beside its calls.
    : { status: 'completed', input: { code: 'return await tools.tasks.list({ project: "DEMO" })' }, output, metadata: status === 'failed' ? { toolCalls: calls, error: true } : { toolCalls: calls }, time: { start: 1, end: 2 } },
});

const listCall: ScriptCall = { tool: 'tasks.list', status: 'completed', input: { project: 'DEMO' } };

test('a Code Mode script that made one call shows as the row of that tool\'s rule', async () => {
  const { container, render, dispose } = mountToolPart();
  const ruleShows = () => container.textContent?.includes('Tasks for DEMO') === true;

  try {
    useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
    // Without a rule the script row stays: the namespace as the title, the script and its call list.
    await render(script([listCall], JSON.stringify(tasksOutput, null, 2)));
    expect(ruleShows()).toBe(false);
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('tools.tasks.list');

    await act(async () => {
      useGuestsStore.getState().replaceCatalog([directRuleGuest], 'test');
    });
    expect(ruleShows()).toBe(true);
    expect(container.textContent).toContain('2 open');
    expect(container.querySelector('use[href="#oc-checkbox-circle"]')).not.toBeNull();
    expect(tableRows(container)).toEqual([
      ['DEMO-1', 'Write docs', 'Ada'],
      ['DEMO-2', 'Ship it', ''],
    ]);

    // A running script can still make another call, so it keeps the script row until it has finished.
    await render(script([listCall], '', 'running'));
    expect(ruleShows()).toBe(false);
    const row = container.querySelector('.group\\/tool');
    expect(row).not.toBeNull();
    await render(script([listCall], JSON.stringify(tasksOutput, null, 2)));
    expect(ruleShows()).toBe(true);
    expect(container.querySelector('.group\\/tool')).toBe(row);

    // The script returned something other than the tool's answer: the row keeps its title and shows what came back.
    await render(script([listCall], '2'));
    expect(ruleShows()).toBe(true);
    expect(container.textContent).not.toContain('2 open');
    expect(container.querySelector('table')).toBeNull();
    await render(script([listCall], `${JSON.stringify(tasksOutput, null, 2)}\n\nLogs:\nfetched`));
    expect(ruleShows()).toBe(true);
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('fetched');

    // Several calls, a call without a rule, a failed call, and a script that failed after its call stay script rows.
    await render(script([listCall, { ...listCall, input: { project: 'OTHER' } }], '[]'));
    expect(ruleShows()).toBe(false);
    await render(script([{ ...listCall, tool: 'tasks.remove' }], '{}'));
    expect(ruleShows()).toBe(false);
    await render(script([{ ...listCall, status: 'error' }], 'The backend is down.'));
    expect(ruleShows()).toBe(false);
    expect(container.textContent).toContain('tools.tasks.list');
    await render(script([listCall], "TypeError: Cannot read properties of undefined (reading 'name')", 'failed'));
    expect(ruleShows()).toBe(false);
    expect(container.textContent).toContain('tools.tasks.list');

    // Pausing the extension gives the script row back.
    await render(script([listCall], JSON.stringify(tasksOutput, null, 2)));
    expect(ruleShows()).toBe(true);
    await act(async () => {
      useGuestsStore.getState().replaceCatalog([{ ...directRuleGuest, enabled: false }], 'test');
    });
    expect(ruleShows()).toBe(false);
    expect(container.querySelector('table')).toBeNull();
  } finally {
    await dispose();
  }
});

const issuesGuest = (toolLinkSettings?: Record<string, string>): InstalledGuest => ({
  id: 'issues-demo',
  name: 'Issues Demo',
  icon: 'bug',
  entry: 'panel/index.html',
  capabilities: { requested: [], granted: [] },
  tools: [{
    match: 'issues_*',
    name: 'Issue',
    output: 'card',
    card: {
      label: '{output.key} · {output.type}',
      title: '{output.summary}',
      status: { value: '{output.status}', tones: { 'In Progress': 'info', Blocked: 'error' } },
      fields: [{ label: 'Assignee', value: '{output.assignee.name}' }, { label: 'Priority', value: '{output.priority}' }],
      link: { label: 'Open in tracker', url: 'https://{settings.site}/browse/{output.key}' },
    },
  }],
  ...(toolLinkSettings ? { toolLinkSettings } : {}),
});

const issuePart = (tool: string, output: string): ToolPartData => ({
  id: 'prt_issue', sessionID: 'ses_tasks', messageID: 'msg_tasks',
  type: 'tool', tool, callID: 'call_issue',
  state: { status: 'completed', input: {}, output, metadata: {}, time: { start: 1, end: 2 } },
});

const issue = { key: 'DEMO-482', type: 'Bug', summary: 'Login fails after token refresh', status: 'In Progress', assignee: { name: 'Olena K.' }, priority: 'High' };

test('a declared card draws the output as a card, an array as a list, and anything else as before', async () => {
  const { container, render, dispose } = mountToolPart();
  const link = () => container.querySelector('a[href^="https://"]');
  const badge = (text: string) => Array.from(container.querySelectorAll('span')).find((node) => node.textContent === text);

  try {
    useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
    await act(async () => {
      useGuestsStore.getState().replaceCatalog([issuesGuest({ site: 'acme.example' })], 'test');
    });

    await render(issuePart('issues_get', JSON.stringify(issue)));
    expect(container.textContent).toContain('DEMO-482 · Bug');
    expect(container.textContent).toContain('Login fails after token refresh');
    expect(Array.from(container.querySelectorAll('dt')).map((node) => node.textContent)).toEqual(['Assignee', 'Priority']);
    expect(Array.from(container.querySelectorAll('dd')).map((node) => node.textContent)).toEqual(['Olena K.', 'High']);
    expect(badge('In Progress')?.className).toContain('--status-info-background');
    expect(link()?.getAttribute('href')).toBe('https://acme.example/browse/DEMO-482');
    expect(link()?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link()?.textContent).toBe('Open in tracker');
    // The raw answer is not drawn beside the card.
    expect(container.textContent).not.toContain('"summary"');
    // Each text takes its own direction, so a value in another script reads in its own order.
    const texts = ['DEMO-482 · Bug', 'In Progress', 'Login fails after token refresh', 'Assignee', 'Olena K.', 'Open in tracker'];
    const shown = Array.from(container.querySelectorAll('span, div, dt, dd'));
    expect(texts.map((text) => shown.find((node) => node.textContent === text && node.children.length === 0)?.getAttribute('dir'))).toEqual(texts.map(() => 'auto'));

    // The saved setting changed: the catalog brings the new value and the link follows it.
    await act(async () => {
      useGuestsStore.getState().replaceCatalog([issuesGuest({ site: 'other.example' })], 'test');
    });
    expect(link()?.getAttribute('href')).toBe('https://other.example/browse/DEMO-482');
    // No value saved: the card stays, the link goes.
    await act(async () => {
      useGuestsStore.getState().replaceCatalog([issuesGuest()], 'test');
    });
    expect(container.textContent).toContain('Login fails after token refresh');
    expect(link()).toBeNull();

    // A missing path hides its part; a status without a mapping is neutral.
    await render(issuePart('issues_get', JSON.stringify({ key: 'DEMO-470', summary: 'Billing export misses refunds', status: 'To Do' })));
    expect(container.querySelectorAll('dt')).toHaveLength(0);
    expect(badge('To Do')?.className).toContain('oc-tile-inset');

    // An array, or an `items` array, is a list: one row per item, the first field beside the status, no link.
    await act(async () => {
      useGuestsStore.getState().replaceCatalog([issuesGuest({ site: 'acme.example' })], 'test');
    });
    const blocked = { key: 'DEMO-477', summary: 'Rate limiter drops webhook retries', status: 'Blocked', assignee: { name: 'Ada L.' }, priority: 'Low' };
    for (const output of [[issue, blocked], { total: 2, items: [issue, blocked] }]) {
      await render(issuePart('issues_search', JSON.stringify(output)));
      const rows = Array.from(container.querySelectorAll('li'));
      expect(rows.map((row) => Array.from(row.children).map((cell) => cell.textContent))).toEqual([
        ['DEMO-482 · Bug', 'Login fails after token refresh', 'Olena K.', 'In Progress'],
        ['DEMO-477 ·', 'Rate limiter drops webhook retries', 'Ada L.', 'Blocked'],
      ]);
      expect(badge('Blocked')?.className).toContain('--status-error-background');
      expect(rows.flatMap((row) => Array.from(row.children).map((cell) => cell.getAttribute('dir')))).toEqual(Array.from({ length: 8 }, () => 'auto'));
      expect(link()).toBeNull();
      expect(container.textContent).not.toContain('High');
    }

    // An item without a title: its first field is the row's text, in the cell no width hides.
    await render(issuePart('issues_search', JSON.stringify([{ assignee: { name: 'Ada L.' }, priority: 'Low' }, blocked])));
    const cells = Array.from(container.querySelectorAll('li')).map((row) => Array.from(row.children));
    expect(cells.map((row) => row.map((cell) => cell.textContent))).toEqual([['Ada L.'], ['DEMO-477 ·', 'Rate limiter drops webhook retries', 'Ada L.', 'Blocked']]);
    expect(cells[0]?.[0]?.getAttribute('title')).toBe('Assignee: Ada L.');
    expect([cells[0]?.[0], cells[1]?.[2]].map((cell) => cell?.className.includes('hidden'))).toEqual([false, true]);

    // Nothing the card names is in the answer, or the answer is not JSON: the output shows as it would without the rule.
    await render(issuePart('issues_get', JSON.stringify({ message: 'No such issue' })));
    expect(container.querySelector('li, dl')).toBeNull();
    expect(container.textContent).toContain('No such issue');
    await render(issuePart('issues_get', 'Issue DEMO-1 was not found.'));
    expect(container.querySelector('li, dl')).toBeNull();
    expect(container.textContent).toContain('Issue DEMO-1 was not found.');
  } finally {
    await dispose();
  }
});

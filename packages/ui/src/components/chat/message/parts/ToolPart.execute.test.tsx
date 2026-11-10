import { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { JsonValue, ToolPart as ToolPartData } from '@/lib/opencode/model';
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

const part: ToolPartData = {
  id: 'prt_execute', sessionID: 'ses_exec', messageID: 'msg_exec',
  type: 'tool', tool: 'execute', callID: 'call_exec',
  state: {
    status: 'completed',
    input: { code: 'const issues = await linear.list_issues({ teamId: "OPE" });\nreturn issues;' },
    output: '{"count":3}',
    metadata: {
      truncated: true,
      outputPath: '/tmp/oc-script-output.json',
      toolCalls: [
        { tool: 'linear.list_issues', status: 'completed', input: { teamId: 'OPE' } },
        { tool: 'linear.list_issues', status: 'error', input: { teamId: 'OPE' } },
        { tool: 'openchamber_web', status: 'completed', input: { action: 'browser.open' } },
        { tool: 'openchamber_web', status: 'completed', input: { action: 'browser.capture' } },
        { tool: 'opencode.worktree_list', status: 'completed', input: {} },
        { tool: 'opencode.session_rename', status: 'error', input: { title: 'x' } },
      ],
    },
    time: { start: 1, end: 2 },
  },
};

test('a Code Mode call shows its script, the tools it called, and the truncation note', async () => {
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

    // The row is named "Script", not "execute", and carries the braces icon.
    expect(container.textContent).toContain('Script');
    expect(container.textContent).not.toContain('execute');
    expect(container.querySelector('use[href="#oc-braces"]')).not.toBeNull();

    // The description names the called tools, deduplicated and counted.
    expect(container.textContent).toContain('linear.list_issues \u00d72, OpenChamber Web ×2, Listed worktrees, session_rename');
    // The failed OpenCode call (session_rename) keeps its tool's name: its verb would claim it happened.

    // The body lists every call with its input, and reports the truncated output.
    expect(container.textContent).toContain('Tool calls');
    expect(container.textContent).toContain('{"teamId":"OPE"}');
    expect(container.textContent).toContain('Output was truncated');
    expect(container.textContent).toContain('/tmp/oc-script-output.json');

    // A script whose calls all went to one namespace carries its name and mark.
    const namespacePart: ToolPartData = {
      ...part,
      id: 'prt_namespace',
      state: {
        status: 'completed',
        input: { code: 'await tools.opencode.worktree_list({})' },
        output: '"done"',
        metadata: {
          toolCalls: [
            { tool: 'opencode.worktree_list', status: 'completed', input: {} },
            { tool: 'opencode.session_rename', status: 'completed', input: { title: 'x' } },
          ],
        },
        time: { start: 1, end: 2 },
      },
    };
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="">
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <ToolPart part={namespacePart} isExpanded={false} isMobile={false} onToggle={() => {}} />
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      );
    });
    expect(container.textContent).toContain('OpenCodeListed worktrees, Renamed the session');
    expect(container.textContent).not.toContain('Script');
    expect(container.querySelector('use[href="#oc-opencode"]')).not.toBeNull();

    // OpenChamber actions draw their own view of the answer, never the envelope's JSON.
    const views: Array<[string, string, { [key: string]: JsonValue }, string[]]> = [
      ['openchamber_memory', 'memory.read', { memory: { memoryId: 'm1', title: 'Telemetry caveats', type: 'reference', scope: 'project', body: 'Counts are per install.' } }, ['Read a memory', 'Reference · This project', 'Telemetry caveats', 'Counts are per install.', 'Show the raw answer']],
      ['openchamber', 'session.messages', { sessionId: 'ses_x', directory: '/repo', role: 'all', messages: [{ id: 'b', role: 'assistant', createdAt: 2, completedAt: 3, model: 'a/b', text: 'Fixed the cookie.' }] }, ['Agent · a/b', 'Fixed the cookie.', 'Open session']],
      ['openchamber', 'pr.watch', { watching: { url: 'https://github.com/a/b/pull/7', number: 7, title: 'Fix login', status: 'pending' }, next: 'x' }, ['#7 Fix login', 'Checks running']],
      ['openchamber_web', 'browser.inspect', { ok: true, selector: '#save', tag: 'button', label: 'Save', styles: { color: 'red' } }, ['button · Save', '#save', 'color', 'red']],
      ['openchamber_web', 'browser.scroll', { ok: true, scrollY: 400, maxScrollY: 1200, atTop: false, atBottom: false }, ['Position', '400 of 1200 px']],
      ['openchamber_workflow', 'workflow.check', { name: 'audit-routes', description: 'Audit every route', phases: ['Find', 'Audit'], limits: { concurrentAgents: 8, agentsPerRun: 200 } }, ['audit-routes', 'Audit every route', '1. Find', '2. Audit']],
      ['openchamber_workflow', 'workflow.status', { id: 'run_1', parentSessionId: 'ses_exec', directory: '/repo', name: 'audit-routes', description: 'Audit every route', state: 'running', attempt: 1, createdAt: 1, currentPhase: 'Audit', phases: ['Find', 'Audit'], agents: [{ key: 'a', label: 'One', phase: 'Audit', state: 'completed' }, { key: 'b', label: 'Two', phase: 'Audit', state: 'running' }], logs: [] }, ['Running', 'Audit', '1 of 2 done']],
      ['openchamber_workflow', 'workflow.result', { runId: 'run_1', state: 'completed', result: 'Two routes lack auth.' }, ['Done', 'Two routes lack auth.']],
      ['openchamber_workflow', 'workflow.list', { workflows: [{ name: 'audit-routes', description: 'Audit every route' }], runs: [{ runId: 'run_1', name: 'audit-routes', state: 'failed', createdAt: 1 }] }, ['Saved', 'Runs', 'Failed']],
    ];
    for (const [tool, action, data, expected] of views) {
      const viewPart: ToolPartData = {
        ...part,
        id: `prt_${action}`,
        state: {
          status: 'completed',
          input: { code: 'return await tools.x()' },
          output: JSON.stringify({ schemaVersion: 1, ok: true, action, data }),
          metadata: { toolCalls: [{ tool, status: 'completed', input: { action, parameters: {} } }] },
          time: { start: 1, end: 2 },
        },
      };
      await act(async () => {
        root.render(
          <SyncProvider sdk={sdk} directory="">
            <I18nProvider>
              <ThemeSystemContext.Provider value={themeContext}>
                <ToolPart key={viewPart.id} part={viewPart} isExpanded isMobile={false} onToggle={() => {}} />
              </ThemeSystemContext.Provider>
            </I18nProvider>
          </SyncProvider>,
        );
      });
      for (const text of expected) expect(container.textContent).toContain(text);
      expect(container.textContent).not.toContain('schemaVersion');
    }
  } finally {
    await act(async () => { root.unmount(); });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

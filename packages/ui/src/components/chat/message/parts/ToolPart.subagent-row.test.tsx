import { act } from 'react';
import { describe, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { ToolPart as ToolPartData } from '@/lib/opencode/model';
import { SyncProvider, useChildStoreManager } from '@/sync/sync-context';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useGuestsStore } from '@/lib/guests/store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useSessionActivityTimingStore } from '@/sync/session-activity-timing';
import { opencodeClient } from '@/lib/opencode/client';
import { subagentCancellationNote } from '@/lib/opencode/subagent-run';

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

const parent: ToolPartData = {
  id: 'parent-call', sessionID: 'parent', messageID: 'parent-message',
  type: 'tool', tool: 'subagent', callID: 'parent-call',
  state: {
    status: 'completed', input: { description: 'Update files', agent: 'explore' },
    output: '<subagent sessionID="child" state="completed">\nFound two files\n</subagent>',
    metadata: { sessionID: 'child' }, time: { start: 1_000, end: 63_000 },
  },
};

const patchPart = (paths: string[]): ToolPartData => ({
  id: 'patch-call', sessionID: 'child', messageID: 'child-message',
  type: 'tool', tool: 'patch', callID: 'patch-call',
  state: {
    status: 'completed',
    input: { patchText: ['*** Begin Patch', ...paths.flatMap((path) => [
      `*** Add File: ${path}`, '+content',
    ]), '*** End Patch'].join('\n') },
    output: '', metadata: {}, time: { start: 1, end: 2 },
  },
});

const withHarness = async (
  toolPart: ToolPartData,
  isExpanded: boolean,
  run: (store: ReturnType<ReturnType<typeof useChildStoreManager>['ensureChild']>, container: HTMLElement) => Promise<void>,
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
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const sdk = OpenCode.make({
    baseUrl: 'http://localhost',
    fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
  });

  const previousDirectory = useDirectoryStore.getState().currentDirectory;
  let manager: ReturnType<typeof useChildStoreManager> | undefined;
  const CaptureManager = () => { manager = useChildStoreManager(); return null; };
  try {
    useDirectoryStore.setState({ currentDirectory: '/workspace' });
    useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="/workspace">
          <CaptureManager />
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <ToolPart part={toolPart} isExpanded={isExpanded} isMobile={false} onToggle={() => {}} />
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      );
    });

    if (!manager) throw new Error('Sync manager did not mount');
    await run(manager.ensureChild('/workspace', { bootstrap: false }), container);
  } finally {
    await act(async () => { root.unmount(); });
    useDirectoryStore.setState({ currentDirectory: previousDirectory });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

const childSession = (id: string, created: number) => ({
  id, parentID: 'parent', projectID: 'p', directory: '/workspace', title: id, agent: 'explore',
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created, updated: created },
});

const childActivity = (sessionID: string) => ({
  message: { [sessionID]: [{
    id: `${sessionID}-message`, sessionID, role: 'assistant' as const,
    agent: 'explore', providerID: 'test', modelID: 'test',
    time: { created: 121, completed: 122 },
  }] },
  part: { [`${sessionID}-message`]: [{ ...patchPart(['src/child-work.ts']), sessionID, messageID: `${sessionID}-message` }] },
});

const openButton = (container: HTMLElement) => container.querySelector('button[aria-label="Open Explore subtask"]');

test('a finished subagent is one row with its duration and an open action, never its child activity', async () => {
  await withHarness(parent, false, async (store, container) => {
    await act(async () => store.setState(childActivity('child')));
    expect(container.textContent).toContain('Update files');
    expect(container.textContent).toContain('62.0s');
    expect(openButton(container)).not.toBeNull();
    expect(container.textContent).not.toContain('child-work.ts');
    expect(container.textContent).not.toContain('Found two files');
  });
});

test('a running subagent without the progress join resolves its child session from the store', async () => {
  const running: ToolPartData = {
    ...parent,
    state: { status: 'running', input: { description: 'Look around', agent: 'explore', sessionID: '  ' }, time: { start: 100 } },
  };
  await withHarness(running, false, async (store, container) => {
    expect(openButton(container)).toBeNull();
    await act(async () => store.setState({ session: [childSession('child', 120)], ...childActivity('child') }));
    expect(openButton(container)).not.toBeNull();
    expect(container.textContent).not.toContain('child-work.ts');
  });
});

test('a resumed subagent opens its explicit child even when that child predates the call', async () => {
  const running: ToolPartData = {
    ...parent,
    state: {
      status: 'running',
      input: { description: 'Look around', agent: 'explore', sessionID: 'child' },
      time: { start: 100 },
    },
  };
  await withHarness(running, false, async (store, container) => {
    await act(async () => store.setState({ session: [childSession('child', 50)] }));
    expect(openButton(container)).not.toBeNull();
  });
});

test('a running subagent offers a stop that tells the agent before interrupting the child', async () => {
  const running: ToolPartData = {
    ...parent,
    state: { status: 'running', input: { description: 'Look around', agent: 'explore' }, metadata: { sessionID: 'child' }, time: { start: 100 } },
  };
  const stop = spyOn(opencodeClient, 'stopSubagent').mockResolvedValue(undefined);
  try {
    await withHarness(running, false, async (_store, container) => {
      const button = container.querySelector('button[aria-label="Stop subagent"]');
      if (!(button instanceof HTMLElement)) throw new Error('Stop action is missing');
      await act(async () => { button.click(); });
      expect(stop.mock.calls).toEqual([[{ sessionID: 'parent', directory: '/workspace', childSessionID: 'child', description: 'Look around' }]]);
      expect(container.querySelector('button[aria-label="Stop subagent"]')).toBeNull();
    });
  } finally {
    stop.mockRestore();
  }
});

test('a subagent the user stopped reads as stopped, not failed, and offers no stop', async () => {
  const cancelled: ToolPartData = {
    ...parent,
    id: 'stopped-call',
    state: {
      status: 'error', input: { description: 'Look around', agent: 'explore' },
      error: 'Subagent cancelled (sessionID: stopped-child)', metadata: { sessionID: 'stopped-child' }, time: { start: 100, end: 200 },
    },
  };
  const note = subagentCancellationNote({ childSessionID: 'stopped-child', description: 'Look around' });
  await withHarness(cancelled, false, async (store, container) => {
    await act(async () => store.setState({
      message: { parent: [{ id: 'note', sessionID: 'parent', role: 'synthetic', time: { created: 150 }, text: note.text, description: note.description, metadata: note.metadata }] },
    }));
    expect(container.textContent).toContain('stopped');
    expect(container.querySelector('button[aria-label="Stop subagent"]')).toBeNull();
  });
});

test('a background subagent drops the background label once its report arrives', async () => {
  const backgrounded: ToolPartData = {
    ...parent,
    id: 'background-call',
    state: {
      status: 'completed', input: { description: 'Look around', agent: 'explore' },
      output: 'The subagent is working in the background.', metadata: { status: 'running', sessionID: 'bg-child' }, time: { start: 100, end: 110 },
    },
  };
  await withHarness(backgrounded, false, async (store, container) => {
    await act(async () => store.setState({
      message: { parent: [{
        id: 'report', sessionID: 'parent', role: 'synthetic', time: { created: 900 },
        text: '<subagent sessionID="bg-child" state="completed" description="Look around">\nDone.\n</subagent>',
        description: 'Look around', metadata: { source: 'subagent', childID: 'bg-child', agent: 'explore', state: 'completed' },
      }] },
    }));
    expect(container.textContent).toContain('Look around');
    expect(container.textContent).not.toContain('in background');
    expect(container.querySelector('button[aria-label="Stop subagent"]')).toBeNull();
  });
});

// oh-my-opencode-slim's `task revive` prompts the same child session again, so
// the report already in the parent describes a run that is over while the child
// works on the next one.
test('a background subagent running again after a failed report reads as running', async () => {
  const backgrounded: ToolPartData = {
    ...parent,
    id: 'revived-call',
    state: {
      status: 'completed', input: { description: 'Look around', agent: 'explore' },
      output: 'The subagent is working in the background.', metadata: { status: 'running', sessionID: 'bg-child' }, time: { start: 100, end: 110 },
    },
  };
  const report = {
    id: 'report', sessionID: 'parent', role: 'synthetic' as const, time: { created: 900 },
    text: '<subagent sessionID="bg-child" state="error" description="Look around">\nProvider error\n</subagent>',
    description: 'Look around', metadata: { source: 'subagent', childID: 'bg-child', agent: 'explore', state: 'error' as const },
  };
  const previousStatus = useGlobalSessionStatusStore.getState();
  const previousTiming = useSessionActivityTimingStore.getState();
  try {
    await withHarness(backgrounded, true, async (store, container) => {
      await act(async () => store.setState({ message: { parent: [report] } }));
      // The report alone reads as the failure it was, timed by the call that started it.
      expect(container.textContent).toContain('Provider error');
      expect(container.textContent).toContain('0.8s');

      await act(async () => {
        useGlobalSessionStatusStore.setState({ activeSessionIds: new Set(['bg-child']) });
        useSessionActivityTimingStore.setState({ startedAt: new Map([['bg-child', Date.now() - 60_000]]) });
      });
      expect(container.textContent).not.toContain('Provider error');
      expect(container.textContent).toContain('in background');
      expect(container.querySelector('button[aria-label="Stop subagent"]')).not.toBeNull();
      // Counted from the revived turn, not from the call the report belongs to.
      expect(container.textContent).not.toContain('0.8s');

      await act(async () => useGlobalSessionStatusStore.setState({ activeSessionIds: new Set() }));
      expect(container.textContent).toContain('Provider error');
    });
  } finally {
    useGlobalSessionStatusStore.setState(previousStatus, true);
    useSessionActivityTimingStore.setState(previousTiming, true);
  }
});

// The tool that revived the child reports the end of that run itself, in the
// envelope OpenCode uses for a `task` result. The row follows it: the failure of
// the run before is history, and the new result appears where the run is.
test('a revived background subagent ends on the record of the run that continued it', async () => {
  const backgrounded: ToolPartData = {
    ...parent,
    id: 'revived-call',
    state: {
      status: 'completed', input: { description: 'Look around', agent: 'explore' },
      output: 'The subagent is working in the background.', metadata: { status: 'running', sessionID: 'bg-child' }, time: { start: 100, end: 110 },
    },
  };
  const report = {
    id: 'report', sessionID: 'parent', role: 'synthetic' as const, time: { created: 900 },
    text: '<subagent sessionID="bg-child" state="error" description="Look around">\nProvider error\n</subagent>',
    description: 'Look around', metadata: { source: 'subagent', childID: 'bg-child', agent: 'explore', state: 'error' as const },
  };
  const continued = {
    id: 'continued', sessionID: 'parent', role: 'synthetic' as const, time: { created: 9_000 },
    text: [
      '<task id="bg-child" state="completed">',
      '<summary>Background task completed: Look around</summary>',
      '<task_result>',
      'All three items are implemented.',
      '</task_result>',
      '</task>',
    ].join('\n'),
    metadata: { 'oh-my-opencode-slim.internalInitiator': true },
  };
  await withHarness(backgrounded, true, async (store, container) => {
    await act(async () => store.setState({ message: { parent: [report] } }));
    expect(container.textContent).toContain('Provider error');

    await act(async () => store.setState({ message: { parent: [report, continued] } }));
    expect(container.textContent).toContain('All three items are implemented.');
    expect(container.textContent).not.toContain('Provider error');
  });
});

// A foreground call fails into its own part and OpenCode never revises it, so a
// child continued by hand after that failure is the only thing that can tell the
// row the work went on.
describe('a failed foreground subagent', () => {
  const failed: ToolPartData = {
    ...parent,
    id: 'foreground-call',
    state: {
      status: 'error', input: { description: 'Look around', agent: 'explore' },
      error: 'Provider error', metadata: { sessionID: 'fg-child' }, time: { start: 1000, end: 10_000 },
    },
  };
  const record = (created: number) => ({
    id: 'record', sessionID: 'parent', role: 'synthetic' as const, time: { created },
    text: [
      '<task id="fg-child" state="completed">',
      '<summary>Background task completed: Look around</summary>',
      '<task_result>',
      'Fixed it up.',
      '</task_result>',
      '</task>',
    ].join('\n'),
    metadata: { 'oh-my-opencode-slim.internalInitiator': true },
  });

  test('reads as running while its child works again, without claiming the background', async () => {
    const previousStatus = useGlobalSessionStatusStore.getState();
    try {
      await withHarness(failed, false, async (_store, container) => {
        expect(container.textContent).toContain('Look around');
        expect(container.querySelector('button[aria-label="Stop subagent"]')).toBeNull();

        await act(async () => useGlobalSessionStatusStore.setState({ activeSessionIds: new Set(['fg-child']) }));
        expect(container.querySelector('button[aria-label="Stop subagent"]')).not.toBeNull();
        expect(container.textContent).not.toContain('in background');

        await act(async () => useGlobalSessionStatusStore.setState({ activeSessionIds: new Set() }));
        expect(container.querySelector('button[aria-label="Stop subagent"]')).toBeNull();
      });
    } finally {
      useGlobalSessionStatusStore.setState(previousStatus, true);
    }
  });

  test('follows a record of the run that continued it after the failure', async () => {
    await withHarness(failed, true, async (store, container) => {
      expect(container.textContent).toContain('Provider error');
      await act(async () => store.setState({ message: { parent: [record(60_000)] } }));
      expect(container.textContent).toContain('Fixed it up.');
      expect(container.textContent).not.toContain('Provider error');
    });
  });

  test('keeps the failure a report from before it describes', async () => {
    await withHarness(failed, true, async (store, container) => {
      await act(async () => store.setState({ message: { parent: [record(900)] } }));
      expect(container.textContent).toContain('Provider error');
      expect(container.textContent).not.toContain('Fixed it up.');
    });
  });
});

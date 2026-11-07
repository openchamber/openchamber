import { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Message, ToolInput, ToolPart as ToolPartData } from '@/lib/opencode/model';
import { SyncProvider, useChildStoreManager } from '@/sync/sync-context';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useGuestsStore } from '@/lib/guests/store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';
import { subagentCancellationNote } from '@/lib/opencode/subagent-run';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { getToolMetadata } from '@/lib/toolHelpers';

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
const { TimelineNotice } = await import('../TimelineNotice');

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

type HarnessHelpers = {
  renderPart: (part: ToolPartData, expanded?: boolean, failureReason?: string) => Promise<void>;
  renderNotice: (message: Message) => Promise<void>;
  renderTwoParts: (partA: ToolPartData, partB: ToolPartData) => Promise<void>;
};

const withHarness = async (
  toolPart: ToolPartData,
  isExpanded: boolean,
  run: (
    store: ReturnType<ReturnType<typeof useChildStoreManager>['ensureChild']>,
    container: HTMLElement,
    helpers: HarnessHelpers,
  ) => Promise<void>,
  failureReason?: string,
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
  let manager: ReturnType<typeof useChildStoreManager> | undefined;
  const CaptureManager = () => { manager = useChildStoreManager(); return null; };

  const renderPart = async (part: ToolPartData, expanded: boolean = isExpanded, failReason?: string) => {
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="/workspace">
          <CaptureManager />
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <ToolPart part={part} isExpanded={expanded} isMobile={false} onToggle={() => {}} failureReason={failReason ?? failureReason} />
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      );
    });
  };

  const renderNotice = async (message: Message) => {
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="/workspace">
          <CaptureManager />
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <TimelineNotice message={message} />
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      );
    });
  };

  const renderTwoParts = async (partA: ToolPartData, partB: ToolPartData) => {
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="/workspace">
          <CaptureManager />
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <div>
                <ToolPart part={partA} isExpanded={false} isMobile={false} onToggle={() => {}} />
                <ToolPart part={partB} isExpanded={false} isMobile={false} onToggle={() => {}} />
              </div>
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      );
    });
  };

  try {
    useDirectoryStore.setState({ currentDirectory: '/workspace' });
    useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
    await renderPart(toolPart, isExpanded, failureReason);

    if (!manager) throw new Error('Sync manager did not mount');
    await run(manager.ensureChild('/workspace', { bootstrap: false }), container, { renderPart, renderNotice, renderTwoParts });
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

const openButton = (container: HTMLElement) => container.querySelector('button[aria-label^="Open "][aria-label$=" subtask"]');

const headerTitleText = (root: HTMLElement) => {
  const scope = root.classList.contains('group/tool') ? root : (root.querySelector<HTMLElement>('.group\\/tool') ?? root);
  return scope.querySelector<HTMLElement>('span.font-medium')?.textContent ?? '';
};

const headerDescriptionText = (root: HTMLElement) => {
  const scope = root.classList.contains('group/tool') ? root : (root.querySelector<HTMLElement>('.group\\/tool') ?? root);
  return scope.querySelector<HTMLElement>('div[style*="--tools-description"] .truncate')?.textContent?.trim() ?? '';
};

test('a finished subagent is one row with its duration, visible agent title, and an open action, never its child activity', async () => {
  await withHarness(parent, false, async (store, container) => {
    await act(async () => store.setState(childActivity('child')));
    expect(headerTitleText(container)).toBe('explore');
    expect(headerDescriptionText(container)).toBe('Update files');
    expect(container.textContent).toContain('Update files');
    expect(container.textContent).toContain('62.0s');
    expect(openButton(container)).not.toBeNull();
    expect(container.textContent).not.toContain('child-work.ts');
    expect(container.textContent).not.toContain('Found two files');
  });
});

test('a pending subagent before child exists displays agent ID in header title and description', async () => {
  const pending: ToolPartData = {
    id: 'pending-call', sessionID: 'parent', messageID: 'parent-message',
    type: 'tool', tool: 'subagent', callID: 'pending-call',
    state: {
      status: 'pending',
      input: { description: 'Plan architecture', agent: 'planner' },
      raw: '',
    },
  };
  await withHarness(pending, false, async (_store, container) => {
    expect(headerTitleText(container)).toBe('planner');
    expect(headerDescriptionText(container)).toBe('Plan architecture');
    expect(openButton(container)).toBeNull();
  });
});

test('a running subagent before child exists displays agent in header title with live duration', async () => {
  const running: ToolPartData = {
    id: 'running-call', sessionID: 'parent', messageID: 'parent-message',
    type: 'tool', tool: 'subagent', callID: 'running-call',
    state: {
      status: 'running',
      input: { description: 'Draft architecture proposal', agent: 'architect' },
      time: { start: 1_000 },
    },
  };
  await withHarness(running, false, async (_store, container) => {
    expect(headerTitleText(container)).toBe('architect');
    expect(headerDescriptionText(container)).toBe('Draft architecture proposal');
    expect(openButton(container)).toBeNull();
    expect(container.querySelector('.tabular-nums')).not.toBeNull();
  });
});

test('a running subagent without the progress join resolves its child session from the store while showing agent title', async () => {
  const running: ToolPartData = {
    ...parent,
    state: { status: 'running', input: { description: 'Look around', agent: 'explore', sessionID: '  ' }, time: { start: 100 } },
  };
  await withHarness(running, false, async (store, container) => {
    expect(headerTitleText(container)).toBe('explore');
    expect(openButton(container)).toBeNull();
    await act(async () => store.setState({ session: [childSession('child', 120)], ...childActivity('child') }));
    expect(headerTitleText(container)).toBe('explore');
    expect(openButton(container)).not.toBeNull();
    expect(container.textContent).not.toContain('child-work.ts');
  });
});

test('a resumed subagent opens its explicit child even when that child predates the call and displays agent title', async () => {
  const running: ToolPartData = {
    ...parent,
    state: {
      status: 'running',
      input: { description: 'Look around', agent: 'explore', sessionID: 'child' },
      time: { start: 100 },
    },
  };
  await withHarness(running, false, async (store, container) => {
    expect(headerTitleText(container)).toBe('explore');
    await act(async () => store.setState({ session: [childSession('child', 50)] }));
    expect(headerTitleText(container)).toBe('explore');
    expect(openButton(container)).not.toBeNull();
  });
});

test('an expanded subagent retains the agent header title while displaying the prompt/output body', async () => {
  const expanded: ToolPartData = {
    id: 'expanded-call', sessionID: 'parent', messageID: 'parent-message',
    type: 'tool', tool: 'subagent', callID: 'expanded-call',
    state: {
      status: 'completed',
      input: { description: 'Audit security rules', agent: 'auditor', prompt: 'Check all security boundaries' },
      output: '<subagent sessionID="child" state="completed">\nAll boundaries verified\n</subagent>',
      metadata: { sessionID: 'child' },
      time: { start: 1_000, end: 5_000 },
    },
  };
  await withHarness(expanded, true, async (_store, container) => {
    expect(headerTitleText(container)).toBe('auditor');
    expect(headerDescriptionText(container)).toBe('Audit security rules');
    expect(container.textContent).toContain('Check all security boundaries');
    expect(container.textContent).toContain('All boundaries verified');
  });
});

test('a subagent failed before spawn shows agent header title, failure reason, and offers no open action', async () => {
  const failedPart: ToolPartData = {
    id: 'failed-call', sessionID: 'parent', messageID: 'parent-message',
    type: 'tool', tool: 'subagent', callID: 'failed-call',
    state: {
      status: 'error',
      input: { description: 'Inspect compiler crash', agent: 'debugger' },
      error: 'Spawn process rejected: quota exceeded',
      time: { start: 1_000, end: 1_200 },
    },
  };
  await withHarness(failedPart, false, async (_store, container) => {
    expect(headerTitleText(container)).toBe('debugger');
    expect(headerDescriptionText(container)).toBe('Inspect compiler crash');
    expect(container.textContent).toContain('Spawn process rejected: quota exceeded');
    expect(openButton(container)).toBeNull();
  }, 'Spawn process rejected: quota exceeded');
});

test('a running subagent offers a stop that tells the agent before interrupting the child and keeps agent title', async () => {
  const running: ToolPartData = {
    ...parent,
    state: { status: 'running', input: { description: 'Look around', agent: 'explore' }, metadata: { sessionID: 'child' }, time: { start: 100 } },
  };
  const stop = spyOn(opencodeClient, 'stopSubagent').mockResolvedValue(undefined);
  try {
    await withHarness(running, false, async (_store, container) => {
      expect(headerTitleText(container)).toBe('explore');
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

test('a subagent the user stopped reads as stopped, retains agent title, and offers no stop', async () => {
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
    expect(headerTitleText(container)).toBe('explore');
    expect(container.textContent).toContain('stopped');
    expect(container.querySelector('button[aria-label="Stop subagent"]')).toBeNull();
  });
});

test('a background subagent displays agent header title across running and terminal synthetic report states', async () => {
  const backgrounded: ToolPartData = {
    ...parent,
    id: 'background-call',
    state: {
      status: 'completed', input: { description: 'Look around', agent: 'explore' },
      output: 'The subagent is working in the background.', metadata: { status: 'running', sessionID: 'bg-child' }, time: { start: 100, end: 110 },
    },
  };
  await withHarness(backgrounded, false, async (store, container) => {
    await act(async () => {
      useGlobalSessionStatusStore.setState({ activeSessionIds: new Set(['bg-child']) });
    });
    try {
      expect(headerTitleText(container)).toBe('explore');
      expect(container.textContent).toContain('in background');
      expect(container.querySelector('button[aria-label="Stop subagent"]')).not.toBeNull();

      await act(async () => store.setState({
        message: { parent: [{
          id: 'report', sessionID: 'parent', role: 'synthetic', time: { created: 900 },
          text: '<subagent sessionID="bg-child" state="completed" description="Look around">\nDone.\n</subagent>',
          description: 'Look around', metadata: { source: 'subagent', childID: 'bg-child', agent: 'explore', state: 'completed' },
        }] },
      }));
      expect(headerTitleText(container)).toBe('explore');
      expect(container.textContent).toContain('Look around');
      expect(container.textContent).not.toContain('in background');
      expect(container.querySelector('button[aria-label="Stop subagent"]')).toBeNull();
    } finally {
      await act(async () => {
        useGlobalSessionStatusStore.setState({ activeSessionIds: new Set() });
      });
    }
  });
});

test('subagent header title falls back to generic Agent Task when agent is absent, empty, whitespace, or malformed', async () => {
  const fallbacks: Array<{ name: string; input: ToolInput }> = [
    { name: 'no agent field', input: { description: 'Generic task' } },
    { name: 'empty string agent', input: { agent: '', description: 'Generic task' } },
    { name: 'whitespace agent', input: { agent: '   \t  ', description: 'Generic task' } },
    { name: 'null agent', input: { agent: null, description: 'Generic task' } },
    { name: 'number agent', input: { agent: 42, description: 'Generic task' } },
    { name: 'object agent', input: { agent: { id: 'bad' }, description: 'Generic task' } },
  ];
  for (const tc of fallbacks) {
    const partData: ToolPartData = {
      id: `fallback-${tc.name.replace(/\s+/g, '-')}`,
      sessionID: 'parent', messageID: 'parent-message',
      type: 'tool', tool: 'subagent', callID: 'fallback-call',
      state: {
        status: 'completed',
        input: tc.input,
        output: '',
        time: { start: 1_000, end: 2_000 },
      },
    };
    await withHarness(partData, false, async (_store, container) => {
      expect(headerTitleText(container)).toBe('Agent Task');
      expect(headerDescriptionText(container)).toBe('Generic task');
    });
  }
});

test('subagent header title trims surrounding whitespace from agent ID', async () => {
  const padded: ToolPartData = {
    id: 'padded-agent', sessionID: 'parent', messageID: 'parent-message',
    type: 'tool', tool: 'subagent', callID: 'padded-call',
    state: {
      status: 'completed',
      input: { agent: '   architect   ', description: 'Plan architecture' },
      output: '',
      time: { start: 1_000, end: 2_000 },
    },
  };
  await withHarness(padded, false, async (_store, container) => {
    expect(headerTitleText(container)).toBe('architect');
  });
});

test('multiple subagent calls rendered concurrently display distinct agent names without cross-contamination', async () => {
  const callAlpha: ToolPartData = {
    id: 'call-alpha', sessionID: 'parent', messageID: 'parent-message',
    type: 'tool', tool: 'subagent', callID: 'call-alpha',
    state: {
      status: 'completed',
      input: { agent: 'agent-alpha', description: 'Alpha task' },
      output: '',
      time: { start: 1_000, end: 2_000 },
    },
  };
  const callBeta: ToolPartData = {
    id: 'call-beta', sessionID: 'parent', messageID: 'parent-message',
    type: 'tool', tool: 'subagent', callID: 'call-beta',
    state: {
      status: 'completed',
      input: { agent: 'agent-beta', description: 'Beta task' },
      output: '',
      time: { start: 1_000, end: 2_000 },
    },
  };
  await withHarness(callAlpha, false, async (_store, container, helpers) => {
    await helpers.renderTwoParts(callAlpha, callBeta);
    const rows = container.querySelectorAll<HTMLElement>('.group\\/tool');
    expect(rows.length).toBe(2);
    expect(headerTitleText(rows[0])).toBe('agent-alpha');
    expect(headerDescriptionText(rows[0])).toBe('Alpha task');
    expect(headerTitleText(rows[1])).toBe('agent-beta');
    expect(headerDescriptionText(rows[1])).toBe('Beta task');
  });
});

test('re-rendering the same part id with same status and updated agent input updates the header title', async () => {
  const runningPartInitial: ToolPartData = {
    id: 'same-part-id', sessionID: 'parent', messageID: 'parent-message',
    type: 'tool', tool: 'subagent', callID: 'dynamic-call',
    state: {
      status: 'running',
      input: { agent: 'initial-agent', description: 'Step 1' },
      time: { start: 1_000 },
    },
  };
  const runningPartUpdated: ToolPartData = {
    ...runningPartInitial,
    state: {
      status: 'running',
      input: { agent: 'updated-agent', description: 'Step 2' },
      time: { start: 1_000 },
    },
  };
  await withHarness(runningPartInitial, false, async (_store, container, helpers) => {
    expect(headerTitleText(container)).toBe('initial-agent');
    expect(headerDescriptionText(container)).toBe('Step 1');

    await helpers.renderPart(runningPartUpdated);
    expect(headerTitleText(container)).toBe('updated-agent');
    expect(headerDescriptionText(container)).toBe('Step 2');
  });
});

test('long custom agent name remains complete in title DOM without JS truncation', async () => {
  const longName = 'enterprise-cloud-infrastructure-reliability-and-compliance-auditor';
  const longPart: ToolPartData = {
    id: 'long-agent-part', sessionID: 'parent', messageID: 'parent-message',
    type: 'tool', tool: 'subagent', callID: 'long-call',
    state: {
      status: 'completed',
      input: { agent: longName, description: 'Run full audit' },
      output: '',
      time: { start: 1_000, end: 2_000 },
    },
  };
  await withHarness(longPart, false, async (_store, container) => {
    expect(headerTitleText(container)).toBe(longName);
  });
});

test('non-subagent tools retain their default tool display names unchanged', async () => {
  const nonSubagentTools: Array<{ tool: string; input: ToolInput }> = [
    { tool: 'shell', input: { command: 'git status' } },
    { tool: 'bash', input: { command: 'echo hello' } },
    { tool: 'edit', input: { path: 'src/index.ts' } },
    { tool: 'write', input: { path: 'src/new.ts', content: 'export const x = 1;' } },
    { tool: 'read', input: { path: 'src/read.ts' } },
    { tool: 'glob', input: { pattern: '**/*.ts' } },
  ];
  for (const tc of nonSubagentTools) {
    const toolPart: ToolPartData = {
      id: `tool-${tc.tool}`, sessionID: 'parent', messageID: 'parent-message',
      type: 'tool', tool: tc.tool, callID: `call-${tc.tool}`,
      state: {
        status: 'completed',
        input: tc.input,
        output: 'ok',
        time: { start: 1_000, end: 2_000 },
      },
    };
    await withHarness(toolPart, false, async (_store, container) => {
      const expectedDisplayName = getToolMetadata(tc.tool).displayName;
      expect(headerTitleText(container)).toBe(expectedDisplayName);
    });
  }
});

test('no duplicate task description in header when input description is absent and agent is specified', async () => {
  const noDescPart: ToolPartData = {
    id: 'no-desc-call', sessionID: 'parent', messageID: 'parent-message',
    type: 'tool', tool: 'subagent', callID: 'no-desc-call',
    state: {
      status: 'completed',
      input: { agent: 'explorer' },
      output: '',
      time: { start: 1_000, end: 2_000 },
    },
  };
  await withHarness(noDescPart, false, async (_store, container) => {
    expect(headerTitleText(container)).toBe('explorer');
    expect(headerDescriptionText(container)).not.toBe('explorer');
  });
});

test('synthetic TimelineNotice carries subagent agent to visible tool header row for completed run', async () => {
  const message: Message = {
    id: 'synth-subagent-completed',
    sessionID: 'parent',
    role: 'synthetic',
    time: { created: 1_000 },
    text: '<subagent sessionID="child-1" state="completed" description="Run regression checks">\nAll checks passed\n</subagent>',
    description: 'Run regression checks',
    metadata: {
      source: 'subagent',
      childID: 'child-1',
      agent: 'verifier',
      state: 'completed',
    },
  };
  await withHarness(parent, false, async (_store, container, helpers) => {
    await helpers.renderNotice(message);
    expect(headerTitleText(container)).toBe('verifier');
    expect(headerDescriptionText(container)).toBe('Run regression checks');
  });
});

test('synthetic TimelineNotice carries subagent agent to visible tool header row for running job', async () => {
  const message: Message = {
    id: 'subagent-run:child-running-job',
    sessionID: 'parent',
    role: 'synthetic',
    time: { created: 1_000 },
    text: '',
    description: 'Build packages',
    metadata: {
      source: 'subagent',
      childID: 'child-running-job',
      state: 'running',
      agent: 'deployer',
    },
  };
  await withHarness(parent, false, async (_store, container, helpers) => {
    await helpers.renderNotice(message);
    expect(headerTitleText(container)).toBe('deployer');
    expect(headerDescriptionText(container)).toBe('Build packages');
  });
});

test('synthetic TimelineNotice falls back to generic Agent Task in visible tool header when agent is absent', async () => {
  const message: Message = {
    id: 'synth-subagent-no-agent',
    sessionID: 'parent',
    role: 'synthetic',
    time: { created: 1_000 },
    text: '<subagent sessionID="child-legacy" state="completed" description="Legacy subtask">\nCompleted\n</subagent>',
    description: 'Legacy subtask',
    metadata: {
      source: 'subagent',
      childID: 'child-legacy',
      state: 'completed',
    },
  };
  await withHarness(parent, false, async (_store, container, helpers) => {
    await helpers.renderNotice(message);
    expect(headerTitleText(container)).toBe('Agent Task');
    expect(headerDescriptionText(container)).toBe('Legacy subtask');
  });
});

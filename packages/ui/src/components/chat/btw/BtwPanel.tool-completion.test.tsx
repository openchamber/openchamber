import { act } from 'react';
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Message, Metadata, Part, Session, ToolPart as ToolPartData } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { toolContentShellChars } from '@/lib/opencode/toolContentShells';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { ChatColumnSessionContext } from '../chatColumnSession';
import type { BtwPanelState } from './useBtwPanelState';

// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'btw-tool-completion-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const { default: ToolPart } = await import('../message/parts/ToolPart');

// The real row inside the real panel; only the message chrome around it goes.
mock.module('@/components/chat/ChatMessage', () => ({
  default: ({ message }: { message: { parts: Part[] } }) => message.parts.map((part) => (
    part.type === 'tool'
      ? <ToolPart key={part.id} part={part} isExpanded isMobile={false} onToggle={() => {}} />
      : null
  )),
}));

const { BtwPanel } = await import('./BtwPanel');

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

const PARENT_DIRECTORY = '/repo/chat';
const FORK_DIRECTORY = '/private/repo/fork';
const PARENT_ID = 'ses_parent';
const FORK_ID = 'ses_fork';
const MESSAGE_ID = 'msg_fork';
const OUTPUT = 'output read through the fork';

const panel: BtwPanelState = {
  parentPromoted: false,
  btwSessionId: FORK_ID,
  btwDirectory: FORK_DIRECTORY,
  boundaryMessageID: null,
  collapsed: false,
  creating: false,
  pending: false,
};

const session: Session = {
  id: FORK_ID,
  parentID: PARENT_ID,
  projectID: 'project',
  directory: FORK_DIRECTORY,
  title: 'btw',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
};

const info: Message = {
  id: MESSAGE_ID,
  sessionID: FORK_ID,
  role: 'assistant',
  time: { created: 1, completed: 2 },
  modelID: 'model',
  providerID: 'provider',
  agent: 'build',
};

const toolPart = (output: string, metadata: Metadata): ToolPartData => ({
  id: 'prt_tool',
  sessionID: FORK_ID,
  messageID: MESSAGE_ID,
  type: 'tool',
  tool: 'bash',
  callID: 'call_tool',
  state: { status: 'completed', input: { command: 'ls' }, output, metadata, time: { start: 1, end: 2 } },
});

const shelled = toolPart('', { openchamberContentShell: { chars: OUTPUT.length } });
const whole = toolPart(OUTPUT, {});

let happyWindow: Window;
let previous: Array<readonly [string, PropertyDescriptor | undefined]>;
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  happyWindow = new Window({ url: 'http://localhost' });
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
  previous = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  await happyWindow.happyDOM.abort();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

/** The parent's column shows the fork, whose records live in another directory's store. */
const renderFork = async () => {
  const sdk = OpenCode.make({
    baseUrl: 'http://localhost',
    fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
  });
  const tree = (showPanel: boolean) => (
    <SyncProvider sdk={sdk} directory={PARENT_DIRECTORY}>
      <I18nProvider>
        <ThemeSystemContext.Provider value={themeContext}>
          <TooltipProvider>
            <ChatColumnSessionContext.Provider value={{ sessionId: PARENT_ID, directory: PARENT_DIRECTORY }}>
              {showPanel ? <BtwPanel parentSessionId={PARENT_ID} panel={panel} hidden={false} onExit={() => {}} /> : null}
            </ChatColumnSessionContext.Provider>
          </TooltipProvider>
        </ThemeSystemContext.Provider>
      </I18nProvider>
    </SyncProvider>
  );
  await act(async () => { root.render(tree(false)); });

  const stores = getSyncChildStores();
  const parent = stores.ensureChild(PARENT_DIRECTORY, { bootstrap: false });
  const fork = stores.ensureChild(FORK_DIRECTORY, { bootstrap: false });
  fork.setState({
    session: [session],
    message: { [FORK_ID]: [info] },
    part: { [MESSAGE_ID]: [shelled] },
  });
  await act(async () => { root.render(tree(true)); });
  return { parent, fork };
};

test('a fork in another directory completes its row in its own store', async () => {
  const read = spyOn(opencodeClient, 'getToolContentMessage').mockResolvedValue({ info, parts: [whole] });
  try {
    const { parent, fork } = await renderFork();
    const parentBefore = parent.getState();
    await settle();

    expect(read.mock.calls).toEqual([[FORK_ID, MESSAGE_ID, FORK_DIRECTORY]]);
    expect(fork.getState().part[MESSAGE_ID].some((part) => toolContentShellChars(part) !== null)).toBe(false);
    expect(container.textContent).toContain(OUTPUT);
    expect(parent.getState().message).toBe(parentBefore.message);
    expect(parent.getState().part).toBe(parentBefore.part);
  } finally {
    read.mockRestore();
  }
});

test('a message removed from the fork while its result loads does not come back', async () => {
  let answer: (record: { info: Message; parts: Part[] }) => void = () => {};
  const read = spyOn(opencodeClient, 'getToolContentMessage').mockImplementation(
    () => new Promise((resolve) => { answer = resolve; }),
  );
  try {
    const { fork } = await renderFork();
    await settle();
    expect(read.mock.calls).toHaveLength(1);

    await act(async () => { fork.setState({ message: { [FORK_ID]: [] } }); });
    await act(async () => { answer({ info, parts: [whole] }); });
    await settle();

    expect(fork.getState().message[FORK_ID]).toEqual([]);
    expect(JSON.stringify(fork.getState().part)).not.toContain(OUTPUT);
  } finally {
    read.mockRestore();
  }
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import type { Message, Session } from '@/lib/opencode/model';
import { useUIStore } from '@/stores/useUIStore';
import { ChildStoreManager } from '@/sync/child-store';
import { SessionMessageLoader } from '@/sync/session-message-loader';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncContext, SyncRuntimeContext, type SyncSystem } from '@/sync/sync-runtime-context';
import { HeaderContextUsage } from './HeaderContextUsage';
import { ContextRailTooltipDetails } from './ContextRailUsage';

const directory = '/context-usage-test';
const sdk = OpenCode.make({ baseUrl: 'http://context-usage.test' });
const measured: Message = {
  id: 'answer', sessionID: 'root', role: 'assistant', time: { created: 1 },
  agent: 'build', providerID: 'test', modelID: 'test',
  tokens: { input: 28_600, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
};
const compacted: Message = {
  id: 'compaction', sessionID: 'root', role: 'compaction', time: { created: 2 },
  reason: 'auto', status: 'completed', summary: '',
};

const session = (id: string, cost: number, parentID?: string): Session => ({
  id, cost, parentID, projectID: 'project', directory, title: id,
  time: { created: 0, updated: 0 },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

describe('HeaderContextUsage cost', () => {
  let browser: Window;
  let root: Root;
  let container: HTMLElement;
  let system: SyncSystem;
  let sessions: Session[];
  let messages: Message[];
  let restoreGlobals: () => void;

  beforeEach(() => {
    browser = new Window({ url: 'http://localhost' });
    const globals = {
      window: browser, document: browser.document, navigator: browser.navigator,
      HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
      localStorage: browser.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
      getComputedStyle: browser.getComputedStyle.bind(browser),
    };
    const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    for (const [key, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    restoreGlobals = () => {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };
    const childStores = new ChildStoreManager({ seedsSessions: () => false });
    const runtimeKey = 'context-usage-test';
    system = {
      childStores, runtimeKey, sdk, directory,
      messageLoader: new SessionMessageLoader(childStores, {
        runtimeKey,
        sdk: { getSessionMessages: async () => ({ items: [], cursor: {} }) },
      }),
      currentDirectory: { get: () => directory, subscribe: () => () => {} },
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    sessions = [session('root', 4.1593)];
    messages = [measured];
    useSessionUIStore.setState({ currentSessionId: 'root', currentSessionDirectory: directory });
    useUIStore.setState({
      workStatusPanelVisible: false, workStatusHiddenSections: [],
      workStatusPanelEnabled: true, workStatusPanelFits: true, workStatusOverlayOpen: false,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    system.messageLoader.dispose();
    system.childStores.disposeAll();
    await browser.happyDOM.close();
    restoreGlobals();
  });

  const render = async (node: React.ReactNode) => {
    const store = system.childStores.ensureChild(directory, { bootstrap: false });
    await act(async () => {
      store.setState({ session: sessions, message: { root: messages } });
      root.render(
        <I18nProvider>
          <SyncRuntimeContext.Provider value={system}>
            <SyncContext.Provider value={system}>{node}</SyncContext.Provider>
          </SyncRuntimeContext.Provider>
        </I18nProvider>,
      );
    });
    return container.textContent;
  };
  const text = (isMobile = false) => render(<HeaderContextUsage buttonClassName="header-button" isMobile={isMobile} />);
  const tooltipText = (showCostBreakdown = true) => render(<ContextRailTooltipDetails showCostBreakdown={showCostBreakdown} />);

  test('shows only the session cost when there are no subagents', async () => {
    expect(await text()).toBe('14.3% · $4.1593');
  });

  test('shows only the recursive total in the header using panel precision', async () => {
    sessions.push(session('child', 0.5, 'root'), session('grandchild', 0.1827, 'child'));
    expect(await text()).toBe('14.3% · $4.842');
  });

  test('does not include unrelated sessions', async () => {
    sessions.push(session('other', 50), session('other-child', 10, 'other'));
    expect(await text()).toBe('14.3% · $4.1593');
  });

  test('keeps zero-cost subagents out of the compact header', async () => {
    sessions.push(session('child', 0, 'root'));
    expect(await text()).toBe('14.3% · $4.1593');
  });

  test('omits unavailable cost without hiding the context', async () => {
    sessions = [];
    expect(await text()).toBe('14.3%');
  });

  test('shows a known zero cost', async () => {
    sessions = [session('root', 0)];
    expect(await text()).toBe('14.3% · $0');
  });

  test('keeps the cost visible after compaction', async () => {
    messages = [measured, compacted];
    expect(await text()).toBe('— · $4.1593');
  });

  test('shows nothing without a context reading', async () => {
    messages = [];
    expect(await text()).toBe('');
  });

  test('shows nothing without a selected session', async () => {
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
    expect(await text()).toBe('');
  });

  test('defers to Work Status only while its Session section is visible', async () => {
    useUIStore.setState({ workStatusPanelVisible: true });
    expect(await text()).toBe('');
    await act(async () => useUIStore.setState({ workStatusHiddenSections: ['session'] }));
    expect(container.textContent).toBe('14.3% · $4.1593');
  });

  test('also defers to the visible Work Status overlay on a narrow layout', async () => {
    useUIStore.setState({ workStatusPanelFits: false, workStatusOverlayOpen: true });
    expect(await text()).toBe('');
    expect(await text(true)).toBe('14.3% · $4.1593');
    expect(await text()).toBe('');
    await act(async () => useUIStore.setState({ workStatusOverlayOpen: false }));
    expect(container.textContent).toBe('14.3% · $4.1593');
  });

  test('shows session and recursive subagent costs on separate tooltip lines', async () => {
    sessions.push(session('child', 0.5, 'root'), session('grandchild', 0.1827, 'child'));
    await tooltipText();
    expect(Array.from(container.querySelectorAll('bdi'), (value) => value.parentElement?.textContent))
      .toEqual(['Session: $4.1593', 'Subagents: $0.6827']);
  });

  test('shows known zero costs in both tooltip rows', async () => {
    sessions = [session('root', 0)];
    const tooltip = await tooltipText();
    expect(tooltip).toContain('Session: $0');
    expect(tooltip).toContain('Subagents: $0');
  });

  test('omits the tooltip breakdown when cost is unavailable', async () => {
    sessions = [];
    const tooltip = await tooltipText();
    expect(tooltip).not.toContain('Session:');
    expect(tooltip).not.toContain('Subagents:');
  });

  test('leaves the rail tooltip unchanged without the header breakdown option', async () => {
    const tooltip = await tooltipText(false);
    expect(tooltip).not.toContain('Session:');
    expect(tooltip).not.toContain('Subagents:');
  });
});

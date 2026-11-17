import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { opencodeClient } from '@/lib/opencode/client';
import { I18nProvider } from '@/lib/i18n';
import { dict as enDict } from '@/lib/i18n/messages/en';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { WorkStatusMcpSection } from '@/components/chat/work-status/WorkStatusMcpSection';
import type { McpServerStatus } from '@/lib/opencode/model';
import { toast } from 'sonner';

type LoadMcpConfigs = (options?: { force?: boolean; directory?: string | null }) => Promise<boolean>;

// Reading MCP status boots the directory's whole stdio server fleet as an
// OpenCode side effect, so these tests spy on the status read itself and
// assert which mounts are allowed to issue it.
describe('MCP dropdown status reads', () => {
  let root: Root | null = null;
  let restoreGlobals: () => void;
  let listSpy: ReturnType<typeof spyOn>;
  let listServers: typeof opencodeClient.listMcpServers;
  let originalLoadMcpConfigs: LoadMcpConfigs;
  let dom: Window;
  const initialSessionState = useSessionUIStore.getState();
  const extraSpies: Array<{ mockRestore: () => void }> = [];
  const configRequests: Array<Parameters<LoadMcpConfigs>[0]> = [];
  const loadMcpConfigs = mock(async (options?: Parameters<LoadMcpConfigs>[0]) => {
    configRequests.push(options);
    return true;
  });

  const renderNode = async (element: React.ReactNode) => {
    const host = document.createElement('div');
    document.body.append(host);
    const mounted = createRoot(host);
    root = mounted;
    await act(async () => {
      mounted.render(
        <I18nProvider>
          <TooltipProvider>
            {element}
          </TooltipProvider>
        </I18nProvider>,
      );
    });
    return host;
  };

  beforeEach(() => {
    dom = new Window();
    const globals = {
      window: dom,
      document: dom.document,
      Event: dom.Event,
      PointerEvent: dom.PointerEvent,
      KeyboardEvent: dom.KeyboardEvent,
      HTMLElement: dom.HTMLElement,
      Element: dom.Element,
      Node: dom.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const descriptors = Object.getOwnPropertyDescriptors(globalThis);
    Object.assign(globalThis, globals);
    restoreGlobals = () => {
      for (const key of Object.keys(globals)) {
        const descriptor = descriptors[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };

    useDirectoryStore.setState({ currentDirectory: 'C:/proj-a' });
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: { ...initialSessionState.newSessionDraft, open: false },
    });
    useMcpStore.setState({
      byDirectory: {},
      diagnosticsByDirectory: {},
      loadingKeys: {},
      lastErrorKeys: {},
      refreshedAtKeys: {},
    });
    originalLoadMcpConfigs = useMcpConfigStore.getState().loadMcpConfigs;
    useMcpConfigStore.setState({ loadMcpConfigs });
    listServers = async () => [];
    listSpy = spyOn(opencodeClient, 'listMcpServers').mockImplementation((directory) => listServers(directory));
  });

  afterEach(async () => {
    if (root) {
      const mounted = root;
      root = null;
      await act(async () => mounted.unmount());
    }
    listSpy.mockRestore();
    useMcpConfigStore.setState({ loadMcpConfigs: originalLoadMcpConfigs });
    for (const spy of extraSpies.splice(0)) spy.mockRestore();
    useSessionUIStore.setState(initialSessionState);
    restoreGlobals();
  });

  test('inactive content does not read MCP status on mount', async () => {
    const { McpDropdownContent } = await import('./McpDropdown');
    await renderNode(<McpDropdownContent active={false} />);
    await act(async () => {});

    expect(listSpy.mock.calls.length).toBe(0);
  });

  test('active content reads MCP status on mount', async () => {
    const { McpDropdownContent } = await import('./McpDropdown');
    await renderNode(<McpDropdownContent active={true} />);
    await act(async () => {});

    expect(listSpy.mock.calls.length).toBe(1);
  });

  test('closed dropdown does not read MCP status on mount', async () => {
    const { McpDropdown } = await import('./McpDropdown');
    await renderNode(<McpDropdown headerIconButtonClass="" />);
    await act(async () => {});

    expect(listSpy.mock.calls.length).toBe(0);
  });

  test('directory change while inactive issues no status read', async () => {
    const { McpDropdownContent } = await import('./McpDropdown');
    await renderNode(<McpDropdownContent active={false} />);
    await act(async () => {});

    useDirectoryStore.setState({ currentDirectory: 'C:/proj-b' });
    await act(async () => {});

    expect(listSpy.mock.calls.length).toBe(0);
  });

  test('directory change while active reads the new directory', async () => {
    const { McpDropdownContent } = await import('./McpDropdown');
    await renderNode(<McpDropdownContent active={true} />);
    await act(async () => {});
    expect(listSpy.mock.calls.length).toBe(1);

    useDirectoryStore.setState({ currentDirectory: 'C:/proj-b' });
    await act(async () => {});

    expect(listSpy.mock.calls.length).toBe(2);
    expect(listSpy.mock.calls[1]?.[0]).toBe('C:/proj-b');
  });

  test('concurrent freshens issue a single status read', async () => {
    const first = useMcpStore.getState().ensureFresh({ directory: 'C:/proj-a', silent: true, maxAgeMs: 60_000 });
    const second = useMcpStore.getState().ensureFresh({ directory: 'C:/proj-a', silent: true, maxAgeMs: 60_000 });
    await act(async () => {
      await Promise.all([first, second]);
    });

    expect(listSpy.mock.calls.length).toBe(1);
  });

  const openChatDraft = (draftId = 100) => {
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: {
        ...initialSessionState.newSessionDraft,
        draftId, open: true, target: 'chat', preparedChatDirectory: null,
      },
    });
  };

  const prepareFixture = () => {
    const homeSpy = spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home/test', chatsRoot: '/chats' });
    const createSpy = spyOn(opencodeClient, 'createDirectory').mockImplementation(async (path) => ({ success: true, path }));
    extraSpies.push(homeSpy, createSpy);
    return createSpy;
  };

  test('a closed Chat dropdown neither prepares a directory nor reads the previous Chat', async () => {
    openChatDraft();
    const create = prepareFixture();
    const { McpDropdown } = await import('./McpDropdown');
    await renderNode(<McpDropdown headerIconButtonClass="" />);
    expect(create.mock.calls.length).toBe(0);
    expect(listSpy.mock.calls.length).toBe(0);
  });

  test('a Chat draft shows its own status and applies toggles in the directory reused by send', async () => {
    openChatDraft();
    const create = prepareFixture();
    const servers = (connected: boolean): McpServerStatus[] => [{
      name: 'fixture', status: connected ? { status: 'connected' } : { status: 'disabled' },
    }];
    const connected = new Map<string | null | undefined, boolean>([['C:/proj-a', true]]);
    listServers = async (directory) => servers(connected.get(directory) ?? false);
    const connect = spyOn(opencodeClient, 'connectMcpServer').mockImplementation(async (_name, directory) => {
      connected.set(directory, true);
    });
    extraSpies.push(connect);
    useMcpStore.setState({ byDirectory: { 'C:/proj-a': { fixture: servers(true)[0] } } });

    const { McpDropdownContent } = await import('./McpDropdown');
    const host = await renderNode(<McpDropdownContent active />);
    const prepared = useSessionUIStore.getState().newSessionDraft.preparedChatDirectory;
    expect(prepared?.startsWith('/chats/')).toBe(true);
    expect(listSpy.mock.calls).toEqual([[prepared]]);
    const toggle = host.querySelector<HTMLElement>('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    expect(connect.mock.calls[0]).toEqual(['fixture', prepared]);
    expect(connected.get('C:/proj-a')).toBe(true);
    expect(await useSessionUIStore.getState().prepareChatDraftDirectory()).toBe(prepared);
    expect(create.mock.calls.length).toBe(1);

    // Materialization transfers the prepared directory to the new session.
    // Clearing that draft field must not create a second scratch directory.
    await act(async () => {
      useSessionUIStore.setState((state) => ({ newSessionDraft: { ...state.newSessionDraft, preparedChatDirectory: null } }));
    });
    expect(create.mock.calls.length).toBe(1);
    await act(async () => {
      useSessionUIStore.setState((state) => ({
        currentSessionId: 'sent-chat', currentSessionDirectory: prepared,
        newSessionDraft: { ...state.newSessionDraft, open: false },
      }));
    });
    expect(host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
  });

  test('the status panel and dropdown share one prepared Chat directory', async () => {
    openChatDraft();
    const create = prepareFixture();
    const { McpDropdownContent } = await import('./McpDropdown');
    await renderNode(<><McpDropdownContent active /><WorkStatusMcpSection sessionId={null} directory={null} /></>);
    const prepared = useSessionUIStore.getState().newSessionDraft.preparedChatDirectory;
    expect(create.mock.calls.length).toBe(1);
    expect(listSpy.mock.calls.length).toBe(1);
    expect(listSpy.mock.calls).toEqual([[prepared]]);
  });

  test('preparation failure reports an error without reading or showing the previous scope', async () => {
    openChatDraft();
    const create = prepareFixture();
    create.mockRejectedValue(new Error('Cannot create Chat directory'));
    const error = spyOn(toast, 'error').mockImplementation(() => 'toast');
    extraSpies.push(error);
    const { McpDropdownContent } = await import('./McpDropdown');
    const host = await renderNode(<McpDropdownContent active />);
    expect(listSpy.mock.calls.length).toBe(0);
    expect(host.querySelector('[role="switch"]')).toBeNull();
    expect(error.mock.calls[0]?.[0]).toBe('Cannot create Chat directory');
  });

  test('a pinned session panel uses its own directory while the main Chat is a draft', async () => {
    openChatDraft();
    const create = prepareFixture();
    await renderNode(<WorkStatusMcpSection sessionId="pinned-chat" directory="/chats/pinned" />);
    expect(create.mock.calls.length).toBe(0);
    expect(listSpy.mock.calls).toEqual([['/chats/pinned']]);
  });

  test('project drafts read their selected directory rather than the previous session directory', async () => {
    useSessionUIStore.setState({ newSessionDraft: {
      ...initialSessionState.newSessionDraft, open: true, target: 'project', directoryOverride: '/project-b',
    } });
    const { McpDropdownContent } = await import('./McpDropdown');
    await renderNode(<McpDropdownContent active />);
    expect(listSpy.mock.calls).toEqual([['/project-b']]);
    expect(configRequests.at(-1)).toEqual({ force: true, directory: '/project-b' });
  });

  test('changing drafts during preparation discards the old directory without showing its connections', async () => {
    openChatDraft(100);
    const create = prepareFixture();
    let finish = (_value: { success: boolean; path: string }) => {};
    const pending = new Promise<{ success: boolean; path: string }>((resolve) => { finish = resolve; });
    create.mockImplementationOnce(() => pending);
    const cleanup = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    extraSpies.push(cleanup);
    const { McpDropdownContent } = await import('./McpDropdown');
    const host = await renderNode(<McpDropdownContent active />);
    expect(create.mock.calls.length).toBe(1);
    expect(listSpy.mock.calls.length).toBe(0);
    expect(host.querySelector('[role="switch"]')).toBeNull();
    const oldPath = create.mock.calls[0][0];
    await act(async () => { openChatDraft(101); });
    const currentPath = useSessionUIStore.getState().newSessionDraft.preparedChatDirectory;
    expect(currentPath).not.toBe(oldPath);
    await act(async () => { finish({ success: true, path: oldPath }); });
    expect(useSessionUIStore.getState().newSessionDraft.preparedChatDirectory).toBe(currentPath);
    expect(listSpy.mock.calls).toEqual([[currentPath]]);
    expect(cleanup.mock.calls.length).toBe(1);
  });

  // A server with code mode off changes the request's tool list mid-session; the note
  // tells the user that switching costs the next turn its prompt cache.
  test('both MCP toggle surfaces show the prompt cache note next to their switches', async () => {
    const note = enDict['mcpDropdown.cacheNote'];
    expect(note.length).toBeGreaterThan(0);
    const { McpDropdownContent } = await import('./McpDropdown');

    const empty = await renderNode(<McpDropdownContent active />);
    expect(empty.querySelector('[role="switch"]')).toBeNull();
    expect(empty.textContent).not.toContain(note);
    const emptyRoot = root;
    root = null;
    await act(async () => emptyRoot?.unmount());

    listServers = async () => [{ name: 'fixture', status: { status: 'connected' } }];
    const initialExpanded = useUIStore.getState().workStatusExpandedSections;
    useUIStore.setState({ workStatusExpandedSections: { ...initialExpanded, mcp: true } });
    extraSpies.push({ mockRestore: () => useUIStore.setState({ workStatusExpandedSections: initialExpanded }) });
    const host = await renderNode(<><McpDropdownContent active /><WorkStatusMcpSection sessionId={null} directory="C:/proj-a" /></>);
    await act(async () => { await useMcpStore.getState().refresh({ directory: 'C:/proj-a' }); });
    expect(host.querySelectorAll('[role="switch"]').length).toBe(2);
    expect(host.textContent?.split(note).length).toBe(3);
  });

  // happy-dom does no layout, so this checks the classes that do it: in a host with a
  // bounded height (the mobile workspace pane, overflow hidden), the server list is
  // the column's scrolling child and the note sits outside it, so neither is clipped.
  test('the content is a column whose server list scrolls and whose cache note stays outside it', async () => {
    listServers = async () => Array.from({ length: 30 }, (_, index) => ({ name: `server-${index}`, status: { status: 'connected' } }));
    const { McpDropdownContent } = await import('./McpDropdown');
    const host = await renderNode(
      <div className="h-96 overflow-hidden">
        <McpDropdownContent active fillHeight hideHeader mobileListDensity />
      </div>,
    );
    await act(async () => { await useMcpStore.getState().refresh({ directory: 'C:/proj-a' }); });
    const content = host.querySelector<HTMLElement>('[data-mcp-content]');
    const list = host.querySelector<HTMLElement>('[data-mcp-server-list]');
    const note = host.querySelector<HTMLElement>('[data-mcp-cache-note]');
    if (!content || !list || !note) throw new Error('Missing MCP content, list or note');
    expect(list.querySelectorAll('[role="switch"]').length).toBe(30);
    for (const name of ['flex', 'flex-col', 'min-h-0', 'h-full']) expect(content.classList.contains(name)).toBe(true);
    for (const name of ['flex-1', 'min-h-0', 'overflow-y-auto']) expect(list.classList.contains(name)).toBe(true);
    expect(list.classList.contains('max-h-64')).toBe(false);
    expect(note.parentElement).toBe(content);
    expect(note.classList.contains('shrink-0')).toBe(true);
  });

  test('the desktop dropdown keeps its list capped at the same height', async () => {
    listServers = async () => [{ name: 'fixture', status: { status: 'connected' } }];
    const { McpDropdownContent } = await import('./McpDropdown');
    const host = await renderNode(<McpDropdownContent active />);
    await act(async () => { await useMcpStore.getState().refresh({ directory: 'C:/proj-a' }); });
    const list = host.querySelector<HTMLElement>('[data-mcp-server-list]');
    expect(list?.classList.contains('max-h-64')).toBe(true);
    expect(list?.classList.contains('overflow-y-auto')).toBe(true);
  });
});

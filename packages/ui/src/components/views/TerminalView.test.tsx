import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { TerminalHandlers } from '@/lib/api/types';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { noteSpaceCreationRequest, resetSpaceCreationRequests } from '@/lib/spaces/space-creation-requests';
import type { SpaceEntry } from '@/lib/spaces/spaces-api';
import { useSpacesStore } from '@/lib/spaces/spaces-store';

let effectiveDirectory = '/repo';
const openContextPreviewCalls: Array<[string, string]> = [];
const createSessionCalls: Array<{ cwd: string }> = [];
const connectCalls: string[] = [];
const ensureDirectoryCalls: string[] = [];
const openContextPreview = (directory: string, url: string) => {
  openContextPreviewCalls.push([directory, url]);
};
const createSession = async ({ cwd }: { cwd: string }) => {
  createSessionCalls.push({ cwd });
  return { sessionId: 'unused', cols: 80, rows: 24, status: 'running' as const };
};
let connectBehavior: (sessionId: string, handlers: TerminalHandlers) => { close: () => void } = () => ({ close: () => undefined });
const terminalRuntime = {
  createSession,
  sendInput: async () => undefined,
  resize: async () => undefined,
  close: async () => undefined,
  updateAppearance: async () => undefined,
  connect: (sessionId: string, handlers: TerminalHandlers) => {
    connectCalls.push(sessionId);
    return connectBehavior(sessionId, handlers);
  },
};
const runtimeApis = {
  runtime: { platform: 'web' as const },
  terminal: terminalRuntime,
};
const i18n = { t: (key: string) => key };
let deviceInfo = { isMobile: false, isTablet: false, hasTouchOnlyPointer: false };
const pasteClipboardCalls: string[] = [];

// The two fields the view reads: a selected session, or an open draft and what it waits for.
type SessionUiState = {
  currentSessionId: string | null;
  newSessionDraft: { open: boolean; pendingWorktreeRequestId: string | null } | null;
};

const sessionUiState: SessionUiState = {
  currentSessionId: 'session-1',
  newSessionDraft: null,
};

const useSessionUIStoreMock = <T,>(selector: (state: typeof sessionUiState) => T): T => selector(sessionUiState);

const uiState = {
  terminalFontSize: 14,
  terminalShell: 'zsh',
  terminalLoginShells: ['zsh'],
  showTerminalQuickKeysOnDesktop: false,
  openContextPreview,
};

const useUiStoreMock = Object.assign(
  <T,>(selector: (state: typeof uiState) => T): T => selector(uiState),
  { getState: () => uiState },
);

mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: useSessionUIStoreMock }));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => effectiveDirectory }));
mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => runtimeApis,
}));
mock.module('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({
    currentTheme: {
      metadata: { variant: 'dark' },
      colors: {
        surface: {
          background: '#000',
          muted: '#111',
          elevatedForeground: '#fff',
        },
        syntax: {
          base: { foreground: '#fff' },
          function: '#7dd3fc',
          keyword: '#c084fc',
          type: '#67e8f9',
          comment: '#6b7280',
        },
        interactive: {
          cursor: '#fff',
          selection: '#334155',
          selectionForeground: '#fff',
        },
        status: {
          error: '#f87171',
          success: '#4ade80',
          warning: '#fbbf24',
        },
      },
    },
  }),
}));
mock.module('@/hooks/useFontPreferences', () => ({ useFontPreferences: () => ({ monoFont: 'geist-mono' }) }));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => deviceInfo }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: useUiStoreMock }));
mock.module('@/stores/useInlineCommentDraftStore', () => ({ useInlineCommentDraftStore: () => ({ addDraft: () => undefined }) }));
mock.module('@/components/terminal/TerminalViewport', () => ({
  TerminalViewport: React.forwardRef(function TerminalViewportMock(
    { sessionKey, chunks, isVisible, onResize }: { sessionKey: string; chunks: unknown[]; isVisible: boolean; onResize: (cols: number, rows: number) => void },
    ref: React.ForwardedRef<{ focus: () => void; fit: () => void; getSelection: () => null; pasteClipboard: () => Promise<void> }>,
  ) {
    React.useImperativeHandle(ref, () => ({
      focus: () => undefined,
      fit: () => undefined,
      getSelection: () => null,
      pasteClipboard: async () => { pasteClipboardCalls.push(sessionKey); },
    }), [sessionKey]);
    // A real surface reports its fitted grid once it is visible; a visible tab
    // spawns its shell only after that report.
    React.useEffect(() => {
      if (isVisible) onResize(100, 30);
    }, [isVisible, onResize]);

    return React.createElement('div', {
      'data-terminal-viewport': 'true',
      'data-session-key': sessionKey,
      'data-visible': String(isVisible),
      'data-chunk-count': String(chunks.length),
    });
  }),
}));
mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => React.createElement('span', { 'data-icon': name, className }),
}));
mock.module('@/components/ui/sortable-tabs-strip', () => ({
  SortableTabsStrip: ({ items, onClose }: { items: Array<{ id: string; label: string; icon?: React.ReactNode }>; onClose?: (id: string) => void }) => React.createElement(
    'div',
    { 'data-tabs-strip': 'terminal' },
    items.map((item) => React.createElement(
      'div',
      { key: item.id, 'data-tab-id': item.id },
      item.icon,
      React.createElement('span', { 'data-tab-label': item.id }, item.label),
      React.createElement('button', { type: 'button', 'data-tab-close': item.id, onClick: () => onClose?.(item.id) }),
    )),
  ),
}));
mock.module('@/lib/i18n', () => ({ useI18n: () => i18n }));

const { TerminalView } = await import('./TerminalView');

const ensureDirectorySpy = (directory: string) => {
  ensureDirectoryCalls.push(directory);
  useTerminalStore.setState((state) => {
    if (state.sessions.get(directory)) return state;

    const tab = {
      id: `spy-tab-${directory}`,
      terminalSessionId: null,
      lifecycle: 'idle' as const,
      purpose: { type: 'terminal' as const },
      label: 'Terminal',
      iconKey: null,
      isConnecting: false,
      createdAt: Date.now(),
      previewUrl: null,
      previewAutoOpened: false,
      previewUrlLocked: false,
    };

    const sessions = new Map(state.sessions);
    sessions.set(directory, { tabs: [tab], activeTabId: tab.id });
    return { sessions };
  });
};

const flushEffects = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const bufferEntryKey = (directory: string, tabId: string) => `${directory}\u0000${tabId}`;
const readBufferContent = (directory: string, tabId: string) => useTerminalStore.getState().getBuffer(directory, tabId).chunks.map((chunk) => chunk.data).join('');

describe('TerminalView project action tab indicator', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    effectiveDirectory = '/repo';
    openContextPreviewCalls.length = 0;
    createSessionCalls.length = 0;
    connectCalls.length = 0;
    ensureDirectoryCalls.length = 0;
    connectBehavior = () => ({ close: () => undefined });
    deviceInfo = { isMobile: false, isTablet: false, hasTouchOnlyPointer: false };
    pasteClipboardCalls.length = 0;
    windowInstance = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      Event: windowInstance.Event,
      KeyboardEvent: windowInstance.KeyboardEvent,
      MouseEvent: windowInstance.MouseEvent,
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      IS_REACT_ACT_ENVIRONMENT: true,
    });

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    useTerminalStore.getState().clearAll();
    useTerminalStore.setState({ ensureDirectory: ensureDirectorySpy });
    useTerminalStore.getState().ensureDirectory('/repo');

    const interactiveTabId = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!.id;
    useTerminalStore.getState().setTabLabel('/repo', interactiveTabId, 'Interactive');

    const runningActionTabId = useTerminalStore.getState().createTab('/repo');
    useTerminalStore.getState().setTabLabel('/repo', runningActionTabId, 'Build');
    useTerminalStore.getState().setTabIconKey('/repo', runningActionTabId, 'build');
    useTerminalStore.getState().setTabPurpose('/repo', runningActionTabId, { type: 'project-action', actionId: 'build', executionId: 'exec-running' });
    useTerminalStore.getState().setTabLifecycle('/repo', runningActionTabId, 'running');

    const exitedActionTabId = useTerminalStore.getState().createTab('/repo');
    useTerminalStore.getState().setTabLabel('/repo', exitedActionTabId, 'Deploy');
    useTerminalStore.getState().setTabIconKey('/repo', exitedActionTabId, 'play');
    useTerminalStore.getState().setTabPurpose('/repo', exitedActionTabId, { type: 'project-action', actionId: 'deploy', executionId: 'exec-exited' });
    useTerminalStore.getState().setTabLifecycle('/repo', exitedActionTabId, 'exited');
    ensureDirectoryCalls.length = 0;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useTerminalStore.getState().clearAll();
    sessionUiState.currentSessionId = 'session-1';
    sessionUiState.newSessionDraft = null;
    resetSpaceCreationRequests();
    useSpacesStore.getState().resetForRuntimeSwitch();
  });

  test('a draft waiting for a new space opens no shell until the space runs, then opens it in the space', async () => {
    const space: SpaceEntry = {
      id: 'a1b2c3d4e5f6', name: 'Fix login', placeId: 'docker', machine: null,
      projectDirectory: '/repo', projectFolder: { path: '/repo', found: null }, directory: '/spaces/a1b2c3d4e5f6/repo',
      state: 'preparing', stoppedIdle: false, step: 'creating', failure: null, network: { mode: 'allowlist', domains: [] },
      grants: [], access: null, needsAccess: [], accessFailures: [], damage: null, setup: null,
    };
    // The draft stays on the project's folder while its chip names the space.
    sessionUiState.currentSessionId = null;
    sessionUiState.newSessionDraft = { open: true, pendingWorktreeRequestId: 'worktree_space' };
    noteSpaceCreationRequest('worktree_space', space.id);
    useSpacesStore.getState().addJourneyEntry(space);

    await act(async () => root.render(React.createElement(TerminalView, { visible: true })));
    await flushEffects();
    expect(host.textContent).toContain('spaces.draft.preparing');
    expect(createSessionCalls).toEqual([]);

    await act(async () => useSpacesStore.getState().addJourneyEntry({ ...space, state: 'running', step: null }));
    await flushEffects();
    expect(ensureDirectoryCalls).toEqual(['/spaces/a1b2c3d4e5f6/repo']);
    expect(host.querySelector('[data-terminal-viewport]')?.getAttribute('data-session-key')?.startsWith('/spaces/a1b2c3d4e5f6/repo::')).toBe(true);

    // What the panel hands to the draft stays on the draft's folder.
    const tabId = useTerminalStore.getState().getDirectoryState('/spaces/a1b2c3d4e5f6/repo')!.tabs[0]!.id;
    await act(async () => useTerminalStore.getState().setTabPreviewUrl('/spaces/a1b2c3d4e5f6/repo', tabId, 'https://preview.example.test'));
    host.querySelector<HTMLElement>('[title="terminalView.preview.openTitle"]')?.click();
    expect(openContextPreviewCalls).toEqual([['/repo', 'https://preview.example.test']]);
  });

  test('closing the last tab closes the surface instead of only replacing the tab', async () => {
    effectiveDirectory = '/solo';
    useTerminalStore.getState().ensureDirectory('/solo');
    let lastTabClosedCalls = 0;
    const onLastTabClosed = () => { lastTabClosedCalls += 1; };

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: false, onLastTabClosed }));
    });
    const [onlyTab] = useTerminalStore.getState().getDirectoryState('/solo')!.tabs;
    await act(async () => {
      host.querySelector<HTMLElement>(`[data-tab-close="${onlyTab!.id}"]`)?.click();
    });
    await flushEffects();

    expect(lastTabClosedCalls).toBe(1);
  });

  test('closing one of several tabs keeps the surface open', async () => {
    let lastTabClosedCalls = 0;
    const onLastTabClosed = () => { lastTabClosedCalls += 1; };

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: false, onLastTabClosed }));
    });
    const [firstTab] = useTerminalStore.getState().getDirectoryState('/repo')!.tabs;
    await act(async () => {
      host.querySelector<HTMLElement>(`[data-tab-close="${firstTab!.id}"]`)?.click();
    });
    await flushEffects();

    expect(lastTabClosedCalls).toBe(0);
    expect(useTerminalStore.getState().getDirectoryState('/repo')!.tabs).toHaveLength(2);
  });

  test('shows the shared spinner while a project action starts, runs or stops, and its own icon otherwise', async () => {
    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: false }));
    });

    const tabs = Array.from(host.querySelectorAll('[data-tab-id]'));
    expect(tabs).toHaveLength(3);

    const tab = (label: string) => tabs.find((entry) => entry.querySelector('[data-tab-label]')?.textContent === label);

    expect(tab('Interactive')?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('terminal');
    expect(tab('Build')?.querySelector('[data-spinner]')).not.toBeNull();
    expect(tab('Deploy')?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('play');
    expect(host.querySelectorAll('.animate-spin').length).toBe(0);

    const buildTabId = useTerminalStore.getState().getDirectoryState('/repo')!.tabs.find((entry) => entry.label === 'Build')!.id;
    await act(async () => {
      useTerminalStore.getState().setTabLifecycle('/repo', buildTabId, 'stopping');
    });

    expect(host.querySelectorAll('[data-spinner]').length).toBe(1);
  });

  test('offers Paste next to Copy only on touch terminals and pastes into the active tab', async () => {
    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: false }));
    });
    expect(host.querySelector('[aria-label="terminalView.actions.copySelection"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="terminalView.actions.paste"]')).toBeNull();

    deviceInfo = { isMobile: true, isTablet: false, hasTouchOnlyPointer: true };
    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true }));
    });
    await flushEffects();
    const paste = host.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.paste"]');
    expect(paste?.previousElementSibling?.getAttribute('aria-label')).toBe('terminalView.actions.copySelection');
    expect(paste?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('clipboard');

    const activeTabId = useTerminalStore.getState().getDirectoryState('/repo')!.activeTabId;
    await act(async () => { paste?.click(); });
    expect(pasteClipboardCalls).toEqual([`/repo::${activeTabId}`]);
  });

  test('uses the explicit terminal directory for terminal tabs and session creation while preview ownership stays on the host directory', async () => {
    effectiveDirectory = '/repo-worktree';
    useTerminalStore.getState().ensureDirectory('/repo-worktree');
    const worktreeTabId = useTerminalStore.getState().getDirectoryState('/repo-worktree')!.tabs[0]!.id;
    useTerminalStore.getState().setTabLabel('/repo-worktree', worktreeTabId, 'Worktree Terminal');

    const repoTabId = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!.id;
    useTerminalStore.getState().setTabLabel('/repo', repoTabId, 'Repo Terminal');
    useTerminalStore.getState().setTabPreviewUrl('/repo', repoTabId, 'https://preview.example.test');

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true, directory: '/repo' }));
    });

    const tabLabels = Array.from(host.querySelectorAll('[data-tab-label]')).map((node) => node.textContent);
    expect(tabLabels).toContain('Repo Terminal');
    expect(tabLabels).not.toContain('Worktree Terminal');
    expect(createSessionCalls.length).toBe(1);
    expect(createSessionCalls[0]?.cwd).toBe('/repo');

    const previewButton = host.querySelector<HTMLElement>('[title="terminalView.preview.openTitle"]');
    expect(previewButton).not.toBeNull();
    previewButton?.click();
    expect(openContextPreviewCalls).toEqual([['/repo-worktree', 'https://preview.example.test']]);
  });

  test('keeps the existing context-directory behavior when no explicit terminal directory is provided', async () => {
    effectiveDirectory = '/repo-worktree';
    useTerminalStore.getState().ensureDirectory('/repo-worktree');
    const worktreeTabId = useTerminalStore.getState().getDirectoryState('/repo-worktree')!.tabs[0]!.id;
    useTerminalStore.getState().setTabLabel('/repo-worktree', worktreeTabId, 'Worktree Terminal');

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true }));
    });

    const tabLabels = Array.from(host.querySelectorAll('[data-tab-label]')).map((node) => node.textContent);
    expect(tabLabels).toContain('Worktree Terminal');
    expect(createSessionCalls.length).toBe(1);
    expect(createSessionCalls[0]?.cwd).toBe('/repo-worktree');
  });

  test('treats an explicit terminal target with no terminal state as an inert reveal', async () => {
    effectiveDirectory = '/repo-worktree';
    useTerminalStore.getState().ensureDirectory('/repo-worktree');

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true, directory: '/missing-repo' }));
    });

    expect(ensureDirectoryCalls).not.toContain('/missing-repo');
    expect(createSessionCalls.length).toBe(0);
    expect(host.querySelector('[data-tabs-strip="terminal"]')).toBeNull();
    expect(host.querySelector('[data-terminal-viewport="true"]')).toBeNull();
  });

  test('includes the terminal directory in the viewport identity key', async () => {
    effectiveDirectory = '/repo-worktree';
    useTerminalStore.getState().ensureDirectory('/repo-worktree');

    useTerminalStore.setState((state) => {
      const repoTab = state.sessions.get('/repo')!.tabs[0]!;
      const sessions = new Map(state.sessions);
      sessions.set('/repo-worktree', {
        tabs: [{ ...repoTab, label: 'Mirrored Terminal' }],
        activeTabId: repoTab.id,
      });
      return { sessions };
    });

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true }));
    });
    const contextKey = host.querySelector('[data-terminal-viewport="true"]')!.getAttribute('data-session-key');

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true, directory: '/repo' }));
    });
    const targetKey = host.querySelector('[data-terminal-viewport="true"]')!.getAttribute('data-session-key');

    expect(contextKey).not.toBe(targetKey);
    expect(contextKey).toContain('/repo-worktree');
    expect(targetKey).toContain('/repo');
  });

  test('replacing an exited action does not show a connection failure', async () => {
    const store = useTerminalStore.getState();
    const actionTab = store.getDirectoryState('/repo')?.tabs.find(tab => tab.label === 'Build');
    if (!actionTab) throw new Error('action tab missing');
    store.setTabSessionId('/repo', actionTab.id, 'srv-build');
    store.setActiveTab('/repo', actionTab.id);
    connectBehavior = (_sessionId, handlers) => {
      void Promise.resolve().then(() => {
        handlers.onError?.(Object.assign(new Error('Terminal replaced by a new action run'), { code: 'SUPERSEDED' }), true);
      });
      return { close: () => undefined };
    };
    await act(async () => root.render(React.createElement(TerminalView, { visible: true })));
    await flushEffects();
    expect(host.textContent).not.toContain('terminalView.error.connectionFailed');
    expect(store.getActiveTab('/repo')?.terminalSessionId).toBeNull();
    expect(store.getActiveTab('/repo')?.lifecycle).toBe('exited');
  });

  test('would fail if revisit attach skipped the active running project-action snapshot restore', async () => {
    const state = useTerminalStore.getState().getDirectoryState('/repo');
    const actionTab = state?.tabs.find((tab) => tab.label === 'Build');
    expect(actionTab).toBeDefined();
    if (!actionTab) throw new Error('action tab missing');

    useTerminalStore.getState().setTabSessionId('/repo', actionTab.id, 'srv-build', { expectedExecutionId: 'exec-running' });
    useTerminalStore.getState().setActiveTab('/repo', actionTab.id);

    const snapshotData = 'snapshot history\nfinal line\n';
    let replaceCount = 0;
    const unsubscribe = useTerminalStore.subscribe((nextState, previousState) => {
      const next = nextState.buffers.get(bufferEntryKey('/repo', actionTab.id));
      const previous = previousState.buffers.get(bufferEntryKey('/repo', actionTab.id));
      const nextContent = next?.chunks.map((chunk) => chunk.data).join('') ?? '';
      const previousContent = previous?.chunks.map((chunk) => chunk.data).join('') ?? '';
      if (nextContent === snapshotData && previousContent !== snapshotData && next?.lastSequence === 7) {
        replaceCount += 1;
      }
    });
    connectBehavior = (_sessionId, handlers) => {
      void Promise.resolve().then(() => {
        handlers.onEvent({ type: 'snapshot', data: snapshotData, sequence: 7, status: 'running', cols: 94, rows: 56 });
      });
      return { close: () => undefined };
    };

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true }));
    });
    await flushEffects();
    unsubscribe();

    expect(connectCalls).toEqual(['srv-build']);
    expect(createSessionCalls.length).toBe(0);
    expect(readBufferContent('/repo', actionTab.id)).toBe(snapshotData);
    expect(useTerminalStore.getState().getBuffer('/repo', actionTab.id).lastSequence).toBe(7);
    expect(useTerminalStore.getState().getBuffer('/repo', actionTab.id).chunks[0]?.size).toEqual({ cols: 94, rows: 56 });
    expect(replaceCount).toBe(1);
  });

  test('would fail if retained parent action targets rendered worktree tabs or attached the wrong session', async () => {
    effectiveDirectory = '/repo-worktree';
    useTerminalStore.getState().ensureDirectory('/repo-worktree');
    const worktreeTabId = useTerminalStore.getState().getDirectoryState('/repo-worktree')!.tabs[0]!.id;
    useTerminalStore.getState().setTabLabel('/repo-worktree', worktreeTabId, 'Worktree Terminal');

    const repoState = useTerminalStore.getState().getDirectoryState('/repo');
    const repoActionTab = repoState?.tabs.find((tab) => tab.label === 'Build');
    expect(repoActionTab).toBeDefined();
    if (!repoActionTab) throw new Error('repo action tab missing');

    useTerminalStore.getState().setTabLabel('/repo', repoActionTab.id, 'Repo Build');
    useTerminalStore.getState().setTabSessionId('/repo', repoActionTab.id, 'srv-parent-build', { expectedExecutionId: 'exec-running' });
    useTerminalStore.getState().setActiveTab('/repo', repoActionTab.id);

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true, directory: '/repo' }));
    });
    await flushEffects();

    const tabLabels = Array.from(host.querySelectorAll('[data-tab-label]')).map((node) => node.textContent);
    expect(tabLabels).toContain('Repo Build');
    expect(tabLabels).toContain('Interactive');
    expect(tabLabels).not.toContain('Worktree Terminal');
    expect(connectCalls).toEqual(['srv-parent-build']);
    expect(createSessionCalls.length).toBe(0);
  });
});

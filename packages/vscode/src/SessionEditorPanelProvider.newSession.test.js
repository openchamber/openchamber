import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { runInNewContext } from 'node:vm';

// ---------------------------------------------------------------------------
// Mock the `vscode` module surface used by SessionEditorPanelProvider and its
// transitive imports (bridge, sseProxy, webviewHtml, shikiThemes, opencode).
// `workspaceFolders` is read lazily via a getter so each test can swap it.
// ---------------------------------------------------------------------------
let workspaceFolders = [{ name: 'alpha', uri: { fsPath: '/work/alpha' } }];

const postMessages = [];

let panel;
const panels = [];
const executeCommand = mock(async () => undefined);

const createWebviewPanel = mock((viewType, title, viewColumn) => {
  const disposeListeners = [];
  let receiveMessage;
  let disposed = false;
  const messages = [];
  const webview = {
    html: '',
    postMessage: (message) => { postMessages.push(message); messages.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: (listener) => { receiveMessage = listener; return { dispose() {} }; },
    asWebviewUri: (uri) => uri,
    cspSource: 'vscode-webview://mock',
  };
  panel = {
    viewType,
    active: true,
    visible: true,
    messages,
    receive: (message) => receiveMessage(message),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const listener of disposeListeners) listener();
    },
    title,
    iconPath: null,
    reveal: mock(() => undefined),
    viewColumn,
    get webview() {
      if (disposed) throw new Error('Webview is disposed');
      return webview;
    },
    onDidDispose: (listener) => { disposeListeners.push(listener); return { dispose() {} }; },
    onDidChangeViewState: mock(() => ({ dispose() {} })),
  };
  panels.push(panel);
  return panel;
});

mock.module('vscode', () => ({
  workspace: {
    get workspaceFolders() { return workspaceFolders; },
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    fs: {},
    getConfiguration: () => ({ get: () => undefined }),
  },
  window: {
    activeTextEditor: undefined,
    activeColorTheme: { kind: 2 }, // Dark
    showInformationMessage: mock(() => undefined),
    createWebviewPanel,
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    state: { focused: true },
  },
  env: { language: 'en' },
  Uri: {
    joinPath: (base, ...segments) => ({ fsPath: [base.fsPath, ...segments].join('/') }),
    file: (fsPath) => ({ fsPath }),
  },
  commands: {
    executeCommand,
  },
  ColorThemeKind: { Dark: 2, Light: 1, HighContrast: 3, HighContrastLight: 4 },
  ExtensionMode: { Development: 1, Production: 2 },
  l10n: { t: (value) => value },
  ViewColumn: { One: 1, Beside: 2, Active: -1 },
}));

const { SessionEditorPanelProvider } = await import('./SessionEditorPanelProvider.ts');

const createContext = () => ({
  extensionMode: 2, // Production: no dev-server HMR URL
  subscriptions: [],
  extension: {
    packageJSON: { version: '1.0.0-test' },
  },
});

const createProvider = () => new SessionEditorPanelProvider(createContext(), { fsPath: '/ext' });

afterEach(() => {
  for (const entry of panels) entry.dispose();
  panels.length = 0;
});

describe('SessionEditorPanelProvider.createOrShowNewSession', () => {
  beforeEach(() => {
    postMessages.length = 0;
    workspaceFolders = [{ name: 'alpha', uri: { fsPath: '/work/alpha' } }];
  });

  it('embeds the current workspace folder for automatic draft initialization', () => {
    const provider = createProvider();
    provider.createOrShowNewSession();

    const newSessionMessage = postMessages.find(
      (message) => message.type === 'command' && message.command === 'newSession'
    );
    expect(newSessionMessage).toBeUndefined();
    expect(panel.webview.html).toContain('workspaceFolder: "/work/alpha"');
    expect(panel.webview.html).toContain('workspaceFolders: [{"name":"alpha","path":"/work/alpha"}]');
    expect(panel.webview.html).toContain('initialComposer: null');
  });

  it('opens the "Run on several models" tab with its draft in parallel mode', () => {
    createWebviewPanel.mockClear();
    const provider = createProvider();
    provider.createOrShowParallelDraft();

    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(createWebviewPanel.mock.calls[0][1]).toBe('Run on several models');
    expect(panel.webview.html).toContain('initialComposer: "parallel"');
    expect(panel.webview.html).toContain('initialSessionId: null');
  });

  it('embeds the selected directory for a new editor session', () => {
    workspaceFolders = [
      { name: 'alpha', uri: { fsPath: '/work/alpha' } },
      { name: 'beta', uri: { fsPath: '/work/beta' } },
    ];

    const provider = createProvider();
    provider.createOrShowNewSession('/work/beta');

    expect(panel.webview.html).toContain('workspaceFolder: "/work/beta"');
    expect(panel.webview.html).toContain(
      'workspaceFolders: [{"name":"alpha","path":"/work/alpha"},{"name":"beta","path":"/work/beta"}]'
    );
  });

  it('opens a projectless draft when no workspace folder is open', () => {
    workspaceFolders = [];
    createWebviewPanel.mockClear();

    const provider = createProvider();
    provider.createOrShowNewSession();

    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(panel.webview.html).toContain('workspaceFolder: ""');
    expect(panel.webview.html).toContain('workspaceFolders: []');
    const newSessionMessage = postMessages.find(
      (message) => message.type === 'command' && message.command === 'newSession'
    );
    expect(newSessionMessage).toBeUndefined();
  });
});

describe('Settings editor panel', () => {
  beforeEach(() => {
    createWebviewPanel.mockClear();
    postMessages.length = 0;
    workspaceFolders = [{ name: 'alpha', uri: { fsPath: '/work/alpha' } }];
  });

  it('reveals one Settings tab, even without an open folder or resolved sidebar', () => {
    workspaceFolders = [];
    const provider = createProvider();
    provider.showSettings();
    const settings = panel;
    provider.showSettings();
    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(settings.viewType).toBe('openchamber.settings');
    expect(settings.title).toBe('Settings');
    expect(settings.viewColumn).toBe(1);
    expect(settings.reveal).toHaveBeenCalledTimes(1);
    expect(settings.webview.html).toContain('panelType: "settings"');
  });

  it('keeps the latest page target until the Settings root is ready', async () => {
    const provider = createProvider();
    provider.showSettings({ page: 'appearance', directory: '/work/beta' });
    const settings = panel;
    await settings.receive({ type: 'webview:ready' });
    provider.showSettings({ page: 'mcp', directory: '/work/beta', itemId: 'mcp.create' });
    expect(settings.messages.filter((message) => message.command === 'showSettings')).toEqual([]);
    await settings.receive({ id: 'ready-1', type: 'vscode:command', payload: { command: 'openchamber.settingsReady' } });
    expect(settings.messages.filter((message) => message.command === 'showSettings')).toEqual([
      { type: 'command', command: 'showSettings', payload: { page: 'mcp', directory: '/work/beta', itemId: 'mcp.create' } },
    ]);
    expect(settings.webview.html).toContain('workspaceFolder: "/work/beta"');

    await settings.receive({ type: 'webview:ready' });
    await settings.receive({ id: 'ready-2', type: 'vscode:command', payload: { command: 'openchamber.settingsReady' } });
    expect(settings.messages.filter((message) => message.command === 'showSettings').length).toBe(1);
  });

  it('keeps a quoted or HTML-like Settings directory as bootstrap data', () => {
    const directory = '/work/";globalThis.injected=true;//</script><script>bad</script>';
    const provider = createProvider();
    provider.showSettings({ page: 'mcp', directory });
    const script = panel.webview.html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    const window = { localStorage: { getItem: () => null }, addEventListener() {} };
    const context = { window, document: { getElementById: () => null }, setInterval: () => 0, clearInterval() {} };
    runInNewContext(script, context);
    expect(window.__VSCODE_CONFIG__.workspaceFolder).toBe(directory);
    expect(window.__OPENCHAMBER_HOME__).toBe(directory);
    expect(context.injected).toBeUndefined();
  });

  it('does not count Settings as an attended chat or send attachments there', () => {
    const provider = createProvider();
    provider.showSettings();
    const settings = panel;
    expect(provider.hasVisiblePanel()).toBe(false);
    expect(provider.addContextSelectionToActivePanel({ filePath: '/work/a.ts', filename: 'a.ts', text: 'selected' })).toBe(false);
    provider.createOrShow('session-a', 'Chat A');
    const chat = panel;
    provider.showSettings();
    expect(provider.addContextSelectionToActivePanel({ filePath: '/work/a.ts', filename: 'a.ts', text: 'selected' })).toBe(true);
    expect(chat.messages.some((message) => message.command === 'addContextSelection')).toBe(true);
    expect(settings.messages.some((message) => message.command === 'addContextSelection')).toBe(false);
  });

  it('scopes the native shortcut to the focused sender and ignores a late peer blur', async () => {
    const provider = createProvider();
    provider.createOrShow('session-a', 'Chat A');
    const chat = panel;
    provider.showSettings();
    const settings = panel;
    executeCommand.mockClear();
    await settings.receive({ type: 'webview:settings-focus', payload: { focused: true } });
    expect(executeCommand.mock.calls.at(-1)).toEqual(['setContext', 'openchamber.settingsShortcutTarget', 'settings']);
    await chat.receive({ type: 'webview:settings-focus', payload: { focused: true } });
    await settings.receive({ type: 'webview:settings-focus', payload: { focused: false } });
    expect(executeCommand.mock.calls.at(-1)).toEqual(['setContext', 'openchamber.settingsShortcutTarget', 'chat']);
    const count = executeCommand.mock.calls.length;
    await settings.receive({ type: 'webview:settings-focus', payload: { focused: 'yes' } });
    expect(executeCommand.mock.calls.length).toBe(count);
    chat.dispose();
    expect(executeCommand.mock.calls.at(-1)).toEqual(['setContext', 'openchamber.settingsShortcutTarget', '']);
  });

  it('broadcasts settings and connection changes to both editor surfaces', () => {
    const provider = createProvider();
    provider.createOrShow('session-a', 'Chat A');
    const chat = panel;
    provider.showSettings();
    const settings = panel;
    const snapshot = { showReasoningTraces: false };
    provider.notifySettingsSynced(snapshot);
    provider.updateConnectionStatus('error', 'Connection unavailable');
    for (const entry of [settings, chat]) {
      expect(entry.messages.some((message) => message.command === 'settingsSynced' && message.payload === snapshot)).toBe(true);
      expect(entry.messages.some((message) => message.type === 'connectionStatus' && message.status === 'error' && message.error === 'Connection unavailable')).toBe(true);
    }
  });

  it('closes only Settings and creates a fresh tab when reopened', () => {
    const provider = createProvider();
    provider.createOrShow('session-a', 'Chat A');
    const chat = panel;
    provider.showSettings();
    const firstSettings = panel;
    provider.closeSettings();
    provider.showSettings();
    expect(panel).not.toBe(firstSettings);
    expect(createWebviewPanel).toHaveBeenCalledTimes(3);
    provider.createOrShow('session-a', 'Chat A');
    expect(chat.reveal).toHaveBeenCalledTimes(1);
    expect(createWebviewPanel).toHaveBeenCalledTimes(3);
  });

  it('does not deliver an in-flight bridge reply to a closed Settings tab', async () => {
    const provider = createProvider();
    provider.showSettings();
    const settings = panel;
    const pending = settings.receive({ id: 'stop-old', type: 'api:sse:stop', payload: { streamId: 'missing' } });
    provider.closeSettings();
    provider.showSettings();
    await pending;
    expect(settings.messages.some((message) => message.id === 'stop-old')).toBe(false);
    expect(panel.messages.some((message) => message.id === 'stop-old')).toBe(false);
  });

  it('ignores a closed tab readiness message while its replacement is starting', async () => {
    const provider = createProvider();
    provider.showSettings({ page: 'appearance' });
    const oldSettings = panel;
    provider.closeSettings();
    provider.showSettings({ page: 'mcp' });
    const settings = panel;
    await oldSettings.receive({ id: 'old-ready', type: 'vscode:command', payload: { command: 'openchamber.settingsReady' } });
    expect(settings.messages.some((message) => message.command === 'showSettings')).toBe(false);
    await settings.receive({ id: 'new-ready', type: 'vscode:command', payload: { command: 'openchamber.settingsReady' } });
    expect(settings.messages.filter((message) => message.command === 'showSettings')).toEqual([
      { type: 'command', command: 'showSettings', payload: { page: 'mcp' } },
    ]);
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

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
const { ChatViewProvider } = await import('./ChatViewProvider');
const { getWebviewHtml } = await import('./webviewHtml');

// A built extension folder: the webview HTML takes its entry file from the
// build manifest.
const extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-ext-'));
fs.mkdirSync(path.join(extensionDir, 'dist', 'webview'), { recursive: true });
fs.writeFileSync(path.join(extensionDir, 'dist', 'webview', 'manifest.json'), JSON.stringify({
  'index.html': { file: 'assets/index-AbC123.js', isEntry: true },
  '../ui/src/apps/renderVSCodeApp.tsx': { file: 'assets/renderVSCodeApp-XyZ789.js', isDynamicEntry: true },
}));
afterAll(() => fs.rmSync(extensionDir, { recursive: true, force: true }));

const createContext = () => ({
  extensionMode: 2, // Production: no dev-server HMR URL
  subscriptions: [],
  extension: {
    packageJSON: { version: '1.0.0-test' },
  },
});

const createProvider = () => new SessionEditorPanelProvider(createContext(), { fsPath: extensionDir });

describe('VS Code webview content security policy', () => {
  const extensionUri = { fsPath: extensionDir };
  const webviewStub = {
    cspSource: 'vscode-webview://test',
    asWebviewUri: (value) => value,
    postMessage: async () => true,
    onDidReceiveMessage: () => ({ dispose() {} }),
  };

  test('allows blob URLs for workers without allowing blob scripts', () => {
    const html = getWebviewHtml({ webview: webviewStub, extensionUri,
      workspaceFolder: '/workspace', initialStatus: 'connecting', cliAvailable: true });
    const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
    assert.ok(policy);
    const directives = new Map(policy.split(';').map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/);
      return [name, values];
    }));
    assert.ok(directives.get('worker-src')?.includes('blob:'));
    assert.ok(directives.has('script-src'));
    assert.ok(!directives.get('script-src')?.includes('blob:'));
  });

  test('loads the hashed entry named by the build manifest', () => {
    const webview = { ...webviewStub, asWebviewUri: (value) => ({ toString: () => value.fsPath }) };
    const html = getWebviewHtml({ webview, extensionUri,
      workspaceFolder: '/workspace', initialStatus: 'connecting', cliAvailable: true });
    assert.ok(html.includes(JSON.stringify(`${extensionDir}/dist/webview/assets/index-AbC123.js`)));
  });

  test('installs a CSP document before changing sidebar webview options', () => {
    let html = '';
    const writes = [];
    const webview = {
      ...webviewStub,
      get html() { return html; },
      set html(value) { html = value; writes.push('html'); },
      set options(_value) {
        assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'none';"/);
        writes.push('options');
      },
    };
    let dispose = () => {};
    const view = { webview, visible: true, onDidChangeVisibility: () => ({ dispose() {} }),
      onDidDispose: (listener) => { dispose = listener; return { dispose() {} }; },
    };
    try {
      new ChatViewProvider(createContext(), extensionUri).resolveWebviewView(view);
      assert.deepEqual(writes, ['html', 'options', 'html']);
      assert.match(html, /id="root"/);
    } finally {
      dispose();
    }
  });
});

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

  it('validates panel-only commands and keeps them from falling through to executeCommand', async () => {
    const provider = createProvider();
    provider.createOrShow('ses_1', 'Initial Title');
    const chat = panel;
    provider.showSettings({ page: 'appearance' });
    const settings = panel;
    executeCommand.mockClear();
    const replyOf = (entry, id) => entry.messages.find((message) => message.id === id);

    await settings.receive({ id: 'bad-ready', type: 'vscode:command', payload: { command: 'openchamber.settingsReady', args: ['unexpected'] } });
    expect(replyOf(settings, 'bad-ready')).toEqual({
      id: 'bad-ready',
      type: 'vscode:command',
      success: false,
      error: 'Invalid arguments for command: openchamber.settingsReady',
    });
    expect(settings.messages.some((message) => message.command === 'showSettings')).toBe(false);

    await settings.receive({ id: 'ok-ready-empty-args', type: 'vscode:command', payload: { command: 'openchamber.settingsReady', args: [] } });
    expect(replyOf(settings, 'ok-ready-empty-args')).toEqual({ id: 'ok-ready-empty-args', type: 'vscode:command', success: true, data: { result: true } });
    expect(settings.messages.some((message) => message.command === 'showSettings')).toBe(true);

    await settings.receive({ id: 'wrong-panel-title', type: 'vscode:command', payload: { command: 'openchamber.updateSessionEditorTitle', args: ['ses_1', 'Hijacked'] } });
    expect(replyOf(settings, 'wrong-panel-title')).toEqual({
      id: 'wrong-panel-title',
      type: 'vscode:command',
      success: false,
      error: 'Command is not allowed: openchamber.updateSessionEditorTitle',
    });

    await chat.receive({ id: 'wrong-panel-ready', type: 'vscode:command', payload: { command: 'openchamber.settingsReady', args: [] } });
    expect(replyOf(chat, 'wrong-panel-ready')).toEqual({
      id: 'wrong-panel-ready',
      type: 'vscode:command',
      success: false,
      error: 'Command is not allowed: openchamber.settingsReady',
    });

    const malformedTitleArgs = [[], [null, 'Title'], [123, 'Title'], ['ses_1', 42], ['ses_1', 'Title', 'extra']];
    for (let index = 0; index < malformedTitleArgs.length; index++) {
      const id = `bad-title-${index}`;
      await chat.receive({ id, type: 'vscode:command', payload: { command: 'openchamber.updateSessionEditorTitle', args: malformedTitleArgs[index] } });
      expect(replyOf(chat, id)).toEqual({
        id,
        type: 'vscode:command',
        success: false,
        error: 'Invalid arguments for command: openchamber.updateSessionEditorTitle',
      });
      expect(chat.title).toBe('Initial Title');
    }

    await chat.receive({ id: 'ok-title', type: 'vscode:command', payload: { command: 'openchamber.updateSessionEditorTitle', args: ['ses_1', '  Renamed Session  '] } });
    expect(chat.title).toBe('Renamed Session');
    expect(replyOf(chat, 'ok-title')).toEqual({ id: 'ok-title', type: 'vscode:command', success: true, data: { result: true } });

    await chat.receive({ id: 'blank-title', type: 'vscode:command', payload: { command: 'openchamber.updateSessionEditorTitle', args: ['ses_1', '   '] } });
    expect(chat.title).toBe('Session');

    await chat.receive({ id: 'long-title', type: 'vscode:command', payload: { command: 'openchamber.updateSessionEditorTitle', args: ['ses_1', 'y'.repeat(5000)] } });
    expect(chat.title).toBe('y'.repeat(4096));

    chat.dispose();
    await chat.receive({ id: 'disposed-title', type: 'vscode:command', payload: { command: 'openchamber.updateSessionEditorTitle', args: ['ses_1', 'After Dispose'] } });
    expect(chat.title).toBe('y'.repeat(4096));

    expect(executeCommand).not.toHaveBeenCalled();
  });
});

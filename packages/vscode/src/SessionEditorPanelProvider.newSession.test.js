import { beforeEach, describe, expect, it, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Mock the `vscode` module surface used by SessionEditorPanelProvider and its
// transitive imports (bridge, sseProxy, webviewHtml, shikiThemes, opencode).
// `workspaceFolders` is read lazily via a getter so each test can swap it.
// ---------------------------------------------------------------------------
let workspaceFolders = [{ name: 'alpha', uri: { fsPath: '/work/alpha' } }];

const postMessages = [];

const panel = {
  title: '',
  iconPath: null,
  reveal: mock(() => undefined),
  viewColumn: undefined,
  webview: {
    html: '',
    postMessage: (message) => { postMessages.push(message); },
    onDidReceiveMessage: mock(() => ({ dispose() {} })),
    asWebviewUri: (uri) => uri,
    cspSource: 'vscode-webview://mock',
  },
  onDidDispose: mock(() => ({ dispose() {} })),
  onDidChangeViewState: mock(() => ({ dispose() {} })),
};

const createWebviewPanel = mock(() => panel);

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
  Uri: {
    joinPath: (base, ...segments) => ({ fsPath: [base.fsPath, ...segments].join('/') }),
    file: (fsPath) => ({ fsPath }),
  },
  commands: {
    executeCommand: mock(async () => undefined),
  },
  ColorThemeKind: { Dark: 2, Light: 1, HighContrast: 3, HighContrastLight: 4 },
  ExtensionMode: { Development: 1, Production: 2 },
  l10n: { t: (value) => value },
  ViewColumn: { Beside: 2, Active: -1 },
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
  });

  it('does not open a panel or post a newSession command when no workspace folder is open', () => {
    workspaceFolders = [];
    createWebviewPanel.mockClear();

    const provider = createProvider();
    provider.createOrShowNewSession();

    expect(createWebviewPanel).not.toHaveBeenCalled();
    const newSessionMessage = postMessages.find(
      (message) => message.type === 'command' && message.command === 'newSession'
    );
    expect(newSessionMessage).toBeUndefined();
  });
});

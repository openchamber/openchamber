import * as vscode from 'vscode';
import { handleBridgeMessage, type BridgeRequest } from './bridge';
import type { OpenCodeManager, ConnectionStatus } from './opencode';
import { getWebviewHtml } from './webviewHtml';
import { resolveWebviewDevServerUrl } from './webviewDevServer';
import { normalizeWindowsDriveLetter } from './pathUtils';
import { resolveWorkspaceFolders } from './workspaceResolver';
import { ActiveEditorFileBroadcaster } from './activeEditorFile';
import {
  postPermissionAutoAcceptSynced,
  postSettingsSynced,
  postThemeChange,
  postWebviewCommand,
  postWindowFocusChanged,
  syncConnectionAndFocus,
} from './webviewHostMessages';
import {
  abortAllSseStreams,
  startWebviewSseProxy,
  stopWebviewSseProxy,
  type SseStreamMap,
} from './webviewSseSession';

const t = vscode.l10n.t;

type SessionPanelState = {
  panel: vscode.WebviewPanel;
  sseStreams: SseStreamMap;
};

export class SessionEditorPanelProvider {
  public static readonly viewType = 'openchamber.sessionEditor';

  private _cachedStatus: ConnectionStatus = 'connecting';
  private _cachedError?: string;
  private _sseCounter = 0;
  private _panels = new Map<string, SessionPanelState>();
  private _lastActivePanelId: string | null = null;
  private readonly _webviewDevServerUrl: string | null;
  private readonly _activeEditor: ActiveEditorFileBroadcaster;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _openCodeManager?: OpenCodeManager
  ) {
    this._webviewDevServerUrl = resolveWebviewDevServerUrl(this._context);
    this._activeEditor = new ActiveEditorFileBroadcaster({
      hasTargets: () => this._panels.size > 0,
      postPayload: (payload) => {
        postWebviewCommand(this._allWebviews(), 'activeEditorFile', payload);
      },
    });

    this._context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => void this._activeEditor.broadcast()),
      vscode.window.onDidChangeTextEditorSelection(() => this._activeEditor.scheduleSelectionBroadcast()),
    );
  }

  public createOrShowNewSession(): void {
    const panelId = `new_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this._createPanel(panelId, t('New Session'), null);
  }

  public createOrShow(sessionId: string, title?: string): void {
    if (!sessionId || typeof sessionId !== 'string') {
      return;
    }

    const sessionTitle = title && title.trim().length > 0 ? title.trim() : t('Session');
    const existing = this._panels.get(sessionId);
    if (existing) {
      existing.panel.title = sessionTitle;
      existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.Active);
      return;
    }

    this._createPanel(sessionId, sessionTitle, sessionId);
  }

  private _createPanel(panelId: string, title: string, initialSessionId: string | null): void {
    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist');

    const panel = vscode.window.createWebviewPanel(
      SessionEditorPanelProvider.viewType,
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this._extensionUri, distUri],
      }
    );

    panel.iconPath = {
      light: vscode.Uri.joinPath(this._extensionUri, 'assets', 'icon.svg'),
      dark: vscode.Uri.joinPath(this._extensionUri, 'assets', 'icon-titlebar.svg'),
    };

    const state: SessionPanelState = {
      panel,
      sseStreams: new Map(),
    };

    this._panels.set(panelId, state);
    this._lastActivePanelId = panelId;

    panel.webview.html = this._getHtmlForWebview(panel.webview, initialSessionId);
    void this.updateTheme(vscode.window.activeColorTheme.kind);
    this._sendCachedStateToPanel(state);
    void this._activeEditor.broadcast();

    panel.onDidDispose(() => {
      this._disposePanel(panelId);
    }, null, this._context.subscriptions);

    panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        this._lastActivePanelId = panelId;
      }
    }, null, this._context.subscriptions);

    panel.webview.onDidReceiveMessage(async (message: BridgeRequest) => {
      if (message.type === 'restartApi') {
        await this._openCodeManager?.restart();
        return;
      }

      if (message.type === 'vscode:command') {
        const { command, args } = (message.payload || {}) as { command?: unknown; args?: unknown[] };
        if (command === 'openchamber.updateSessionEditorTitle') {
          const nextTitle = typeof args?.[1] === 'string' && args[1].trim().length > 0 ? args[1].trim() : t('Session');
          state.panel.title = nextTitle;
          state.panel.webview.postMessage({ id: message.id, type: message.type, success: true, data: { result: true } });
          return;
        }
      }

      if (message.type === 'api:sse:start') {
        const response = await startWebviewSseProxy({
          message,
          manager: this._openCodeManager,
          streams: state.sseStreams,
          nextCounter: () => ++this._sseCounter,
          postMessage: (payload) => {
            void state.panel.webview.postMessage(payload);
          },
        });
        state.panel.webview.postMessage(response);
        return;
      }

      if (message.type === 'api:sse:stop') {
        const response = stopWebviewSseProxy(message, state.sseStreams);
        state.panel.webview.postMessage(response);
        return;
      }

      const response = await handleBridgeMessage(message, {
        manager: this._openCodeManager,
        context: this._context,
      });
      state.panel.webview.postMessage(response);

      if (message.type === 'api:config/settings:save' && response.success) {
        void vscode.commands.executeCommand('openchamber.internal.settingsSynced', response.data);
      }
    }, null, this._context.subscriptions);
  }

  public updateTheme(kind: vscode.ColorThemeKind) {
    postThemeChange(this._allWebviews(), kind);
  }

  public updateConnectionStatus(status: ConnectionStatus, error?: string) {
    this._cachedStatus = status;
    this._cachedError = error;
    for (const entry of this._panels.values()) {
      this._sendCachedStateToPanel(entry);
    }
  }

  public notifySettingsSynced(settings: unknown): void {
    postSettingsSynced(this._allWebviews(), settings);
  }

  public notifyPermissionAutoAcceptSynced(snapshot: unknown): void {
    postPermissionAutoAcceptSynced(this._allWebviews(), snapshot);
  }

  public notifyWindowFocusChanged(focused: boolean): void {
    postWindowFocusChanged(this._allWebviews(), focused);
  }

  public addContextSelectionToActivePanel(selection: { filePath: string; filename: string; text: string }): boolean {
    if (!selection.filePath.trim() || !selection.filename.trim() || !selection.text.trim()) {
      return false;
    }

    const entry = this._getActivePanelEntry();
    if (!entry) return false;

    entry.panel.reveal(entry.panel.viewColumn ?? vscode.ViewColumn.Active, true);
    postWebviewCommand([entry.panel.webview], 'addContextSelection', selection);
    return true;
  }

  public createSessionWithPromptInActivePanel(prompt: string): boolean {
    if (!prompt.trim()) return false;

    const entry = this._getActivePanelEntry();
    if (!entry) return false;

    entry.panel.reveal(entry.panel.viewColumn ?? vscode.ViewColumn.Active, true);
    postWebviewCommand([entry.panel.webview], 'createSessionWithPrompt', { prompt });
    return true;
  }

  public addFileAttachmentsToActivePanel(files: Array<{ filePath: string; fileName: string; fileSize: number | null }>): boolean {
    const cleanedFiles = files.filter((entry) => entry.filePath.trim().length > 0 && entry.fileName.trim().length > 0);
    if (cleanedFiles.length === 0) return false;

    const entry = this._getActivePanelEntry();
    if (!entry) return false;

    entry.panel.reveal(entry.panel.viewColumn ?? vscode.ViewColumn.Active, true);
    postWebviewCommand([entry.panel.webview], 'addFileAttachments', { files: cleanedFiles });
    return true;
  }

  private _allWebviews() {
    return Array.from(this._panels.values()).map((entry) => entry.panel.webview);
  }

  private _getActivePanelEntry(): SessionPanelState | null {
    const activeEntry = Array.from(this._panels.entries()).find(([, entry]) => entry.panel.active);
    const panelId = activeEntry?.[0] ?? this._lastActivePanelId;
    if (!panelId) return null;
    return this._panels.get(panelId) ?? null;
  }

  private _sendCachedStateToPanel(entry: SessionPanelState) {
    syncConnectionAndFocus([entry.panel.webview], this._cachedStatus, this._cachedError);
  }

  private _disposePanel(sessionId: string) {
    const entry = this._panels.get(sessionId);
    if (!entry) return;

    abortAllSseStreams(entry.sseStreams);
    this._panels.delete(sessionId);
    if (this._lastActivePanelId === sessionId) {
      this._lastActivePanelId = null;
    }
    if (this._panels.size === 0) {
      this._activeEditor.reset();
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview, sessionId: string | null) {
    const workspaceFolder = normalizeWindowsDriveLetter(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''
    );
    const workspaceFolders = resolveWorkspaceFolders(vscode.workspace.workspaceFolders ?? []);

    return getWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      workspaceFolder,
      workspaceFolders,
      initialStatus: this._cachedStatus,
      cliAvailable: this._openCodeManager?.isCliAvailable() ?? false,
      panelType: 'chat',
      initialSessionId: sessionId ?? undefined,
      viewMode: 'editor',
      extensionVersion: String(this._context.extension?.packageJSON?.version || ''),
      devServerUrl: this._webviewDevServerUrl,
    });
  }
}

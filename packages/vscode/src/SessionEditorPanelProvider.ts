import * as vscode from 'vscode';
import { handleBridgeMessage, type BridgeRequest, type BridgeResponse } from './bridge';
import { getThemeKindName } from './theme';
import type { OpenCodeManager, ConnectionStatus } from './opencode';
import { getWebviewShikiThemes } from './shikiThemes';
import { getWebviewHtml } from './webviewHtml';
import { openSseProxy } from './sseProxy';

type SessionPanelState = {
  panel: vscode.WebviewPanel;
  sseStreams: Map<string, AbortController>;
};

export class SessionEditorPanelProvider {
  public static readonly viewType = 'openchamber.sessionEditor';

  private _cachedStatus: ConnectionStatus = 'connecting';
  private _cachedError?: string;
  private _sseCounter = 0;
  private _panels = new Map<string, SessionPanelState>();

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _openCodeManager?: OpenCodeManager
  ) {}

  public createOrShowNewSession(): void {
    // Generate unique panel ID for new session drafts
    const panelId = `new_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this._createPanel(panelId, 'New Session', null);
  }

  public createOrShow(sessionId: string, title?: string): void {
    if (!sessionId || typeof sessionId !== 'string') {
      return;
    }

    const sessionTitle = title && title.trim().length > 0 ? title.trim() : 'Session';

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

    panel.webview.html = this._getHtmlForWebview(panel.webview, initialSessionId);

    void this.updateTheme(vscode.window.activeColorTheme.kind);
    this._sendCachedStateToPanel(state);

    panel.onDidDispose(() => {
      this._disposePanel(panelId);
    }, null, this._context.subscriptions);

    panel.webview.onDidReceiveMessage(async (message: BridgeRequest) => {
      if (message.type === 'restartApi') {
        await this._openCodeManager?.restart();
        return;
      }

      if (message.type === 'api:sse:start') {
        const response = await this._startSseProxy(message, state);
        state.panel.webview.postMessage(response);
        return;
      }

      if (message.type === 'api:sse:stop') {
        const response = await this._stopSseProxy(message, state);
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
    const themeKind = getThemeKindName(kind);
    void getWebviewShikiThemes().then((shikiThemes) => {
      for (const entry of this._panels.values()) {
        entry.panel.webview.postMessage({
          type: 'themeChange',
          theme: { kind: themeKind, shikiThemes },
        });
      }
    });
  }

  public updateConnectionStatus(status: ConnectionStatus, error?: string) {
    this._cachedStatus = status;
    this._cachedError = error;

    for (const entry of this._panels.values()) {
      this._sendCachedStateToPanel(entry);
    }
  }

  public notifySettingsSynced(settings: unknown): void {
    for (const entry of this._panels.values()) {
      entry.panel.webview.postMessage({
        type: 'command',
        command: 'settingsSynced',
        payload: settings,
      });
    }
  }

  private _sendCachedStateToPanel(entry: SessionPanelState) {
    entry.panel.webview.postMessage({
      type: 'connectionStatus',
      status: this._cachedStatus,
      error: this._cachedError,
    });
  }

  private _disposePanel(sessionId: string) {
    const entry = this._panels.get(sessionId);
    if (!entry) return;

    for (const controller of entry.sseStreams.values()) {
      controller.abort();
    }
    entry.sseStreams.clear();

    this._panels.delete(sessionId);
  }

  private _buildSseHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...(extra || {}),
    };
  }

  private async _startSseProxy(message: BridgeRequest, entry: SessionPanelState): Promise<BridgeResponse> {
    const { id, type, payload } = message;

    const { path, headers } = (payload || {}) as { path?: string; headers?: Record<string, string> };
    const normalizedPath = typeof path === 'string' && path.trim().length > 0 ? path.trim() : '/event';

    if (!this._openCodeManager) {
      return {
        id,
        type,
        success: true,
        data: { status: 503, headers: { 'content-type': 'application/json' }, streamId: null },
      };
    }

    const streamId = `sse_${++this._sseCounter}_${Date.now()}`;
    const controller = new AbortController();

    try {
      const start = await openSseProxy({
        manager: this._openCodeManager,
        path: normalizedPath,
        headers: this._buildSseHeaders(headers),
        signal: controller.signal,
        onChunk: (chunk) => {
          entry.panel.webview.postMessage({ type: 'api:sse:chunk', streamId, chunk });
        },
      });

      entry.sseStreams.set(streamId, controller);

      start.run
        .then(() => {
          entry.panel.webview.postMessage({ type: 'api:sse:end', streamId });
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            const messageText = error instanceof Error ? error.message : String(error);
            entry.panel.webview.postMessage({ type: 'api:sse:end', streamId, error: messageText });
          }
        })
        .finally(() => {
          entry.sseStreams.delete(streamId);
        });

      return {
        id,
        type,
        success: true,
        data: {
          status: 200,
          headers: start.headers,
          streamId,
        },
      };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      return {
        id,
        type,
        success: true,
        data: { status: 502, headers: { 'content-type': 'application/json' }, streamId: null, error: messageText },
      };
    }
  }

  private async _stopSseProxy(message: BridgeRequest, entry: SessionPanelState): Promise<BridgeResponse> {
    const { id, type, payload } = message;
    const { streamId } = (payload || {}) as { streamId?: string };
    if (typeof streamId === 'string' && streamId.length > 0) {
      const controller = entry.sseStreams.get(streamId);
      if (controller) {
        controller.abort();
        entry.sseStreams.delete(streamId);
      }
    }
    return { id, type, success: true, data: { stopped: true } };
  }

  private _getHtmlForWebview(webview: vscode.Webview, sessionId: string | null) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const initialStatus = this._cachedStatus;
    const cliAvailable = this._openCodeManager?.isCliAvailable() ?? false;

    return getWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      workspaceFolder,
      initialStatus,
      cliAvailable,
      panelType: 'chat',
      initialSessionId: sessionId ?? undefined,
      viewMode: 'editor',
    });
  }
}

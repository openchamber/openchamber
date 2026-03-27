import * as vscode from 'vscode';
import { handleBridgeMessage, type BridgeRequest, type BridgeResponse } from './bridge';
import { getThemeKindName } from './theme';
import type { OpenCodeManager, ConnectionStatus } from './opencode';
import { getWebviewShikiThemes } from './shikiThemes';
import { getWebviewHtml } from './webviewHtml';
import { openSseProxy } from './sseProxy';
import { resolveWebviewDevServerUrl } from './webviewDevServer';

export class AgentManagerPanelProvider {
  public static readonly viewType = 'openchamber.agentManager';

  private _panel?: vscode.WebviewPanel;
  
  // Cache latest status/URL for when webview is resolved after connection is ready
  private _cachedStatus: ConnectionStatus = 'connecting';
  private _cachedError?: string;
  private _sseCounter = 0;
  private _sseStreams = new Map<string, AbortController>();
  private readonly _webviewDevServerUrl: string | null;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _openCodeManager?: OpenCodeManager
  ) {
    this._webviewDevServerUrl = resolveWebviewDevServerUrl(this._context);
  }

  public createOrShow(): void {
    // If panel exists, reveal it
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist');

    // Create new panel
    this._panel = vscode.window.createWebviewPanel(
      AgentManagerPanelProvider.viewType,
      'Agent Manager',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this._extensionUri, distUri],
      }
    );

    this._panel.iconPath = {
      light: vscode.Uri.joinPath(this._extensionUri, 'assets', 'icon.svg'),
      dark: vscode.Uri.joinPath(this._extensionUri, 'assets', 'icon-titlebar.svg'),
    };

    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
    
    // Send theme payload (including optional Shiki theme JSON) after the webview is set up.
    void this.updateTheme(vscode.window.activeColorTheme.kind);
    
    // Send cached connection status
    this._sendCachedState();

    // Handle panel disposal
    this._panel.onDidDispose(() => {
      // Clean up SSE streams
      for (const controller of this._sseStreams.values()) {
        controller.abort();
      }
      this._sseStreams.clear();

      this._panel = undefined;
    }, null, this._context.subscriptions);

    // Handle messages
    this._panel.webview.onDidReceiveMessage(async (message: BridgeRequest) => {
      if (message.type === 'restartApi') {
        await this._openCodeManager?.restart();
        return;
      }

      if (message.type === 'api:sse:start') {
        const response = await this._startSseProxy(message);
        this._panel?.webview.postMessage(response);
        return;
      }

      if (message.type === 'api:sse:stop') {
        const response = await this._stopSseProxy(message);
        this._panel?.webview.postMessage(response);
        return;
      }

      const response = await handleBridgeMessage(message, {
        manager: this._openCodeManager,
        context: this._context,
      });
      this._panel?.webview.postMessage(response);
    }, null, this._context.subscriptions);
  }

  public updateTheme(kind: vscode.ColorThemeKind) {
    if (this._panel) {
      const themeKind = getThemeKindName(kind);
      void getWebviewShikiThemes().then((shikiThemes) => {
        this._panel?.webview.postMessage({
          type: 'themeChange',
          theme: { kind: themeKind, shikiThemes },
        });
      });
    }
  }

  public updateConnectionStatus(status: ConnectionStatus, error?: string) {
    // Cache the latest state
    this._cachedStatus = status;
    this._cachedError = error;
    
    // Send to webview if it exists
    this._sendCachedState();
  }
  
  private _sendCachedState() {
    if (!this._panel) {
      return;
    }
    
    this._panel.webview.postMessage({
      type: 'connectionStatus',
      status: this._cachedStatus,
      error: this._cachedError,
    });
  }

  private _buildSseHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...(extra || {}),
    };
  }

  private async _startSseProxy(message: BridgeRequest): Promise<BridgeResponse> {
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
          this._panel?.webview.postMessage({ type: 'api:sse:chunk', streamId, chunk });
        },
      });

      this._sseStreams.set(streamId, controller);

      start.run
        .then(() => {
          this._panel?.webview.postMessage({ type: 'api:sse:end', streamId });
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            const messageText = error instanceof Error ? error.message : String(error);
            this._panel?.webview.postMessage({ type: 'api:sse:end', streamId, error: messageText });
          }
        })
        .finally(() => {
          this._sseStreams.delete(streamId);
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
      const message = error instanceof Error ? error.message : String(error);
      return {
        id,
        type,
        success: true,
        data: { status: 502, headers: { 'content-type': 'application/json' }, streamId: null, error: message },
      };
    }
  }

  private async _stopSseProxy(message: BridgeRequest): Promise<BridgeResponse> {
    const { id, type, payload } = message;
    const { streamId } = (payload || {}) as { streamId?: string };
    if (typeof streamId === 'string' && streamId.length > 0) {
      const controller = this._sseStreams.get(streamId);
      if (controller) {
        controller.abort();
        this._sseStreams.delete(streamId);
      }
    }
    return { id, type, success: true, data: { stopped: true } };
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const cliAvailable = this._openCodeManager?.isCliAvailable() ?? false;

    return getWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      workspaceFolder,
      initialStatus: this._cachedStatus,
      cliAvailable,
      panelType: 'agentManager',
      devServerUrl: this._webviewDevServerUrl,
    });
  }
}

import * as vscode from 'vscode';
import { handleBridgeMessage, type BridgeRequest, type BridgeResponse } from './bridge';
import { getThemeKindName } from './theme';
import type { OpenCodeManager, ConnectionStatus } from './opencode';
import { getWebviewShikiThemes } from './shikiThemes';
import { getWebviewHtml } from './webviewHtml';
import { openSseProxy } from './sseProxy';
import { resolveWebviewDevServerUrl } from './webviewDevServer';

const resolveDisplayLanguage = (): string => {
  const language = vscode.env.language;
  return typeof language === 'string' && language.trim().length > 0 ? language : 'en';
};

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'openchamber.chatView';

  private _view?: vscode.WebviewView;

  public isVisible() {
    return this._view?.visible ?? false;
  }

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

  public resolveWebviewView(
    webviewView: vscode.WebviewView
  ) {
    this._view = webviewView;

    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri, distUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    // Send theme payload (including optional Shiki theme JSON) after the webview is set up.
    void this.updateTheme(vscode.window.activeColorTheme.kind);
    
    // Send cached connection status and API URL (may have been set before webview was resolved)
    this._sendCachedState();

    webviewView.webview.onDidReceiveMessage(async (message: BridgeRequest) => {
      if (message.type === 'restartApi') {
        await this._openCodeManager?.restart();
        return;
      }

      if (message.type === 'api:sse:start') {
        const response = await this._startSseProxy(message);
        webviewView.webview.postMessage(response);
        return;
      }

      if (message.type === 'api:sse:stop') {
        const response = await this._stopSseProxy(message);
        webviewView.webview.postMessage(response);
        return;
      }

      const response = await handleBridgeMessage(message, {
        manager: this._openCodeManager,
        context: this._context,
      });
      webviewView.webview.postMessage(response);

      if (message.type === 'api:config/settings:save' && response.success) {
        void vscode.commands.executeCommand('openchamber.internal.settingsSynced', response.data);
      }
    });
  }

  public updateTheme(kind: vscode.ColorThemeKind) {
    if (this._view) {
      const themeKind = getThemeKindName(kind);
      void getWebviewShikiThemes().then((shikiThemes) => {
        this._view?.webview.postMessage({
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

  public addTextToInput(text: string) {
    if (this._view) {
      // Reveal the webview panel
      this._view.show(true);
      
      this._view.webview.postMessage({
        type: 'command',
        command: 'addToContext',
        payload: { text }
      });
    }
  }

  public addFileMentions(paths: string[]) {
    if (!this._view) {
      return;
    }

    const cleanedPaths = paths
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (cleanedPaths.length === 0) {
      return;
    }

    this._view.show(true);
    this._view.webview.postMessage({
      type: 'command',
      command: 'addFileMentions',
      payload: { paths: cleanedPaths },
    });
  }

  public createNewSessionWithPrompt(prompt: string) {
    if (this._view) {
      // Reveal the webview panel
      this._view.show(true);
      
      this._view.webview.postMessage({
        type: 'command',
        command: 'createSessionWithPrompt',
        payload: { prompt }
      });
    }
  }

  public createNewSession() {
    if (this._view) {
      // Reveal the webview panel
      this._view.show(true);
      
      this._view.webview.postMessage({
        type: 'command',
        command: 'newSession'
      });
    }
  }

  public showSettings() {
    if (this._view) {
      // Reveal the webview panel
      this._view.show(true);
      
      this._view.webview.postMessage({
        type: 'command',
        command: 'showSettings'
      });
    }
  }

  public postMessage(message: unknown): void {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  public notifySettingsSynced(settings: unknown): void {
    if (!this._view) {
      return;
    }

    this._view.webview.postMessage({
      type: 'command',
      command: 'settingsSynced',
      payload: settings,
    });
  }

  private _sendCachedState() {
    if (!this._view) {
      return;
    }
    
    this._view.webview.postMessage({
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
          this._view?.webview.postMessage({ type: 'api:sse:chunk', streamId, chunk });
        },
      });

      this._sseStreams.set(streamId, controller);

      start.run
        .then(() => {
          this._view?.webview.postMessage({ type: 'api:sse:end', streamId });
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            const messageText = error instanceof Error ? error.message : String(error);
            this._view?.webview.postMessage({ type: 'api:sse:end', streamId, error: messageText });
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

  private _getHtmlForWebview(webview: vscode.Webview) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    // Use cached values which are updated by onStatusChange callback
    const initialStatus = this._cachedStatus;
    const cliAvailable = this._openCodeManager?.isCliAvailable() ?? false;

    return getWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      workspaceFolder,
      initialStatus,
      cliAvailable,
      locale: resolveDisplayLanguage(),
      devServerUrl: this._webviewDevServerUrl,
    });
  }
}

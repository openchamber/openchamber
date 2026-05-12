import * as vscode from 'vscode';
import { handleBridgeMessage, type BridgeRequest, type BridgeResponse } from './bridge';
import { getThemeKindName } from './theme';
import type { OpenCodeManager, ConnectionStatus } from './opencode';
import { getWebviewShikiThemes } from './shikiThemes';
import { getWebviewHtml } from './webviewHtml';
import { openSseProxy } from './sseProxy';
import { resolveWebviewDevServerUrl } from './webviewDevServer';
import { normalizeWindowsDriveLetter } from './pathUtils';

type ActiveEditorFilePayload = {
  filePath: string;
  fileName: string;
  relativePath: string;
  fileSize: number | null;
  selection: { startLine: number; endLine: number; text: string } | null;
};

const isSameActiveEditorFilePayload = (a: ActiveEditorFilePayload | null, b: ActiveEditorFilePayload | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.filePath === b.filePath
    && a.fileName === b.fileName
    && a.relativePath === b.relativePath
    && a.fileSize === b.fileSize
    && a.selection?.startLine === b.selection?.startLine
    && a.selection?.endLine === b.selection?.endLine
    && a.selection?.text === b.selection?.text;
};

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'openchamber.chatView';

  private _view?: vscode.WebviewView;

  public isVisible() {
    return this._view?.visible ?? false;
  }

  public hasResolvedView() {
    return this._view !== undefined;
  }

  // Cache latest status/URL for when webview is resolved after connection is ready
  private _cachedStatus: ConnectionStatus = 'connecting';
  private _cachedError?: string;
  private _sseCounter = 0;
  private _sseStreams = new Map<string, AbortController>();
  private readonly _webviewDevServerUrl: string | null;
  private _broadcastSelectionDebounce: ReturnType<typeof setTimeout> | undefined;
  private _clearActiveEditorFileTimer: ReturnType<typeof setTimeout> | undefined;
  private _lastActiveEditorFilePayload: ActiveEditorFilePayload | null = null;

  // Message delivery confirmation and retry
  private readonly _pendingMessages = new Set<string>();
  private readonly _messageTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly _MESSAGE_TIMEOUT = 5000; // 5 seconds
  private readonly _MAX_RETRIES = 3;

  private _createMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private _clearPendingMessages(): void {
    for (const timeout of this._messageTimeouts.values()) {
      clearTimeout(timeout);
    }
    this._messageTimeouts.clear();
    this._pendingMessages.clear();
  }

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _openCodeManager?: OpenCodeManager
  ) {
    this._webviewDevServerUrl = resolveWebviewDevServerUrl(this._context);

    this._context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => void this._broadcastActiveEditorFile()),
      vscode.window.onDidChangeTextEditorSelection(() => this._scheduleBroadcast()),
    );
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView
  ) {
    this._clearPendingMessages();
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

    // Send current active editor file state to the new webview
    this._lastActiveEditorFilePayload = null;
    void this._broadcastActiveEditorFile();

    webviewView.onDidDispose(() => {
      this._clearPendingMessages();
    });

    webviewView.webview.onDidReceiveMessage(async (message: (BridgeRequest & { _msgId?: string }) | { type: 'bridge:ack'; _msgId: string }) => {
      if (message.type === 'bridge:ack' && typeof message._msgId === 'string') {
        this._confirmMessage(message._msgId);
        return;
      }

      if (!('id' in message) || typeof message.id !== 'string') {
        return;
      }

      if (message.type === 'restartApi') {
        await this._openCodeManager?.restart();
        return;
      }

      if (message.type === 'api:sse:start') {
        const response = await this._startSseProxy(message);
        void this._sendMessageWithRetry(response);
        return;
      }

      if (message.type === 'api:sse:stop') {
        const response = await this._stopSseProxy(message);
        void this._sendMessageWithRetry(response);
        return;
      }

      const response = await handleBridgeMessage(message, {
        manager: this._openCodeManager,
        context: this._context,
      });
      void this._sendMessageWithRetry(response);

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

  // Message delivery confirmation
  private _confirmMessage(messageId: string) {
    this._pendingMessages.delete(messageId);

    const timeout = this._messageTimeouts.get(messageId);
    if (timeout) {
      clearTimeout(timeout);
      this._messageTimeouts.delete(messageId);
    }
  }

  // Send message with retry mechanism
  private async _sendMessageWithRetry(response: BridgeResponse, retryCount: number = 0, messageId?: string): Promise<boolean> {
    if (!this._view) {
      return false;
    }

    const pendingMessageId = messageId ?? this._createMessageId();
    const existingTimeout = this._messageTimeouts.get(pendingMessageId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this._messageTimeouts.delete(pendingMessageId);
    }

    try {
      const delivered = await this._view.webview.postMessage({
        ...response,
        _msgId: pendingMessageId,
      });
      if (!delivered) {
        throw new Error('Webview rejected message delivery');
      }

      this._pendingMessages.add(pendingMessageId);

      const timeout = setTimeout(() => {
        if (!this._pendingMessages.has(pendingMessageId)) {
          return;
        }

        if (retryCount < this._MAX_RETRIES) {
          console.warn(`[Message Retry] Message ${pendingMessageId} not confirmed, retrying (${retryCount + 1}/${this._MAX_RETRIES})...`);
          void this._sendMessageWithRetry(response, retryCount + 1, pendingMessageId);
          return;
        }

        console.error(`[Message Retry] Message ${pendingMessageId} failed after ${this._MAX_RETRIES} retries`);
        this._pendingMessages.delete(pendingMessageId);
        this._messageTimeouts.delete(pendingMessageId);
      }, this._MESSAGE_TIMEOUT);

      this._messageTimeouts.set(pendingMessageId, timeout);
      return true;

    } catch (error) {
      console.error(`[Message Retry] Failed to send message:`, error);

      if (retryCount < this._MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (retryCount + 1)));
        return this._sendMessageWithRetry(response, retryCount + 1, pendingMessageId);
      }

      this._pendingMessages.delete(pendingMessageId);
      this._messageTimeouts.delete(pendingMessageId);

      return false;
    }
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

  private _scheduleBroadcast(): void {
    if (this._broadcastSelectionDebounce !== undefined) {
      clearTimeout(this._broadcastSelectionDebounce);
    }
    this._broadcastSelectionDebounce = setTimeout(() => {
      this._broadcastSelectionDebounce = undefined;
      void this._broadcastActiveEditorFile();
    }, 150);
  }

  private _scheduleClearActiveEditorFile(): void {
    if (this._clearActiveEditorFileTimer !== undefined) {
      clearTimeout(this._clearActiveEditorFileTimer);
    }
    this._clearActiveEditorFileTimer = setTimeout(() => {
      this._clearActiveEditorFileTimer = undefined;
      if (!this._view || this._lastActiveEditorFilePayload === null) {
        return;
      }
      this._lastActiveEditorFilePayload = null;
      this._view.webview.postMessage({
        type: 'command',
        command: 'activeEditorFile',
        payload: null,
      });
    }, 200);
  }

  private async _broadcastActiveEditorFile() {
    if (!this._view) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      this._scheduleClearActiveEditorFile();
      return;
    }

    if (this._clearActiveEditorFileTimer !== undefined) {
      clearTimeout(this._clearActiveEditorFileTimer);
      this._clearActiveEditorFileTimer = undefined;
    }

    const filePath = normalizeWindowsDriveLetter(editor.document.uri.fsPath);
    const rawFileName = editor.document.uri.fsPath;
    const fileName = rawFileName.replace(/\\/g, '/').split('/').pop() || '';
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);

    let fileSize: number | null = null;
    try {
      const stat = await vscode.workspace.fs.stat(editor.document.uri);
      fileSize = stat.size;
    } catch {
      // File may not be saved yet or inaccessible
    }

    let selection: { startLine: number; endLine: number; text: string } | null = null;
    if (!editor.selection.isEmpty) {
      selection = {
        startLine: editor.selection.start.line + 1,
        endLine: editor.selection.end.line + 1,
        text: editor.document.getText(editor.selection),
      };
    }

    const payload: ActiveEditorFilePayload = { filePath, fileName, relativePath, fileSize, selection };
    if (isSameActiveEditorFilePayload(this._lastActiveEditorFilePayload, payload)) {
      return;
    }
    this._lastActiveEditorFilePayload = payload;

    this._view.webview.postMessage({
      type: 'command',
      command: 'activeEditorFile',
      payload,
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
    const workspaceFolder = normalizeWindowsDriveLetter(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''
    );
    // Use cached values which are updated by onStatusChange callback
    const initialStatus = this._cachedStatus;
    const cliAvailable = this._openCodeManager?.isCliAvailable() ?? false;

    return getWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      workspaceFolder,
      initialStatus,
      cliAvailable,
      extensionVersion: String(this._context.extension?.packageJSON?.version || ''),
      devServerUrl: this._webviewDevServerUrl,
    });
  }
}

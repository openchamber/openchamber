import * as vscode from 'vscode';
import { handleBridgeMessage, type BridgeRequest } from './bridge';
import type { OpenCodeManager, ConnectionStatus } from './opencode';
import { getWebviewHtml } from './webviewHtml';
import { resolveWebviewDevServerUrl } from './webviewDevServer';
import { normalizeWindowsDriveLetter } from './pathUtils';
import { resolveWorkspaceFolders, type WorkspaceFolderCandidate } from './workspaceResolver';
import { ActiveEditorFileBroadcaster } from './activeEditorFile';
import {
  postPermissionAutoAcceptSynced,
  postSettingsSynced,
  postThemeChange,
  postWebviewCommand,
  postWindowFocusChanged,
  syncConnectionAndFocus,
} from './webviewHostMessages';
import { WebviewMessageRetryQueue } from './webviewMessageRetry';
import {
  abortAllSseStreams,
  startWebviewSseProxy,
  stopWebviewSseProxy,
  type SseStreamMap,
} from './webviewSseSession';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'openchamber.chatView';

  private _view?: vscode.WebviewView;
  private _cachedStatus: ConnectionStatus = 'connecting';
  private _cachedError?: string;
  private _sseCounter = 0;
  private readonly _sseStreams: SseStreamMap = new Map();
  private readonly _webviewDevServerUrl: string | null;
  private readonly _messageRetry: WebviewMessageRetryQueue;
  private readonly _activeEditor: ActiveEditorFileBroadcaster;

  public isVisible() {
    return this._view?.visible ?? false;
  }

  public hasResolvedView() {
    return this._view !== undefined;
  }

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _openCodeManager?: OpenCodeManager
  ) {
    this._webviewDevServerUrl = resolveWebviewDevServerUrl(this._context);
    this._messageRetry = new WebviewMessageRetryQueue(
      () => this._view?.webview,
      {
        onRetry: (messageId, retryCount, maxRetries) => {
          console.warn(`[Message Retry] Message ${messageId} not confirmed, retrying (${retryCount}/${maxRetries})...`);
        },
        onExhausted: (messageId, maxRetries) => {
          console.error(`[Message Retry] Message ${messageId} failed after ${maxRetries} retries`);
        },
        onSendError: (error) => {
          console.error(`[Message Retry] Failed to send message:`, error);
        },
      },
    );
    this._activeEditor = new ActiveEditorFileBroadcaster({
      hasTargets: () => this._view !== undefined,
      postPayload: (payload) => {
        postWebviewCommand(this._targets(), 'activeEditorFile', payload);
      },
    });

    this._context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => void this._activeEditor.broadcast()),
      vscode.window.onDidChangeTextEditorSelection(() => this._activeEditor.scheduleSelectionBroadcast()),
    );
  }

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this._messageRetry.clear();
    this._view = webviewView;

    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri, distUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    void this.updateTheme(vscode.window.activeColorTheme.kind);
    this._sendCachedState();
    this._activeEditor.reset();
    void this._activeEditor.broadcast();

    webviewView.onDidDispose(() => {
      abortAllSseStreams(this._sseStreams);
      if (this._view !== webviewView) return;
      this._activeEditor.reset();
      this._messageRetry.clear();
      this._view = undefined;
    });

    webviewView.webview.onDidReceiveMessage(async (message: (BridgeRequest & { _msgId?: string }) | { type: 'bridge:ack'; _msgId: string }) => {
      if (message.type === 'bridge:ack' && typeof message._msgId === 'string') {
        this._messageRetry.confirm(message._msgId);
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
        const response = await startWebviewSseProxy({
          message,
          manager: this._openCodeManager,
          streams: this._sseStreams,
          nextCounter: () => ++this._sseCounter,
          postMessage: (payload) => {
            void this._view?.webview.postMessage(payload);
          },
        });
        void this._messageRetry.send(response);
        return;
      }

      if (message.type === 'api:sse:stop') {
        const response = stopWebviewSseProxy(message, this._sseStreams);
        void this._messageRetry.send(response);
        return;
      }

      const response = await handleBridgeMessage(message, {
        manager: this._openCodeManager,
        context: this._context,
      });
      void this._messageRetry.send(response);

      if (message.type === 'api:config/settings:save' && response.success) {
        void vscode.commands.executeCommand('openchamber.internal.settingsSynced', response.data);
      }
    });
  }

  public updateTheme(kind: vscode.ColorThemeKind) {
    postThemeChange(this._targets(), kind);
  }

  public updateConnectionStatus(status: ConnectionStatus, error?: string) {
    this._cachedStatus = status;
    this._cachedError = error;
    this._sendCachedState();
  }

  public addTextToInput(text: string) {
    if (!this._view) return;
    this._view.show(true);
    postWebviewCommand(this._targets(), 'addToContext', { text });
  }

  public addContextSelection(selection: { filePath: string; filename: string; text: string }) {
    if (!this._view) return;
    this._view.show(true);
    postWebviewCommand(this._targets(), 'addContextSelection', selection);
  }

  public addFileAttachments(files: Array<{ filePath: string; fileName: string; fileSize: number | null }>) {
    if (!this._view) return;
    const cleanedFiles = files.filter((entry) => entry.filePath.trim().length > 0 && entry.fileName.trim().length > 0);
    if (cleanedFiles.length === 0) return;
    this._view.show(true);
    postWebviewCommand(this._targets(), 'addFileAttachments', { files: cleanedFiles });
  }

  public addFileMentions(paths: string[]) {
    if (!this._view) return;
    const cleanedPaths = paths.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    if (cleanedPaths.length === 0) return;
    this._view.show(true);
    postWebviewCommand(this._targets(), 'addFileMentions', { paths: cleanedPaths });
  }

  public createNewSessionWithPrompt(prompt: string) {
    if (!this._view) return;
    this._view.show(true);
    postWebviewCommand(this._targets(), 'createSessionWithPrompt', { prompt });
  }

  public createNewSession(options?: { directory?: string; workspaceFolders?: WorkspaceFolderCandidate[] }) {
    if (!this._view) return;
    this._view.show(true);
    this._view.webview.postMessage({
      type: 'command',
      command: 'newSession',
      ...((options?.directory || options?.workspaceFolders?.length) && {
        payload: { directory: options?.directory, workspaceFolders: options?.workspaceFolders ?? [] },
      }),
    });
  }

  public syncWorkspaceFolders(workspaceFolders: WorkspaceFolderCandidate[]) {
    postWebviewCommand(this._targets(), 'workspaceFoldersChanged', { workspaceFolders });
  }

  public showSettings() {
    if (!this._view) return;
    this._view.show(true);
    postWebviewCommand(this._targets(), 'showSettings');
  }

  public postMessage(message: unknown): void {
    this._view?.webview.postMessage(message);
  }

  public notifySettingsSynced(settings: unknown): void {
    postSettingsSynced(this._targets(), settings);
  }

  public notifyPermissionAutoAcceptSynced(snapshot: unknown): void {
    postPermissionAutoAcceptSynced(this._targets(), snapshot);
  }

  /**
   * Ask the webview to run the full OpenCode reload flow (overlay + managed
   * restart via the bridge + config/data refresh) — the same flow used after an
   * OpenCode update. Returns false if no webview is resolved to drive it.
   */
  public reloadOpenCode(): boolean {
    if (!this._view) return false;
    postWebviewCommand(this._targets(), 'reloadOpenCode');
    return true;
  }

  public notifyWindowFocusChanged(focused: boolean): void {
    postWindowFocusChanged(this._targets(), focused);
  }

  private _targets() {
    return this._view ? [this._view.webview] : [];
  }

  private _sendCachedState() {
    syncConnectionAndFocus(this._targets(), this._cachedStatus, this._cachedError);
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
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
      extensionVersion: String(this._context.extension?.packageJSON?.version || ''),
      devServerUrl: this._webviewDevServerUrl,
    });
  }
}

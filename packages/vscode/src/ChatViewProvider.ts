import * as vscode from 'vscode';
import type { OpenCodeManager, ConnectionStatus } from './opencode';
import type { WorkspaceFolderCandidate } from './workspaceResolver';
import { MessageDelivery } from './host/messageDelivery';
import { SseProxySession } from './host/sseProxySession';
import { handleHostWebviewMessage, type IncomingHostMessage } from './host/handleHostWebviewMessage';
import {
  type ConnectionCache,
  postConnectionStatus,
  postHostCommand,
  postThemeChange,
  postWindowFocus,
} from './host/webviewMessaging';
import { buildHostWebviewHtml, resolveHostDevServerUrl } from './host/buildHostWebviewHtml';
import { ActiveEditorBroadcaster, webviewCommandPoster } from './host/activeEditorBroadcaster';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'openchamber.chatView';

  private _view?: vscode.WebviewView;
  private _cache: ConnectionCache = { status: 'connecting' };
  private readonly _delivery = new MessageDelivery(() => this._view?.webview);
  private readonly _sse: SseProxySession;
  private readonly _webviewDevServerUrl: string | null;
  private readonly _editorBroadcast: ActiveEditorBroadcaster;

  public isVisible() {
    return this._view?.visible ?? false;
  }

  public hasResolvedView() {
    return this._view !== undefined;
  }

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _openCodeManager?: OpenCodeManager,
  ) {
    this._webviewDevServerUrl = resolveHostDevServerUrl(this._context);
    this._sse = new SseProxySession(
      () => this._openCodeManager,
      (message) => {
        void this._view?.webview.postMessage(message);
      },
    );
    this._editorBroadcast = new ActiveEditorBroadcaster(() => {
      if (!this._view) return [];
      return [{
        isLive: () => this._view !== undefined,
        post: webviewCommandPoster(this._view.webview),
      }];
    });

    this._context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => void this._editorBroadcast.broadcast()),
      vscode.window.onDidChangeTextEditorSelection(() => this._editorBroadcast.schedule()),
    );
  }

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this._delivery.clear();
    this._view = webviewView;

    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri, distUri],
    };

    webviewView.webview.html = buildHostWebviewHtml({
      webview: webviewView.webview,
      extensionUri: this._extensionUri,
      context: this._context,
      manager: this._openCodeManager,
      cache: this._cache,
      devServerUrl: this._webviewDevServerUrl,
    });

    void this.updateTheme(vscode.window.activeColorTheme.kind);
    this._sendCachedState();
    this._editorBroadcast.resetLastPayload();
    void this._editorBroadcast.broadcast();

    webviewView.onDidDispose(() => {
      this._sse.abortAll();
      if (this._view !== webviewView) return;
      this._editorBroadcast.clearTimers();
      this._delivery.clear();
      this._view = undefined;
    });

    webviewView.webview.onDidReceiveMessage(async (message: IncomingHostMessage) => {
      await handleHostWebviewMessage({
        message,
        manager: this._openCodeManager,
        context: this._context,
        delivery: this._delivery,
        sse: this._sse,
      });
    });
  }

  public updateTheme(kind: vscode.ColorThemeKind) {
    if (this._view) {
      postThemeChange(this._view.webview, kind);
    }
  }

  public updateConnectionStatus(status: ConnectionStatus, error?: string) {
    this._cache = { status, error };
    this._sendCachedState();
  }

  public addTextToInput(text: string) {
    if (!this._view) return;
    this._view.show(true);
    postHostCommand(this._view.webview, 'addToContext', { text });
  }

  public addContextSelection(selection: { filePath: string; filename: string; text: string }) {
    if (!this._view) return;
    this._view.show(true);
    postHostCommand(this._view.webview, 'addContextSelection', selection);
  }

  public addFileAttachments(files: Array<{ filePath: string; fileName: string; fileSize: number | null }>) {
    if (!this._view) return;
    const cleanedFiles = files.filter((entry) => entry.filePath.trim().length > 0 && entry.fileName.trim().length > 0);
    if (cleanedFiles.length === 0) return;
    this._view.show(true);
    postHostCommand(this._view.webview, 'addFileAttachments', { files: cleanedFiles });
  }

  public addFileMentions(paths: string[]) {
    if (!this._view) return;
    const cleanedPaths = paths.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    if (cleanedPaths.length === 0) return;
    this._view.show(true);
    postHostCommand(this._view.webview, 'addFileMentions', { paths: cleanedPaths });
  }

  public createNewSessionWithPrompt(prompt: string) {
    if (!this._view) return;
    this._view.show(true);
    postHostCommand(this._view.webview, 'createSessionWithPrompt', { prompt });
  }

  public createNewSession(options?: { directory?: string; workspaceFolders?: WorkspaceFolderCandidate[] }) {
    if (!this._view) return;
    this._view.show(true);
    postHostCommand(this._view.webview, 'newSession', {
      ...(options?.directory ? { directory: options.directory } : {}),
      ...(options?.workspaceFolders?.length ? { workspaceFolders: options.workspaceFolders } : {}),
    });
  }

  public syncWorkspaceFolders(workspaceFolders: WorkspaceFolderCandidate[]) {
    if (!this._view) return;
    postHostCommand(this._view.webview, 'workspaceFoldersChanged', { workspaceFolders });
  }

  public showSettings() {
    if (!this._view) return;
    this._view.show(true);
    postHostCommand(this._view.webview, 'showSettings');
  }

  public postMessage(message: unknown): void {
    this._view?.webview.postMessage(message);
  }

  public notifySettingsSynced(settings: unknown): void {
    if (!this._view) return;
    postHostCommand(this._view.webview, 'settingsSynced', settings);
  }

  public notifyPermissionAutoAcceptSynced(snapshot: unknown): void {
    if (!this._view) return;
    postHostCommand(this._view.webview, 'permissionAutoAcceptSynced', snapshot);
  }

  public reloadOpenCode(): boolean {
    if (!this._view) return false;
    postHostCommand(this._view.webview, 'reloadOpenCode');
    return true;
  }

  public notifyWindowFocusChanged(focused: boolean): void {
    if (!this._view) return;
    postWindowFocus(this._view.webview, focused);
  }

  private _sendCachedState() {
    if (!this._view) return;
    postConnectionStatus(this._view.webview, this._cache, this._openCodeManager);
    postWindowFocus(this._view.webview, vscode.window.state.focused);
  }
}

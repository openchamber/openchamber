import * as vscode from 'vscode';
import type { BridgeRequest } from './bridge-types';
import type { OpenCodeManager, ConnectionStatus } from './opencode';
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

const t = vscode.l10n.t;

type SessionPanelState = {
  panel: vscode.WebviewPanel;
  delivery: MessageDelivery;
  sse: SseProxySession;
};

export class SessionEditorPanelProvider {
  public static readonly viewType = 'openchamber.sessionEditor';

  private _cache: ConnectionCache = { status: 'connecting' };
  private _panels = new Map<string, SessionPanelState>();
  private _lastActivePanelId: string | null = null;
  private readonly _webviewDevServerUrl: string | null;
  private readonly _editorBroadcast: ActiveEditorBroadcaster;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _openCodeManager?: OpenCodeManager,
  ) {
    this._webviewDevServerUrl = resolveHostDevServerUrl(this._context);
    this._editorBroadcast = new ActiveEditorBroadcaster(() =>
      Array.from(this._panels.values()).map((entry) => ({
        isLive: () => true,
        post: webviewCommandPoster(entry.panel.webview),
      })),
    );

    this._context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => void this._editorBroadcast.broadcast()),
      vscode.window.onDidChangeTextEditorSelection(() => this._editorBroadcast.schedule()),
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
      },
    );

    panel.iconPath = {
      light: vscode.Uri.joinPath(this._extensionUri, 'assets', 'icon.svg'),
      dark: vscode.Uri.joinPath(this._extensionUri, 'assets', 'icon-titlebar.svg'),
    };

    const delivery = new MessageDelivery(() => this._panels.get(panelId)?.panel.webview);
    const sse = new SseProxySession(
      () => this._openCodeManager,
      (message) => {
        void this._panels.get(panelId)?.panel.webview.postMessage(message);
      },
    );

    const state: SessionPanelState = { panel, delivery, sse };
    this._panels.set(panelId, state);
    this._lastActivePanelId = panelId;

    panel.webview.html = buildHostWebviewHtml({
      webview: panel.webview,
      extensionUri: this._extensionUri,
      context: this._context,
      manager: this._openCodeManager,
      cache: this._cache,
      panelType: 'chat',
      initialSessionId: initialSessionId ?? undefined,
      viewMode: 'editor',
      devServerUrl: this._webviewDevServerUrl,
    });

    void this.updateTheme(vscode.window.activeColorTheme.kind);
    this._sendCachedStateToPanel(state);
    void this._editorBroadcast.broadcast();

    panel.onDidDispose(() => {
      this._disposePanel(panelId);
    }, null, this._context.subscriptions);

    panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        this._lastActivePanelId = panelId;
      }
    }, null, this._context.subscriptions);

    panel.webview.onDidReceiveMessage(async (message: IncomingHostMessage) => {
      await handleHostWebviewMessage({
        message,
        manager: this._openCodeManager,
        context: this._context,
        delivery,
        sse,
        beforeBridge: async (request: BridgeRequest) => {
          if (request.type !== 'vscode:command') {
            return false;
          }
          const { command, args } = (request.payload || {}) as { command?: unknown; args?: unknown[] };
          if (command !== 'openchamber.updateSessionEditorTitle') {
            return false;
          }
          const nextTitle = typeof args?.[1] === 'string' && args[1].trim().length > 0
            ? args[1].trim()
            : t('Session');
          state.panel.title = nextTitle;
          await delivery.send({
            id: request.id,
            type: request.type,
            success: true,
            data: { result: true },
          });
          return true;
        },
      });
    }, null, this._context.subscriptions);
  }

  public updateTheme(kind: vscode.ColorThemeKind) {
    for (const entry of this._panels.values()) {
      postThemeChange(entry.panel.webview, kind);
    }
  }

  public updateConnectionStatus(status: ConnectionStatus, error?: string) {
    this._cache = { status, error };
    for (const entry of this._panels.values()) {
      this._sendCachedStateToPanel(entry);
    }
  }

  public notifySettingsSynced(settings: unknown): void {
    for (const entry of this._panels.values()) {
      postHostCommand(entry.panel.webview, 'settingsSynced', settings);
    }
  }

  public notifyPermissionAutoAcceptSynced(snapshot: unknown): void {
    for (const entry of this._panels.values()) {
      postHostCommand(entry.panel.webview, 'permissionAutoAcceptSynced', snapshot);
    }
  }

  public notifyWindowFocusChanged(focused: boolean): void {
    for (const entry of this._panels.values()) {
      postWindowFocus(entry.panel.webview, focused);
    }
  }

  private _getActivePanelEntry(): SessionPanelState | null {
    const activeEntry = Array.from(this._panels.entries()).find(([, entry]) => entry.panel.active);
    const panelId = activeEntry?.[0] ?? this._lastActivePanelId;
    if (!panelId) return null;
    return this._panels.get(panelId) ?? null;
  }

  public addContextSelectionToActivePanel(selection: { filePath: string; filename: string; text: string }): boolean {
    if (!selection.filePath.trim() || !selection.filename.trim() || !selection.text.trim()) {
      return false;
    }
    const entry = this._getActivePanelEntry();
    if (!entry) return false;
    entry.panel.reveal(entry.panel.viewColumn ?? vscode.ViewColumn.Active, true);
    postHostCommand(entry.panel.webview, 'addContextSelection', selection);
    return true;
  }

  public createSessionWithPromptInActivePanel(prompt: string): boolean {
    if (!prompt.trim()) return false;
    const entry = this._getActivePanelEntry();
    if (!entry) return false;
    entry.panel.reveal(entry.panel.viewColumn ?? vscode.ViewColumn.Active, true);
    postHostCommand(entry.panel.webview, 'createSessionWithPrompt', { prompt });
    return true;
  }

  public addFileAttachmentsToActivePanel(
    files: Array<{ filePath: string; fileName: string; fileSize: number | null }>,
  ): boolean {
    const cleanedFiles = files.filter((entry) => entry.filePath.trim().length > 0 && entry.fileName.trim().length > 0);
    if (cleanedFiles.length === 0) return false;
    const entry = this._getActivePanelEntry();
    if (!entry) return false;
    entry.panel.reveal(entry.panel.viewColumn ?? vscode.ViewColumn.Active, true);
    postHostCommand(entry.panel.webview, 'addFileAttachments', { files: cleanedFiles });
    return true;
  }

  private _sendCachedStateToPanel(entry: SessionPanelState) {
    postConnectionStatus(entry.panel.webview, this._cache, this._openCodeManager);
    postWindowFocus(entry.panel.webview, vscode.window.state.focused);
  }

  private _disposePanel(sessionId: string) {
    const entry = this._panels.get(sessionId);
    if (!entry) return;
    entry.sse.abortAll();
    entry.delivery.clear();
    this._panels.delete(sessionId);
    if (this._lastActivePanelId === sessionId) {
      this._lastActivePanelId = null;
    }
    if (this._panels.size === 0) {
      this._editorBroadcast.clearTimers();
      this._editorBroadcast.resetLastPayload();
    }
  }
}

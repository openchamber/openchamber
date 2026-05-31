import * as vscode from 'vscode';
import { handleBridgeMessage, type BridgeRequest, type BridgeResponse } from './bridge';
import { getThemeKindName } from './theme';
import type { OpenCodeManager, ConnectionStatus } from './opencode';
import { getWebviewShikiThemes } from './shikiThemes';
import { getWebviewHtml } from './webviewHtml';
import { openSseProxy } from './sseProxy';
import { resolveWebviewDevServerUrl } from './webviewDevServer';
import { normalizeWindowsDriveLetter } from './pathUtils';

const t = vscode.l10n.t;

type SessionPanelState = {
  panel: vscode.WebviewPanel;
  sseStreams: Map<string, AbortController>;
};

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

export class SessionEditorPanelProvider {
  public static readonly viewType = 'openchamber.sessionEditor';

  private _cachedStatus: ConnectionStatus = 'connecting';
  private _cachedError?: string;
  private _sseCounter = 0;
  private _panels = new Map<string, SessionPanelState>();
  private _lastActivePanelId: string | null = null;
  private _broadcastSelectionDebounce: ReturnType<typeof setTimeout> | undefined;
  private _clearActiveEditorFileTimer: ReturnType<typeof setTimeout> | undefined;
  private _lastActiveEditorFilePayload: ActiveEditorFilePayload | null = null;
  private readonly _webviewDevServerUrl: string | null;

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

  public createOrShowNewSession(): void {
    // Generate unique panel ID for new session drafts
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
    void this._broadcastActiveEditorFile();

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
          const title = typeof args?.[1] === 'string' && args[1].trim().length > 0 ? args[1].trim() : t('Session');
          state.panel.title = title;
          state.panel.webview.postMessage({ id: message.id, type: message.type, success: true, data: { result: true } });
          return;
        }
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

  public notifyWindowFocusChanged(focused: boolean): void {
    for (const entry of this._panels.values()) {
      entry.panel.webview.postMessage({
        type: 'command',
        command: 'windowFocusChanged',
        payload: { focused },
      });
    }
  }

  private _getActivePanelEntry(): SessionPanelState | null {
    const activeEntry = Array.from(this._panels.entries()).find(([, entry]) => entry.panel.active);
    const panelId = activeEntry?.[0] ?? this._lastActivePanelId;
    if (!panelId) {
      return null;
    }

    return this._panels.get(panelId) ?? null;
  }

  public addContextSelectionToActivePanel(selection: { filePath: string; filename: string; text: string }): boolean {
    if (!selection.filePath.trim() || !selection.filename.trim() || !selection.text.trim()) {
      return false;
    }

    const entry = this._getActivePanelEntry();
    if (!entry) {
      return false;
    }

    entry.panel.reveal(entry.panel.viewColumn ?? vscode.ViewColumn.Active, true);
    void entry.panel.webview.postMessage({
      type: 'command',
      command: 'addContextSelection',
      payload: selection,
    });
    return true;
  }

  public createSessionWithPromptInActivePanel(prompt: string): boolean {
    if (!prompt.trim()) {
      return false;
    }

    const entry = this._getActivePanelEntry();
    if (!entry) {
      return false;
    }

    entry.panel.reveal(entry.panel.viewColumn ?? vscode.ViewColumn.Active, true);
    void entry.panel.webview.postMessage({
      type: 'command',
      command: 'createSessionWithPrompt',
      payload: { prompt },
    });
    return true;
  }

  public addFileAttachmentsToActivePanel(files: Array<{ filePath: string; fileName: string; fileSize: number | null }>): boolean {
    const cleanedFiles = files.filter((entry) => entry.filePath.trim().length > 0 && entry.fileName.trim().length > 0);

    if (cleanedFiles.length === 0) {
      return false;
    }

    const entry = this._getActivePanelEntry();
    if (!entry) {
      return false;
    }

    entry.panel.reveal(entry.panel.viewColumn ?? vscode.ViewColumn.Active, true);
    void entry.panel.webview.postMessage({
      type: 'command',
      command: 'addFileAttachments',
      payload: { files: cleanedFiles },
    });
    return true;
  }

  private _sendCachedStateToPanel(entry: SessionPanelState) {
    entry.panel.webview.postMessage({
      type: 'connectionStatus',
      status: this._cachedStatus,
      error: this._cachedError,
    });
    entry.panel.webview.postMessage({
      type: 'command',
      command: 'windowFocusChanged',
      payload: { focused: vscode.window.state.focused },
    });
  }

  private _postCommandToPanels(command: string, payload: unknown): void {
    for (const entry of this._panels.values()) {
      entry.panel.webview.postMessage({
        type: 'command',
        command,
        payload,
      });
    }
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
      if (this._panels.size === 0 || this._lastActiveEditorFilePayload === null) {
        return;
      }
      this._lastActiveEditorFilePayload = null;
      this._postCommandToPanels('activeEditorFile', null);
    }, 200);
  }

  private async _broadcastActiveEditorFile(): Promise<void> {
    if (this._panels.size === 0) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      this._scheduleClearActiveEditorFile();
      return;
    }

    const editorUri = editor.document.uri;
    const editorUriKey = editorUri.toString();

    if (this._clearActiveEditorFileTimer !== undefined) {
      clearTimeout(this._clearActiveEditorFileTimer);
      this._clearActiveEditorFileTimer = undefined;
    }

    const filePath = normalizeWindowsDriveLetter(editorUri.fsPath);
    const fileName = editorUri.fsPath.replace(/\\/g, '/').split('/').pop() || '';
    const relativePath = vscode.workspace.asRelativePath(editorUri, false);

    let fileSize: number | null = null;
    try {
      const stat = await vscode.workspace.fs.stat(editorUri);
      fileSize = stat.size;
    } catch {
      // File may not be saved yet or inaccessible.
    }

    if (vscode.window.activeTextEditor?.document.uri.toString() !== editorUriKey) {
      return;
    }

    let selection: ActiveEditorFilePayload['selection'] = null;
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
    this._postCommandToPanels('activeEditorFile', payload);
  }

  private _disposePanel(sessionId: string) {
    const entry = this._panels.get(sessionId);
    if (!entry) return;

    for (const controller of entry.sseStreams.values()) {
      controller.abort();
    }
    entry.sseStreams.clear();

    this._panels.delete(sessionId);
    if (this._lastActivePanelId === sessionId) {
      this._lastActivePanelId = null;
    }
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
    const workspaceFolder = normalizeWindowsDriveLetter(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''
    );
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
      extensionVersion: String(this._context.extension?.packageJSON?.version || ''),
      devServerUrl: this._webviewDevServerUrl,
    });
  }
}

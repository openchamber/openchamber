import * as vscode from 'vscode';
import { handleBridgeMessage, type BridgeRequest } from './bridge';
import type { OpenCodeManager, ConnectionStatus } from './opencode';
import { getWebviewHtml } from './webviewHtml';
import { resolveWebviewDevServerUrl } from './webviewDevServer';
import { normalizeWindowsDriveLetter } from './pathUtils';
import { resolveWorkspaceFolders } from './workspaceResolver';
import {
  postPermissionAutoAcceptSynced,
  postSettingsSynced,
  postThemeChange,
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

export class AgentManagerPanelProvider {
  public static readonly viewType = 'openchamber.agentManager';

  private _panel?: vscode.WebviewPanel;
  private _cachedStatus: ConnectionStatus = 'connecting';
  private _cachedError?: string;
  private _sseCounter = 0;
  private readonly _sseStreams: SseStreamMap = new Map();
  private readonly _webviewDevServerUrl: string | null;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _openCodeManager?: OpenCodeManager
  ) {
    this._webviewDevServerUrl = resolveWebviewDevServerUrl(this._context);
  }

  public createOrShow(): void {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist');

    this._panel = vscode.window.createWebviewPanel(
      AgentManagerPanelProvider.viewType,
      t('Agent Manager'),
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
    void this.updateTheme(vscode.window.activeColorTheme.kind);
    this._sendCachedState();

    this._panel.onDidDispose(() => {
      abortAllSseStreams(this._sseStreams);
      this._panel = undefined;
    }, null, this._context.subscriptions);

    this._panel.webview.onDidReceiveMessage(async (message: BridgeRequest) => {
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
            void this._panel?.webview.postMessage(payload);
          },
        });
        this._panel?.webview.postMessage(response);
        return;
      }

      if (message.type === 'api:sse:stop') {
        const response = stopWebviewSseProxy(message, this._sseStreams);
        this._panel?.webview.postMessage(response);
        return;
      }

      const response = await handleBridgeMessage(message, {
        manager: this._openCodeManager,
        context: this._context,
      });
      this._panel?.webview.postMessage(response);

      if (message.type === 'api:config/settings:save' && response.success) {
        void vscode.commands.executeCommand('openchamber.internal.settingsSynced', response.data);
      }
    }, null, this._context.subscriptions);
  }

  public updateTheme(kind: vscode.ColorThemeKind) {
    postThemeChange(this._targets(), kind);
  }

  public updateConnectionStatus(status: ConnectionStatus, error?: string) {
    this._cachedStatus = status;
    this._cachedError = error;
    this._sendCachedState();
  }

  public notifySettingsSynced(settings: unknown): void {
    postSettingsSynced(this._targets(), settings);
  }

  public notifyPermissionAutoAcceptSynced(snapshot: unknown): void {
    postPermissionAutoAcceptSynced(this._targets(), snapshot);
  }

  public notifyWindowFocusChanged(focused: boolean): void {
    postWindowFocusChanged(this._targets(), focused);
  }

  private _targets() {
    return this._panel ? [this._panel.webview] : [];
  }

  private _sendCachedState() {
    syncConnectionAndFocus(this._targets(), this._cachedStatus, this._cachedError);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
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
      panelType: 'agentManager',
      extensionVersion: String(this._context.extension?.packageJSON?.version || ''),
      devServerUrl: this._webviewDevServerUrl,
    });
  }
}

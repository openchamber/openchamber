import * as vscode from 'vscode';
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

const t = vscode.l10n.t;

export class AgentManagerPanelProvider {
  public static readonly viewType = 'openchamber.agentManager';

  private _panel?: vscode.WebviewPanel;
  private _cache: ConnectionCache = { status: 'connecting' };
  private readonly _delivery = new MessageDelivery(() => this._panel?.webview);
  private readonly _sse: SseProxySession;
  private readonly _webviewDevServerUrl: string | null;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _openCodeManager?: OpenCodeManager,
  ) {
    this._webviewDevServerUrl = resolveHostDevServerUrl(this._context);
    this._sse = new SseProxySession(
      () => this._openCodeManager,
      (message) => {
        void this._panel?.webview.postMessage(message);
      },
    );
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
      },
    );

    this._panel.iconPath = {
      light: vscode.Uri.joinPath(this._extensionUri, 'assets', 'icon.svg'),
      dark: vscode.Uri.joinPath(this._extensionUri, 'assets', 'icon-titlebar.svg'),
    };

    this._panel.webview.html = buildHostWebviewHtml({
      webview: this._panel.webview,
      extensionUri: this._extensionUri,
      context: this._context,
      manager: this._openCodeManager,
      cache: this._cache,
      panelType: 'agentManager',
      devServerUrl: this._webviewDevServerUrl,
    });

    void this.updateTheme(vscode.window.activeColorTheme.kind);
    this._sendCachedState();

    this._panel.onDidDispose(() => {
      this._sse.abortAll();
      this._delivery.clear();
      this._panel = undefined;
    }, null, this._context.subscriptions);

    this._panel.webview.onDidReceiveMessage(async (message: IncomingHostMessage) => {
      await handleHostWebviewMessage({
        message,
        manager: this._openCodeManager,
        context: this._context,
        delivery: this._delivery,
        sse: this._sse,
      });
    }, null, this._context.subscriptions);
  }

  public updateTheme(kind: vscode.ColorThemeKind) {
    if (this._panel) {
      postThemeChange(this._panel.webview, kind);
    }
  }

  public updateConnectionStatus(status: ConnectionStatus, error?: string) {
    this._cache = { status, error };
    this._sendCachedState();
  }

  public notifySettingsSynced(settings: unknown): void {
    if (!this._panel) return;
    postHostCommand(this._panel.webview, 'settingsSynced', settings);
  }

  public notifyPermissionAutoAcceptSynced(snapshot: unknown): void {
    if (!this._panel) return;
    postHostCommand(this._panel.webview, 'permissionAutoAcceptSynced', snapshot);
  }

  public notifyWindowFocusChanged(focused: boolean): void {
    if (!this._panel) return;
    postWindowFocus(this._panel.webview, focused);
  }

  private _sendCachedState() {
    if (!this._panel) return;
    postConnectionStatus(this._panel.webview, this._cache, this._openCodeManager);
    postWindowFocus(this._panel.webview, vscode.window.state.focused);
  }
}

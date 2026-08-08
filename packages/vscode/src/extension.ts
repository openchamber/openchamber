import * as vscode from 'vscode';
import { ChatViewProvider } from './ChatViewProvider';
import { AgentManagerPanelProvider } from './AgentManagerPanelProvider';
import { SessionEditorPanelProvider } from './SessionEditorPanelProvider';
import { createOpenCodeManager, type OpenCodeManager } from './opencode';
import { startGlobalEventWatcher, stopGlobalEventWatcher, setChatViewProvider } from './sessionActivityWatcher';
import { registerExtensionCommands } from './extension/commands';
import { maybeMoveChatToRightSidebarOnStartup } from './extension/sidebarPlacement';

let chatViewProvider: ChatViewProvider | undefined;
let agentManagerProvider: AgentManagerPanelProvider | undefined;
let sessionEditorProvider: SessionEditorPanelProvider | undefined;
let openCodeManager: OpenCodeManager | undefined;
let outputChannel: vscode.OutputChannel | undefined;

let activeSessionId: string | null = null;
let activeSessionTitle: string | null = null;

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('OpenChamber');

  // Migration: clear legacy auto-set API URLs (ports 47680-47689 were auto-assigned by older extension versions)
  const config = vscode.workspace.getConfiguration('openchamber');
  const legacyApiUrl = config.get<string>('apiUrl') || '';
  if (/^https?:\/\/localhost:4768\d\/?$/.test(legacyApiUrl.trim())) {
    await config.update('apiUrl', '', vscode.ConfigurationTarget.Global);
  }

  // Create OpenCode manager first
  openCodeManager = createOpenCodeManager(context);

  // Create chat view provider with manager reference
  // The webview will show a loading state until OpenCode is ready
  chatViewProvider = new ChatViewProvider(context, context.extensionUri, openCodeManager);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  registerExtensionCommands(context, {
    getChatViewProvider: () => chatViewProvider,
    getAgentManagerProvider: () => agentManagerProvider,
    getSessionEditorProvider: () => sessionEditorProvider,
    getOpenCodeManager: () => openCodeManager,
    outputChannel,
    getActiveSessionId: () => activeSessionId,
    setActiveSessionId: (sessionId, title) => {
      activeSessionId = sessionId;
      activeSessionTitle = title ?? null;
    },
    getActiveSessionTitle: () => activeSessionTitle,
  });

  maybeMoveChatToRightSidebarOnStartup(context, outputChannel);

  // Create Agent Manager panel provider
  agentManagerProvider = new AgentManagerPanelProvider(context, context.extensionUri, openCodeManager);
  sessionEditorProvider = new SessionEditorPanelProvider(context, context.extensionUri, openCodeManager);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme((theme) => {
      chatViewProvider?.updateTheme(theme.kind);
      agentManagerProvider?.updateTheme(theme.kind);
      sessionEditorProvider?.updateTheme(theme.kind);
    }),
  );

  // Theme changes can update the `workbench.colorTheme` setting slightly after the
  // `activeColorTheme` event. Listen for config changes too so we can re-resolve
  // the contributed theme JSON and update Shiki themes in the webview.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('workbench.colorTheme') ||
        event.affectsConfiguration('workbench.preferredLightColorTheme') ||
        event.affectsConfiguration('workbench.preferredDarkColorTheme')
      ) {
        chatViewProvider?.updateTheme(vscode.window.activeColorTheme.kind);
        agentManagerProvider?.updateTheme(vscode.window.activeColorTheme.kind);
        sessionEditorProvider?.updateTheme(vscode.window.activeColorTheme.kind);
      }
    }),
  );

  // Subscribe to status changes - this broadcasts to webview
  context.subscriptions.push(
    openCodeManager.onStatusChange((status, error) => {
      chatViewProvider?.updateConnectionStatus(status, error);
      agentManagerProvider?.updateConnectionStatus(status, error);
      sessionEditorProvider?.updateConnectionStatus(status, error);

      // Start/stop global event watcher based on connection status
      // Mirrors web server and desktop behavior
      if (status === 'connected' && chatViewProvider && openCodeManager) {
        setChatViewProvider(chatViewProvider);
        void startGlobalEventWatcher(openCodeManager, chatViewProvider);
      } else if (status === 'disconnected' || status === 'error') {
        stopGlobalEventWatcher();
      }
    }),
  );

  // Start OpenCode API without blocking activation.
  // Blocking here delays webview resolution and causes a blank panel until startup completes.
  void openCodeManager.start();
}

export async function deactivate() {
  stopGlobalEventWatcher();
  await openCodeManager?.stop();
  openCodeManager = undefined;
  chatViewProvider = undefined;
  agentManagerProvider = undefined;
  sessionEditorProvider = undefined;
  outputChannel?.dispose();
  outputChannel = undefined;
}

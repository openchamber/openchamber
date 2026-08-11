import * as vscode from 'vscode';
import type { ChatViewProvider } from '../ChatViewProvider';
import type { AgentManagerPanelProvider } from '../AgentManagerPanelProvider';
import type { SessionEditorPanelProvider } from '../SessionEditorPanelProvider';
import type { OpenCodeManager } from '../opencode';
import { resolveWorkspaceFolders } from '../workspaceResolver';
import { registerShowOpenCodeStatusCommand } from './statusReport';

const t = vscode.l10n.t;

export const CHAT_VIEW_BOOTSTRAP_DELAY_MS = 80;

export const waitForChatViewBootstrap = () =>
  new Promise<void>((resolve) => setTimeout(resolve, CHAT_VIEW_BOOTSTRAP_DELAY_MS));

export type ExtensionCommandsDeps = {
  getChatViewProvider: () => ChatViewProvider | undefined;
  getAgentManagerProvider: () => AgentManagerPanelProvider | undefined;
  getSessionEditorProvider: () => SessionEditorPanelProvider | undefined;
  getOpenCodeManager: () => OpenCodeManager | undefined;
  outputChannel?: vscode.OutputChannel;
  getActiveSessionId: () => string | null;
  setActiveSessionId: (sessionId: string | null, title?: string | null) => void;
  getActiveSessionTitle: () => string | null;
};

export const registerExtensionCommands = (
  context: vscode.ExtensionContext,
  deps: ExtensionCommandsDeps,
): void => {
  const {
    getChatViewProvider,
    getAgentManagerProvider,
    getSessionEditorProvider,
    getOpenCodeManager,
    outputChannel,
    getActiveSessionId,
    setActiveSessionId,
    getActiveSessionTitle,
  } = deps;

  const revealChatViewForPayload = async () => {
    const opened = await vscode.commands.executeCommand<boolean>('openchamber.openSidebar');
    if (!opened) {
      return false;
    }

    await waitForChatViewBootstrap();
    const chatViewProvider = getChatViewProvider();
    if (!chatViewProvider?.hasResolvedView()) {
      outputChannel?.appendLine('[OpenChamber] Chat sidebar webview was disposed before payload delivery');
      vscode.window.showWarningMessage(t('OpenChamber: Chat sidebar is not ready'));
      return false;
    }

    return true;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openSidebar', async () => {
      // Best-effort: open the container (if available), then focus the chat view.
      try {
        await vscode.commands.executeCommand('workbench.view.extension.openchamber');
      } catch (e) {
        outputChannel?.appendLine(`[OpenChamber] workbench.view.extension.openchamber failed: ${e}`);
      }

      try {
        await vscode.commands.executeCommand('openchamber.chatView.focus');
      } catch (e) {
        outputChannel?.appendLine(`[OpenChamber] openchamber.chatView.focus failed: ${e}`);
        vscode.window.showErrorMessage(t('OpenChamber: Failed to open sidebar - {0}', String(e)));
        return false;
      }

      const chatViewProvider = getChatViewProvider();
      if (!chatViewProvider?.hasResolvedView()) {
        outputChannel?.appendLine('[OpenChamber] Chat sidebar focus completed before the webview was resolved');
        vscode.window.showWarningMessage(t('OpenChamber: Chat sidebar is not ready'));
        return false;
      }

      return true;
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.focusChat', async () => {
      await vscode.commands.executeCommand('openchamber.chatView.focus');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.internal.settingsSynced', (settings: unknown) => {
      getChatViewProvider()?.notifySettingsSynced(settings);
      getSessionEditorProvider()?.notifySettingsSynced(settings);
      getAgentManagerProvider()?.notifySettingsSynced(settings);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.internal.permissionAutoAcceptSynced', (snapshot: unknown) => {
      getChatViewProvider()?.notifyPermissionAutoAcceptSynced(snapshot);
      getSessionEditorProvider()?.notifyPermissionAutoAcceptSynced(snapshot);
      getAgentManagerProvider()?.notifyPermissionAutoAcceptSynced(snapshot);
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      getChatViewProvider()?.notifyWindowFocusChanged(state.focused);
      getSessionEditorProvider()?.notifyWindowFocusChanged(state.focused);
      getAgentManagerProvider()?.notifyWindowFocusChanged(state.focused);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openAgentManager', () => {
      getAgentManagerProvider()?.createOrShow();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.setActiveSession', (sessionId: unknown, title?: unknown) => {
      if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
        setActiveSessionId(sessionId.trim(), typeof title === 'string' && title.trim().length > 0 ? title.trim() : null);
        return;
      }

      setActiveSessionId(null);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openActiveSessionInEditor', () => {
      const activeSessionId = getActiveSessionId();
      if (!activeSessionId) {
        vscode.window.showInformationMessage(t('OpenChamber: No active session'));
        return;
      }
      getSessionEditorProvider()?.createOrShow(activeSessionId, getActiveSessionTitle() ?? undefined);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openSessionInEditor', (sessionId: string, title?: string) => {
      if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        return;
      }
      getSessionEditorProvider()?.createOrShow(sessionId.trim(), title);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openNewSessionInEditor', () => {
      getSessionEditorProvider()?.createOrShowNewSession();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openCurrentOrNewSessionInEditor', () => {
      const activeSessionId = getActiveSessionId();
      if (activeSessionId) {
        getSessionEditorProvider()?.createOrShow(activeSessionId, getActiveSessionTitle() ?? undefined);
      } else {
        getSessionEditorProvider()?.createOrShowNewSession();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.restartApi', async () => {
      try {
        // Prefer the full in-app reload flow (overlay + managed restart via the
        // bridge + config/data refresh) driven by the webview — same as after an
        // OpenCode update. Fall back to a bare manager restart when no webview is
        // open to drive it.
        const chatViewProvider = getChatViewProvider();
        if (chatViewProvider?.reloadOpenCode()) {
          return;
        }
        await getOpenCodeManager()?.restart();
        vscode.window.showInformationMessage(t('OpenChamber: API connection restarted'));
      } catch (e) {
        vscode.window.showErrorMessage(t('OpenChamber: Failed to restart API - {0}', String(e)));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.addToContext', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(t('OpenChamber [Add to Context]: No active editor'));
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);

      if (!selectedText) {
        vscode.window.showWarningMessage(t('OpenChamber [Add to Context]: No text selected'));
        return;
      }

      // Get file info for context
      // false matches the relativePath broadcast for the active editor, so this attachment dedupes against the pin-selection suggestion.
      const filePath = vscode.workspace.asRelativePath(editor.document.uri, false);
      // Get line numbers (1-based for display)
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;
      const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;

      const filename = `${filePath}:${lineRange}`;
      const contextSelection = {
        filePath: editor.document.uri.fsPath,
        filename,
        text: selectedText,
      };

      const sessionEditorProvider = getSessionEditorProvider();
      if (!sessionEditorProvider?.addContextSelectionToActivePanel(contextSelection)) {
        if (!(await revealChatViewForPayload())) {
          return;
        }
        getChatViewProvider()?.addContextSelection(contextSelection);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.attachExplorerToChat', async (resource?: vscode.Uri, resources?: vscode.Uri[]) => {
      const uriCandidates: vscode.Uri[] = [];
      if (Array.isArray(resources)) {
        uriCandidates.push(...resources.filter((entry): entry is vscode.Uri => entry instanceof vscode.Uri));
      }
      if (resource instanceof vscode.Uri) {
        uriCandidates.push(resource);
      }
      if (uriCandidates.length === 0) {
        const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
        if (activeEditorUri) {
          uriCandidates.push(activeEditorUri);
        }
      }

      const uniqueUris = Array.from(new Map(uriCandidates.map((uri) => [uri.toString(), uri])).values());
      const attachedFiles: Array<{ filePath: string; fileName: string; fileSize: number | null }> = [];
      const skippedEntries: string[] = [];

      for (const uri of uniqueUris) {
        if (uri.scheme !== 'file') {
          skippedEntries.push(uri.toString());
          continue;
        }

        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if ((stat.type & vscode.FileType.Directory) !== 0) {
            skippedEntries.push(vscode.workspace.asRelativePath(uri, false));
            continue;
          }
        } catch {
          skippedEntries.push(vscode.workspace.asRelativePath(uri, false));
          continue;
        }

        const filePath = uri.fsPath.trim();
        const fileName = uri.fsPath.replace(/\\/g, '/').split('/').pop() || vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/').trim();
        if (!filePath || !fileName) {
          skippedEntries.push(uri.fsPath || uri.toString());
          continue;
        }
        let fileSize: number | null = null;
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          fileSize = stat.size;
        } catch {
          fileSize = null;
        }
        attachedFiles.push({ filePath, fileName, fileSize });
      }

      if (attachedFiles.length === 0) {
        vscode.window.showWarningMessage(t('OpenChamber: No file selected to mention'));
        return;
      }

      const sessionEditorProvider = getSessionEditorProvider();
      if (!sessionEditorProvider?.addFileAttachmentsToActivePanel(attachedFiles)) {
        if (!(await revealChatViewForPayload())) {
          return;
        }
        getChatViewProvider()?.addFileAttachments(attachedFiles);
      }

      if (skippedEntries.length > 0) {
        vscode.window.showInformationMessage(t('OpenChamber: Some selected entries were skipped (folders or unsupported resources)'));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.explain', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(t('OpenChamber [Explain]: No active editor'));
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const languageId = editor.document.languageId;

      let prompt: string;

      if (selectedText) {
        // Selection exists - explain the selected code
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
        prompt = `${t('Explain the following Code / Text:')}\n\n${filePath}:${lineRange}\n\`\`\`${languageId}\n${selectedText}\n\`\`\``;
      } else {
        // No selection - explain the entire file
        prompt = `${t('Explain the following Code / Text:')}\n\n${filePath}`;
      }

      const sessionEditorProvider = getSessionEditorProvider();
      if (!sessionEditorProvider?.createSessionWithPromptInActivePanel(prompt)) {
        if (!(await revealChatViewForPayload())) {
          return;
        }
        getChatViewProvider()?.createNewSessionWithPrompt(prompt);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.improveCode', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(t('OpenChamber [Improve Code]: No active editor'));
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);

      if (!selectedText) {
        vscode.window.showWarningMessage(t('OpenChamber [Improve Code]: No text selected'));
        return;
      }

      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const languageId = editor.document.languageId;
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;
      const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;

      const prompt = `${t('Improve the following Code:')}\n\n${filePath}:${lineRange}\n\`\`\`${languageId}\n${selectedText}\n\`\`\``;

      const sessionEditorProvider = getSessionEditorProvider();
      if (!sessionEditorProvider?.createSessionWithPromptInActivePanel(prompt)) {
        if (!(await revealChatViewForPayload())) {
          return;
        }
        getChatViewProvider()?.createNewSessionWithPrompt(prompt);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.newSession', async (directory?: unknown) => {
      const candidates = resolveWorkspaceFolders(vscode.workspace.workspaceFolders ?? []);
      let folderPath: string | undefined = typeof directory === 'string' ? directory : undefined;

      if (!folderPath && candidates.length === 0) {
        vscode.window.showInformationMessage('OpenChamber: No folder is open. Open a folder to start a new session.');
        return;
      }

      if (!folderPath) {
        folderPath = candidates.length === 1
          ? candidates[0].path
          : (await vscode.window.showQuickPick(
              candidates.map((folder) => ({ label: folder.name, description: folder.path, path: folder.path })),
              { placeHolder: 'Select a workspace folder for this session', matchOnDescription: true },
            ))?.path;
      }

      if (!folderPath) {
        return;
      }

      const openCodeManager = getOpenCodeManager();
      if (openCodeManager) {
        const result = await openCodeManager.setWorkingDirectory(folderPath);
        if (!result.success) {
          vscode.window.showErrorMessage(`OpenChamber: ${result.error}`);
          return;
        }
      }
      const workspaceFolders = candidates.some((folder) => folder.path === folderPath)
        ? candidates
        : [
            ...candidates,
            {
              name: folderPath.split(/[\\/]/).filter(Boolean).pop() ?? folderPath,
              path: folderPath,
            },
          ];
      getChatViewProvider()?.createNewSession({ directory: folderPath, workspaceFolders });
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      getChatViewProvider()?.syncWorkspaceFolders(resolveWorkspaceFolders(vscode.workspace.workspaceFolders ?? []));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.showSettings', () => {
      getChatViewProvider()?.showSettings();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openWalkthrough', async () => {
      await vscode.commands.executeCommand('workbench.action.openWalkthrough', 'fedaykindev.openchamber#gettingStarted');
    }),
  );

  registerShowOpenCodeStatusCommand(context, {
    openCodeManager: getOpenCodeManager(),
    outputChannel,
  });
};

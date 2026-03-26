import * as vscode from 'vscode';
import { ChatViewProvider } from './ChatViewProvider';
import { AgentManagerPanelProvider } from './AgentManagerPanelProvider';
import { SessionEditorPanelProvider } from './SessionEditorPanelProvider';
import { createOpenCodeManager, type OpenCodeManager } from './opencode';
import { startGlobalEventWatcher, stopGlobalEventWatcher, setChatViewProvider } from './sessionActivityWatcher';
import { buildVSCodeCodeBlockPrompt, getVSCodeRuntimeCopy, resolveVSCodeLocale } from './i18n';

let chatViewProvider: ChatViewProvider | undefined;
let agentManagerProvider: AgentManagerPanelProvider | undefined;
let sessionEditorProvider: SessionEditorPanelProvider | undefined;
let openCodeManager: OpenCodeManager | undefined;
let outputChannel: vscode.OutputChannel | undefined;

let activeSessionId: string | null = null;
let activeSessionTitle: string | null = null;

const SETTINGS_KEY = 'openchamber.settings';

const getExtensionMessages = () => {
  const locale = resolveVSCodeLocale(vscode.env.language);
  const host = getVSCodeRuntimeCopy(locale).host;
  return {
    ...host,
    explainPromptWithSelection: (filePath: string, lineRange: string, languageId: string, selectedText: string) =>
      buildVSCodeCodeBlockPrompt(host.explainPromptPrefix, filePath, lineRange, languageId, selectedText),
    improvePrompt: (filePath: string, lineRange: string, languageId: string, selectedText: string) =>
      buildVSCodeCodeBlockPrompt(host.improvePromptPrefix, filePath, lineRange, languageId, selectedText),
  };
};

const formatIso = (value: number | null | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '(none)';
  try {
    return new Date(value).toISOString();
  } catch {
    return String(value);
  }
};

const formatDurationMs = (value: number | null | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '(none)';
  const seconds = Math.round(value / 100) / 10;
  return `${seconds}s`;
};

export async function activate(context: vscode.ExtensionContext) {
  const i18n = getExtensionMessages();
  outputChannel = vscode.window.createOutputChannel('OpenChamber');

  let moveToRightSidebarScheduled = false;

  const isCursorLikeHost = () => /\bcursor\b/i.test(vscode.env.appName);

  const findMoveToRightSidebarCommandId = async (): Promise<string | null> => {
    const commands = await vscode.commands.getCommands(true);

    const preferred = [
      // Newer VS Code naming
      'workbench.action.moveViewToSecondarySideBar',
      'workbench.action.moveViewToSecondarySidebar',
      'workbench.action.moveFocusedViewToSecondarySideBar',
      'workbench.action.moveFocusedViewToSecondarySidebar',

      // Some builds use "Auxiliary Bar" naming
      'workbench.action.moveViewToAuxiliaryBar',
      'workbench.action.moveFocusedViewToAuxiliaryBar',
    ];

    for (const commandId of preferred) {
      if (commands.includes(commandId)) return commandId;
    }

    const fuzzy = commands.find((commandId) => {
      const id = commandId.toLowerCase();
      const looksLikeMoveView = id.includes('workbench.action') && id.includes('move') && id.includes('view');
      if (!looksLikeMoveView) return false;

      // Support both "secondary sidebar" and "auxiliary bar" naming.
      return (id.includes('secondary') && id.includes('side') && id.includes('bar')) || (id.includes('auxiliary') && id.includes('bar'));
    });

    return fuzzy || null;
  };

  const attemptMoveChatToRightSidebar = async (): Promise<'moved' | 'unsupported' | 'failed'> => {
    const moveCommandId = await findMoveToRightSidebarCommandId();
    if (!moveCommandId) return 'unsupported';

    try {
      await vscode.commands.executeCommand('openchamber.chatView.focus');
      await vscode.commands.executeCommand(moveCommandId);
      return 'moved';
    } catch (error) {
      outputChannel?.appendLine(
        `[OpenChamber] Failed moving chat view to right sidebar (command=${moveCommandId}): ${error instanceof Error ? error.message : String(error)}`
      );
      return 'failed';
    }
  };

  const maybeMoveChatToRightSidebarOnStartup = async () => {
    if (isCursorLikeHost()) return;

    const attempted = context.globalState.get<boolean>('openchamber.sidebarAutoMoveAttempted') || false;
    if (attempted) return;
    await context.globalState.update('openchamber.sidebarAutoMoveAttempted', true);

    if (moveToRightSidebarScheduled) return;
    moveToRightSidebarScheduled = true;

    // Defer until after activation to avoid stealing focus during startup.
    setTimeout(() => {
      void (async () => {
        try {
          await attemptMoveChatToRightSidebar();
        } finally {
          moveToRightSidebarScheduled = false;
        }
      })();
    }, 800);
  };


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
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Register sidebar/focus commands AFTER the webview view provider is registered
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
        vscode.window.showErrorMessage(i18n.failedToOpenSidebar(e));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.focusChat', async () => {
      await vscode.commands.executeCommand('openchamber.chatView.focus');
    })
  );

  void maybeMoveChatToRightSidebarOnStartup();

  // Create Agent Manager panel provider
  agentManagerProvider = new AgentManagerPanelProvider(context, context.extensionUri, openCodeManager);
  sessionEditorProvider = new SessionEditorPanelProvider(context, context.extensionUri, openCodeManager);

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.internal.settingsSynced', (settings: unknown) => {
      chatViewProvider?.notifySettingsSynced(settings);
      sessionEditorProvider?.notifySettingsSynced(settings);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openAgentManager', () => {
      agentManagerProvider?.createOrShow();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.setActiveSession', (sessionId: unknown, title?: unknown) => {
      if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
        activeSessionId = sessionId.trim();
        activeSessionTitle = typeof title === 'string' && title.trim().length > 0 ? title.trim() : null;
        return;
      }

      activeSessionId = null;
      activeSessionTitle = null;
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openActiveSessionInEditor', () => {
      if (!activeSessionId) {
        vscode.window.showInformationMessage(i18n.noActiveSession);
        return;
      }
      sessionEditorProvider?.createOrShow(activeSessionId, activeSessionTitle ?? undefined);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openSessionInEditor', (sessionId: string, title?: string) => {
      if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        return;
      }
      sessionEditorProvider?.createOrShow(sessionId.trim(), title);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openNewSessionInEditor', () => {
      sessionEditorProvider?.createOrShowNewSession();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openCurrentOrNewSessionInEditor', () => {
      if (activeSessionId) {
        sessionEditorProvider?.createOrShow(activeSessionId, activeSessionTitle ?? undefined);
      } else {
        sessionEditorProvider?.createOrShowNewSession();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.restartApi', async () => {
      try {
        await openCodeManager?.restart();
        vscode.window.showInformationMessage(i18n.apiRestarted);
      } catch (e) {
        vscode.window.showErrorMessage(i18n.failedToRestartApi(e));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.addToContext', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(i18n.addToContextNoActiveEditor);
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);

      if (!selectedText) {
        vscode.window.showWarningMessage(i18n.addToContextNoSelection);
        return;
      }

      // Get file info for context
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const languageId = editor.document.languageId;
      
      // Get line numbers (1-based for display)
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;
      const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;

      // Format as file path with line numbers, followed by markdown code block
      const contextText = `${filePath}:${lineRange}\n\`\`\`${languageId}\n${selectedText}\n\`\`\``;

      // Send to webview and reveal the panel
      chatViewProvider?.addTextToInput(contextText);

      // Focus the chat panel
      vscode.commands.executeCommand('openchamber.focusChat');
    })
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
      const mentionPaths: string[] = [];
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

        const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/').trim();
        if (!relativePath) {
          skippedEntries.push(uri.fsPath || uri.toString());
          continue;
        }
        mentionPaths.push(relativePath);
      }

      if (mentionPaths.length === 0) {
        vscode.window.showWarningMessage(i18n.noFileSelectedToMention);
        return;
      }

      await vscode.commands.executeCommand('openchamber.openSidebar');
      await new Promise((resolve) => setTimeout(resolve, 80));
      chatViewProvider?.addFileMentions(mentionPaths);

      if (skippedEntries.length > 0) {
          vscode.window.showInformationMessage(i18n.skippedEntries);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.explain', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(i18n.explainNoActiveEditor);
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
        prompt = i18n.explainPromptWithSelection(filePath, lineRange, languageId, selectedText);
      } else {
        // No selection - explain the entire file
        prompt = i18n.explainPromptWithoutSelection(filePath);
      }

      // Create new session and send the prompt
      chatViewProvider?.createNewSessionWithPrompt(prompt);
      vscode.commands.executeCommand('openchamber.focusChat');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.improveCode', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(i18n.improveNoActiveEditor);
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);

      if (!selectedText) {
        vscode.window.showWarningMessage(i18n.improveNoSelection);
        return;
      }

      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const languageId = editor.document.languageId;
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;
      const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;

      const prompt = i18n.improvePrompt(filePath, lineRange, languageId, selectedText);

      // Create new session and send the prompt
      chatViewProvider?.createNewSessionWithPrompt(prompt);
      vscode.commands.executeCommand('openchamber.focusChat');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.newSession', () => {
      chatViewProvider?.createNewSession();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.showSettings', () => {
      chatViewProvider?.showSettings();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.showOpenCodeStatus', async () => {
      const config = vscode.workspace.getConfiguration('openchamber');
      const configuredApiUrl = (config.get<string>('apiUrl') || '').trim();

      const extensionVersion = String(context.extension?.packageJSON?.version || '');
      const workspaceFolders = (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
      const primaryWorkspace = workspaceFolders[0] || '';

      const debug = openCodeManager?.getDebugInfo();
      const resolvedApiUrl = openCodeManager?.getApiUrl();
      const workingDirectory = openCodeManager?.getWorkingDirectory() ?? '';
      const workingDirectoryMatchesWorkspace = Boolean(primaryWorkspace && workingDirectory === primaryWorkspace);
      let resolvedApiPath = '';
      if (resolvedApiUrl) {
        try {
          resolvedApiPath = new URL(resolvedApiUrl).pathname || '/';
        } catch {
          resolvedApiPath = '(invalid url)';
        }
      }

      const safeFetch = async (input: string, timeoutMs = 6000) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const startedAt = Date.now();
        const openCodeAuthHeaders = openCodeManager?.getOpenCodeAuthHeaders() || {};
        try {
          const resp = await fetch(input, {
            method: 'GET',
            headers: { Accept: 'application/json', ...openCodeAuthHeaders },
            signal: controller.signal,
          });
          const elapsedMs = Date.now() - startedAt;
          const contentType = resp.headers.get('content-type') || '';
          const isJson = contentType.toLowerCase().includes('json') && !contentType.toLowerCase().includes('text/html');

          let summary = '';
          if (isJson) {
            const json = await resp.json().catch(() => null);
            if (Array.isArray(json)) {
              summary = `json[array] len=${json.length}`;
            } else if (json && typeof json === 'object') {
              const keys = Object.keys(json).slice(0, 8);
              summary = `json[object] keys=${keys.join(',')}${Object.keys(json).length > keys.length ? ',…' : ''}`;
            } else {
              summary = `json[${typeof json}]`;
            }
          } else {
            summary = contentType ? `content-type=${contentType}` : 'no content-type';
          }

          return { ok: resp.ok && isJson, status: resp.status, elapsedMs, summary };
        } catch (error) {
          const elapsedMs = Date.now() - startedAt;
          const isAbort =
            controller.signal.aborted ||
            (error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted')));
          const message = isAbort
            ? `timeout after ${timeoutMs}ms`
            : error instanceof Error
              ? error.message
              : String(error);
          return { ok: false, status: 0, elapsedMs, summary: `error=${message}` };
        } finally {
          clearTimeout(timeout);
        }
      };

      const buildProbeUrl = (pathname: string, includeDirectory = true) => {
        if (!resolvedApiUrl) return null;
        const base = `${resolvedApiUrl.replace(/\/+$/, '')}/`;
        const url = new URL(pathname.replace(/^\/+/, ''), base);
        if (includeDirectory && workingDirectory) {
          url.searchParams.set('directory', workingDirectory);
        }
        return url.toString();
      };

      const probeTargets: Array<{ label: string; path: string; includeDirectory?: boolean; timeoutMs?: number }> = [
        { label: 'health', path: '/global/health', includeDirectory: false },
        { label: 'config', path: '/config', includeDirectory: true },
        { label: 'providers', path: '/config/providers', includeDirectory: true },
        // Can be slower on large configs; keep the probe from producing false negatives.
        { label: 'agents', path: '/agent', includeDirectory: true, timeoutMs: 12000 },
        { label: 'commands', path: '/command', includeDirectory: true, timeoutMs: 10000 },
        { label: 'project', path: '/project/current', includeDirectory: true },
        { label: 'path', path: '/path', includeDirectory: true },
        // Session listing is what powers the sidebar. This helps diagnose "no sessions shown" bugs.
        { label: 'sessions', path: '/session', includeDirectory: true, timeoutMs: 12000 },
        { label: 'sessionStatus', path: '/session/status', includeDirectory: true },
      ];

      const probes = resolvedApiUrl
        ? await Promise.all(
            probeTargets.map(async (entry) => {
              const url = buildProbeUrl(entry.path, entry.includeDirectory !== false);
              if (!url) {
                return { label: entry.label, url: '(none)', result: null as null };
              }
              const result = await safeFetch(url, typeof entry.timeoutMs === 'number' ? entry.timeoutMs : undefined);
              return { label: entry.label, url, result };
            })
          )
        : [];

      const storedSettings = context.globalState.get<Record<string, unknown>>(SETTINGS_KEY) || {};
      const settingsKeys = Object.keys(storedSettings).filter((key) => key !== 'lastDirectory');

      const lines = [
        `Time: ${new Date().toISOString()}`,
        `OpenChamber version: ${extensionVersion || '(unknown)'}`,
        `OpenCode Version: ${debug?.version ?? '(unknown)'}`,
        `VS Code version: ${vscode.version}`,
        `Platform: ${process.platform} ${process.arch}`,
        `Workspace folders: ${workspaceFolders.length}${workspaceFolders.length ? ` (${workspaceFolders.join(', ')})` : ''}`,
        `Status: ${openCodeManager?.getStatus() ?? 'unknown'}`,
        `Working directory: ${workingDirectory}`,
        `Working dir matches workspace: ${workingDirectoryMatchesWorkspace ? 'yes' : 'no'}`,
        `API URL (configured): ${configuredApiUrl || '(none)'}`,
        `OpenCode binary (configured): ${(vscode.workspace.getConfiguration('openchamber').get<string>('opencodeBinary') || '').trim() || '(none)'}`,
        `API URL (resolved): ${openCodeManager?.getApiUrl() ?? '(none)'}`,
        `API URL path: ${resolvedApiPath || '(none)'}`,
        debug
          ? `OpenCode server URL: ${debug.serverUrl ?? '(none)'}`
          : `OpenCode server URL: (unknown)`,
        debug
          ? `OpenCode mode: ${debug.mode} (starts=${debug.startCount}, restarts=${debug.restartCount})`
          : `OpenCode mode: (unknown)`,
        debug
          ? `Secure OpenCode connection: ${debug.secureConnection ? 'true' : 'false'}`
          : `Secure OpenCode connection: (unknown)`,
        debug
          ? `OpenCode auth source: ${debug.authSource ?? '(none)'}`
          : `OpenCode auth source: (unknown)`,
        debug
          ? `OpenCode CLI path: ${debug.cliPath || '(not found)'}`
          : `OpenCode CLI path: (unknown)`,
        debug
          ? `OpenCode detected port: ${debug.detectedPort ?? '(none)'}`
          : `OpenCode detected port: (unknown)`,
        debug
          ? `OpenCode API prefix: ${debug.apiPrefixDetected ? (debug.apiPrefix || '(root)') : '(unknown)'}`
          : `OpenCode API prefix: (unknown)`,
        debug
          ? `Last start: ${formatIso(debug.lastStartAt)}`
          : `Last start: (unknown)`,
        debug
          ? `Last ready: ${debug.lastReadyElapsedMs !== null ? `${debug.lastReadyElapsedMs}ms` : '(unknown)'}`
          : `Last ready: (unknown)`,
        debug
          ? `Ready attempts: ${debug.lastReadyAttempts ?? '(unknown)'}`
          : `Ready attempts: (unknown)`,
        debug
          ? `Start attempts: ${debug.lastStartAttempts ?? '(unknown)'}`
          : `Start attempts: (unknown)`,
        debug
          ? `Last connected: ${formatIso(debug.lastConnectedAt)}`
          : `Last connected: (unknown)`,
        debug && debug.lastConnectedAt ? `Connected for: ${formatDurationMs(Date.now() - debug.lastConnectedAt)}` : `Connected for: (n/a)`,
        debug && debug.lastExitCode !== null ? `Last exit code: ${debug.lastExitCode}` : `Last exit code: (none)`,
        debug?.lastError ? `Last error: ${debug.lastError}` : `Last error: (none)`,
        `Settings keys (stored): ${settingsKeys.length ? settingsKeys.join(', ') : '(none)'}`,
        probes.length ? '' : '',
        ...(probes.length
          ? [
              'OpenCode API probes:',
              ...probes.map((probe) => {
                if (!probe.result) return `- ${probe.label}: (no url)`;
                const { ok, status, elapsedMs, summary } = probe.result;
                const suffix = ok ? '' : ` url=${probe.url}`;
                return `- ${probe.label}: ${ok ? 'ok' : 'fail'} status=${status} time=${elapsedMs}ms ${summary}${suffix}`;
              }),
            ]
          : []),
        '',
      ];

      outputChannel?.appendLine(lines.join('\n'));
      outputChannel?.show(true);
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme((theme) => {
      chatViewProvider?.updateTheme(theme.kind);
      agentManagerProvider?.updateTheme(theme.kind);
      sessionEditorProvider?.updateTheme(theme.kind);
    })
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
    })
  );

  // Subscribe to status changes - this broadcasts to webview
  context.subscriptions.push(
    openCodeManager.onStatusChange((status, error) => {
      chatViewProvider?.updateConnectionStatus(status, error);
      agentManagerProvider?.updateConnectionStatus(status, error);
      sessionEditorProvider?.updateConnectionStatus(status, error);

      // Start/stop global event watcher based on connection status
      // Mirrors web server and desktop Tauri behavior
      if (status === 'connected' && chatViewProvider && openCodeManager) {
        setChatViewProvider(chatViewProvider);
        void startGlobalEventWatcher(openCodeManager, chatViewProvider);
      } else if (status === 'disconnected' || status === 'error') {
        stopGlobalEventWatcher();
      }
    })
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

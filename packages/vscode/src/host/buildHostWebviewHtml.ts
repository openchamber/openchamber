import * as vscode from 'vscode';
import { normalizeWindowsDriveLetter } from '../pathUtils';
import { resolveWorkspaceFolders } from '../workspaceResolver';
import { getWebviewHtml, type WebviewHtmlOptions } from '../webviewHtml';
import { resolveWebviewDevServerUrl } from '../webviewDevServer';
import type { OpenCodeManager } from '../opencode';
import type { ConnectionCache } from './webviewMessaging';

type BuildHtmlArgs = {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  context: vscode.ExtensionContext;
  manager?: OpenCodeManager;
  cache: ConnectionCache;
  devServerUrl: string | null;
} & Pick<WebviewHtmlOptions, 'panelType' | 'viewMode' | 'initialSessionId'>;

export const resolveHostDevServerUrl = (context: vscode.ExtensionContext): string | null =>
  resolveWebviewDevServerUrl(context);

export const buildHostWebviewHtml = (args: BuildHtmlArgs): string => {
  const workspaceFolder = normalizeWindowsDriveLetter(
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
  );
  const workspaceFolders = resolveWorkspaceFolders(vscode.workspace.workspaceFolders ?? []);
  const cliAvailable = args.manager?.isCliAvailable() ?? false;

  return getWebviewHtml({
    webview: args.webview,
    extensionUri: args.extensionUri,
    workspaceFolder,
    workspaceFolders,
    initialStatus: args.cache.status,
    cliAvailable,
    panelType: args.panelType,
    viewMode: args.viewMode,
    initialSessionId: args.initialSessionId,
    extensionVersion: String(args.context.extension?.packageJSON?.version || ''),
    devServerUrl: args.devServerUrl,
  });
};

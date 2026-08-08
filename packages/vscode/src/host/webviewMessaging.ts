import * as vscode from 'vscode';
import { getThemeKindName } from '../theme';
import { getWebviewShikiThemes } from '../shikiThemes';
import type { ConnectionStatus, OpenCodeManager } from '../opencode';

export type ConnectionCache = {
  status: ConnectionStatus;
  error?: string;
};

export const postConnectionStatus = (
  webview: vscode.Webview,
  cache: ConnectionCache,
  manager?: OpenCodeManager,
): void => {
  webview.postMessage({
    type: 'connectionStatus',
    status: cache.status,
    error: cache.error,
    cliAvailable: manager?.isCliAvailable() ?? true,
  });
};

export const postThemeChange = (webview: vscode.Webview, kind: vscode.ColorThemeKind): void => {
  const themeKind = getThemeKindName(kind);
  void getWebviewShikiThemes().then((shikiThemes) => {
    webview.postMessage({
      type: 'themeChange',
      theme: { kind: themeKind, shikiThemes },
    });
  });
};

export const postWindowFocus = (webview: vscode.Webview, focused: boolean): void => {
  webview.postMessage({
    type: 'command',
    command: 'windowFocusChanged',
    payload: { focused },
  });
};

export const postHostCommand = (webview: vscode.Webview, command: string, payload?: unknown): void => {
  webview.postMessage({
    type: 'command',
    command,
    payload,
  });
};

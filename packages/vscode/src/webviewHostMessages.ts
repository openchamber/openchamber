import * as vscode from 'vscode';
import { getThemeKindName } from './theme';
import { getWebviewShikiThemes } from './shikiThemes';
import type { ConnectionStatus } from './opencode';

export type WebviewPoster = {
  postMessage(message: unknown): Thenable<boolean> | boolean | void;
};

export const postThemeChange = (targets: Iterable<WebviewPoster>, kind: vscode.ColorThemeKind): void => {
  const themeKind = getThemeKindName(kind);
  void getWebviewShikiThemes().then((shikiThemes) => {
    for (const target of targets) {
      target.postMessage({
        type: 'themeChange',
        theme: { kind: themeKind, shikiThemes },
      });
    }
  });
};

const postConnectionStatus = (
  targets: Iterable<WebviewPoster>,
  status: ConnectionStatus,
  error?: string,
): void => {
  for (const target of targets) {
    target.postMessage({
      type: 'connectionStatus',
      status,
      error,
    });
  }
};

export const postWindowFocusChanged = (targets: Iterable<WebviewPoster>, focused: boolean): void => {
  for (const target of targets) {
    target.postMessage({
      type: 'command',
      command: 'windowFocusChanged',
      payload: { focused },
    });
  }
};

export const postSettingsSynced = (targets: Iterable<WebviewPoster>, settings: unknown): void => {
  for (const target of targets) {
    target.postMessage({
      type: 'command',
      command: 'settingsSynced',
      payload: settings,
    });
  }
};

export const postPermissionAutoAcceptSynced = (targets: Iterable<WebviewPoster>, snapshot: unknown): void => {
  for (const target of targets) {
    target.postMessage({
      type: 'command',
      command: 'permissionAutoAcceptSynced',
      payload: snapshot,
    });
  }
};

export const postWebviewCommand = (
  targets: Iterable<WebviewPoster>,
  command: string,
  payload?: unknown,
): void => {
  for (const target of targets) {
    target.postMessage({
      type: 'command',
      command,
      ...(payload !== undefined ? { payload } : {}),
    });
  }
};

export const syncConnectionAndFocus = (
  targets: Iterable<WebviewPoster>,
  status: ConnectionStatus,
  error?: string,
): void => {
  const list = Array.from(targets);
  postConnectionStatus(list, status, error);
  postWindowFocusChanged(list, vscode.window.state.focused);
};

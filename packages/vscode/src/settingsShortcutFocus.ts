import * as vscode from 'vscode';
import { z } from 'zod';

const focusSchema = z.object({ focused: z.boolean() });
let focusedWebview: vscode.Webview | null = null;

export const clearSettingsShortcutFocus = (webview: vscode.Webview): void => {
  if (focusedWebview !== webview) return;
  focusedWebview = null;
  void vscode.commands.executeCommand('setContext', 'openchamber.settingsShortcutTarget', '');
};

/** The host stamps the sender's kind; a late blur can release only its owner. */
export const handleSettingsShortcutFocus = (
  message: { type: string; payload?: unknown },
  webview: vscode.Webview,
  kind: 'chat' | 'settings',
): boolean => {
  if (message.type !== 'webview:settings-focus') return false;
  const focus = focusSchema.safeParse(message.payload);
  if (!focus.success) return true;
  if (!focus.data.focused) {
    clearSettingsShortcutFocus(webview);
    return true;
  }
  focusedWebview = webview;
  void vscode.commands.executeCommand('setContext', 'openchamber.settingsShortcutTarget', kind);
  return true;
};

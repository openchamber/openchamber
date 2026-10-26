import * as vscode from 'vscode';

const DEFAULT_WEBVIEW_DEV_SERVER_URL = 'http://localhost:5173';

const normalizeUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
};

export const resolveWebviewDevServerUrl = (context: vscode.ExtensionContext): string | null => {
  if (context.extensionMode !== vscode.ExtensionMode.Development) {
    return null;
  }

  if (process.env.OPENCHAMBER_DISABLE_WEBVIEW_HMR === '1') {
    return null;
  }

  const configured = normalizeUrl(process.env.OPENCHAMBER_VSCODE_WEBVIEW_URL ?? '');
  if (configured) {
    return configured;
  }

  return DEFAULT_WEBVIEW_DEV_SERVER_URL;
};

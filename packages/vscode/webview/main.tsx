import { createVSCodeAPIs } from './api';
import { onThemeChange } from './api/bridge';
import {
  buildVSCodeThemeFromPalette,
  readVSCodeThemePalette,
  type VSCodeThemeKind,
  type VSCodeThemePayload,
} from '@openchamber/ui/lib/theme/vscode/adapter';
import { getBootstrapMessages, readStoredLocaleForBootstrap } from '@openchamber/ui/lib/i18n';
import type { RuntimeAPIs } from '@openchamber/ui/lib/api/types';
import { createLoadingOverlayController } from './loadingOverlay';
import { installFetchInterceptor } from './fetchInterceptor';
import { registerWebviewCommandHandlers } from './commandHandlers';
import { registerWebviewNotifications } from './notifications';

type ConnectionStatus = 'connecting' | 'connected' | 'error' | 'disconnected';
type PanelType = 'chat' | 'agentManager';

declare const __OPENCHAMBER_WEBVIEW_BUILD_TIME__: string;

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
    __VSCODE_CONFIG__?: {
      apiUrl?: string;
      workspaceFolder: string;
      workspaceFolders?: Array<{ name: string; path: string }>;
      theme: string;
      connectionStatus: string;
      cliAvailable?: boolean;
      extensionVersion?: string;
      platform?: string;
      arch?: string;
      panelType?: PanelType;
      viewMode?: 'sidebar' | 'editor';
      initialSessionId?: string | null;
    };
    __OPENCHAMBER_VSCODE_THEME__?: VSCodeThemePayload['theme'];
    __OPENCHAMBER_VSCODE_SHIKI_THEMES__?: { light?: Record<string, unknown>; dark?: Record<string, unknown> } | null;
    __OPENCHAMBER_CONNECTION__?: { status: ConnectionStatus; error?: string; cliAvailable?: boolean };
    __OPENCHAMBER_HOME__?: string;
    __OPENCHAMBER_PANEL_TYPE__?: PanelType;
    __OPENCHAMBER_VSCODE_WINDOW_FOCUSED__?: boolean;
  }
}

console.log('[OpenChamber] VS Code webview starting...');
console.log('[OpenChamber] VS Code webview build:', __OPENCHAMBER_WEBVIEW_BUILD_TIME__);
console.log('[OpenChamber] Config:', window.__VSCODE_CONFIG__);
try {
  if (window.localStorage.getItem('openchamber_stream_debug') === '1') {
    console.log('[OpenChamber] Debug: openchamber_stream_debug=1');
  }
} catch {
  // ignore
}

window.__OPENCHAMBER_RUNTIME_APIS__ = createVSCodeAPIs();

const bootstrapLocale = readStoredLocaleForBootstrap();
const bootstrapMessages = getBootstrapMessages(bootstrapLocale);
const loadingOverlay = createLoadingOverlayController({
  connectionError: bootstrapMessages.connectionError,
  disconnected: bootstrapMessages.disconnected,
});

const bootstrapConnectionStatus = () => {
  const initialStatus = (window.__VSCODE_CONFIG__?.connectionStatus as ConnectionStatus | undefined) || 'connecting';
  const cliAvailable = window.__VSCODE_CONFIG__?.cliAvailable ?? true;
  window.__OPENCHAMBER_CONNECTION__ = { status: initialStatus, cliAvailable };
};

bootstrapConnectionStatus();

// Expose panel type globally for the VS Code app root to conditionally render.
window.__OPENCHAMBER_PANEL_TYPE__ = (window.__VSCODE_CONFIG__?.panelType as PanelType) || 'chat';

const handleConnectionMessage = (event: MessageEvent) => {
  const msg = event.data;
  if (msg?.type === 'connectionStatus') {
    const payload: ConnectionStatus = msg.status;
    const error: string | undefined = msg.error;
    const prevCliAvailable = window.__OPENCHAMBER_CONNECTION__?.cliAvailable ?? true;
    window.__OPENCHAMBER_CONNECTION__ = { status: payload, error, cliAvailable: prevCliAvailable };
    window.dispatchEvent(new CustomEvent('openchamber:connection-status', { detail: { status: payload, error } }));
  }
};

window.addEventListener('message', handleConnectionMessage);
window.addEventListener('openchamber:connection-status', () => {
  loadingOverlay.maybeHideLoadingOverlay();
});

const applyInitialTheme = (theme: { metadata?: { variant?: string }; colors?: { surface?: { background?: string; foreground?: string } } }) => {
  if (typeof document === 'undefined' || !theme) return;
  const variant = theme.metadata?.variant === 'dark' ? 'dark' : 'light';
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(variant);

  const background = theme.colors?.surface?.background;
  if (background) {
    document.body.style.backgroundColor = background;
    let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', background);
  }
};

const emitVSCodeTheme = (preferredKind?: VSCodeThemeKind) => {
  const palette = readVSCodeThemePalette(preferredKind);
  if (!palette) {
    return;
  }
  const theme = buildVSCodeThemeFromPalette(palette);
  window.__OPENCHAMBER_VSCODE_THEME__ = theme;
  applyInitialTheme(theme);
  window.dispatchEvent(new CustomEvent<VSCodeThemePayload>('openchamber:vscode-theme', {
    detail: { theme, palette },
  }));
};

emitVSCodeTheme(window.__VSCODE_CONFIG__?.theme as VSCodeThemeKind | undefined);

const scheduleThemeRecompute = (kind?: VSCodeThemeKind) => {
  // VS Code updates webview CSS variables asynchronously around theme changes.
  // Re-read on the next frames so we don't snapshot the old palette.
  requestAnimationFrame(() => {
    emitVSCodeTheme(kind);
    requestAnimationFrame(() => emitVSCodeTheme(kind));
  });
};

onThemeChange((payload) => {
  const kind = (typeof payload === 'string'
    ? payload
    : typeof payload === 'object' && payload
      ? payload.kind
      : undefined) as VSCodeThemeKind | undefined;

  if (typeof payload === 'object' && payload?.shikiThemes !== undefined) {
    window.__OPENCHAMBER_VSCODE_SHIKI_THEMES__ = payload.shikiThemes;
    window.dispatchEvent(
      new CustomEvent('openchamber:vscode-shiki-themes', {
        detail: { shikiThemes: payload.shikiThemes },
      }),
    );
  }

  scheduleThemeRecompute(kind);
});

const workspaceFolder = window.__VSCODE_CONFIG__?.workspaceFolder;
if (workspaceFolder) {
  const normalizeWorkspacePath = (value: string) => {
    const normalized = value
      .replace(/\\/g, '/')
      .replace(/^([a-z]):\//, (_, letter: string) => `${letter.toUpperCase()}:/`)
      .replace(/^\/([a-z]):\//, (_, letter: string) => `/${letter.toUpperCase()}:/`);
    if (normalized === '/') {
      return '/';
    }
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
  };

  const normalizedWorkspaceFolder = normalizeWorkspacePath(workspaceFolder);
  window.__OPENCHAMBER_HOME__ = normalizedWorkspaceFolder;
  try {
    window.localStorage.setItem('lastDirectory', normalizedWorkspaceFolder);
    window.localStorage.setItem('homeDirectory', normalizedWorkspaceFolder);

    // VS Code defaults: show dotfiles, hide gitignored
    if (window.localStorage.getItem('directoryTreeShowHidden') === null) {
      window.localStorage.setItem('directoryTreeShowHidden', 'true');
    }
    if (window.localStorage.getItem('filesViewShowGitignored') === null) {
      window.localStorage.setItem('filesViewShowGitignored', 'false');
    }
  } catch (error) {
    console.warn('Failed to persist workspace folder', error);
  }
}

installFetchInterceptor({
  onLocalResponse: () => loadingOverlay.maybeHideLoadingOverlay(),
});

registerWebviewCommandHandlers();
registerWebviewNotifications();

import('@openchamber/ui/apps/renderVSCodeApp')
  .then(async ({ renderVSCodeApp }) => {
    renderVSCodeApp(window.__OPENCHAMBER_RUNTIME_APIS__ ?? createVSCodeAPIs());
    await loadingOverlay.waitForUiMount();
    loadingOverlay.markUiMounted();
  })
  .catch((error) => {
    console.error('[OpenChamber] Failed to bootstrap UI:', error);
    // If the UI bundle fails to load, remove the overlay so the user at least sees errors in the root.
    loadingOverlay.markUiMounted();
    loadingOverlay.forceHideLoadingScreen();
  });

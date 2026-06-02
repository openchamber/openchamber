import { createVSCodeAPIs } from './api';
import { onCommand, onThemeChange, proxyApiRequest, proxySessionMessageRequest, sendBridgeMessage, startSseProxy, stopSseProxy } from './api/bridge';
import { vscodeStreamPerfCount, vscodeStreamPerfMeasure, vscodeStreamPerfObserve } from './api/streamPerf';
import { extractBodyBase64, extractBodyText, extractJsonBody, hasInitBody } from './requestBodyTransport';
import type { RuntimeAPIs } from '@openchamber/ui/lib/api/types';
import { opencodeClient } from '@openchamber/ui/lib/opencode/client';
import {
  buildVSCodeThemeFromPalette,
  readVSCodeThemePalette,
  type VSCodeThemeKind,
  type VSCodeThemePayload,
} from '@openchamber/ui/lib/theme/vscode/adapter';
import { getBootstrapMessages, readStoredLocaleForBootstrap } from '@openchamber/ui/lib/i18n';
import type { VSCodeActiveEditorFile } from '@/sync/input-store';

type ConnectionStatus = 'connecting' | 'connected' | 'error' | 'disconnected';
type PanelType = 'chat' | 'agentManager';

declare const __OPENCHAMBER_WEBVIEW_BUILD_TIME__: string;

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
    __VSCODE_CONFIG__?: {
      apiUrl?: string;
      workspaceFolder: string;
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
  maybeHideLoadingOverlay();
});

const fadeOutLoadingScreen = () => {
  const loadingEl = document.getElementById('initial-loading');
  if (!loadingEl) return;
  loadingEl.classList.add('fade-out');
  setTimeout(() => {
    try {
      loadingEl.remove();
    } catch {
      // ignore
    }
  }, 300);
};

const setLoadingStatusText = (text: string, variant: 'normal' | 'error' = 'normal') => {
  const statusEl = document.getElementById('loading-status');
  if (!statusEl) return;
  statusEl.textContent = text;
  if (variant === 'error') {
    statusEl.classList.add('error-text');
  } else {
    statusEl.classList.remove('error-text');
  }
};

const waitForUiMount = (timeoutMs = 8000): Promise<boolean> => {
  if (typeof document === 'undefined') return Promise.resolve(false);
  const root = document.getElementById('root');
  if (!root) return Promise.resolve(false);

  const hasContent = () => root.childNodes.length > 0;
  if (hasContent()) return Promise.resolve(true);

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (hasContent()) {
        observer.disconnect();
        clearTimeout(timeout);
        resolve(true);
      }
    });

    observer.observe(root, { childList: true, subtree: true });

    const timeout = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, timeoutMs);
  });
};

let uiMounted = false;
let bootstrapProvidersReady = false;
let bootstrapAgentsReady = false;
let bootstrapFailed = false;

const recordBootstrapFetch = (pathname: string, ok: boolean) => {
  if (!pathname.startsWith('/api/')) return;

  // Don't mark as failed while still connecting — early 503s are expected
  const isConnected = window.__OPENCHAMBER_CONNECTION__?.status === 'connected';

  if (pathname.startsWith('/api/config/providers')) {
    if (ok) {
      bootstrapProvidersReady = true;
      // Reset failed flag — a successful retry supersedes earlier 503s
      if (bootstrapAgentsReady || !isConnected) bootstrapFailed = false;
    } else if (isConnected) {
      bootstrapFailed = true;
    }
    return;
  }

  if (pathname === '/api/agent' || pathname.startsWith('/api/agent?')) {
    if (ok) {
      bootstrapAgentsReady = true;
      if (bootstrapProvidersReady || !isConnected) bootstrapFailed = false;
    } else if (isConnected) {
      bootstrapFailed = true;
    }
  }
};

const maybeHideLoadingOverlay = () => {
  const connectionStatus = window.__OPENCHAMBER_CONNECTION__?.status ?? 'connecting';

  if (!uiMounted) {
    return;
  }

  if (connectionStatus === 'connected') {
    if (bootstrapFailed) {
      setLoadingStatusText(bootstrapMessages.initialDataLoadFailed, 'error');
      fadeOutLoadingScreen();
      return;
    }

    if (bootstrapProvidersReady && bootstrapAgentsReady) {
      fadeOutLoadingScreen();
      return;
    }

    // Still loading providers/agents — stay silent (the animated logo signals work).
    setLoadingStatusText('');
    return;
  }

  if (connectionStatus === 'error') {
    const error = window.__OPENCHAMBER_CONNECTION__?.error;
    setLoadingStatusText(error || bootstrapMessages.connectionError, 'error');
    fadeOutLoadingScreen();
    return;
  }

  if (connectionStatus === 'disconnected') {
    setLoadingStatusText(bootstrapMessages.disconnected, 'error');
    fadeOutLoadingScreen();
    return;
  }

  // Connecting — no jargon; the animated logo conveys progress.
  setLoadingStatusText('');
};

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

const normalizeUrl = (input: string | URL) => {
  try {
    return typeof input === 'string' ? new URL(input, window.location.href) : new URL(input.toString(), window.location.href);
  } catch {
    return null;
  }
};

const headersToRecord = (headers: HeadersInit | undefined): Record<string, string> => {
  if (!headers) return {};
  const normalized = headers instanceof Headers ? headers : new Headers(headers);
  const result: Record<string, string> = {};
  normalized.forEach((value, key) => {
    result[key] = value;
  });
  return result;
};

const getRequestHeaders = (input?: RequestInfo | URL, init?: RequestInit): Record<string, string> => {
  const headersFromRequest = input instanceof Request ? headersToRecord(input.headers) : {};
  const headersFromInit = headersToRecord(init?.headers);
  return { ...headersFromRequest, ...headersFromInit };
};

const getRequestDirectoryHint = (url: URL, input?: RequestInfo | URL, init?: RequestInit): string | undefined => {
  const queryDirectory = url.searchParams.get('directory') || undefined;
  if (queryDirectory) return queryDirectory;
  const headers = getRequestHeaders(input, init);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'x-opencode-directory') return value;
  }
  return undefined;
};

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};

const unsupportedWebRouteResponse = (feature: string): Response => {
  return jsonResponse({ error: `${feature} is not supported in VS Code` }, 501);
};

const pluginConfigErrorStatus = (message: string): number => {
  const lower = message.toLowerCase();
  if (lower.includes('already exists')) return 409;
  if (lower.includes('not found')) return 404;
  if (lower.includes('required') || lower.includes('invalid') || lower.includes('must ')) return 400;
  return 500;
};

const isNullBodyStatus = (status: number): boolean => status === 204 || status === 205 || status === 304;

const buildProxiedResponse = (
  proxied: { status: number; headers: Record<string, string>; bodyBase64?: string; bodyText?: string }
): Response => {
  if (isNullBodyStatus(proxied.status)) {
    return new Response(null, { status: proxied.status, headers: proxied.headers });
  }

  if (typeof proxied.bodyText === 'string') {
    return new Response(proxied.bodyText, { status: proxied.status, headers: proxied.headers });
  }

  const body = proxied.bodyBase64 ? decodeBase64(proxied.bodyBase64) : new Uint8Array();
  return new Response(body, { status: proxied.status, headers: proxied.headers });
};

const isSseApiPath = (pathname: string) => pathname === '/api/event' || pathname === '/api/global/event';
const isSessionMessageApiPath = (pathname: string) => /^\/api\/session\/[^/]+\/message$/.test(pathname);
const isApiPath = (pathname: string) => pathname === '/api' || pathname.startsWith('/api/');
const isLocalRuntimePath = (pathname: string) => isApiPath(pathname) || pathname === '/auth/session';

const handleLocalApiRequest = async (input: RequestInfo | URL, url: URL, init: RequestInit | undefined, method: string) => {
  const pathname = url.pathname;
  const normalizedPathname = pathname !== '/' ? pathname.replace(/\/+$/, '') : pathname;

  if (normalizedPathname === '/api/system/info' && method === 'GET') {
    const config = window.__VSCODE_CONFIG__;
    return jsonResponse({
      openchamberVersion: config?.extensionVersion || 'VS Code Extension',
      runtime: 'vscode',
      platform: config?.platform || '',
      arch: config?.arch || '',
    });
  }

  if (normalizedPathname === '/api/preview/targets') {
    return unsupportedWebRouteResponse('Preview proxy');
  }

  if (normalizedPathname.startsWith('/api/openchamber/tunnel/')) {
    return unsupportedWebRouteResponse('Remote tunnel settings');
  }

  if (/^\/api\/projects\/[^/]+\/scheduled-tasks(?:\/[^/]+)?$/.test(normalizedPathname)) {
    return unsupportedWebRouteResponse('Scheduled tasks');
  }

  if (normalizedPathname === '/api/sessions/snapshot' && method === 'GET') {
    const activity = await sendBridgeMessage<Record<string, { type: 'idle' | 'busy' | 'cooldown' }>>('api:session-activity:get')
      .catch(() => ({}));
    return new Response(
      JSON.stringify({
        statusSessions: {},
        attentionSessions: {},
        activitySessions: activity || {},
        serverTime: Date.now(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  if (/^\/api\/sessions\/[^/]+\/(view|unview)$/.test(normalizedPathname) && method === 'POST') {
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (normalizedPathname === '/api/notifications/auto-accept' && method === 'POST') {
    const bodyText = await extractBodyText(url, init, method);
    const body = bodyText
      ? JSON.parse(bodyText) as { sessionId?: unknown; enabled?: unknown }
      : {};
    const result = await sendBridgeMessage<{ success?: boolean }>('api:notifications/auto-accept', body)
      .catch(() => ({ success: false }));
    return new Response(JSON.stringify(result), {
      status: result?.success === false ? 400 : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (/^\/api\/sessions\/[^/]+\/message-sent$/.test(normalizedPathname) && method === 'POST') {
    const sessionId = normalizedPathname.split('/')[3] || '';
    return new Response(
      JSON.stringify({
        success: true,
        sessionId,
        messageSent: true,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  if (normalizedPathname === '/api/session-activity' && method === 'GET') {
    const activity = await sendBridgeMessage<Record<string, { type: 'idle' | 'busy' | 'cooldown' }>>('api:session-activity:get')
      .catch(() => ({}));
    return new Response(JSON.stringify(activity || {}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (normalizedPathname === '/api/sessions/status' && method === 'GET') {
    return new Response(
      JSON.stringify({
        sessions: {},
        serverTime: Date.now(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  if (normalizedPathname === '/api/sessions/attention' && method === 'GET') {
    return new Response(
      JSON.stringify({
        sessions: {},
        serverTime: Date.now(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  if (/^\/api\/sessions\/[^/]+\/status$/.test(normalizedPathname) && method === 'GET') {
    const sessionId = normalizedPathname.split('/')[3] || '';
    return new Response(
      JSON.stringify({
        error: 'Session not found or no state available',
        sessionId,
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  if (/^\/api\/sessions\/[^/]+\/attention$/.test(normalizedPathname) && method === 'GET') {
    const sessionId = normalizedPathname.split('/')[3] || '';
    return new Response(
      JSON.stringify({
        error: 'Session not found or no attention state available',
        sessionId,
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  if (normalizedPathname === '/api/tts/status' && method === 'GET') {
    return new Response(JSON.stringify({ available: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (normalizedPathname === '/api/tts/say/status' && method === 'GET') {
    return new Response(JSON.stringify({ available: false, voices: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if ((pathname === '/api/tts/speak' || pathname === '/api/tts/say/speak') && method === 'POST') {
    return new Response(JSON.stringify({ error: 'TTS endpoints are not available in VS Code runtime' }), {
      status: 501,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Health endpoints: reflect actual connection status
  if (pathname === '/health' || pathname === '/api/health') {
    const connectionStatus = window.__OPENCHAMBER_CONNECTION__?.status;
    const isReady = connectionStatus === 'connected';
    const cliAvailable = window.__OPENCHAMBER_CONNECTION__?.cliAvailable ?? true;
    return new Response(JSON.stringify({ 
      status: isReady ? 'ok' : 'connecting', 
      isOpenCodeReady: isReady,
      cliAvailable,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (pathname.startsWith('/api/fs/list')) {
    const targetPath = url.searchParams.get('path') || '';
    const respectGitignore = url.searchParams.get('respectGitignore') === 'true';
    const data = await sendBridgeMessage('api:fs:list', { path: targetPath, respectGitignore });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/fs/mkdir')) {
    const body = await extractJsonBody(input, init, method);
    const data = await sendBridgeMessage('api:fs:mkdir', { path: body.path });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/fs/home')) {
    const data = await sendBridgeMessage('api:fs/home');
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/vscode/pick-files')) {
    const data = await sendBridgeMessage('api:files/pick');
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/vscode/drop-files') && method === 'POST') {
    const body = await extractJsonBody(input, init, method);
    const uris = Array.isArray((body as { uris?: unknown[] }).uris)
      ? (body as { uris: unknown[] }).uris.filter((value): value is string => typeof value === 'string')
      : [];
    const data = await sendBridgeMessage('api:files/drop', { uris });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/vscode/save-image') && method === 'POST') {
    const body = await extractJsonBody(input, init, method);
    const fileName = typeof (body as { fileName?: unknown }).fileName === 'string'
      ? (body as { fileName: string }).fileName
      : undefined;
    const dataUrl = typeof (body as { dataUrl?: unknown }).dataUrl === 'string'
      ? (body as { dataUrl: string }).dataUrl
      : undefined;
    const data = await sendBridgeMessage('api:files/save-image', { fileName, dataUrl });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/vscode/save-markdown') && method === 'POST') {
    const body = await extractJsonBody(input, init, method);
    const fileName = typeof (body as { fileName?: unknown }).fileName === 'string'
      ? (body as { fileName: string }).fileName
      : undefined;
    const content = typeof (body as { content?: unknown }).content === 'string'
      ? (body as { content: string }).content
      : undefined;
    const data = await sendBridgeMessage('api:files/save-markdown', { fileName, content });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/config/agents/')) {
    const encodedName = pathname.slice('/api/config/agents/'.length);
    const name = decodeURIComponent(encodedName);
    const verb = method;
    const body = await extractJsonBody(input, init, method);
    const directory = getRequestDirectoryHint(url, input, init);
    try {
      const data = await sendBridgeMessage('api:config/agents', { method: verb, name, body, directory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/config/commands/')) {
    const encodedName = pathname.slice('/api/config/commands/'.length);
    const name = decodeURIComponent(encodedName);
    const verb = method;
    const body = await extractJsonBody(input, init, method);
    const directory = getRequestDirectoryHint(url, input, init);
    try {
      const data = await sendBridgeMessage('api:config/commands', { method: verb, name, body, directory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/api/config/mcp') {
    const verb = method;
    const body = await extractJsonBody(input, init, method);
    const directory = getRequestDirectoryHint(url, input, init);
    try {
      const data = await sendBridgeMessage('api:config/mcp', { method: verb, body, directory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/config/mcp/')) {
    const encodedName = pathname.slice('/api/config/mcp/'.length);
    const name = decodeURIComponent(encodedName);
    const verb = method;
    const body = await extractJsonBody(input, init, method);
    const directory = getRequestDirectoryHint(url, input, init);
    try {
      const data = await sendBridgeMessage('api:config/mcp', { method: verb, name, body, directory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/api/config/snippets') {
    const verb = method;
    const directory = getRequestDirectoryHint(url, input, init);
    try {
      const data = await sendBridgeMessage('api:config/snippets', { method: verb, directory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/api/config/snippets/expand') {
    const verb = method === 'GET' && !hasInitBody(init) && !(input instanceof Request) ? 'POST' : method;
    const body = await extractJsonBody(input, init, method);
    const directory = getRequestDirectoryHint(url, input, init);
    try {
      const data = await sendBridgeMessage('api:config/snippets', { method: verb, body, directory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/config/snippets/')) {
    const encodedName = pathname.slice('/api/config/snippets/'.length);
    const name = decodeURIComponent(encodedName);
    const verb = method;
    const body = await extractJsonBody(input, init, method);
    const directory = getRequestDirectoryHint(url, input, init);
    try {
      const data = await sendBridgeMessage('api:config/snippets', { method: verb, name, body, directory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Skills file operations: /api/config/skills/:name/files/:filePath
  const skillsFilesMatch = pathname.match(/^\/api\/config\/skills\/([^/]+)\/files\/(.+)$/);
  if (skillsFilesMatch) {
    const name = decodeURIComponent(skillsFilesMatch[1]);
    const filePath = decodeURIComponent(skillsFilesMatch[2]);
    const verb = method;
    const body = await extractJsonBody(input, init, method);
    try {
      const data = await sendBridgeMessage('api:config/skills/files', { 
        method: verb, 
        name, 
        filePath, 
        content: body.content 
      });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  const skillsCatalogStatusFromPayload = (payload: unknown): number => {
    if (!payload || typeof payload !== 'object') return 200;
    const data = payload as { ok?: boolean; error?: { kind?: string } };
    if (data.ok === false) {
      const kind = data.error?.kind;
      if (kind === 'conflicts') return 409;
      if (kind === 'authRequired') return 401;
      return 400;
    }
    return 200;
  };

  // Skills catalog: /api/config/skills/catalog
  if (pathname === '/api/config/skills/catalog') {
    const refresh = url.searchParams.get('refresh') === 'true';
    try {
      const data = await sendBridgeMessage('api:config/skills:catalog', { refresh });
      return new Response(JSON.stringify(data), { status: skillsCatalogStatusFromPayload(data), headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ ok: false, error: { kind: 'unknown', message } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Skills scan: /api/config/skills/scan
  if (pathname === '/api/config/skills/scan') {
    const body = await extractJsonBody(input, init, method);
    try {
      const data = await sendBridgeMessage('api:config/skills:scan', body);
      return new Response(JSON.stringify(data), { status: skillsCatalogStatusFromPayload(data), headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ ok: false, error: { kind: 'unknown', message } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Skills install: /api/config/skills/install
  if (pathname === '/api/config/skills/install') {
    const body = await extractJsonBody(input, init, method);
    try {
      const data = await sendBridgeMessage('api:config/skills:install', body);
      return new Response(JSON.stringify(data), { status: skillsCatalogStatusFromPayload(data), headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ ok: false, error: { kind: 'unknown', message } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Skills CRUD: /api/config/skills/:name or /api/config/skills
  if (pathname === '/api/config/skills') {
    try {
      const data = await sendBridgeMessage('api:config/skills', { method: 'GET' });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/config/skills/')) {
    const encodedName = pathname.slice('/api/config/skills/'.length);
    const name = decodeURIComponent(encodedName);
    const verb = method;
    const body = await extractJsonBody(input, init, method);
    try {
      const data = await sendBridgeMessage('api:config/skills', { method: verb, name, body });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/config/settings')) {
    if (method === 'GET') {
      const settings = await sendBridgeMessage('api:config/settings:get');
      return new Response(JSON.stringify(settings), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const body = await extractJsonBody(input, init, method);
    const updated = await sendBridgeMessage('api:config/settings:save', body);
    return new Response(JSON.stringify(updated), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (normalizedPathname === '/api/behavior/agents-md') {
    if (method === 'GET') {
      const data = await sendBridgeMessage('api:behavior/agents-md:get');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'PUT') {
      const body = await extractJsonBody(input, init, method);
      const data = await sendBridgeMessage('api:behavior/agents-md:save', body);
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/api/magic-prompts') {
    if (method === 'GET') {
      const data = await sendBridgeMessage('api:magic-prompts:get');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'DELETE') {
      const data = await sendBridgeMessage('api:magic-prompts:reset-all');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/magic-prompts/')) {
    const id = decodeURIComponent(pathname.slice('/api/magic-prompts/'.length));
    if (method === 'PUT') {
      const body = await extractJsonBody(input, init, method);
      const data = await sendBridgeMessage('api:magic-prompts:save', { id, text: body?.text });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'DELETE') {
      const data = await sendBridgeMessage('api:magic-prompts:reset', { id });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/api/config/opencode-resolution' && method === 'GET') {
    try {
      const data = await sendBridgeMessage('api:config/opencode-resolution:get');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/config/reload')) {
    await sendBridgeMessage('api:config/reload');
    return new Response(JSON.stringify({ restarted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname === '/api/config/plugins' && method === 'GET') {
    try {
      const directory = getRequestDirectoryHint(url, input, init);
      const data = await sendBridgeMessage('api:config/plugins', { method, target: 'list', directory });
      return jsonResponse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: message }, pluginConfigErrorStatus(message));
    }
  }

  if (pathname === '/api/config/plugins/registry' && method === 'GET') {
    try {
      const rawSpecs = url.searchParams.get('specs') || '';
      const specs = rawSpecs ? rawSpecs.split(',').map((spec) => spec.trim()).filter(Boolean) : [];
      const directory = getRequestDirectoryHint(url, input, init);
      const data = await sendBridgeMessage('api:config/plugins', {
        method,
        target: 'registry',
        specs,
        refresh: url.searchParams.get('refresh') === 'true',
        directory,
      });
      return jsonResponse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: message }, pluginConfigErrorStatus(message));
    }
  }

  if (pathname === '/api/config/plugins/entry' && method === 'POST') {
    try {
      const body = await extractJsonBody(input, init, method);
      const directory = getRequestDirectoryHint(url, input, init);
      const data = await sendBridgeMessage('api:config/plugins', { method, target: 'entry', body, directory });
      return jsonResponse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: message }, pluginConfigErrorStatus(message));
    }
  }

  const pluginEntryMatch = pathname.match(/^\/api\/config\/plugins\/entry\/([^/]+)$/);
  if (pluginEntryMatch) {
    try {
      const body = method === 'GET' || method === 'DELETE' ? undefined : await extractJsonBody(input, init, method);
      const directory = getRequestDirectoryHint(url, input, init);
      const data = await sendBridgeMessage('api:config/plugins', {
        method,
        target: 'entry',
        pluginId: decodeURIComponent(pluginEntryMatch[1]),
        body,
        directory,
      });
      return jsonResponse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: message }, pluginConfigErrorStatus(message));
    }
  }

  if (pathname === '/api/config/plugins/file' && method === 'POST') {
    try {
      const body = await extractJsonBody(input, init, method);
      const directory = getRequestDirectoryHint(url, input, init);
      const data = await sendBridgeMessage('api:config/plugins', { method, target: 'file', body, directory });
      return jsonResponse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: message }, pluginConfigErrorStatus(message));
    }
  }

  const pluginFileMatch = pathname.match(/^\/api\/config\/plugins\/file\/([^/]+)$/);
  if (pluginFileMatch) {
    try {
      const body = method === 'GET' || method === 'DELETE' ? undefined : await extractJsonBody(input, init, method);
      const directory = getRequestDirectoryHint(url, input, init);
      const data = await sendBridgeMessage('api:config/plugins', {
        method,
        target: 'file',
        pluginId: decodeURIComponent(pluginFileMatch[1]),
        body,
        directory,
      });
      return jsonResponse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: message }, pluginConfigErrorStatus(message));
    }
  }

  if (pathname.startsWith('/api/openchamber/models-metadata')) {
    try {
      const data = await sendBridgeMessage('api:models/metadata');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      console.warn('[OpenChamber] Failed to fetch models metadata via bridge, returning empty set:', error);
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/api/zen/models' && method === 'GET') {
    try {
      const data = await sendBridgeMessage('api:zen:models');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message, models: [] }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/openchamber/update-check')) {
    try {
      const currentVersion = url.searchParams.get('currentVersion') || undefined;
      const instanceMode = url.searchParams.get('instanceMode') || 'local';
      const deviceClass = url.searchParams.get('deviceClass') || 'desktop';
      const platform = url.searchParams.get('platform') || window.__VSCODE_CONFIG__?.platform || undefined;
      const arch = url.searchParams.get('arch') || window.__VSCODE_CONFIG__?.arch || undefined;
      const reportUsageRaw = (url.searchParams.get('reportUsage') || 'true').toLowerCase();
      const reportUsage = !(reportUsageRaw === 'false' || reportUsageRaw === '0' || reportUsageRaw === 'no');
      const data = await sendBridgeMessage('api:openchamber:update-check', {
        currentVersion,
        instanceMode,
        deviceClass,
        platform,
        arch,
        reportUsage,
      });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ available: false, error: message }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/auth/session') {
    // VS Code host is trusted; mirror web server shape to keep UI logic happy
    const body = {
      authenticated: true,
      requireSetup: false,
      authenticatedAt: Date.now(),
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/opencode/directory')) {
    const body = await extractJsonBody(input, init, method);
    const result = await sendBridgeMessage('api:opencode/directory', { path: body.path });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname === '/api/quota/providers') {
    try {
      const data = await sendBridgeMessage('api:quota:providers');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  const quotaMatch = pathname.match(/^\/api\/quota\/([^/]+)$/);
  if (quotaMatch && method === 'GET') {
    const providerId = decodeURIComponent(quotaMatch[1]);
    try {
      const data = await sendBridgeMessage('api:quota:get', { providerId });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Handle provider auth deletion: DELETE /api/provider/:providerId/auth
  const providerAuthMatch = pathname.match(/^\/api\/provider\/([^/]+)\/auth$/);
  if (providerAuthMatch && method === 'DELETE') {
    const providerId = decodeURIComponent(providerAuthMatch[1]);
    const scope = url.searchParams.get('scope') || 'auth';
    const queryDirectory = url.searchParams.get('directory') || undefined;
    try {
      const data = await sendBridgeMessage('api:provider/auth:delete', { providerId, scope, directory: queryDirectory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Handle provider source lookup: GET /api/provider/:providerId/source
  const providerSourceMatch = pathname.match(/^\/api\/provider\/([^/]+)\/source$/);
  if (providerSourceMatch && method === 'GET') {
    const providerId = decodeURIComponent(providerSourceMatch[1]);
    const queryDirectory = url.searchParams.get('directory') || undefined;
    try {
      const data = await sendBridgeMessage('api:provider/source:get', { providerId, directory: queryDirectory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  return null;
};

const originalFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const targetUrl = typeof input === 'string' || input instanceof URL ? normalizeUrl(input) : normalizeUrl((input as Request).url);
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

  const pathname = targetUrl?.pathname || '';
  const normalizedPathname = pathname.replace(/\/{2,}/g, '/');
  if (targetUrl && normalizedPathname === '/health') {
    const connectionStatus = window.__OPENCHAMBER_CONNECTION__?.status;
    const isReady = connectionStatus === 'connected';
    const cliAvailable = window.__OPENCHAMBER_CONNECTION__?.cliAvailable ?? true;
    return new Response(JSON.stringify({ 
      status: isReady ? 'ok' : 'connecting', 
      isOpenCodeReady: isReady,
      cliAvailable,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (targetUrl && isLocalRuntimePath(normalizedPathname)) {
    const localResponse = await handleLocalApiRequest(input, targetUrl, init, method);
    if (localResponse) {
      recordBootstrapFetch(targetUrl.pathname, localResponse.ok);
      maybeHideLoadingOverlay();
      return localResponse;
    }

    if (!isApiPath(normalizedPathname)) {
      return originalFetch(input as RequestInfo, init);
    }

    const suffixPath = `${targetUrl.pathname.replace(/^\/api/, '')}${targetUrl.search}`;

    const headersFromRequest = input instanceof Request ? headersToRecord(input.headers) : {};
    const headersFromInit = headersToRecord(init?.headers);
    const headers = { ...headersFromRequest, ...headersFromInit };

    if (isSseApiPath(targetUrl.pathname)) {
      const start = await vscodeStreamPerfMeasure('vscode.webview.sse_start_ms', () => startSseProxy({ path: suffixPath, headers }));
      if (!start.streamId) {
        return new Response(null, { status: start.status || 503, headers: start.headers || {} });
      }

      const streamId = start.streamId;
      const signal = (input instanceof Request ? input.signal : init?.signal) as AbortSignal | undefined;
      const encoder = new TextEncoder();
      let unsubscribe: (() => void) | null = null;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const onMessage = (event: MessageEvent) => {
            const msg = event.data as { type?: string; streamId?: string; chunk?: string; error?: string };
            if (!msg || msg.streamId !== streamId) return;

            if (msg.type === 'api:sse:chunk' && typeof msg.chunk === 'string') {
              vscodeStreamPerfCount('vscode.webview.sse_chunk');
              vscodeStreamPerfObserve('vscode.webview.sse_chunk_bytes', msg.chunk.length);
              controller.enqueue(encoder.encode(msg.chunk));
              return;
            }

            if (msg.type === 'api:sse:end') {
              vscodeStreamPerfCount('vscode.webview.sse_end');
              unsubscribe?.();
              unsubscribe = null;
              if (typeof msg.error === 'string' && msg.error.length > 0) {
                controller.error(new Error(msg.error));
              } else {
                controller.close();
              }
              void stopSseProxy({ streamId }).catch(() => {});
            }
          };

          window.addEventListener('message', onMessage);
          unsubscribe = () => window.removeEventListener('message', onMessage);

          if (signal) {
            const onAbort = () => {
              unsubscribe?.();
              unsubscribe = null;
              try {
                controller.error(new DOMException('Aborted', 'AbortError'));
              } catch {
                controller.close();
              }
              void stopSseProxy({ streamId }).catch(() => {});
            };
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
          }
        },
        cancel() {
          unsubscribe?.();
          unsubscribe = null;
          void stopSseProxy({ streamId }).catch(() => {});
        },
      });

      return new Response(stream, { status: start.status || 200, headers: start.headers || { 'content-type': 'text/event-stream' } });
    }

    if (method === 'POST' && isSessionMessageApiPath(targetUrl.pathname)) {
      const bodyText = await extractBodyText(input, init, method);
      const signal = (input instanceof Request ? input.signal : init?.signal) as AbortSignal | undefined;
      const proxied = await proxySessionMessageRequest({ path: suffixPath, headers, bodyText, signal });
      const response = buildProxiedResponse(proxied);
      recordBootstrapFetch(targetUrl.pathname, response.ok);
      maybeHideLoadingOverlay();
      return response;
    }

    const bodyBase64 = await extractBodyBase64(input, init, method);
    const signal = (input instanceof Request ? input.signal : init?.signal) as AbortSignal | undefined;
    const proxied = await proxyApiRequest({ method, path: suffixPath, headers, bodyBase64, signal });
    const response = buildProxiedResponse(proxied);
    recordBootstrapFetch(targetUrl.pathname, response.ok);
    maybeHideLoadingOverlay();
    return response;
  }

  if (targetUrl && targetUrl.hostname.includes('models.dev')) {
    try {
      const data = await sendBridgeMessage('api:models/metadata');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      console.warn('[OpenChamber] models.dev request failed via bridge, returning empty metadata:', error);
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  return originalFetch(input as RequestInfo, init);
};

onCommand('addContextSelection', (payload) => {
  const { filePath, filename, text } = payload as { filePath?: unknown; filename?: unknown; text?: unknown };
  if (typeof filePath !== 'string' || typeof filename !== 'string' || typeof text !== 'string') {
    return;
  }

  const trimmedPath = filePath.trim();
  const trimmedFilename = filename.trim();
  if (!trimmedPath || !trimmedFilename || !text.trim()) {
    return;
  }

  import('@/sync/input-store').then(({ useInputStore }) => {
    const file = new File([new Blob([text], { type: 'text/plain' })], trimmedFilename, { type: 'text/plain' });
    void useInputStore.getState().addVSCodeSelectionAttachment(trimmedPath, file);
  });
});

onCommand('addFileMentions', (payload) => {
  const rawPaths = Array.isArray((payload as { paths?: unknown[] })?.paths)
    ? (payload as { paths: unknown[] }).paths
    : [];
  const paths = rawPaths
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (paths.length === 0) {
    return;
  }

  const mentionText = paths.map((relativePath) => `@${relativePath}`).join(' ');

  import('@/sync/input-store').then(({ useInputStore }) => {
    useInputStore.getState().setPendingInputText(mentionText, 'append-inline');
  });
});

onCommand('addFileAttachments', (payload) => {
  const rawFiles = Array.isArray((payload as { files?: unknown[] })?.files)
    ? (payload as { files: unknown[] }).files
    : [];

  const files = rawFiles
    .map((entry) => {
      const record = entry as { filePath?: unknown; fileName?: unknown; fileSize?: unknown };
      const filePath = typeof record.filePath === 'string' ? record.filePath.trim() : '';
      const fileName = typeof record.fileName === 'string' ? record.fileName.trim() : '';
      const fileSize = typeof record.fileSize === 'number' && Number.isFinite(record.fileSize) ? record.fileSize : null;
      return filePath && fileName ? { filePath, fileName, fileSize } : null;
    })
    .filter((entry): entry is { filePath: string; fileName: string; fileSize: number | null } => entry !== null);

  if (files.length === 0) {
    return;
  }

  import('@/sync/input-store').then(({ useInputStore }) => {
    const inputStore = useInputStore.getState();
    for (const file of files) {
      inputStore.addVSCodeFileAttachment(file.filePath, file.fileName, file.fileSize);
    }
  });
});

// Listen for createSessionWithPrompt command from extension (Explain, Improve Code)
onCommand('createSessionWithPrompt', (payload) => {
  const { prompt } = payload as { prompt: string };

  Promise.all([
    import('@/sync/session-ui-store'),
    import('@/stores/useConfigStore'),
    import('@/sync/input-store'),
  ]).then(([{ useSessionUIStore }, { useConfigStore }, { useInputStore }]) => {
    const sessionStore = useSessionUIStore.getState();
    const configStore = useConfigStore.getState();

    // Get current provider/model/agent configuration
    const { currentProviderId, currentModelId, currentAgentName } = configStore;

    if (currentProviderId && currentModelId) {
      if (!sessionStore.currentSessionId) {
        sessionStore.openNewSessionDraft();
      }

      // Send the message - this will create the session from the draft and send
      sessionStore.sendMessage(
        prompt,
        currentProviderId,
        currentModelId,
        currentAgentName ?? undefined,
        undefined, // attachments
        undefined, // agentMentionName
        undefined  // additionalParts
      ).catch((error: unknown) => {
        console.error('[OpenChamber] Failed to send prompt:', error);
      });
    } else {
      // If no provider/model configured, just set the text and let user send manually
      useInputStore.getState().setPendingInputText(prompt);
    }
  });
});

// Listen for newSession command from extension title bar button
onCommand('newSession', () => {
  import('@/sync/session-ui-store').then(({ useSessionUIStore }) => {
    useSessionUIStore.getState().openNewSessionDraft();
  });
  
  // Also dispatch event to navigate to chat view in VSCodeLayout
  window.dispatchEvent(new CustomEvent('openchamber:navigate', { detail: { view: 'chat' } }));
});

// Listen for showSettings command from extension title bar button
onCommand('showSettings', () => {
  // Dispatch event to navigate to settings view in VSCodeLayout
  window.dispatchEvent(new CustomEvent('openchamber:navigate', { detail: { view: 'settings' } }));
});

// Run the same full OpenCode reload flow the app uses after an update: shows the
// reload overlay, restarts the managed OpenCode (via the bridge's /api/config/reload),
// and refreshes config/data. Triggered by the "Restart API Connection" command.
onCommand('reloadOpenCode', () => {
  void import('@openchamber/ui/stores/useAgentsStore').then(({ reloadOpenCodeConfiguration }) => {
    void reloadOpenCodeConfiguration();
  });
});

const getNotificationClaimKey = (payload: { title?: unknown; body?: unknown; sessionId?: unknown; tag?: unknown } | undefined): string => {
  const tag = typeof payload?.tag === 'string' ? payload.tag.trim() : '';
  if (tag) return tag;
  return [payload?.sessionId, payload?.title, payload?.body]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .join('|');
};

const claimOpenChamberNotification = async (payload: { title?: unknown; body?: unknown; sessionId?: unknown; tag?: unknown } | undefined): Promise<boolean> => {
  const key = getNotificationClaimKey(payload);
  if (!key) return true;
  try {
    const result = await sendBridgeMessage<{ claimed?: boolean }>('api:notifications:claim', { key });
    return result?.claimed === true;
  } catch {
    return true;
  }
};

const showOpenChamberNotification = (payload: { title?: unknown; body?: unknown; sessionId?: unknown; tag?: unknown; requireHidden?: unknown } | undefined) => {
  if (typeof Notification === 'undefined') {
    return false;
  }

  const show = async () => {
    const isVSCodeWindowFocused = window.__OPENCHAMBER_VSCODE_WINDOW_FOCUSED__ ?? document.hasFocus();
    if (payload?.requireHidden === true && isVSCodeWindowFocused) {
      return false;
    }
    if (Notification.permission !== 'granted') {
      return false;
    }

    const title = typeof payload?.title === 'string' && payload.title.trim().length > 0
      ? payload.title.trim()
      : 'OpenChamber';
    const body = typeof payload?.body === 'string' ? payload.body : '';
    const sessionId = typeof payload?.sessionId === 'string' && payload.sessionId.trim().length > 0
      ? payload.sessionId.trim()
      : '';
    if (!await claimOpenChamberNotification({ ...payload, title, body, sessionId })) {
      return false;
    }

    const notification = new Notification(title, { body });
    notification.onclick = () => {
      if (sessionId) {
        import('@/sync/session-ui-store').then(({ useSessionUIStore }) => {
          useSessionUIStore.getState().setCurrentSession(sessionId);
        });
      }
      window.dispatchEvent(new CustomEvent('openchamber:navigate', { detail: { view: 'chat' } }));
    };
    return true;
  };

  if (Notification.permission === 'default') {
    void Notification.requestPermission().then((permission) => {
      if (permission === 'granted') {
        void show();
      }
    });
    return true;
  }

  void show();
  return true;
};

onCommand('showNotification', (payload) => {
  showOpenChamberNotification(payload as { title?: unknown; body?: unknown; sessionId?: unknown; requireHidden?: unknown } | undefined);
});

onCommand('windowFocusChanged', (payload) => {
  if (typeof payload === 'object' && payload && typeof (payload as { focused?: unknown }).focused === 'boolean') {
    window.__OPENCHAMBER_VSCODE_WINDOW_FOCUSED__ = (payload as { focused: boolean }).focused;
  }
});

const readyNotificationCooldowns = new Map<string, number>();
const READY_NOTIFICATION_COOLDOWN_MS = 5000;
const DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH = 250;
let notificationSettingsSyncPromise: Promise<void> | null = null;

const getPayloadString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const normalizeNotificationPlainText = (text: string): string => text
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`([^`]*)`/g, '$1')
  .replace(/^[\t ]*[-*+]\s+/gm, '')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/\*\*(.*?)\*\*/g, '$1')
  .replace(/__(.*?)__/g, '$1')
  .replace(/\*(.*?)\*/g, '$1')
  .replace(/_(.*?)_/g, '$1')
  .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
  .replace(/\s*\n\s*/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const truncateNotificationText = (text: string, maxLength: number): string => (
  text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`
);

const resolvePositiveNotificationNumber = (value: unknown, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
);

const ensureNotificationSettingsSynced = async () => {
  if (!notificationSettingsSyncPromise) {
    notificationSettingsSyncPromise = import('@/lib/persistence')
      .then(({ syncDesktopSettings }) => syncDesktopSettings())
      .catch((error) => {
        console.warn('[OpenChamber] Failed to sync notification settings:', error);
      });
  }
  await notificationSettingsSyncPromise;
};

const prepareNotificationLastMessage = (
  message: string,
  settings: { maxLastMessageLength: number },
): string => {
  const maxLength = resolvePositiveNotificationNumber(settings.maxLastMessageLength, DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH);
  return truncateNotificationText(normalizeNotificationPlainText(message), maxLength);
};

const resolveTemplate = (template: string, variables: Record<string, string>): string => (
  template.replace(/\{(\w+)\}/g, (_match, key: string) => variables[key] ?? '')
);

const shouldApplyTemplateMessage = (template: string, resolved: string, variables: Record<string, string>) => {
  if (!resolved) return false;
  if (template.includes('{last_message}')) {
    return variables.last_message.trim().length > 0;
  }
  return true;
};

const formatNotificationLabel = (raw: string, fallback: string): string => {
  if (!raw) return fallback;
  return raw.split(/[-_\s]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
};

const extractNotificationTextFromParts = (parts: unknown): string => {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const entry = part as { type?: unknown; text?: unknown; content?: unknown };
      if (entry.type === 'text' || typeof entry.text === 'string' || typeof entry.content === 'string') {
        return typeof entry.text === 'string' ? entry.text : typeof entry.content === 'string' ? entry.content : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
};

const extractNotificationLastMessage = (payload: Record<string, unknown>): string => {
  const properties = (payload.properties ?? payload) as Record<string, unknown>;
  const info = properties.info as Record<string, unknown> | undefined;
  if (!info) return '';
  return extractNotificationTextFromParts(info.parts ?? properties.parts) || extractNotificationTextFromParts(info.content);
};

const fetchLastAssistantMessageText = async (sessionId: string, messageId?: string): Promise<string> => {
  if (!sessionId) return '';

  try {
    const messages = await opencodeClient.getSessionMessages(sessionId, 5);
    if (!Array.isArray(messages)) return '';

    let target = messageId
      ? messages.find((message) => {
          const info = message && typeof message === 'object'
            ? (message as { info?: { id?: unknown; role?: unknown } }).info
            : undefined;
          return info?.id === messageId && info?.role === 'assistant';
        })
      : null;

    if (!target) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        const info = message && typeof message === 'object'
          ? (message as { info?: { role?: unknown; finish?: unknown } }).info
          : undefined;
        if (info?.role === 'assistant' && info?.finish === 'stop') {
          target = message;
          break;
        }
      }
    }

    if (!target || typeof target !== 'object') return '';
    const message = target as { parts?: unknown; content?: unknown; info?: { parts?: unknown; content?: unknown } };
    return extractNotificationTextFromParts(message.parts ?? message.info?.parts)
      || extractNotificationTextFromParts(message.content ?? message.info?.content);
  } catch {
    return '';
  }
};

const getNotificationTemplate = (
  settings: { notificationTemplates?: Record<string, { title?: string; message?: string }> },
  key: 'completion' | 'error' | 'question',
  fallback: { title: string; message: string },
) => {
  const candidate = settings.notificationTemplates?.[key];
  return {
    title: typeof candidate?.title === 'string' ? candidate.title : fallback.title,
    message: typeof candidate?.message === 'string' ? candidate.message : fallback.message,
  };
};

const buildNotificationVariables = (payload: Record<string, unknown>, sessionId: string, lastMessage: string): Record<string, string> => {
  const properties = (payload.properties ?? payload) as Record<string, unknown>;
  const info = properties.info as Record<string, unknown> | undefined;
  const pathInfo = info?.path as { root?: unknown; cwd?: unknown } | undefined;
  const worktree = getPayloadString(pathInfo?.root ?? pathInfo?.cwd);
  const modelId = getPayloadString(info?.modelID ?? info?.modelId ?? (info?.model as { modelID?: unknown } | undefined)?.modelID);
  return {
    project_name: worktree.split(/[\\/]/).filter(Boolean).pop() || '',
    worktree,
    branch: '',
    session_name: getPayloadString(properties.sessionTitle ?? (properties.session as { title?: unknown } | undefined)?.title ?? info?.sessionTitle),
    agent_name: formatNotificationLabel(getPayloadString(info?.agent ?? info?.mode), 'Agent'),
    model_name: formatNotificationLabel(modelId, 'Assistant'),
    last_message: lastMessage,
    session_id: sessionId,
  };
};

const getNotificationSessionId = (payload: Record<string, unknown>): string => {
  const properties = (payload.properties ?? payload) as Record<string, unknown>;
  const info = properties.info as Record<string, unknown> | undefined;
  return getPayloadString(info?.sessionID ?? info?.sessionId ?? properties.sessionID ?? properties.sessionId ?? properties.session);
};

window.addEventListener('openchamber:vscode-notification-event', (event) => {
  const detail = (event as CustomEvent<{ payload?: unknown }>).detail;
  const payload = detail?.payload;
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const record = payload as Record<string, unknown>;
  const type = getPayloadString(record.type);
  const properties = (record.properties ?? record) as Record<string, unknown>;
  const info = properties.info as Record<string, unknown> | undefined;
  const sessionId = getNotificationSessionId(record);
  if (!sessionId) {
    return;
  }

  Promise.all([
    import('@/stores/useUIStore'),
    import('@/stores/permissionStore'),
  ]).then(async ([{ useUIStore }, { usePermissionStore }]) => {
    const localSettings = useUIStore.getState();
    await ensureNotificationSettingsSynced();
    const syncedSettings = useUIStore.getState();
    const settings = {
      ...syncedSettings,
      nativeNotificationsEnabled: localSettings.nativeNotificationsEnabled,
      notificationMode: localSettings.notificationMode,
      notifyOnCompletion: localSettings.notifyOnCompletion,
      notifyOnError: localSettings.notifyOnError,
      notifyOnQuestion: localSettings.notifyOnQuestion,
      notificationTemplates: localSettings.notificationTemplates,
      summarizeLastMessage: localSettings.summarizeLastMessage,
      summaryThreshold: localSettings.summaryThreshold,
      summaryLength: localSettings.summaryLength,
      maxLastMessageLength: localSettings.maxLastMessageLength,
    };
    if (!settings.nativeNotificationsEnabled) {
      return;
    }
    const requireHidden = settings.notificationMode !== 'always';
    const messageId = getPayloadString(info?.id);
    const rawLastMessage = extractNotificationLastMessage(record) || await fetchLastAssistantMessageText(sessionId, messageId);
    const lastMessage = prepareNotificationLastMessage(
      rawLastMessage,
      settings,
    );
    const variables = buildNotificationVariables(record, sessionId, lastMessage);

    if (type === 'message.updated' && getPayloadString(info?.role) === 'assistant') {
      const finish = getPayloadString(info?.finish);
      if (finish === 'stop') {
        if (!settings.notifyOnCompletion) return;
        const now = Date.now();
        const lastAt = readyNotificationCooldowns.get(sessionId) ?? 0;
        if (now - lastAt < READY_NOTIFICATION_COOLDOWN_MS) return;
        readyNotificationCooldowns.set(sessionId, now);
        const template = getNotificationTemplate(settings, 'completion', { title: '{agent_name} is ready', message: '{model_name} completed the task' });
        const title = resolveTemplate(template.title, variables) || 'Agent is ready';
        const body = resolveTemplate(template.message, variables);
        showOpenChamberNotification({
          title,
          body: shouldApplyTemplateMessage(template.message, body, variables) ? body : `${variables.model_name} completed the task`,
          sessionId,
          requireHidden,
        });
        return;
      }

      if (finish === 'error') {
        if (!settings.notifyOnError) return;
        const template = getNotificationTemplate(settings, 'error', { title: 'Tool error', message: '{last_message}' });
        const title = resolveTemplate(template.title, variables) || 'Tool error';
        const body = resolveTemplate(template.message, variables);
        showOpenChamberNotification({
          title,
          body: shouldApplyTemplateMessage(template.message, body, variables) ? body : 'An error occurred',
          sessionId,
          requireHidden,
        });
      }
    }

    if (type === 'question.asked') {
      if (!settings.notifyOnQuestion) return;
      const questions = Array.isArray(properties.questions) ? properties.questions : [];
      const firstQuestion = questions[0] as Record<string, unknown> | undefined;
      const header = getPayloadString(firstQuestion?.header);
      const questionText = getPayloadString(firstQuestion?.question);
      const questionVariables = { ...variables, last_message: questionText || header };
      const template = getNotificationTemplate(settings, 'question', { title: 'Input needed', message: '{last_message}' });
      const title = resolveTemplate(template.title, questionVariables) || (/plan\s*mode/i.test(header) ? 'Switch to plan mode' : /build\s*agent/i.test(header) ? 'Switch to build mode' : header || 'Input needed');
      const body = resolveTemplate(template.message, questionVariables);
      showOpenChamberNotification({
        title,
        body: shouldApplyTemplateMessage(template.message, body, questionVariables) ? body : questionText || 'Agent is waiting for your response',
        sessionId,
        requireHidden,
      });
      return;
    }

    if (type === 'permission.asked') {
      if (!settings.notifyOnQuestion) return;
      if (usePermissionStore.getState().isSessionAutoAccepting(sessionId)) return;
      const permission = getPayloadString(properties.permission);
      const sessionTitle = getPayloadString(properties.sessionTitle);
      const fallbackMessage = sessionTitle || permission || 'Agent is waiting for your approval';
      const permissionVariables = { ...variables, last_message: fallbackMessage };
      const template = getNotificationTemplate(settings, 'question', { title: 'Permission required', message: '{last_message}' });
      const title = resolveTemplate(template.title, permissionVariables) || 'Permission required';
      const body = resolveTemplate(template.message, permissionVariables);
      showOpenChamberNotification({
        title,
        body: shouldApplyTemplateMessage(template.message, body, permissionVariables) ? body : fallbackMessage,
        sessionId,
        requireHidden,
      });
    }
  });
});

// Listen for settings sync command from extension (broadcast to all VS Code webviews)
onCommand('settingsSynced', () => {
  import('@openchamber/ui/lib/persistence').then(({ syncDesktopSettings }) => {
    void syncDesktopSettings();
  });
});

// Listen for active editor file changes from the extension
onCommand('activeEditorFile', (payload) => {
  import('@/sync/input-store').then(({ useInputStore }) => {
    useInputStore.getState().setActiveEditorFile((payload as VSCodeActiveEditorFile | null) ?? null);
  });
});

import('@openchamber/ui/apps/renderVSCodeApp')
  .then(async ({ renderVSCodeApp }) => {
    renderVSCodeApp(window.__OPENCHAMBER_RUNTIME_APIS__ ?? createVSCodeAPIs());
    await waitForUiMount();
    uiMounted = true;
    maybeHideLoadingOverlay();
  })
  .catch((error) => {
    console.error('[OpenChamber] Failed to bootstrap UI:', error);
    // If the UI bundle fails to load, remove the overlay so the user at least sees errors in the root.
    uiMounted = true;
    fadeOutLoadingScreen();
  });

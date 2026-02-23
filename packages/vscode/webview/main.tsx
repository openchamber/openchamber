import { createVSCodeAPIs } from './api';
import { onCommand, onThemeChange, proxyApiRequest, proxySessionMessageRequest, sendBridgeMessage, startSseProxy, stopSseProxy } from './api/bridge';
import type { RuntimeAPIs } from '@openchamber/ui/lib/api/types';
import {
  buildVSCodeThemeFromPalette,
  readVSCodeThemePalette,
  type VSCodeThemeKind,
  type VSCodeThemePayload,
} from '@openchamber/ui/lib/theme/vscode/adapter';

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
      panelType?: PanelType;
      viewMode?: 'sidebar' | 'editor';
      initialSessionId?: string | null;
    };
    __OPENCHAMBER_VSCODE_THEME__?: VSCodeThemePayload['theme'];
    __OPENCHAMBER_VSCODE_SHIKI_THEMES__?: { light?: Record<string, unknown>; dark?: Record<string, unknown> } | null;
    __OPENCHAMBER_CONNECTION__?: { status: ConnectionStatus; error?: string; cliAvailable?: boolean };
    __OPENCHAMBER_HOME__?: string;
    __OPENCHAMBER_PANEL_TYPE__?: PanelType;
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

const bootstrapConnectionStatus = () => {
  const initialStatus = (window.__VSCODE_CONFIG__?.connectionStatus as ConnectionStatus | undefined) || 'connecting';
  const cliAvailable = window.__VSCODE_CONFIG__?.cliAvailable ?? true;
  window.__OPENCHAMBER_CONNECTION__ = { status: initialStatus, cliAvailable };
};

bootstrapConnectionStatus();

// Expose panel type globally for App.tsx to conditionally render
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

  if (pathname.startsWith('/api/config/providers')) {
    if (ok) bootstrapProvidersReady = true;
    else bootstrapFailed = true;
    return;
  }

  if (pathname === '/api/agent' || pathname.startsWith('/api/agent?')) {
    if (ok) bootstrapAgentsReady = true;
    else bootstrapFailed = true;
  }
};

const maybeHideLoadingOverlay = () => {
  const connectionStatus = window.__OPENCHAMBER_CONNECTION__?.status ?? 'connecting';

  if (!uiMounted) {
    return;
  }

  if (connectionStatus === 'connected') {
    if (bootstrapFailed) {
      setLoadingStatusText('OpenCode connected, but initial data load failed.', 'error');
      fadeOutLoadingScreen();
      return;
    }

    if (bootstrapProvidersReady && bootstrapAgentsReady) {
      fadeOutLoadingScreen();
      return;
    }

    const providersText = bootstrapProvidersReady ? '✓ Providers' : '… Providers';
    const agentsText = bootstrapAgentsReady ? '✓ Agents' : '… Agents';
    setLoadingStatusText(`Loading data (${providersText}, ${agentsText})…`);
    return;
  }

  if (connectionStatus === 'error') {
    const error = window.__OPENCHAMBER_CONNECTION__?.error;
    setLoadingStatusText(error || 'Connection error', 'error');
    fadeOutLoadingScreen();
    return;
  }

  if (connectionStatus === 'disconnected') {
    setLoadingStatusText('Disconnected', 'error');
    fadeOutLoadingScreen();
    return;
  }

  setLoadingStatusText('Starting OpenCode API…');
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
    const normalized = value.replace(/\\/g, '/');
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
    return typeof input === 'string' ? new URL(input, window.location.origin) : new URL(input.toString());
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

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const isNullBodyStatus = (status: number): boolean => status === 204 || status === 205 || status === 304;

const buildProxiedResponse = (
  proxied: { status: number; headers: Record<string, string>; bodyBase64?: string }
): Response => {
  if (isNullBodyStatus(proxied.status)) {
    return new Response(null, { status: proxied.status, headers: proxied.headers });
  }

  const body = proxied.bodyBase64 ? decodeBase64(proxied.bodyBase64) : new Uint8Array();
  return new Response(body, { status: proxied.status, headers: proxied.headers });
};

const encodeBase64 = (bytes: Uint8Array): string => {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

const extractBodyBase64 = async (input: RequestInfo | URL, init: RequestInit | undefined, method: string): Promise<string | undefined> => {
  if (method === 'GET' || method === 'HEAD') return undefined;

  if (input instanceof Request) {
    const cloned = input.clone();
    const buffer = await cloned.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    return bytes.length > 0 ? encodeBase64(bytes) : undefined;
  }

  const body = init?.body;
  if (!body) return undefined;

  if (typeof body === 'string') {
    return encodeBase64(new TextEncoder().encode(body));
  }

  if (body instanceof URLSearchParams) {
    return encodeBase64(new TextEncoder().encode(body.toString()));
  }

  if (body instanceof Blob) {
    const buffer = await body.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    return bytes.length > 0 ? encodeBase64(bytes) : undefined;
  }

  console.warn('[OpenChamber] Unsupported request body type for proxy request:', body);
  return undefined;
};

const extractBodyText = async (input: RequestInfo | URL, init: RequestInit | undefined, method: string): Promise<string> => {
  if (method === 'GET' || method === 'HEAD') return '';

  if (input instanceof Request) {
    const cloned = input.clone();
    return await cloned.text();
  }

  const body = init?.body;
  if (!body) return '';

  if (typeof body === 'string') {
    return body;
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  if (body instanceof Blob) {
    return await body.text();
  }

  console.warn('[OpenChamber] Unsupported request body type for direct session proxy:', body);
  return '';
};

const isSseApiPath = (pathname: string) => pathname === '/api/event' || pathname === '/api/global/event';
const isSessionMessageApiPath = (pathname: string) => /^\/api\/session\/[^/]+\/message$/.test(pathname);

const handleLocalApiRequest = async (url: URL, init?: RequestInit) => {
  const pathname = url.pathname;
  const normalizedPathname = pathname !== '/' ? pathname.replace(/\/+$/, '') : pathname;
  const method = ((init?.method || 'GET') as string).toUpperCase();

  if (normalizedPathname === '/api/sessions/snapshot' && method === 'GET') {
    return new Response(JSON.stringify({
      statusSessions: {},
      attentionSessions: {},
      serverTime: Date.now(),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (/^\/api\/sessions\/[^/]+\/(view|unview)$/.test(normalizedPathname) && method === 'POST') {
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
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

  if ((pathname === '/api/tts/speak' || pathname === '/api/tts/say/speak' || pathname === '/api/tts/summarize') && method === 'POST') {
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

  if (pathname.startsWith('/api/fs/search')) {
    const directory = url.searchParams.get('directory') || '';
    const query = url.searchParams.get('q') || '';
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Number(limitParam) : undefined;
    const resolvedLimit = Number.isFinite(limit) ? limit : undefined;
    const includeHidden = url.searchParams.get('includeHidden') === 'true';
    const respectGitignore = url.searchParams.get('respectGitignore') !== 'false';
    const data = await sendBridgeMessage('api:fs:search', {
      directory,
      query,
      limit: resolvedLimit,
      includeHidden,
      respectGitignore,
    });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/fs/mkdir')) {
    const body = init?.body ? JSON.parse(init.body as string) : {};
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

  if (pathname.startsWith('/api/config/agents/')) {
    const encodedName = pathname.slice('/api/config/agents/'.length);
    const name = decodeURIComponent(encodedName);
    const verb = ((init?.method || 'GET') as string).toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const queryDirectory = url.searchParams.get('directory') || undefined;
    const headerDirectory = (() => {
      const headers = init?.headers;
      if (!headers) return undefined;
      if (headers instanceof Headers) {
        return headers.get('x-opencode-directory') || undefined;
      }
      if (Array.isArray(headers)) {
        const found = headers.find(([key]) => key.toLowerCase() === 'x-opencode-directory');
        return found?.[1] || undefined;
      }
      if (typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) {
          if (key.toLowerCase() === 'x-opencode-directory' && typeof value === 'string') {
            return value;
          }
        }
      }
      return undefined;
    })();
    const directory = queryDirectory || headerDirectory;
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
    const verb = ((init?.method || 'GET') as string).toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const queryDirectory = url.searchParams.get('directory') || undefined;
    const headerDirectory = (() => {
      const headers = init?.headers;
      if (!headers) return undefined;
      if (headers instanceof Headers) {
        return headers.get('x-opencode-directory') || undefined;
      }
      if (Array.isArray(headers)) {
        const found = headers.find(([key]) => key.toLowerCase() === 'x-opencode-directory');
        return found?.[1] || undefined;
      }
      if (typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) {
          if (key.toLowerCase() === 'x-opencode-directory' && typeof value === 'string') {
            return value;
          }
        }
      }
      return undefined;
    })();
    const directory = queryDirectory || headerDirectory;
    try {
      const data = await sendBridgeMessage('api:config/commands', { method: verb, name, body, directory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/api/config/mcp') {
    const verb = ((init?.method || 'GET') as string).toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const queryDirectory = url.searchParams.get('directory') || undefined;
    const headerDirectory = (() => {
      const headers = init?.headers;
      if (!headers) return undefined;
      if (headers instanceof Headers) {
        return headers.get('x-opencode-directory') || undefined;
      }
      if (Array.isArray(headers)) {
        const found = headers.find(([key]) => key.toLowerCase() === 'x-opencode-directory');
        return found?.[1] || undefined;
      }
      if (typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) {
          if (key.toLowerCase() === 'x-opencode-directory' && typeof value === 'string') {
            return value;
          }
        }
      }
      return undefined;
    })();
    const directory = queryDirectory || headerDirectory;
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
    const verb = ((init?.method || 'GET') as string).toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const queryDirectory = url.searchParams.get('directory') || undefined;
    const headerDirectory = (() => {
      const headers = init?.headers;
      if (!headers) return undefined;
      if (headers instanceof Headers) {
        return headers.get('x-opencode-directory') || undefined;
      }
      if (Array.isArray(headers)) {
        const found = headers.find(([key]) => key.toLowerCase() === 'x-opencode-directory');
        return found?.[1] || undefined;
      }
      if (typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) {
          if (key.toLowerCase() === 'x-opencode-directory' && typeof value === 'string') {
            return value;
          }
        }
      }
      return undefined;
    })();
    const directory = queryDirectory || headerDirectory;
    try {
      const data = await sendBridgeMessage('api:config/mcp', { method: verb, name, body, directory });
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
    const verb = ((init?.method || 'GET') as string).toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : {};
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
    const body = init?.body ? JSON.parse(init.body as string) : {};
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
    const body = init?.body ? JSON.parse(init.body as string) : {};
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
    const verb = ((init?.method || 'GET') as string).toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : {};
    try {
      const data = await sendBridgeMessage('api:config/skills', { method: verb, name, body });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/config/settings')) {
    if ((init?.method || 'GET').toUpperCase() === 'GET') {
      const settings = await sendBridgeMessage('api:config/settings:get');
      return new Response(JSON.stringify(settings), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const updated = await sendBridgeMessage('api:config/settings:save', body);
    return new Response(JSON.stringify(updated), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/config/reload')) {
    await sendBridgeMessage('api:config/reload');
    return new Response(JSON.stringify({ restarted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
    const body = init?.body ? JSON.parse(init.body as string) : {};
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
  if (quotaMatch && (init?.method || 'GET').toUpperCase() === 'GET') {
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
  if (providerAuthMatch && (init?.method || 'GET').toUpperCase() === 'DELETE') {
    const providerId = decodeURIComponent(providerAuthMatch[1]);
    const scope = url.searchParams.get('scope') || 'auth';
    try {
      const data = await sendBridgeMessage('api:provider/auth:delete', { providerId, scope });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Handle provider source lookup: GET /api/provider/:providerId/source
  const providerSourceMatch = pathname.match(/^\/api\/provider\/([^/]+)\/source$/);
  if (providerSourceMatch && (init?.method || 'GET').toUpperCase() === 'GET') {
    const providerId = decodeURIComponent(providerSourceMatch[1]);
    try {
      const data = await sendBridgeMessage('api:provider/source:get', { providerId });
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
  const normalizedPathname = pathname.replace(/\/+/, '/');
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

  if (targetUrl && targetUrl.pathname.startsWith('/api/')) {
    const localResponse = await handleLocalApiRequest(targetUrl, init);
    if (localResponse) {
      recordBootstrapFetch(targetUrl.pathname, localResponse.ok);
      maybeHideLoadingOverlay();
      return localResponse;
    }

    const suffixPath = `${targetUrl.pathname.replace(/^\/api/, '')}${targetUrl.search}`;

    const headersFromRequest = input instanceof Request ? headersToRecord(input.headers) : {};
    const headersFromInit = headersToRecord(init?.headers);
    const headers = { ...headersFromRequest, ...headersFromInit };

    if (isSseApiPath(targetUrl.pathname)) {
      const start = await startSseProxy({ path: suffixPath, headers });
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
              controller.enqueue(encoder.encode(msg.chunk));
              return;
            }

            if (msg.type === 'api:sse:end') {
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
      const proxied = await proxySessionMessageRequest({ path: suffixPath, headers, bodyText });
      const response = buildProxiedResponse(proxied);
      recordBootstrapFetch(targetUrl.pathname, response.ok);
      maybeHideLoadingOverlay();
      return response;
    }

    const bodyBase64 = await extractBodyBase64(input, init, method);
    const proxied = await proxyApiRequest({ method, path: suffixPath, headers, bodyBase64 });
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

// Listen for addToContext command from extension
onCommand('addToContext', (payload) => {
  const { text } = payload as { text: string };
  
  // Import the store dynamically to avoid circular dependencies
  import('@/stores/useSessionStore').then(({ useSessionStore }) => {
    const store = useSessionStore.getState();
    const currentText = store.pendingInputText || '';
    // Append to existing text with double newline separator
    const newText = currentText ? `${currentText}\n\n${text}` : text;
    store.setPendingInputText(newText);
  });
});

// Listen for createSessionWithPrompt command from extension (Explain, Improve Code)
onCommand('createSessionWithPrompt', (payload) => {
  const { prompt } = payload as { prompt: string };
  
  Promise.all([
    import('@/stores/useSessionStore'),
    import('@/stores/useConfigStore'),
  ]).then(([{ useSessionStore }, { useConfigStore }]) => {
    const sessionStore = useSessionStore.getState();
    const configStore = useConfigStore.getState();
    
    // Open a new session draft first
    sessionStore.openNewSessionDraft();
    
    // Get current provider/model/agent configuration
    const { currentProviderId, currentModelId, currentAgentName } = configStore;
    
    if (currentProviderId && currentModelId) {
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
      sessionStore.setPendingInputText(prompt);
    }
  });
});

// Listen for newSession command from extension title bar button
onCommand('newSession', () => {
  import('@/stores/useSessionStore').then(({ useSessionStore }) => {
    const store = useSessionStore.getState();
    store.openNewSessionDraft();
  });
  
  // Also dispatch event to navigate to chat view in VSCodeLayout
  window.dispatchEvent(new CustomEvent('openchamber:navigate', { detail: { view: 'chat' } }));
});

// Listen for showSettings command from extension title bar button
onCommand('showSettings', () => {
  // Dispatch event to navigate to settings view in VSCodeLayout
  window.dispatchEvent(new CustomEvent('openchamber:navigate', { detail: { view: 'settings' } }));
});

import('@/main')
  .then(async () => {
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

import { randomBytes as nodeRandomBytes } from 'node:crypto';

const ROUTE_PREFIX = '/api/browser-devtools/';
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MIME_TYPES = new Set([
  'application/javascript', 'application/json', 'application/octet-stream', 'application/wasm',
  'font/woff2', 'image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp',
  'text/css', 'text/html', 'text/javascript', 'text/plain',
]);

const bootstrapHtml = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' data:; frame-src 'self' data: blob:; object-src 'none'; base-uri 'none'">
<link href="application_tokens.css" rel="stylesheet"><link href="design_system_tokens.css" rel="stylesheet">
<script type="module" src="bridge.js"></script>
</head><body class="undocked" id="-blink-dev-tools"></body></html>`;

const bridgeScript = `import * as Common from './core/common/common.js';
import * as Host from './core/host/host.js';
import * as UI from './ui/legacy/legacy.js';
import * as ThemeSupport from './ui/legacy/theme_support/theme_support.js';

(() => {
  const query = new URLSearchParams(location.search);
  const expectedOrigin = query.get('parentOrigin');
  const expectedDevToolsId = query.get('devtoolsId');
  const expectedAttachmentId = query.get('attachmentRequestId');
  const host = Host.InspectorFrontendHost.InspectorFrontendHostInstance;
  let port = null;
  let queuedBytes = 0;
  const outbound = [];
  let inboundBytes = 0;
  const inbound = [];
  const encoder = new TextEncoder();
  const themeProperties = {
    background: ['--sys-color-base', '--sys-color-cdt-base', '--sys-color-surface'],
    container: ['--sys-color-base-container', '--sys-color-cdt-base-container', '--sys-color-neutral-container', '--sys-color-surface1', '--sys-color-surface2'],
    elevated: ['--sys-color-base-container-elevated', '--sys-color-surface3', '--sys-color-surface4', '--sys-color-surface5'],
    foreground: ['--sys-color-on-base', '--sys-color-on-surface'],
    mutedForeground: ['--sys-color-on-surface-secondary', '--sys-color-on-surface-subtle'],
    divider: ['--sys-color-divider', '--sys-color-divider-prominent', '--sys-color-neutral-outline', '--sys-color-outline'],
    selection: ['--sys-color-state-focus-highlight', '--sys-color-state-text-highlight', '--sys-color-tonal-container'],
    selectionForeground: ['--sys-color-on-tonal-container', '--sys-color-state-on-text-highlight'],
    focus: ['--sys-color-state-focus-ring', '--sys-color-state-focus-select', '--sys-color-tonal-outline'],
    hover: ['--sys-color-state-header-hover', '--sys-color-state-hover-on-subtle'],
    active: ['--sys-color-state-ripple-neutral-on-subtle'],
    primary: ['--sys-color-on-surface-primary', '--sys-color-primary', '--sys-color-primary-bright'],
    primaryForeground: ['--sys-color-on-primary'],
    error: ['--sys-color-error', '--sys-color-error-bright', '--sys-color-on-error-container', '--sys-color-on-surface-error'],
    errorForeground: ['--sys-color-on-error'],
    errorBackground: ['--sys-color-error-container', '--sys-color-surface-error'],
    warning: ['--sys-color-on-surface-yellow', '--sys-color-yellow', '--sys-color-yellow-bright'],
    warningForeground: ['--sys-color-on-yellow'],
    warningBackground: ['--sys-color-surface-yellow', '--sys-color-yellow-container'],
    success: ['--sys-color-green', '--sys-color-green-bright', '--sys-color-on-surface-green'],
    info: ['--sys-color-blue', '--sys-color-blue-bright'],
    syntaxForeground: ['--sys-color-token-meta'],
    syntaxComment: ['--sys-color-token-comment', '--sys-color-token-subtle'],
    syntaxKeyword: ['--sys-color-token-keyword', '--sys-color-token-tag'],
    syntaxString: ['--sys-color-token-attribute-value', '--sys-color-token-string', '--sys-color-token-string-special'],
    syntaxNumber: ['--sys-color-token-atom', '--sys-color-token-number'],
    syntaxFunction: ['--sys-color-token-builtin', '--sys-color-token-definition'],
    syntaxVariable: ['--sys-color-token-property', '--sys-color-token-variable', '--sys-color-token-variable-special'],
    syntaxType: ['--sys-color-token-attribute', '--sys-color-token-pseudo-element', '--sys-color-token-type'],
    syntaxOperator: ['--sys-color-token-property-special'],
  };
  const themeColorNames = Object.keys(themeProperties);
  let theme = null;
  const close = () => {
    port?.close(); port = null; outbound.length = 0; queuedBytes = 0;
    inbound.length = 0; inboundBytes = 0;
  };
  const send = message => {
    if (message?.constructor !== String) return;
    if (port) { port.postMessage(message); return; }
    queuedBytes += encoder.encode(message).byteLength;
    if (queuedBytes > 1024 * 1024 || outbound.length >= 128) { close(); return; }
    outbound.push(message);
  };
  const dispatch = message => {
    if (message?.constructor !== String) return;
    const api = globalThis.InspectorFrontendAPI;
    if (api?.dispatchMessage) { api.dispatchMessage(message); return; }
    inboundBytes += encoder.encode(message).byteLength;
    if (inboundBytes > 1024 * 1024 || inbound.length >= 128) { close(); return; }
    inbound.push(message);
  };
  const postStatus = type => {
    if (!expectedOrigin || !expectedDevToolsId || !expectedAttachmentId) return;
    parent.postMessage({ type, devtoolsId: expectedDevToolsId, attachmentRequestId: expectedAttachmentId }, expectedOrigin);
  };
  const applyTheme = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.type !== 'openchamber-devtools-theme'
      || (value.variant !== 'light' && value.variant !== 'dark')) return false;
    const colors = value.colors;
    if (!colors || typeof colors !== 'object' || Array.isArray(colors)
      || Object.keys(colors).length !== themeColorNames.length) return false;
    for (const name of themeColorNames) {
      const color = colors[name];
      if (typeof color !== 'string' || color.length < 1 || color.length > 64
        || color !== color.trim() || !CSS.supports('color', color)) return false;
    }
    theme = value;
    const themeSupportReady = ThemeSupport.ThemeSupport.hasInstance();
    if (themeSupportReady) {
      const themeSetting = Common.Settings.Settings.instance().moduleSetting('ui-theme');
      const themeName = value.variant === 'dark' ? 'dark' : 'default';
      // Reapply persisted same-value settings so ThemeSupport initializes its internal theme name.
      themeSetting.set(themeName);
    }
    const root = document.documentElement;
    root.classList.toggle('theme-with-dark-background', value.variant === 'dark');
    root.style.colorScheme = value.variant;
    for (const name of themeColorNames) {
      for (const property of themeProperties[name]) root.style.setProperty(property, colors[name]);
    }
    if (themeSupportReady) {
      ThemeSupport.ThemeSupport.clearThemeCache();
      ThemeSupport.ThemeSupport.instance().dispatchEvent(new ThemeSupport.ThemeChangeEvent());
    }
    postStatus('openchamber-devtools-themed');
    return true;
  };
  const loadCompleted = host.loadCompleted.bind(host);
  host.isHostedMode = () => false;
  UI.ContextMenu.ContextMenu.useSoftMenu = true;
  host.sendMessageToBackend = send;
  host.loadCompleted = () => {
    loadCompleted();
    if (theme) applyTheme(theme);
    postStatus('openchamber-devtools-loaded');
  };
  addEventListener('message', event => {
    if (!expectedOrigin || event.source !== parent || event.origin !== expectedOrigin || port || event.ports.length !== 1) return;
    const value = event.data;
    if (value?.type !== 'openchamber-devtools-connect' || value.devtoolsId !== expectedDevToolsId || value.attachmentRequestId !== expectedAttachmentId) return;
    port = event.ports[0];
    port.onmessage = incoming => {
      const value = incoming.data;
      if (value && typeof value === 'object' && value.type === 'openchamber-devtools-theme') {
        if (!applyTheme(value)) postStatus('openchamber-devtools-theme-rejected');
        return;
      }
      dispatch(value);
    };
    port.onmessageerror = close;
    port.start();
    for (const message of outbound.splice(0)) port.postMessage(message);
    queuedBytes = 0;
  });
  new MutationObserver(() => {
    if (theme && document.documentElement.classList.contains('theme-with-dark-background') !== (theme.variant === 'dark')) {
      applyTheme(theme);
    }
  })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  postStatus('openchamber-devtools-ready');
  void import('./entrypoints/devtools_app/devtools_app.js');
})();`;

const defaultFetchAsset = (url) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });

const readAssetBytes = async (response) => {
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error('asset too large');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const chunk = Buffer.from(result.value);
    length += chunk.byteLength;
    if (length > MAX_ASSET_BYTES) {
      await reader.cancel();
      throw new Error('asset too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
};

const parseRequestPath = (originalUrl) => {
  const rawPath = String(originalUrl || '').split('?', 1)[0];
  if (!rawPath.startsWith(ROUTE_PREFIX) || rawPath.includes('\\')) return null;
  const rawParts = rawPath.slice(ROUTE_PREFIX.length).split('/');
  let parts;
  try { parts = rawParts.map((part) => decodeURIComponent(part)); } catch { return null; }
  if (parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..' || part.includes('/')
    || part.includes('\\') || /%[0-9A-Fa-f]{2}/.test(part))) return null;
  const [grant, ...assetParts] = parts;
  const assetPath = assetParts.join('/');
  if (!/^[A-Za-z0-9_-]{32}$/.test(grant) || assetPath.startsWith('json/') || assetPath.startsWith('devtools/')) return null;
  return { grant, assetPath };
};

const assetOrigin = (webSocketDebuggerUrl) => {
  const url = new URL(webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('Invalid DevTools endpoint');
  return `http://127.0.0.1:${url.port}`;
};

export function createDevToolsAssetHandler({
  fetchAsset = defaultFetchAsset,
  randomBytes = nodeRandomBytes,
} = {}) {
  const grants = new Map();

  const grant = (webSocketDebuggerUrl) => {
    const value = randomBytes(24).toString('base64url');
    grants.set(value, assetOrigin(webSocketDebuggerUrl));
    return value;
  };

  const handle = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.status(405).end(); return; }
    const parsed = parseRequestPath(req.originalUrl ?? req.url);
    const origin = parsed && grants.get(parsed.grant);
    if (!parsed || !origin) { res.status(404).end(); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (parsed.assetPath === 'inspector.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      if (req.method === 'HEAD') res.end(); else res.send(bootstrapHtml);
      return;
    }
    if (parsed.assetPath === 'bridge.js') {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      if (req.method === 'HEAD') res.end(); else res.send(bridgeScript);
      return;
    }
    try {
      const upstream = await fetchAsset(`${origin}/devtools/${parsed.assetPath}`);
      if (!upstream.ok || upstream.status !== 200) { res.status(502).end(); return; }
      const length = Number(upstream.headers.get('content-length'));
      if (Number.isFinite(length) && length > MAX_ASSET_BYTES) { res.status(502).end(); return; }
      const contentType = String(upstream.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      if (!MIME_TYPES.has(contentType)) { res.status(415).end(); return; }
      const bytes = await readAssetBytes(upstream);
      res.setHeader('Content-Type', upstream.headers.get('content-type'));
      res.setHeader('Content-Length', String(bytes.byteLength));
      res.setHeader('Cache-Control', 'private, max-age=3600');
      if (req.method === 'HEAD') res.end(); else res.send(bytes);
    } catch {
      res.status(502).end();
    }
  };

  return {
    grant,
    revoke(value) { grants.delete(value); },
    handle,
    dispose() { grants.clear(); },
  };
}

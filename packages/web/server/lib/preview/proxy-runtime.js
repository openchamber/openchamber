const DEFAULT_TARGET_TTL_MS = 30 * 60 * 1000;
const TOKEN_COOKIE_NAME = 'oc_preview_token';

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
]);

const PREVIEW_BRIDGE_SCRIPT_ID = 'openchamber-preview-bridge';

const PREVIEW_BRIDGE_SCRIPT = String.raw`(() => {
  if (window.__openchamberPreviewBridgeInstalled) return;
  window.__openchamberPreviewBridgeInstalled = true;

  const SOURCE = 'openchamber-preview-bridge';
  const VERSION = 1;
  const MAX_TEXT = 500;
  const MAX_ARG = 1000;
  let inspectMode = false;
  let lastHoverKey = '';
  let pendingHover = null;

  const post = (payload) => {
    try {
      if (window.parent && typeof window.parent.postMessage === 'function') {
        const message = Object.assign({ source: SOURCE, version: VERSION }, payload || {});
        window.parent.postMessage(message, window.location.origin);
      }
    } catch {}
  };

  const clip = (value, max = MAX_TEXT) => {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max) + '...' : text;
  };

  const stringifyArg = (value) => {
    if (typeof value === 'string') return clip(value, MAX_ARG);
    if (value instanceof Error) return clip(value.stack || value.message || String(value), MAX_ARG);
    try {
      return clip(JSON.stringify(value), MAX_ARG);
    } catch {
      return clip(String(value), MAX_ARG);
    }
  };

  const readElementUrl = (element) => {
    return element.currentSrc || element.src || element.href || element.action || '';
  };

  const upstreamPathForUrl = (value) => {
    try {
      const parsed = new URL(value, window.location.href);
      const match = parsed.pathname.match(/^\/api\/preview\/proxy\/[a-f0-9]{16,64}(\/.*)?$/i);
      return match ? (match[1] || '/') : parsed.pathname;
    } catch {
      return String(value || '');
    }
  };

  const upstreamPathAndSearchForUrl = (value) => {
    try {
      const parsed = new URL(value, window.location.href);
      const match = parsed.pathname.match(/^\/api\/preview\/proxy\/[a-f0-9]{16,64}(\/.*)?$/i);
      const path = match ? (match[1] || '/') : parsed.pathname;
      return path + parsed.search;
    } catch {
      return String(value || '');
    }
  };

  const isInternalDevToolResource = (element, value) => {
    const tag = element && element.tagName && typeof element.tagName.toLowerCase === 'function' ? element.tagName.toLowerCase() : '';
    if (tag !== 'script' && tag !== 'link') return false;
    const path = upstreamPathForUrl(value);
    const pathAndSearch = upstreamPathAndSearchForUrl(value);
    return path === '/@vite/client'
      || path === '/@react-refresh'
      || path.indexOf('/@id/astro:') === 0
      || path.startsWith('/@id/__x00__vite/')
      || path.includes('/node_modules/.vite/')
      || path.includes('/vite/dist/client/')
      || path.includes('/astro/dist/runtime/client/dev-toolbar/')
      || (pathAndSearch.indexOf('/node_modules/') >= 0 && pathAndSearch.indexOf('.astro?') >= 0 && pathAndSearch.indexOf('type=script') >= 0);
  };

  const toLoopbackHttpUrl = (value) => {
    try {
      const parsed = new URL(value, window.location.href);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      const host = parsed.hostname;
      if (host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0' && host !== '::1' && host !== '[::1]') {
        return null;
      }
      return parsed.toString();
    } catch {
      return null;
    }
  };

  const shouldParentHandleNavigation = (url) => {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      const current = new URL(window.location.href);
      if (parsed.origin !== current.origin) return true;
      return !parsed.pathname.startsWith('/api/preview/proxy/');
    } catch {
      return false;
    }
  };

  const isInternalDevToolRuntimeError = (filename) => {
    const path = upstreamPathForUrl(filename || '');
    const pathAndSearch = upstreamPathAndSearchForUrl(filename || '');
    const lowerPathAndSearch = pathAndSearch.toLowerCase();
    const isStyleRuntimeNoise = lowerPathAndSearch.endsWith('.css')
      || lowerPathAndSearch.indexOf('.css?') >= 0
      || lowerPathAndSearch.indexOf('type=style') >= 0
      || lowerPathAndSearch.indexOf('lang.css') >= 0;
    return path === '/@vite/client'
      || path === '/@react-refresh'
      || path.indexOf('/astro/dist/runtime/client/dev-toolbar/') >= 0
      || path.indexOf('/node_modules/.vite/') >= 0
      || isStyleRuntimeNoise;
  };

  const installViteHmrProxyPatch = () => {
    if (window.__openchamberViteHmrProxyPatched || typeof window.WebSocket !== 'function') return;
    window.__openchamberViteHmrProxyPatched = true;
    const NativeWebSocket = window.WebSocket;
    const proxyMatch = window.location.pathname.match(/^(\/api\/preview\/proxy\/[a-f0-9]{16,64})(?:\/|$)/i);
    if (!proxyMatch) return;
    const proxyBase = proxyMatch[1] + '/';
    let reloadTimer = 0;

    const schedulePreviewReload = () => {
      if (reloadTimer) return;
      reloadTimer = window.setTimeout(() => {
        reloadTimer = 0;
        try {
          window.location.reload();
        } catch {}
      }, 80);
    };

    const rewriteUrl = (url, protocols) => {
      const protocolList = Array.isArray(protocols) ? protocols : [protocols];
      const isViteSocket = protocolList.indexOf('vite-hmr') >= 0 || protocolList.indexOf('vite-ping') >= 0;
      if (!isViteSocket) return url;
      try {
        const parsed = new URL(String(url), window.location.href);
        if (parsed.host !== window.location.host) return url;
        if (parsed.pathname.indexOf(proxyBase) === 0) return url;
        parsed.pathname = proxyBase;
        return parsed.toString();
      } catch {
        return url;
      }
    };

    function OpenChamberPreviewWebSocket(url, protocols) {
      const protocolList = Array.isArray(protocols) ? protocols : [protocols];
      const isViteSocket = protocolList.indexOf('vite-hmr') >= 0;
      const nextUrl = rewriteUrl(url, protocols);
      const socket = arguments.length === 1
        ? new NativeWebSocket(nextUrl)
        : new NativeWebSocket(nextUrl, protocols);

      if (isViteSocket) {
        socket.addEventListener('message', (event) => {
          try {
            const payload = JSON.parse(String(event.data || ''));
            if (payload && (payload.type === 'update' || payload.type === 'full-reload')) {
              schedulePreviewReload();
            }
          } catch {}
        });
      }

      return socket;
    }

    OpenChamberPreviewWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(OpenChamberPreviewWebSocket, NativeWebSocket);
    Object.defineProperty(OpenChamberPreviewWebSocket, 'name', { value: 'WebSocket' });
    window.WebSocket = OpenChamberPreviewWebSocket;
  };

  const selectorPart = (element) => {
    const tag = element.tagName.toLowerCase();
    if (element.id && /^[A-Za-z][\w:.-]*$/.test(element.id)) return tag + '#' + CSS.escape(element.id);
    const testId = element.getAttribute('data-testid') || element.getAttribute('data-test') || element.getAttribute('data-cy');
    if (testId) return tag + '[data-testid="' + CSS.escape(testId) + '"]';
    const classes = Array.from(element.classList || []).slice(0, 3).map((entry) => '.' + CSS.escape(entry)).join('');
    return tag + classes;
  };

  const buildSelector = (element) => {
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      let part = selectorPart(current);
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1 && !part.includes('#') && !part.includes('[data-testid=')) {
          part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
        }
      }
      parts.unshift(part);
      if (part.includes('#')) break;
      current = parent;
    }
    return parts.join(' > ');
  };

  const metadataForElement = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const attributes = {};
    for (const name of ['id', 'class', 'role', 'aria-label', 'href', 'src', 'data-testid', 'data-test', 'data-cy']) {
      const value = typeof element.getAttribute === 'function' ? element.getAttribute(name) : null;
      if (value) attributes[name] = clip(value, 300);
    }
    const ancestry = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && ancestry.length < 6) {
      ancestry.unshift({
        tag: current.tagName.toLowerCase(),
        id: current.id || undefined,
        className: clip(current.className || '', 200) || undefined,
        selectorPart: selectorPart(current),
      });
      current = current.parentElement;
    }
    return {
      frame: 'top',
      tag: element.tagName.toLowerCase(),
      text: clip(element.innerText || element.textContent || ''),
      selector: buildSelector(element),
      path: ancestry.map((entry) => entry.tag).join(' > '),
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      attributes,
      computedStyle: {
        display: style.display,
        position: style.position,
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        zIndex: style.zIndex,
      },
      ancestry,
    };
  };

  const hoverKeyForTarget = (target) => {
    if (!target) return '';
    const bounds = target.bounds || {};
    return [target.selector, Math.round(bounds.x), Math.round(bounds.y), Math.round(bounds.width), Math.round(bounds.height)].join('|');
  };

  const sendHover = (event) => {
    if (!inspectMode) return;
    pendingHover = event;
    if (window.__openchamberPreviewHoverFrame) return;
    window.__openchamberPreviewHoverFrame = window.requestAnimationFrame(() => {
      window.__openchamberPreviewHoverFrame = 0;
      const currentEvent = pendingHover;
      pendingHover = null;
      if (!currentEvent || !inspectMode) return;
      const element = document.elementFromPoint(currentEvent.clientX, currentEvent.clientY);
      const target = metadataForElement(element);
      const key = hoverKeyForTarget(target);
      if (key === lastHoverKey) return;
      lastHoverKey = key;
      post({ type: 'hover', target, pointer: { x: currentEvent.clientX, y: currentEvent.clientY }, ts: Date.now() });
    });
  };

  const setInspectMode = (enabled) => {
    inspectMode = Boolean(enabled);
    lastHoverKey = '';
    document.documentElement.style.cursor = inspectMode ? 'crosshair' : '';
    if (!inspectMode) {
      post({ type: 'hover', target: null, pointer: { x: 0, y: 0 }, ts: Date.now() });
    }
  };

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level];
    console[level] = function() {
      const args = Array.prototype.slice.call(arguments);
      if (level === 'debug' && typeof args[0] === 'string' && args[0].indexOf('[vite]') === 0) {
        return original.apply(console, args);
      }
      post({ type: 'console', level, args: args.map(stringifyArg), ts: Date.now() });
      return original.apply(console, args);
    };
  }

  installViteHmrProxyPatch();

  window.addEventListener('error', (event) => {
    const target = event.target;
    if (target && target !== window && target.nodeType === Node.ELEMENT_NODE) {
      const url = readElementUrl(target);
      if (isInternalDevToolResource(target, url)) {
        return;
      }
      post({
        type: 'resource-error',
        tag: target.tagName.toLowerCase(),
        url: clip(url, 1000),
        outerHTML: clip(target.outerHTML || '', 1000),
        ts: Date.now(),
      });
      return;
    }
    if (isInternalDevToolRuntimeError(event.filename)) {
      return;
    }
    post({
      type: 'runtime-error',
      message: clip(event.message || 'Unknown error', 1000),
      stack: clip(event.error && event.error.stack ? event.error.stack : '', 2000) || undefined,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      ts: Date.now(),
    });
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    post({
      type: 'runtime-error',
      message: clip(event.reason && event.reason.message ? event.reason.message : event.reason || 'Unhandled promise rejection', 1000),
      stack: clip(event.reason && event.reason.stack ? event.reason.stack : '', 2000) || undefined,
      ts: Date.now(),
    });
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.source !== 'openchamber-preview-parent' || data.version !== VERSION) return;
    if (data.type === 'set-inspect-mode') {
      setInspectMode(data.enabled === true);
    }
  });

  window.addEventListener('mousemove', sendHover, true);
  window.addEventListener('mouseleave', () => {
    if (!inspectMode) return;
    lastHoverKey = '';
    post({ type: 'hover', target: null, pointer: { x: 0, y: 0 }, ts: Date.now() });
  }, true);
  window.addEventListener('click', (event) => {
    const anchor = event.target && typeof event.target.closest === 'function' ? event.target.closest('a[href]') : null;
    if (anchor && !inspectMode) {
      const nextUrl = toLoopbackHttpUrl(anchor.href);
      if (shouldParentHandleNavigation(nextUrl)) {
        event.preventDefault();
        event.stopPropagation();
        post({ type: 'navigate-preview', url: nextUrl, ts: Date.now() });
        return;
      }
    }

    if (!inspectMode) return;
    event.preventDefault();
    event.stopPropagation();
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const target = metadataForElement(element);
    if (target) {
      post({ type: 'select', target, pointer: { x: event.clientX, y: event.clientY }, ts: Date.now() });
    }
  }, true);

  window.addEventListener('DOMContentLoaded', () => {
    post({ type: 'ready', url: window.location.href, title: document.title || '' });
  });
  post({ type: 'ready', url: window.location.href, title: document.title || '' });
})();`;

const parseCookieHeader = (cookieHeader) => {
  const result = new Map();
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
    return result;
  }

  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) {
      continue;
    }
    result.set(key, value);
  }
  return result;
};

const buildCookie = ({
  name,
  value,
  path,
  maxAgeSeconds,
  secure,
}) => {
  const chunks = [`${name}=${value}`];
  if (path) chunks.push(`Path=${path}`);
  if (typeof maxAgeSeconds === 'number' && Number.isFinite(maxAgeSeconds)) {
    chunks.push(`Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`);
  }
  chunks.push('HttpOnly');
  chunks.push('SameSite=Lax');
  if (secure) chunks.push('Secure');
  return chunks.join('; ');
};

const normalizeLoopbackUrl = (rawUrl) => {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http(s) URLs are supported' };
  }

  const hostname = url.hostname;
  if (!LOOPBACK_HOSTS.has(hostname)) {
    return { ok: false, error: 'Only loopback hosts are supported' };
  }

  const port = url.port ? Number.parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { ok: false, error: 'Invalid port' };
  }

  // Normalize common loopback hostnames to IPv4 to avoid environments where
  // `localhost` resolves to ::1 but the dev server only binds IPv4.
  if (hostname === '0.0.0.0' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') {
    url.hostname = '127.0.0.1';
  }

  // Only keep origin here; the proxy path is preserved on the OpenChamber side.
  return { ok: true, origin: url.origin };
};

export const createPreviewProxyRuntime = ({
  crypto,
  URL,
  createProxyMiddleware,
  responseInterceptor,
}) => {
  const targets = new Map();
  let sweepTimer = null;

  const now = () => Date.now();

  const sweepExpired = () => {
    const t = now();
    for (const [id, entry] of targets.entries()) {
      if (entry.expiresAt <= t) {
        targets.delete(id);
      }
    }
  };

  const ensureSweeper = () => {
    if (sweepTimer) {
      return;
    }
    sweepTimer = setInterval(sweepExpired, 30_000);
    // Don't keep the process alive.
    sweepTimer.unref?.();
  };

  const createTarget = (origin, ttlMs) => {
    const id = crypto.randomBytes(16).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    const createdAt = now();
    const expiresAt = createdAt + (Number.isFinite(ttlMs) ? Math.max(15_000, Math.trunc(ttlMs)) : DEFAULT_TARGET_TTL_MS);
    targets.set(id, {
      id,
      origin,
      token,
      createdAt,
      expiresAt,
    });
    return { id, token, expiresAt };
  };

  const resolveTargetFromRequest = (req) => {
    const rawUrl = req?.originalUrl || req?.url || '';
    const parsed = new URL(rawUrl, 'http://localhost');
    const pathname = parsed.pathname || '';

    const match = pathname.match(/^\/api\/preview\/proxy\/([a-f0-9]{16,64})(?:\/|$)/i);
    const id = match?.[1] || '';
    if (!id) {
      return { ok: false, status: 404, error: 'Preview target not found' };
    }

    const entry = targets.get(id);
    if (!entry || entry.expiresAt <= now()) {
      targets.delete(id);
      return { ok: false, status: 404, error: 'Preview target expired' };
    }

    const cookies = parseCookieHeader(req.headers?.cookie);
    const token = cookies.get(TOKEN_COOKIE_NAME) || '';
    if (!token || token !== entry.token) {
      return { ok: false, status: 403, error: 'Preview token missing' };
    }

    return { ok: true, id, entry, parsed };
  };

  const stripProxyPrefix = (pathname, id) => {
    const prefix = `/api/preview/proxy/${id}`;
    if (!pathname.startsWith(prefix)) {
      return pathname;
    }
    const rest = pathname.slice(prefix.length);
    return rest.length === 0 ? '/' : rest;
  };

  const removeRawQueryParam = (search, paramName) => {
    if (typeof search !== 'string' || search.length <= 1) {
      return '';
    }
    const query = search.startsWith('?') ? search.slice(1) : search;
    const parts = query.split('&').filter((part) => {
      const name = part.split('=', 1)[0] || '';
      return decodeURIComponent(name.replace(/\+/g, ' ')) !== paramName;
    });
    return parts.length > 0 ? `?${parts.join('&')}` : '';
  };

  // Strip the `frame-ancestors` directive from a CSP header value while
  // preserving every other directive. Returns null if no directives remain.
  const removeFrameAncestorsDirective = (cspValue) => {
    if (typeof cspValue !== 'string' || cspValue.length === 0) {
      return cspValue;
    }
    const directives = cspValue
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    const filtered = directives.filter((directive) => {
      const name = directive.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
      return name !== 'frame-ancestors';
    });

    if (filtered.length === 0) {
      return null;
    }
    return filtered.join('; ');
  };

  // Drop response headers that prevent the dev server from being framed.
  // The proxy itself is same-origin, so embedding is otherwise safe.
  const stripFrameBustingHeaders = (headers) => {
    if (!headers || typeof headers !== 'object') {
      return;
    }

    const headerKeys = Object.keys(headers);
    for (const key of headerKeys) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'x-frame-options') {
        delete headers[key];
        continue;
      }
      if (lowerKey === 'content-security-policy' || lowerKey === 'content-security-policy-report-only') {
        const original = headers[key];
        const values = Array.isArray(original) ? original : [original];
        const rewritten = values
          .map((value) => removeFrameAncestorsDirective(value))
          .filter((value) => typeof value === 'string' && value.length > 0);
        if (rewritten.length === 0) {
          delete headers[key];
        } else {
          headers[key] = Array.isArray(original) ? rewritten : rewritten[0];
        }
      }
    }
  };

  const attach = (app, {
    server,
    express,
    uiAuthController,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
  }) => {
    ensureSweeper();

    const rewritePreviewBody = (bodyText, proxyBasePath) => {
      if (typeof bodyText !== 'string' || bodyText.length === 0) {
        return bodyText;
      }

      const prefix = proxyBasePath.endsWith('/') ? proxyBasePath.slice(0, -1) : proxyBasePath;
      const rewriteRootPath = (value) => {
        if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
          return value;
        }
        if (value.startsWith('/api/preview/proxy/')) {
          return value;
        }
        return `${prefix}${value}`;
      };

      return bodyText
        .replace(/\b(src|href|action)=(["'])\/(?!\/)([^"']*)\2/gi, (_match, attr, quote, path) => {
          return `${attr}=${quote}${rewriteRootPath(`/${path}`)}${quote}`;
        })
        .replace(/\bsrcset=(["'])([^"']*)\1/gi, (_match, quote, value) => {
          const rewritten = String(value).split(',').map((part) => {
            const trimmed = part.trim();
            if (!trimmed) return trimmed;
            const segments = trimmed.split(/\s+/);
            const url = segments[0] || '';
            segments[0] = rewriteRootPath(url);
            return segments.join(' ');
          }).join(', ');
          return `srcset=${quote}${rewritten}${quote}`;
        })
        .replace(/url\((['"]?)\/(?!\/)([^)'"]*)\1\)/gi, (_match, quote, path) => {
          const q = quote || '';
          return `url(${q}${rewriteRootPath(`/${path}`)}${q})`;
        })
        .replace(/@import\s+(["'])\/(?!\/)([^"']*)\1/gi, (_match, quote, path) => {
          return `@import ${quote}${rewriteRootPath(`/${path}`)}${quote}`;
        });
    };

    const injectPreviewBridge = (bodyText) => {
      if (typeof bodyText !== 'string' || bodyText.includes(PREVIEW_BRIDGE_SCRIPT_ID)) {
        return bodyText;
      }

      const script = `<script id="${PREVIEW_BRIDGE_SCRIPT_ID}">${PREVIEW_BRIDGE_SCRIPT}</script>`;
      if (/<head(?:\s[^>]*)?>/i.test(bodyText)) {
        return bodyText.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${script}`);
      }
      if (bodyText.includes('</body>')) {
        return bodyText.replace('</body>', `${script}</body>`);
      }
      return `${bodyText}${script}`;
    };

    const rewriteViteClientHmr = (bodyText, proxyBasePath) => {
      if (typeof bodyText !== 'string' || !bodyText.includes('vite-hmr')) {
        return bodyText;
      }

      const base = proxyBasePath.endsWith('/') ? proxyBasePath : `${proxyBasePath}/`;
      const escapedBase = JSON.stringify(base).slice(1, -1);
      return bodyText
        .replace(/const base\$1 = [^;]+;/, () => `const base$1 = ${JSON.stringify(base)};`)
        .replace(/const base = [^;]+;/, () => `const base = ${JSON.stringify(base)};`)
        .replace(/const hmrPort = [^;]+;/, () => 'const hmrPort = importMetaUrl.port;')
        .replace(/const socketHost = [^;]+;/, () => `const socketHost = \`\${importMetaUrl.hostname}\${importMetaUrl.port ? ':' + importMetaUrl.port : ''}${escapedBase}\`;`)
        .replace(/const directSocketHost = [^;]+;/, () => 'const directSocketHost = socketHost;')
        .replace(
          /const socketHost = `\$\{[^;]+?;\nconst directSocketHost = [^;]+;/s,
          () => `const socketHost = \`\${importMetaUrl.hostname}\${importMetaUrl.port ? ':' + importMetaUrl.port : ''}${escapedBase}\`;\nconst directSocketHost = socketHost;`,
        );
    };

    app.post('/api/preview/targets', express.json(), async (req, res) => {
      try {
        if (uiAuthController?.enabled) {
          const sessionToken = await uiAuthController?.ensureSessionToken?.(req, res);
          if (!sessionToken) {
            return res.status(401).json({ error: 'UI authentication required' });
          }

          const originAllowed = await isRequestOriginAllowed(req);
          if (!originAllowed) {
            return res.status(403).json({ error: 'Invalid origin' });
          }
        }

        const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
        if (!rawUrl) {
          return res.status(400).json({ error: 'url is required' });
        }

        const ttlMs = typeof req.body?.ttlMs === 'number' ? req.body.ttlMs : DEFAULT_TARGET_TTL_MS;
        const normalized = normalizeLoopbackUrl(rawUrl);
        if (!normalized.ok) {
          return res.status(400).json({ error: normalized.error });
        }

        const target = createTarget(normalized.origin, ttlMs);
        const cookiePath = `/api/preview/proxy/${target.id}`;
        const secure = Boolean(req.secure);
        res.setHeader('Set-Cookie', buildCookie({
          name: TOKEN_COOKIE_NAME,
          value: target.token,
          path: cookiePath,
          maxAgeSeconds: Math.round((target.expiresAt - now()) / 1000),
          secure,
        }));

        return res.json({
          id: target.id,
          proxyBasePath: cookiePath,
          expiresAt: target.expiresAt,
        });
      } catch (error) {
        console.error('[preview-proxy] Failed to create target:', error);
        return res.status(500).json({ error: 'Failed to create preview target' });
      }
    });

    const proxy = createProxyMiddleware({
      target: 'http://127.0.0.1',
      changeOrigin: true,
      ws: true,
      selfHandleResponse: true,
      // Restrict the proxy (especially its auto-attached `upgrade` listener,
      // which is registered globally on the underlying HTTP server when
      // `ws: true`) to preview paths. Without this, every WebSocket upgrade
      // on the server (e.g. `/api/terminal/ws`) gets proxied to
      // `http://127.0.0.1` and tears the socket down with ECONNREFUSED.
      //
      // We use a function so the same filter handles both cases:
      //   - HTTP requests through Express, where `req.url` has been stripped
      //     of the `/api/preview/proxy` mount-point, so we check `originalUrl`.
      //   - Raw upgrade events from the HTTP server, where `req.url` still
      //     contains the full path.
      pathFilter: (pathname, req) => {
        const target = req?.originalUrl || pathname || req?.url || '';
        return target.startsWith('/api/preview/proxy/');
      },
      router: (req) => {
        const resolved = resolveTargetFromRequest(req);
        if (!resolved.ok) {
          return 'http://127.0.0.1';
        }
        return resolved.entry.origin;
      },
      pathRewrite: (pathValue, req) => {
        const resolved = resolveTargetFromRequest(req);
        if (!resolved.ok) {
          return pathValue;
        }

        const parsed = new URL(req.originalUrl || req.url || '', 'http://localhost');
        // Never forward our auth cookie token to the dev server.
        const strippedPath = stripProxyPrefix(parsed.pathname, resolved.id);
        return `${strippedPath}${removeRawQueryParam(parsed.search, 'ocPreview')}`;
      },
      on: {
        proxyReq: (proxyReq) => {
          // Keep local dev servers from receiving OpenChamber credentials.
          proxyReq.removeHeader('cookie');
          proxyReq.removeHeader('authorization');
          proxyReq.removeHeader('x-openchamber-ui-session');
          proxyReq.setHeader('accept-encoding', 'identity');
        },
        proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req) => {
          // Allow the dev server response to be framed inside OpenChamber even
          // if it normally sets X-Frame-Options or a CSP frame-ancestors rule.
          // The proxy is same-origin so embedding is otherwise safe.
          stripFrameBustingHeaders(proxyRes.headers);

          const contentType = String(proxyRes.headers?.['content-type'] || '').toLowerCase();
          const isHtml = contentType.includes('text/html');
          const isCss = contentType.includes('text/css');
          const isJavaScript = contentType.includes('javascript') || contentType.includes('ecmascript');
          if (!isHtml && !isCss && !isJavaScript) {
            return responseBuffer;
          }

          proxyRes.headers['cache-control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
          proxyRes.headers.pragma = 'no-cache';
          proxyRes.headers.expires = '0';
          delete proxyRes.headers.etag;
          delete proxyRes.headers['last-modified'];

          const resolved = resolveTargetFromRequest(req);
          if (!resolved.ok) {
            return responseBuffer;
          }

          const proxyBasePath = `/api/preview/proxy/${resolved.id}`;
          const parsed = new URL(req.originalUrl || req.url || '', 'http://localhost');
          const upstreamPath = stripProxyPrefix(parsed.pathname, resolved.id);
          if (isJavaScript && upstreamPath === '/@vite/client') {
            return rewriteViteClientHmr(responseBuffer.toString('utf8'), proxyBasePath);
          }

          const rewrittenBody = rewritePreviewBody(responseBuffer.toString('utf8'), proxyBasePath);
          return isHtml ? injectPreviewBridge(rewrittenBody) : rewrittenBody;
        }),
        error: (err, _req, res) => {
          const isDev = typeof process !== 'undefined'
            && process
            && process.env
            && process.env.NODE_ENV !== 'production';

          const message = err && typeof err === 'object' && typeof err.message === 'string'
            ? err.message
            : 'Unknown proxy error';

          console.error('[preview-proxy] proxy error:', message);

          if (res && !res.headersSent && typeof res.status === 'function') {
            const payload = { error: 'Preview proxy error' };

            if (isDev) {
              try {
                const resolved = resolveTargetFromRequest(_req);
                payload.details = {
                  message,
                  code: err && typeof err === 'object' ? err.code : undefined,
                  targetOrigin: resolved?.ok ? resolved.entry.origin : undefined,
                };
              } catch {
                payload.details = { message };
              }
            }

            res.status(502).json(payload);
          }
        },
      },
    });

    app.use('/api/preview/proxy', (req, res, next) => {
      const resolved = resolveTargetFromRequest(req);
      if (!resolved.ok) {
        return res.status(resolved.status).json({ error: resolved.error });
      }
      next();
    }, proxy);

    server.on('upgrade', (req, socket, head) => {
      const resolved = resolveTargetFromRequest(req);
      if (!resolved.ok) {
        return;
      }

      const handleUpgrade = async () => {
        try {
          if (uiAuthController?.enabled) {
            const sessionToken = await uiAuthController?.ensureSessionToken?.(req, null);
            if (!sessionToken) {
              rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
              return;
            }

            const originAllowed = await isRequestOriginAllowed(req);
            if (!originAllowed) {
              rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
              return;
            }
          }

          // Rewrite req.url to what the dev server expects.
          const rawUrl = req.url || '';
          const parsed = new URL(rawUrl, 'http://localhost');
          const nextPath = stripProxyPrefix(parsed.pathname, resolved.id);
          const search = parsed.searchParams.toString();
          req.url = `${nextPath}${search ? `?${search}` : ''}`;
          proxy.upgrade(req, socket, head);
        } catch {
          rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
        }
      };

      void handleUpgrade();
    });
  };

  return {
    attach,
  };
};

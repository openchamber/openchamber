import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';

type DesktopBridgeGlobal = {
  openExternal?: (url: string) => Promise<unknown>;
};

const parseUrlSafely = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

export const isExternalHttpUrl = (url: string): boolean => {
  const parsed = parseUrlSafely(url.trim());
  if (!parsed) {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
};

/** Lowercased URL scheme without the trailing colon, or null when unparseable. */
export const getUrlScheme = (url: string): string | null => {
  const parsed = parseUrlSafely(url.trim());
  if (!parsed) {
    return null;
  }
  return parsed.protocol.replace(/:$/, '').toLowerCase();
};

/**
 * Schemes the browser or OS communication apps already handle natively
 * (mailto:, tel:, sms:, ...). They are not application deep links.
 */
const BROWSER_HANDLED_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'sms', 'callto', 'cid', 'xmpp', 'irc', 'news', 'nntp', 'feed', 'webcal']);

/**
 * Schemes that must never be preserved or opened from rendered chat content.
 */
const BLOCKED_APP_LINK_SCHEMES = new Set([
  // Scriptable or web-content schemes
  'javascript', 'data', 'vbscript', 'blob', 'filesystem', 'about',
  // WebView/Electron internal schemes
  'chrome', 'chrome-extension', 'devtools', 'moz-extension', 'ms-browser-extension',
  // Local files flow through the dedicated file-link handling
  'file',
  // Network protocols that are not application links
  'ws', 'wss', 'ftp', 'ftps',
  // Android intent URIs can launch arbitrary components with extras
  'intent',
  // Historically abused Windows handlers can invoke diagnostic, shell, or
  // file-search flows that must not be offered from untrusted chat content.
  'ms-msdt', 'search-ms', 'shell',
  // OpenChamber's own schemes must not be re-launched from chat content
  'openchamber', 'openchamber-ui', 'capacitor',
]);

const APP_LINK_SCHEME_RE = /^[a-z][a-z0-9+.-]{1,31}$/;

/**
 * True for custom application deep links such as `obsidian://`, `linear://`,
 * or `vscode://`. Browser-handled and dangerous/internal schemes are excluded,
 * so a true result means the link may be offered to the user behind a
 * confirmation the first time its scheme appears.
 */
export const isAppLinkUrl = (url: string): boolean => {
  const scheme = getUrlScheme(url);
  if (!scheme) {
    return false;
  }
  if (BROWSER_HANDLED_SCHEMES.has(scheme) || BLOCKED_APP_LINK_SCHEMES.has(scheme)) {
    return false;
  }
  return APP_LINK_SCHEME_RE.test(scheme);
};

export const getExternalFaviconUrl = (url: string): string | null => {
  const parsed = parseUrlSafely(url.trim());
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return null;
  }

  return `https://icons.duckduckgo.com/ip3/${parsed.hostname.toLowerCase()}.ico`;
};

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/**
 * Returns true when the URL is an http(s) URL pointing at a loopback host
 * (localhost, 127.0.0.1, 0.0.0.0, ::1). Used to decide whether to offer an in-app
 * preview pane instead of opening the system browser.
 */
export const isLoopbackHttpUrl = (url: string): boolean => {
  const parsed = parseUrlSafely(url.trim());
  if (!parsed) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  return LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
};

const LOOPBACK_URL_PATTERN
  // eslint-disable-next-line no-control-regex
  = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s<>"'`\u0000-\u001f]*)?/gi;

/**
 * Extracts loopback http(s) URLs from a free-text string. Returns unique URLs
 * in order of first appearance. Trailing punctuation that is unlikely to be
 * part of a real URL is stripped.
 */
export const extractLoopbackUrls = (text: string): string[] => {
  if (!text) {
    return [];
  }
  const matches = text.match(LOOPBACK_URL_PATTERN);
  if (!matches || matches.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[),.;:!?'"`]+$/g, '');
    if (!cleaned || !isLoopbackHttpUrl(cleaned)) {
      continue;
    }
    if (seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
};

/**
 * Opens an external URL in the system browser.
 * In desktop runtime, uses the native shell for proper handling.
 * Falls back to window.open() for web runtime.
 *
 * @param url - The URL to open
 * @returns Promise<boolean> - true if the URL was opened successfully
 */
const openValidatedExternalUrl = async (url: string): Promise<boolean> => {
  if (typeof window === 'undefined') {
    return false;
  }

  const target = url.trim();
  if (!target) {
    return false;
  }

  const parsed = parseUrlSafely(target);
  if (!parsed) {
    return false;
  }

  const normalizedTarget = parsed.toString();

  const runtimeApis = getRegisteredRuntimeAPIs();
  if (runtimeApis?.runtime?.isVSCode && runtimeApis.vscode?.openExternalUrl) {
    try {
      await runtimeApis.vscode.openExternalUrl(normalizedTarget);
      return true;
    } catch {
      return false;
    }
  }

  const desktop = (window as unknown as { __OPENCHAMBER_DESKTOP__?: DesktopBridgeGlobal }).__OPENCHAMBER_DESKTOP__;
  if (desktop?.openExternal) {
    try {
      await desktop.openExternal(normalizedTarget);
      return true;
    } catch {
      // Fall through to window.open
    }
  }

  try {
    window.open(normalizedTarget, '_blank', 'noopener,noreferrer');
    return true;
  } catch {
    return false;
  }
};

export const openExternalUrl = (url: string): Promise<boolean> =>
  isExternalHttpUrl(url) ? openValidatedExternalUrl(url) : Promise.resolve(false);

/** Opens a classified app link after the caller has completed confirmation. */
export const openConfirmedAppLinkUrl = (url: string): Promise<boolean> =>
  isAppLinkUrl(url) ? openValidatedExternalUrl(url) : Promise.resolve(false);

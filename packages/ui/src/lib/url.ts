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

export const getUrlScheme = (url: string): string | null => {
  const parsed = parseUrlSafely(url.trim());
  if (!parsed) {
    return null;
  }
  return parsed.protocol.replace(/:$/, '').toLowerCase();
};

const BROWSER_HANDLED_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'sms', 'callto', 'cid', 'xmpp', 'irc', 'news', 'nntp', 'feed', 'webcal']);

const BLOCKED_APP_LINK_SCHEMES = new Set([
  'javascript', 'data', 'vbscript', 'blob', 'filesystem', 'about',
  'chrome', 'chrome-extension', 'devtools', 'moz-extension', 'ms-browser-extension',
  'file',
  'ws', 'wss', 'ftp', 'ftps',
  'intent',
  'ms-msdt', 'search-ms', 'shell',
  'openchamber', 'openchamber-ui', 'capacitor',
]);

const APP_LINK_SCHEME_RE = /^[a-z][a-z0-9+.-]{1,31}$/;

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

export const isLoopbackHttpUrl = (url: string): boolean => {
  const parsed = parseUrlSafely(url.trim());
  if (!parsed) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return LOOPBACK_HOSTNAMES.has(hostname);
};

const LOOPBACK_URL_PATTERN
  // oxlint-disable-next-line no-control-regex
  = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s<>"'`\u0000-\u001f]*)?/gi;

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
      if (isAppLinkUrl(normalizedTarget)) return false;
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

export const openConfirmedAppLinkUrl = (url: string): Promise<boolean> =>
  isAppLinkUrl(url) ? openValidatedExternalUrl(url) : Promise.resolve(false);

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isAppLinkScheme, type AppLinkSchemeContext } from '@/lib/appLinkSchemes';
import { getVSCodeBootstrapConfig } from '@/lib/vscodeBootstrap';

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

const ALLOWED_MAILTO_QUERY_KEYS = new Set(['to', 'cc', 'bcc', 'subject', 'body', 'in-reply-to', 'references']);
const ENCODED_CONTROL_BYTE_RE = /%([01][0-9a-f]|7f)/i;

const hasControlCharacters = (value: string, allowLineBreaks = false): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (allowLineBreaks && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

const hasUnsafeRawCharacters = (value: string): boolean => /\s/.test(value) || value.includes('\\') || value.includes('"');

export const isMailtoUrl = (url: string): boolean => {
  if (hasControlCharacters(url)) return false;
  const trimmed = url.trim();
  if (!trimmed || /^mailto:\/\//i.test(trimmed) || hasUnsafeRawCharacters(trimmed)) return false;
  const parsed = parseUrlSafely(trimmed);
  if (!parsed || parsed.protocol !== 'mailto:') return false;
  if (!parsed.pathname.trim() && parsed.searchParams.size === 0) return false;
  if (ENCODED_CONTROL_BYTE_RE.test(parsed.pathname) || ENCODED_CONTROL_BYTE_RE.test(parsed.hash)) return false;
  for (const [key, value] of parsed.searchParams.entries()) {
    const normalizedKey = key.toLowerCase();
    if (!ALLOWED_MAILTO_QUERY_KEYS.has(normalizedKey)) return false;
    if (hasControlCharacters(value, normalizedKey === 'body')) return false;
  }
  const serialized = parsed.toString();
  return !hasControlCharacters(serialized) && !hasUnsafeRawCharacters(serialized);
};

export const getUrlScheme = (url: string): string | null => {
  const parsed = parseUrlSafely(url.trim());
  if (!parsed) {
    return null;
  }
  return parsed.protocol.replace(/:$/, '').toLowerCase();
};

const appLinkSchemeContext = (): AppLinkSchemeContext => {
  const config = getVSCodeBootstrapConfig();
  if (config) {
    return { editorUriScheme: config.uriScheme ?? '' };
  }
  return getRegisteredRuntimeAPIs()?.runtime?.isVSCode ? { editorUriScheme: '' } : {};
};

export const isAppLinkUrl = (url: string): boolean => {
  const scheme = getUrlScheme(url);
  if (!scheme) {
    return false;
  }
  return isAppLinkScheme(scheme, appLinkSchemeContext());
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

const openValidatedExternalUrl = async (url: string, browserFallback = true): Promise<boolean> => {
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
      if (!browserFallback || isAppLinkUrl(normalizedTarget)) return false;
    }
  }

  if (!browserFallback) {
    return false;
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

export const openMailtoUrl = (url: string): Promise<boolean> =>
  isMailtoUrl(url) ? openValidatedExternalUrl(url, false) : Promise.resolve(false);

export const DEV_TUNNEL_HOSTNAME = 'openchamber-preview.localhost';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', DEV_TUNNEL_HOSTNAME]);

const isLoopbackAuthority = (value: string): boolean => {
  const host = value.split('/')[0]?.split('?')[0] ?? '';
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0] ?? '';
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
};

export const BLANK_URL = 'about:blank';

const SEARCH_ORIGIN = 'https://www.google.com';
const SEARCH_PATH = '/search';

const searchUrl = (query: string): string => `${SEARCH_ORIGIN}${SEARCH_PATH}?q=${encodeURIComponent(query)}`;

export const framableUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== SEARCH_ORIGIN || parsed.pathname !== SEARCH_PATH || parsed.searchParams.has('igu')) return url;
    parsed.searchParams.set('igu', '1');
    return parsed.toString();
  } catch {
    return url;
  }
};

const looksLikeHost = (parsed: URL, typed: string): boolean => (
  parsed.hostname.includes('.')
  || parsed.hostname.startsWith('[')
  || isLoopbackAuthority(typed)
  || parsed.port !== ''
);

export const normalizeBrowserUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return BLANK_URL;

  if (trimmed.includes('://')) {
    try {
      const parsed = new URL(trimmed);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : BLANK_URL;
    } catch {
      return /\s/.test(trimmed) ? searchUrl(trimmed) : BLANK_URL;
    }
  }

  if (/\s/.test(trimmed)) return searchUrl(trimmed);
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed)) return BLANK_URL;
  try {
    const parsed = new URL(`${isLoopbackAuthority(trimmed) ? 'http' : 'https'}://${trimmed}`);
    return looksLikeHost(parsed, trimmed) ? parsed.toString() : searchUrl(trimmed);
  } catch {
    return searchUrl(trimmed);
  }
};

export const isLoopbackUrl = (value: string): boolean => {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
};

export const browserUrlLabel = (value: string): string => {
  if (!value || value === BLANK_URL) return '';
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
};

const RETRYABLE_LOAD_ERROR_CODES = new Set([
  -2,
  -7,
  -101,
  -102,
  -104,
  -109,
  -118,
  -324,
]);

const isLocalhostName = (url: string): boolean => {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'localhost' || hostname.endsWith('.localhost');
  } catch {
    return false;
  }
};

export const isStartingServerFailure = (code: number, url: string): boolean => (
  RETRYABLE_LOAD_ERROR_CODES.has(code) && (isLoopbackUrl(url) || isLocalhostName(url))
);

export const isStartingServerAnswer = (httpStatus: number, url: string): boolean => (
  (httpStatus === 404 || httpStatus >= 500) && (isLoopbackUrl(url) || isLocalhostName(url))
);

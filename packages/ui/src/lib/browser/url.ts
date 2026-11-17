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

export const normalizeBrowserUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return BLANK_URL;

  const withScheme = trimmed.includes('://')
    ? trimmed
    : `${isLoopbackAuthority(trimmed) ? 'http' : 'https'}://${trimmed}`;

  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return BLANK_URL;
    return parsed.toString();
  } catch {
    return BLANK_URL;
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

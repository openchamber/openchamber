/**
 * Address-bar input handling for the browser surface.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/** `localhost:5173`, `127.0.0.1:3000` — an authority with no scheme. */
const isLoopbackAuthority = (value: string): boolean => {
  const host = value.split('/')[0]?.split('?')[0] ?? '';
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0] ?? '';
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
};

export const BLANK_URL = 'about:blank';

/**
 * Normalizes what the user typed into a URL the browser can load.
 *
 * Schemeless input defaults to `https:`, except for loopback authorities:
 * dev servers overwhelmingly speak plain HTTP, and defaulting `localhost:5173`
 * to HTTPS turns the single most common address in this panel into a
 * connection error.
 */
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

/** True when a URL points at the machine the page is loaded from. */
export const isLoopbackUrl = (value: string): boolean => {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
};

/** Short label for a tab or header: host plus port, falling back to the raw value. */
export const browserUrlLabel = (value: string): string => {
  if (!value || value === BLANK_URL) return '';
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
};

/**
 * Chromium network errors that mean "nothing is answering there yet".
 *
 * A dev server is routinely opened the moment its address appears in the
 * terminal, before it accepts connections, so the first load fails as a matter
 * of course. Treating that as a dead end — and making the user press reload —
 * is the single most common way this panel feels broken.
 */
const RETRYABLE_LOAD_ERROR_CODES = new Set([
  -2,   // FAILED (generic; Electron reports this for some early refusals)
  -7,   // TIMED_OUT
  -101, // CONNECTION_RESET
  -102, // CONNECTION_REFUSED
  -104, // CONNECTION_FAILED
  -109, // ADDRESS_UNREACHABLE
  -118, // CONNECTION_TIMED_OUT
  -324, // EMPTY_RESPONSE
]);

/**
 * Whether a failed load is worth retrying. Restricted to loopback: retrying a
 * public site that refused us is just hammering somebody else's server, and a
 * remote dev server is reached through a local tunnel port anyway.
 */
export const isStartingServerFailure = (code: number, url: string): boolean => (
  RETRYABLE_LOAD_ERROR_CODES.has(code) && isLoopbackUrl(url)
);

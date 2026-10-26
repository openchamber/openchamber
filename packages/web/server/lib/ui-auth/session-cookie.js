/**
 * Session cookie naming that is stable per host:port.
 *
 * Browsers do not isolate cookies by port (RFC 6265). Instances on the same
 * hostname overwrite one another's session cookies without distinct names.
 * This applies to LAN addresses and same-host loopback instances alike.
 *
 * We fold the request port into the cookie name so each port owns its own
 * cookie. Password/passkey session issuance and validation (`ui-auth.js`) and
 * notification identity extraction (`request-security.js`) share this resolver.
 * A host with no explicit port keeps the bare `oc_ui_session` name.
 */
export const SESSION_COOKIE_BASE = 'oc_ui_session';

const forwardedHost = (headers) => {
  const forwarded = headers?.['x-forwarded-host'];
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    return forwarded.split(',')[0].trim();
  }
  const host = headers?.host;
  return typeof host === 'string' ? host.trim() : '';
};

/**
 * Extract the trailing port from a Host authority, or null when there is none.
 * Handles bracketed IPv6 (`[::1]:3000`, `[::1]`) and plain host names.
 */
const hostPort = (host) => {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return null;
    const rest = host.slice(end + 1);
    if (!rest.startsWith(':')) return null;
    return /^\d+$/.test(rest.slice(1)) ? rest.slice(1) : null;
  }
  const matches = host.match(/:(\d+)$/);
  return matches ? matches[1] : null;
};

/**
 * Resolve the session cookie name for a request. Returns the bare base name
 * when the host carries no explicit port, otherwise `<base>_<port>`.
 */
export const sessionCookieNameForRequest = (req, base = SESSION_COOKIE_BASE) => {
  const host = forwardedHost(req?.headers || {});
  const port = host ? hostPort(host) : null;
  if (!port) return base;
  const portNumber = Number.parseInt(port, 10);
  if (!Number.isFinite(portNumber) || portNumber <= 0) return base;
  return `${base}_${port}`;
};

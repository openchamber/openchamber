/**
 * Session cookie naming that is stable per host:port.
 *
 * Browsers do not isolate cookies by port (RFC 6265 — the cookie jar is keyed
 * on the host only). Two OpenChamber instances reached via the same LAN address
 * but different ports (`http://192.168.0.1:3000` and `:3001`) therefore share
 * one `oc_ui_session` cookie, and the instance logged into last silently
 * overwrites the other, logging both tabs out and breaking CSRF (issue #2377).
 *
 * We fold the request port into the cookie name so each port owns its own
 * cookie. The port is read from the request Host on BOTH the set side
 * (`ui-auth.js`) and the CSRF read side (`request-security.js`) through this one
 * function, so the names can never drift apart. Loopback URLs are unaffected:
 * a browser keeps separate jars for `localhost` vs `127.0.0.1`, and a host with
 * no explicit port keeps the bare `oc_ui_session` name for back-compat.
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

/** True when `name` is a session cookie for `base` (bare or a numeric-port variant). */
export const isSessionCookieName = (name, base = SESSION_COOKIE_BASE) =>
  name === base
  || (name.startsWith(`${base}_`) && /^\d+$/.test(name.slice(base.length + 1)));

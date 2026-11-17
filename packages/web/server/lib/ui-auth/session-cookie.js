// external: https://www.rfc-editor.org/rfc/rfc6265#section-8.5 Cookies are shared across ports, so session cookie names include the request port.
export const SESSION_COOKIE_BASE = 'oc_ui_session';

const forwardedHost = (headers) => {
  const forwarded = headers?.['x-forwarded-host'];
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    return forwarded.split(',')[0].trim();
  }
  const host = headers?.host;
  return typeof host === 'string' ? host.trim() : '';
};

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

export const sessionCookieNameForRequest = (req, base = SESSION_COOKIE_BASE) => {
  const host = forwardedHost(req?.headers || {});
  const port = host ? hostPort(host) : null;
  if (!port) return base;
  const portNumber = Number.parseInt(port, 10);
  if (!Number.isFinite(portNumber) || portNumber <= 0) return base;
  return `${base}_${port}`;
};

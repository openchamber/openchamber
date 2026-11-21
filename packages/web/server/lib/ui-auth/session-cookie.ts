import type { IncomingHttpHeaders } from 'node:http';

export interface SessionCookieRequest {
  headers?: IncomingHttpHeaders;
}

export const SESSION_COOKIE_BASE = 'oc_ui_session';

const isHostHeader = (value: unknown): value is string => typeof value === 'string';

const forwardedHost = (headers: IncomingHttpHeaders) => {
  const forwarded = headers?.['x-forwarded-host'];
  if (isHostHeader(forwarded) && forwarded.trim().length > 0) {
    return forwarded.split(',')[0]?.trim() ?? '';
  }
  const host = headers?.host;
  return isHostHeader(host) ? host.trim() : '';
};

const hostPort = (host: string) => {
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

export const sessionCookieNameForRequest = (req: SessionCookieRequest | null | undefined, base = SESSION_COOKIE_BASE) => {
  const host = forwardedHost(req?.headers || {});
  const port = host ? hostPort(host) : null;
  if (!port) return base;
  const portNumber = Number.parseInt(port, 10);
  if (!Number.isFinite(portNumber) || portNumber <= 0) return base;
  return `${base}_${port}`;
};

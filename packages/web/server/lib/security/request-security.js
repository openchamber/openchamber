import { sessionCookieNameForRequest } from '../ui-auth/session-cookie.js';

export const isOpaqueOriginRequest = (req) => {
  const header = req?.headers?.origin;
  const value = Array.isArray(header) ? header[0] : header;
  return String(value ?? '').trim() === 'null';
};

export const allowsLocalDevOrigins = (env) => env.OPENCHAMBER_ELECTRON_DEV === '1' || env.OPENCHAMBER_ALLOW_DEV_ORIGINS === '1';
export const isLocalDevClientOrigin = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

const PACKAGED_FRAME_ANCESTORS = ['openchamber-ui://app', 'capacitor://localhost', 'https://localhost'];
const FRAME_ANCESTOR_SOURCE = /^(?:\*|https?:\/\/[a-z0-9.-]+(?::(?:\d{1,5}|\*))?)$/i;

export const buildFrameAncestorsPolicy = ({ allowLocalDevOrigins = false, extra = '' } = {}) => {
  const sources = ["'self'", ...PACKAGED_FRAME_ANCESTORS];
  if (allowLocalDevOrigins) sources.push('http://127.0.0.1:*', 'http://localhost:*');
  for (const source of String(extra).split(/[\s,]+/)) {
    if (source && FRAME_ANCESTOR_SOURCE.test(source)) sources.push(source);
  }
  return `frame-ancestors ${sources.join(' ')}`;
};

export const isPasswordlessSocketOriginAllowed = async (req, isRequestOriginAllowed) => {
  const header = req?.headers?.origin;
  const origin = String((Array.isArray(header) ? header[0] : header) ?? '').trim();
  if (!origin) return true;
  return Boolean(await isRequestOriginAllowed(req));
};

export const createRequestSecurityRuntime = (deps) => {
  const { readSettingsFromDiskMigrated, allowLocalDevOrigins = false } = deps;
  const packagedClientOrigins = new Set([
    'openchamber-ui://app',
    'capacitor://localhost',
    'https://localhost',
  ]);

  const getUiSessionTokenFromRequest = (req) => {
    const cookieHeader = req?.headers?.cookie;
    if (!cookieHeader || typeof cookieHeader !== 'string') {
      return null;
    }
    const expected = sessionCookieNameForRequest(req);
    for (const segment of cookieHeader.split(';')) {
      const [rawName, ...rest] = segment.split('=');
      if (rawName?.trim() !== expected) continue;
      const value = rest.join('=').trim();
      try {
        return decodeURIComponent(value || '');
      } catch {
        return value || null;
      }
    }
    return null;
  };

  const rejectWebSocketUpgrade = (socket, statusCode, reason) => {
    if (!socket || socket.destroyed) {
      return;
    }

    const message = typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : 'Bad Request';
    const body = Buffer.from(message, 'utf8');
    const statusText = {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      500: 'Internal Server Error',
    }[statusCode] || 'Bad Request';

    try {
      socket.write(
        `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${body.length}\r\n\r\n`
      );
      socket.write(body);
    } catch {
    }

    try {
      socket.destroy();
    } catch {
    }
  };

  const getRequestOriginCandidates = async (req) => {
    const origins = new Set();
    const hosts = new Set();
    const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string'
      ? req.headers['x-forwarded-proto'].split(',')[0].trim().toLowerCase()
      : '';
    const protocol = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');

    const forwardedHost = typeof req.headers['x-forwarded-host'] === 'string'
      ? req.headers['x-forwarded-host'].split(',')[0].trim()
      : '';
    const host = forwardedHost || (typeof req.headers.host === 'string' ? req.headers.host.trim() : '');

    if (host) {
      hosts.add(host.toLowerCase());
      origins.add(`${protocol}://${host}`);
      const [hostname, port] = host.split(':');
      const normalizedHost = typeof hostname === 'string' ? hostname.toLowerCase() : '';
      const portSuffix = typeof port === 'string' && port.length > 0 ? `:${port}` : '';
      if (normalizedHost === 'localhost') {
        origins.add(`${protocol}://127.0.0.1${portSuffix}`);
        origins.add(`${protocol}://[::1]${portSuffix}`);
      } else if (normalizedHost === '127.0.0.1' || normalizedHost === '[::1]') {
        origins.add(`${protocol}://localhost${portSuffix}`);
      }
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      if (typeof settings?.publicOrigin === 'string' && settings.publicOrigin.trim().length > 0) {
        origins.add(new URL(settings.publicOrigin.trim()).origin);
      }
    } catch {
    }

    return { origins, hosts };
  };

  const isRequestOriginAllowed = (req) => {
    const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    if (!originHeader) {
      return false;
    }

    if (packagedClientOrigins.has(originHeader)) {
      return true;
    }
    if (allowLocalDevOrigins && isLocalDevClientOrigin(originHeader)) {
      return true;
    }

    let origin;
    try {
      origin = new URL(originHeader);
    } catch {
      return false;
    }

    const forwardedHostHeader = req.headers['x-forwarded-host'];
    const forwardedHost = (Array.isArray(forwardedHostHeader) ? forwardedHostHeader[0] : forwardedHostHeader || '')
      .split(',')[0].trim().toLowerCase();
    const hostHeader = req.headers.host;
    const host = forwardedHost || (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader || '').trim().toLowerCase();
    if (host && host === origin.host.toLowerCase()) return true;

    return getRequestOriginCandidates(req).then((candidates) => (
      candidates.origins.has(origin.origin) || candidates.hosts.has(origin.host.toLowerCase())
    ));
  };

  return {
    getUiSessionTokenFromRequest,
    rejectWebSocketUpgrade,
    isRequestOriginAllowed,
  };
};

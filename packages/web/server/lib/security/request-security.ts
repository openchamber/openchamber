import { sessionCookieNameForRequest } from '../ui-auth/session-cookie.js';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

export interface SecurityRequest {
  headers: NodeJS.Dict<string | string[]>;
  socket?: Socket & { encrypted?: boolean };
}

export interface FrameAncestorsOptions {
  allowLocalDevOrigins?: boolean;
  extra?: string | undefined;
}

export interface RequestSecurityDependencies {
  readSettingsFromDiskMigrated: () => Promise<PublicOriginSettings | null>;
  allowLocalDevOrigins?: boolean;
}

export interface PublicOriginSettings {
  publicOrigin?: string;
}

export type RequestOriginChecker = (req: SecurityRequest) => Promise<boolean>;

const isString = (value: unknown): value is string => typeof value === 'string';

const firstHeaderValue = (value: string | string[] | undefined, method: 'split' | 'trim') => {
  const first = Array.isArray(value) ? value[0] : value || '';
  if (first === undefined) throw new TypeError(`Cannot read properties of undefined (reading '${method}')`);
  return first;
};

export const isOpaqueOriginRequest = (req: Pick<SecurityRequest, 'headers'> | null | undefined) => {
  const header = req?.headers?.origin;
  const value = Array.isArray(header) ? header[0] : header;
  return String(value ?? '').trim() === 'null';
};

export const allowsLocalDevOrigins = (env: NodeJS.ProcessEnv) => env.OPENCHAMBER_ELECTRON_DEV === '1' || env.OPENCHAMBER_ALLOW_DEV_ORIGINS === '1';
export const isLocalDevClientOrigin = (origin: string) => /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

const PACKAGED_FRAME_ANCESTORS = ['openchamber-ui://app', 'capacitor://localhost', 'https://localhost'];
const FRAME_ANCESTOR_SOURCE = /^(?:\*|https?:\/\/[a-z0-9.-]+(?::(?:\d{1,5}|\*))?)$/i;

export const buildFrameAncestorsPolicy = ({ allowLocalDevOrigins = false, extra = '' }: FrameAncestorsOptions = {}) => {
  const sources = ["'self'", ...PACKAGED_FRAME_ANCESTORS];
  if (allowLocalDevOrigins) sources.push('http://127.0.0.1:*', 'http://localhost:*');
  for (const source of String(extra).split(/[\s,]+/)) {
    if (source && FRAME_ANCESTOR_SOURCE.test(source)) sources.push(source);
  }
  return `frame-ancestors ${sources.join(' ')}`;
};

const CLIENT_CORS_ORIGINS = ['openchamber-ui://app', 'capacitor://localhost', 'http://localhost', 'https://localhost'];
const HEADER_REFLECTING_ORIGINS = new Set(['openchamber-ui://app']);
const CLIENT_CORS_ALLOW_HEADERS = 'Content-Type,Authorization,Accept,X-Requested-With,Cache-Control,X-OpenCode-Directory,X-OpenCode-Directory-Encoding,Ngrok-Skip-Browser-Warning,CF-Access-Client-Id,CF-Access-Client-Secret,X-OpenChamber-Surface,X-OpenChamber-Provider,X-OpenChamber-Model,X-OpenChamber-Part-Shells';
// external: https://www.rfc-editor.org/rfc/rfc9110#section-5.6.2 field names are tokens; list separators allow only space or tab around the comma.
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const CORS_WILDCARD = '*';

const parseRequestedHeaderNames = (value: string | string[] | undefined): string | null => {
  if (!isString(value)) return null;
  const names = value.split(',').map((name) => name.replace(/^[ \t]+|[ \t]+$/g, ''));
  if (!names.every((name) => HTTP_TOKEN.test(name) && name !== CORS_WILDCARD)) return null;
  return names.join(', ');
};

export const resolveClientCorsHeaders = (
  req: Pick<SecurityRequest, 'headers'>,
  { allowLocalDevOrigins = false }: { allowLocalDevOrigins?: boolean } = {},
): Record<string, string> | null => {
  const origin = isString(req.headers.origin) ? req.headers.origin : '';
  if (!CLIENT_CORS_ORIGINS.includes(origin) && !(allowLocalDevOrigins && isLocalDevClientOrigin(origin))) return null;
  const reflected = HEADER_REFLECTING_ORIGINS.has(origin)
    ? parseRequestedHeaderNames(req.headers['access-control-request-headers'])
    : null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': reflected ?? CLIENT_CORS_ALLOW_HEADERS,
    'Access-Control-Expose-Headers': 'x-next-cursor,x-openchamber-error',
    // external: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Max-Age Chromium caps the preflight cache lifetime at 2 hours.
    'Access-Control-Max-Age': '7200',
    Vary: 'Origin, Access-Control-Request-Headers',
  };
};

export const isPasswordlessSocketOriginAllowed = async (req: SecurityRequest, isRequestOriginAllowed: RequestOriginChecker) => {
  const header = req?.headers?.origin;
  const origin = String((Array.isArray(header) ? header[0] : header) ?? '').trim();
  if (!origin) return true;
  return Boolean(await isRequestOriginAllowed(req));
};

export const createRequestSecurityRuntime = (deps: RequestSecurityDependencies) => {
  const { readSettingsFromDiskMigrated, allowLocalDevOrigins = false } = deps;
  const packagedClientOrigins = new Set([
    'openchamber-ui://app',
    'capacitor://localhost',
    'https://localhost',
  ]);

  const getUiSessionTokenFromRequest = (req: Pick<SecurityRequest, 'headers'> | null | undefined) => {
    const cookieHeader = req?.headers?.cookie;
    if (!cookieHeader || !isString(cookieHeader)) {
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

  const rejectWebSocketUpgrade = (socket: Duplex | null | undefined, statusCode: number, reason?: string) => {
    if (!socket || socket.destroyed) {
      return;
    }

    const message = reason && reason.trim().length > 0 ? reason.trim() : 'Bad Request';
    const body = Buffer.from(message, 'utf8');
    const statusTexts = new Map([
      [400, 'Bad Request'],
      [401, 'Unauthorized'],
      [403, 'Forbidden'],
      [404, 'Not Found'],
      [500, 'Internal Server Error'],
    ]);
    const statusText = statusTexts.get(statusCode) || 'Bad Request';

    try {
      socket.write(
        `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${body.length}\r\n\r\n`
      );
      socket.write(body);
    } catch {
      void 0;
    }

    try {
      socket.destroy();
    } catch {
      return;
    }
  };

  const getRequestOriginCandidates = async (req: SecurityRequest) => {
    const origins = new Set<string>();
    const hosts = new Set<string>();
    const forwardedProto = isString(req.headers['x-forwarded-proto'])
      ? (req.headers['x-forwarded-proto'].split(',')[0] ?? '').trim().toLowerCase()
      : '';
    const protocol = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');

    const forwardedHost = isString(req.headers['x-forwarded-host'])
      ? (req.headers['x-forwarded-host'].split(',')[0] ?? '').trim()
      : '';
    const host = forwardedHost || (isString(req.headers.host) ? req.headers.host.trim() : '');

    if (host) {
      hosts.add(host.toLowerCase());
      origins.add(`${protocol}://${host}`);
      const [hostname, port] = host.split(':');
      const normalizedHost = hostname?.toLowerCase() ?? '';
      const portSuffix = port && port.length > 0 ? `:${port}` : '';
      if (normalizedHost === 'localhost') {
        origins.add(`${protocol}://127.0.0.1${portSuffix}`);
        origins.add(`${protocol}://[::1]${portSuffix}`);
      } else if (normalizedHost === '127.0.0.1' || normalizedHost === '[::1]') {
        origins.add(`${protocol}://localhost${portSuffix}`);
      }
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      if (isString(settings?.publicOrigin) && settings.publicOrigin.trim().length > 0) {
        origins.add(new URL(settings.publicOrigin.trim()).origin);
      }
    } catch {
      return { origins, hosts };
    }

    return { origins, hosts };
  };

  const isRequestOriginAllowed = async (req: SecurityRequest): Promise<boolean> => {
    const originHeader = isString(req.headers.origin) ? req.headers.origin.trim() : '';
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
    const forwardedHost = firstHeaderValue(forwardedHostHeader, 'split')
      .split(',')[0]?.trim().toLowerCase() ?? '';
    const hostHeader = req.headers.host;
    const host = forwardedHost || firstHeaderValue(hostHeader, 'trim').trim().toLowerCase();
    if (host && host === origin.host.toLowerCase()) return true;

    const candidates = await getRequestOriginCandidates(req);
    return candidates.origins.has(origin.origin) || candidates.hosts.has(origin.host.toLowerCase());
  };

  return {
    getUiSessionTokenFromRequest,
    rejectWebSocketUpgrade,
    isRequestOriginAllowed,
  };
};

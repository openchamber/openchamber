import crypto from 'crypto';
import type { IncomingMessage } from 'node:http';
import type { Request, Response, NextFunction, RequestHandler } from '../shared/http-contracts.js';
import type { BearerRequest, ClientInput, CreatedClient, RemoteClient } from '../client-auth/contracts.js';
import type { PasskeyOptions } from './ui-passkeys.js';

type AuthRequest = Pick<IncomingMessage, 'headers' | 'method' | 'url'> & Partial<Pick<Request, 'query' | 'originalUrl' | 'baseUrl' | 'path' | 'secure'>>;
type CookieResponse = { setHeader: (name: string, value: string) => void } | null;

export interface ClientAuthentication {
  ok: boolean;
  sessionToken?: string;
  clientId?: string;
  id?: string;
  client?: RemoteClient;
}

export interface UiAuthOptions {
  password?: unknown;
  cookieName?: string;
  sessionTtlMs?: number;
  trustedSessionTtlMs?: number;
  readSettingsFromDiskMigrated?: PasskeyOptions['readSettingsFromDiskMigrated'];
  clientAuthController?: {
    authenticateBearerToken?: (token: string, req: BearerRequest) => Promise<ClientAuthentication | null>;
    createClient?: (input: ClientInput) => Promise<CreatedClient>;
  } | null;
  requireClientAuth?: boolean;
}

export interface AuthContext {
  type: 'session' | 'client';
  token: string | null | undefined;
  clientId?: string | null;
  client?: RemoteClient | null;
}

interface SessionCreated {
  authenticated: true;
  clientToken?: string;
  client?: RemoteClient;
}

interface AuthInput extends ClientInput {
  password?: unknown;
  trustDevice?: unknown;
  issueClientToken?: unknown;
  clientLabel?: unknown;
  scope?: unknown;
}

interface UrlAuthScope {
  kind: 'guest';
  id: string;
}

interface UrlAuthEntry {
  sessionToken: string;
  expiresAt: number;
  scope: UrlAuthScope | null;
}

interface RateLimitRecord {
  count: number;
  lastAttempt: number;
  lockedUntil?: number;
}

interface RateLimitHeaders {
  limit: number;
  remaining: number;
  reset: number;
}

type RateLimitResult = RateLimitHeaders & (
  { allowed: true } | { allowed: false; retryAfter: number; locked: true }
);
const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number';
const hasAuthInput = (value: unknown): value is AuthInput => value != null;
const hasErrorDetails = (value: unknown): value is { message?: unknown; statusCode?: unknown } => value != null;
const readBody = (req: Request) => hasAuthInput(req.body) ? req.body : undefined;

let josePending: Promise<typeof import('jose')> | undefined;
const loadJose = () => {
  josePending ??= import('jose');
  return josePending;
};
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createUiPasskeys } from './ui-passkeys.js';
import { sessionCookieNameForRequest } from './session-cookie.js';
import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';

const SESSION_COOKIE_NAME = 'oc_ui_session';
const HOUR_MS = 60 * 60 * 1000;

export const readSessionTtlMs = (raw: string | undefined, unitMs: number, fallbackMs: number) => {
  const value = Number(String(raw ?? '').trim());
  return Number.isFinite(value) && value > 0 ? Math.round(value * unitMs) : fallbackMs;
};

const SESSION_TTL_MS = readSessionTtlMs(process.env.OPENCHAMBER_UI_SESSION_TTL_HOURS, HOUR_MS, 12 * HOUR_MS);
const TRUSTED_DEVICE_SESSION_TTL_MS = readSessionTtlMs(
  process.env.OPENCHAMBER_UI_TRUSTED_SESSION_TTL_DAYS,
  24 * HOUR_MS,
  7 * 24 * HOUR_MS,
);
const URL_AUTH_TOKEN_TTL_MS = 60 * 1000;
const URL_AUTH_TOKEN_PREFIX = 'oc_url_';

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = Number(process.env.OPENCHAMBER_RATE_LIMIT_MAX_ATTEMPTS) || 10;
const RATE_LIMIT_LOCKOUT_MS = 15 * 60 * 1000;
const RATE_LIMIT_CLEANUP_MS = 60 * 60 * 1000;
const RATE_LIMIT_NO_IP_MAX_ATTEMPTS = Number(process.env.OPENCHAMBER_RATE_LIMIT_NO_IP_MAX_ATTEMPTS) || 3;

const loginRateLimiter = new Map<string, RateLimitRecord>();
let rateLimitCleanupTimer: ReturnType<typeof setInterval> | null = null;

const rateLimitLocks = new Map<string, Promise<boolean>>();

const getClientIp = (req: Request) => {
  const ip = req.ip || req.socket?.remoteAddress;
  if (ip) {
    if (ip.startsWith('::ffff:')) {
      return ip.substring(7);
    }
    return ip;
  }
  return null;
};

const getRateLimitKey = (req: Request) => {
  const ip = getClientIp(req);
  if (ip) return ip;
  return 'rate-limit:no-ip';
};

const getRateLimitConfig = (key: string) => {
  if (key === 'rate-limit:no-ip') {
    return {
      maxAttempts: RATE_LIMIT_NO_IP_MAX_ATTEMPTS,
      windowMs: RATE_LIMIT_WINDOW_MS
    };
  }
  return {
    maxAttempts: RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: RATE_LIMIT_WINDOW_MS
  };
};

const acquireRateLimitLock = async (key: string) => {
  const prev = rateLimitLocks.get(key) || Promise.resolve();
  const curr = prev.then(() => rateLimitLocks.delete(key));
  rateLimitLocks.set(key, curr);
  await curr;
};

const checkRateLimit = async (req: Request): Promise<RateLimitResult> => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  const now = Date.now();
  const { maxAttempts } = getRateLimitConfig(key);

  let record;
  try {
    record = loginRateLimiter.get(key);
  } catch (err) {
      console.error('[RateLimit] Failed to get record', { key, error: hasErrorDetails(err) ? err.message : undefined });
    return {
      allowed: true,
      limit: maxAttempts,
      remaining: maxAttempts,
      reset: Math.ceil((now + RATE_LIMIT_WINDOW_MS) / 1000)
    };
  }

  if (record?.lockedUntil && now < record.lockedUntil) {
    return {
      allowed: false,
      retryAfter: Math.ceil((record.lockedUntil - now) / 1000),
      locked: true,
      limit: maxAttempts,
      remaining: 0,
      reset: Math.ceil(record.lockedUntil / 1000)
    };
  }

  if (record?.lockedUntil && now >= record.lockedUntil) {
    try {
      loginRateLimiter.delete(key);
    } catch (err) {
      console.error('[RateLimit] Failed to delete expired record', { key, error: hasErrorDetails(err) ? err.message : undefined });
    }
  }

  if (!record || now - record.lastAttempt > RATE_LIMIT_WINDOW_MS) {
    return {
      allowed: true,
      limit: maxAttempts,
      remaining: maxAttempts,
      reset: Math.ceil((now + RATE_LIMIT_WINDOW_MS) / 1000)
    };
  }

  if (record.count >= maxAttempts) {
    const lockedUntil = now + RATE_LIMIT_LOCKOUT_MS;
    try {
      loginRateLimiter.set(key, { count: record.count + 1, lastAttempt: now, lockedUntil });
    } catch (err) {
      console.error('[RateLimit] Failed to set lockout', { key, error: hasErrorDetails(err) ? err.message : undefined });
    }
    return {
      allowed: false,
      retryAfter: Math.ceil(RATE_LIMIT_LOCKOUT_MS / 1000),
      locked: true,
      limit: maxAttempts,
      remaining: 0,
      reset: Math.ceil(lockedUntil / 1000)
    };
  }

  const remaining = maxAttempts - record.count;
  const reset = Math.ceil((record.lastAttempt + RATE_LIMIT_WINDOW_MS) / 1000);
  return {
    allowed: true,
    limit: maxAttempts,
    remaining,
    reset
  };
};

const recordFailedAttempt = async (req: Request) => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  const now = Date.now();
  const record = loginRateLimiter.get(key);

  if (!record || now - record.lastAttempt > RATE_LIMIT_WINDOW_MS) {
    try {
      loginRateLimiter.set(key, { count: 1, lastAttempt: now });
    } catch (err) {
      console.error('[RateLimit] Failed to record attempt', { key, error: hasErrorDetails(err) ? err.message : undefined });
    }
  } else {
    const newCount = record.count + 1;
    try {
      loginRateLimiter.set(key, { count: newCount, lastAttempt: now });
    } catch (err) {
      console.error('[RateLimit] Failed to record attempt', { key, error: hasErrorDetails(err) ? err.message : undefined });
    }
  }
};

const clearRateLimit = async (req: Request) => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  try {
    loginRateLimiter.delete(key);
  } catch (err) {
    console.error('[RateLimit] Failed to clear', { key, error: hasErrorDetails(err) ? err.message : undefined });
  }
};

const cleanupRateLimitRecords = () => {
  const now = Date.now();
  for (const [key, record] of loginRateLimiter.entries()) {
    const isExpired = record.lockedUntil && now >= record.lockedUntil;
    const isStale = now - record.lastAttempt > RATE_LIMIT_CLEANUP_MS;
    if (isExpired || isStale) {
      try {
        loginRateLimiter.delete(key);
      } catch (err) {
        console.error('[RateLimit] Cleanup failed', { key, error: hasErrorDetails(err) ? err.message : undefined });
      }
    }
  }
};

const startRateLimitCleanup = () => {
  if (!rateLimitCleanupTimer) {
    rateLimitCleanupTimer = setInterval(cleanupRateLimitRecords, RATE_LIMIT_CLEANUP_MS);
    rateLimitCleanupTimer.unref();
  }
};

const isSecureRequest = (req: AuthRequest) => {
  if (req.secure) {
    return true;
  }
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (isString(forwardedProto)) {
    const firstProto = forwardedProto.split(',')[0]?.trim().toLowerCase();
    return firstProto === 'https';
  }
  return false;
};

const parseCookies = (cookieHeader: Request['headers']['cookie']): Record<string, string> => {
  if (!cookieHeader || !isString(cookieHeader)) {
    return {};
  }

  return cookieHeader.split(';').reduce<Record<string, string>>((acc, segment) => {
    const [name, ...rest] = segment.split('=');
    if (!name) {
      return acc;
    }
    const key = name.trim();
    if (!key) {
      return acc;
    }
    const value = rest.join('=').trim();
    try {
      acc[key] = decodeURIComponent(value || '');
    } catch {
      acc[key] = value || '';
    }
    return acc;
  }, {});
};

export const getBearerTokenFromRequest = (req: Partial<Pick<Request, 'headers'>> | null | undefined) => {
  const header = req?.headers?.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (isString(value)) {
    const match = value.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1]?.trim() || '';
    if (token) return token;
  }
  return null;
};

const getUrlAuthTokenFromRequest = (req: AuthRequest) => {
  const queryToken = req?.query?.oc_url_token;
  let token = Array.isArray(queryToken) ? queryToken[0] : queryToken;
  if (!isString(token) && req?.url !== undefined) {
    try {
      token = new URL(req.url, 'http://localhost').searchParams.get('oc_url_token') || undefined;
    } catch {
      token = undefined;
    }
  }
  if (isString(token) && token.trim()) return token.trim();
  return null;
};

const getRequestPathname = (req: AuthRequest) => {
  const rawUrl = req?.originalUrl || req?.url;
  if (rawUrl) {
    try {
      return new URL(rawUrl, 'http://localhost').pathname;
    } catch {
      void 0;
    }
  }
  if (req?.baseUrl && req.path) {
    return `${req.baseUrl}${req.path}`.replace(/\/+/g, '/');
  }
  if (req?.path) return req.path;
  return '';
};

const isWebSocketUpgrade = (req: AuthRequest) => {
  const upgrade = req?.headers?.upgrade;
  const upgradeValue = Array.isArray(upgrade) ? upgrade[0] : upgrade;
  return String(upgradeValue || '').toLowerCase() === 'websocket';
};

const GUEST_URL_AUTH_SCOPE = /^guest:([a-z][a-z0-9-]*)$/;

const parseUrlAuthScope = (value: AuthInput['scope']): UrlAuthScope | null | undefined => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === '') return null;
  if (!isString(raw)) return undefined;
  const match = raw.trim().match(GUEST_URL_AUTH_SCOPE);
  return match?.[1] !== undefined ? { kind: 'guest', id: match[1] } : undefined;
};

const isGuestScopedPath = (pathname: string, guestId: string) => pathname.startsWith(`/api/guests/${guestId}/`);

const SPACE_RAW_FILE_PATH = /^\/api\/spaces\/[0-9a-f]{12}\/fs\/raw$/;
const SPACE_WS_PATH = /^\/api\/spaces\/[0-9a-f]{12}\/(?:terminal\/ws|dev-tunnel|event\/ws|global\/event\/ws)$/;

const SOURCE_CONTROL_UPLOAD_PREFIXES = Object.freeze(sourceControlProviderDescriptors.list()
  .filter((descriptor) => descriptor.capabilities.uploads)
  .map((descriptor) => `/api/source-control/${descriptor.id}/uploads/`));

const isUrlAuthReadableHttpPath = (pathname: string) => {
  return pathname === '/api/event'
    || pathname === '/api/global/event'
    || pathname === '/api/openchamber/events'
    || pathname === '/api/openchamber/realtime-proxy/sse'
    || pathname === '/api/notifications/stream'
    || pathname === '/api/fs/raw'
    || SOURCE_CONTROL_UPLOAD_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    || pathname.startsWith('/api/preview/proxy/')
    || /^\/api\/projects\/[^/]+\/icon$/.test(pathname)
    || pathname === '/api/guests'
    || /^\/api\/guests\/[a-z][a-z0-9-]*\//.test(pathname)
    || SPACE_RAW_FILE_PATH.test(pathname);
};

const isUrlAuthWebSocketPath = (pathname: string) => {
  return pathname === '/api/event/ws'
    || pathname === '/api/global/event/ws'
    || pathname === '/api/openchamber/realtime-proxy/ws'
    || pathname === '/api/terminal/ws'
    || pathname === '/api/dictation/ws'
    || pathname === '/api/dev-tunnel'
    || /^\/api\/guests\/[a-z][a-z0-9-]*\/surface\/ws$/.test(pathname)
    || pathname.startsWith('/api/preview/proxy/')
    || SPACE_WS_PATH.test(pathname);
};

const canUseUrlAuthTokenForRequest = (req: AuthRequest, scope: UrlAuthScope | null = null) => {
  const method = req?.method !== undefined ? req.method.toUpperCase() : 'GET';
  const pathname = getRequestPathname(req);
  if (scope?.kind === 'guest') {
    return !isWebSocketUpgrade(req) && method === 'GET' && isGuestScopedPath(pathname, scope.id);
  }
  if (isWebSocketUpgrade(req)) {
    return isUrlAuthWebSocketPath(pathname);
  }
  return method === 'GET' && isUrlAuthReadableHttpPath(pathname);
};

const buildCookie = ({
  name,
  value,
  maxAge,
  secure,
}: { name: string; value: string; maxAge: number; secure: boolean }) => {
  const attributes = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];

  attributes.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);

  const expires = maxAge === 0
    ? 'Thu, 01 Jan 1970 00:00:00 GMT'
    : new Date(Date.now() + maxAge * 1000).toUTCString();

  attributes.push(`Expires=${expires}`);

  if (secure) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
};

const normalizePassword = (candidate: UiAuthOptions['password']) => {
  if (!isString(candidate)) {
    return '';
  }
  return candidate.normalize().trim();
};

const isTrustedDeviceRequest = (value: AuthInput['trustDevice']) => value === true;

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');
const JWT_SECRET_FILE = path.join(OPENCHAMBER_DATA_DIR, 'jwt-secret');

function getOrCreateJwtSecret() {
  const envSecret = process.env.OPENCODE_JWT_SECRET;
  if (envSecret) {
    return new TextEncoder().encode(envSecret);
  }

  try {
    if (fs.existsSync(JWT_SECRET_FILE)) {
      return new TextEncoder().encode(fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim());
    }
  } catch (e) {
    console.warn('[JWT] Failed to read secret file:', hasErrorDetails(e) ? e.message : undefined);
  }

  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(OPENCHAMBER_DATA_DIR, { recursive: true });
    fs.writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
    console.log('[JWT] Generated and persisted new secret to', JWT_SECRET_FILE);
  } catch (e) {
    console.warn('[JWT] Failed to persist secret:', hasErrorDetails(e) ? e.message : undefined);
  }

  return new TextEncoder().encode(secret);
}

function persistJwtSecret(secret: string) {
  if (process.env.OPENCODE_JWT_SECRET) {
    const error: Error & { statusCode?: number } = new Error('Global sign-out is unavailable while OPENCODE_JWT_SECRET is set');
    error.statusCode = 400;
    throw error;
  }

  fs.mkdirSync(OPENCHAMBER_DATA_DIR, { recursive: true });
  fs.writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
  return new TextEncoder().encode(secret);
}

export const createUiAuth = ({
  password,
  cookieName = SESSION_COOKIE_NAME,
  sessionTtlMs = SESSION_TTL_MS,
  trustedSessionTtlMs = TRUSTED_DEVICE_SESSION_TTL_MS,
  readSettingsFromDiskMigrated,
  clientAuthController = null,
  requireClientAuth = false,
}: UiAuthOptions = {}) => {
  const normalizedPassword = normalizePassword(password);
  const urlAuthTokens = new Map<string, UrlAuthEntry>();

  const sweepUrlAuthTokens = () => {
    const now = Date.now();
    for (const [token, entry] of urlAuthTokens.entries()) {
      if (!entry || entry.expiresAt <= now) {
        urlAuthTokens.delete(token);
      }
    }
  };

  const issueUrlAuthTokenForSession = (sessionToken: string, scope: UrlAuthScope | null = null) => {
    sweepUrlAuthTokens();
    const token = `${URL_AUTH_TOKEN_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
    const expiresAt = Date.now() + URL_AUTH_TOKEN_TTL_MS;
    urlAuthTokens.set(token, { sessionToken, expiresAt, scope });
    return { token, expiresAt, expiresIn: URL_AUTH_TOKEN_TTL_MS };
  };

  const authenticateUrlAuthToken = (req: AuthRequest) => {
    const token = getUrlAuthTokenFromRequest(req);
    if (!token || !token.startsWith(URL_AUTH_TOKEN_PREFIX)) return null;
    const entry = urlAuthTokens.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      urlAuthTokens.delete(token);
      return null;
    }
    if (!canUseUrlAuthTokenForRequest(req, entry.scope)) return null;
    return { ok: true, sessionToken: entry.sessionToken || 'url:authenticated' };
  };

  const readRequestedUrlAuthScope = (req: Request) => parseUrlAuthScope(readBody(req)?.scope ?? req?.query?.scope);

  const authenticateClientRequest = async (req: AuthRequest, { allowUrlToken = true } = {}): Promise<ClientAuthentication | null> => {
    if (allowUrlToken) {
      const urlAuth = authenticateUrlAuthToken(req);
      if (urlAuth) return urlAuth;
    }
    const token = getBearerTokenFromRequest(req);
    if (!token || !clientAuthController?.authenticateBearerToken) {
      return null;
    }
    try {
      const result = await clientAuthController.authenticateBearerToken(token, req);
      if (result?.ok) {
        return result;
      }
      return null;
    } catch {
      return null;
    }
  };

  const clientSessionToken = (clientAuth: ClientAuthentication) => {
    const raw = clientAuth?.sessionToken || clientAuth?.clientId || clientAuth?.id;
    if (raw !== undefined && (raw.startsWith('client:') || raw.startsWith('url:'))) return raw;
    return raw !== undefined && raw.length > 0 ? `client:${raw}` : 'client:authenticated';
  };

  const clientAuthClientId = (clientAuth: ClientAuthentication) => {
    const raw = clientAuth?.client?.id || clientAuth?.clientId || clientAuth?.id || clientAuth?.sessionToken;
    if (raw === undefined || raw.length === 0) return null;
    return raw.startsWith('client:') ? raw.slice('client:'.length) : raw;
  };

  const clientAuthContext = (clientAuth: ClientAuthentication): AuthContext => ({
    type: 'client',
    token: clientSessionToken(clientAuth),
    clientId: clientAuthClientId(clientAuth),
    client: clientAuth?.client || null,
  });

  if (!normalizedPassword) {
    const setSessionCookie = (req: AuthRequest, res: CookieResponse, token: string, ttlMs = sessionTtlMs) => {
      const secure = isSecureRequest(req);
      const maxAgeSeconds = Math.floor(ttlMs / 1000);
      const header = buildCookie({
        name: sessionCookieNameForRequest(req, cookieName),
        value: encodeURIComponent(token),
        maxAge: maxAgeSeconds,
        secure,
      });
      if (res === null) throw new TypeError("Cannot read properties of null (reading 'setHeader')");
      res.setHeader('Set-Cookie', header);
    };

    const ensureSessionToken = async (req: AuthRequest, res: CookieResponse) => {
      const cookies = parseCookies(req.headers.cookie);
      const name = sessionCookieNameForRequest(req, cookieName);
      if (cookies[name]) {
        return cookies[name];
      }
      const token = crypto.randomBytes(32).toString('base64url');
      setSessionCookie(req, res, token, sessionTtlMs);
      return token;
    };

    const requireAuth: RequestHandler = async (req, res, next) => {
      if (!requireClientAuth) {
        return next();
      }
      if (req.method === 'OPTIONS') {
        return next();
      }
      const clientAuth = await authenticateClientRequest(req);
      if (clientAuth) {
        return next();
      }
      return res.status(401).json({ error: 'Client authentication required', locked: true, clientAuthRequired: true });
    };

    const requireSessionAuth: RequestHandler = async (req, res, next) => {
      if (!requireClientAuth) {
        return next();
      }
      if (req.method === 'OPTIONS') {
        return next();
      }
      return res.status(401).json({ error: 'UI session authentication required', locked: true });
    };

    const resolveAuthContext = async (req: AuthRequest, res: CookieResponse, { allowClientAuth = true, allowUrlToken = true } = {}): Promise<AuthContext | null> => {
      const cookies = parseCookies(req.headers.cookie);
      const name = sessionCookieNameForRequest(req, cookieName);
      if (cookies[name]) {
        return { type: 'session', token: cookies[name] };
      }
      if (allowClientAuth) {
        const clientAuth = await authenticateClientRequest(req, { allowUrlToken });
        if (clientAuth) return clientAuthContext(clientAuth);
      }
      if (!requireClientAuth) {
        const token = await ensureSessionToken(req, res);
        return { type: 'session', token };
      }
      return null;
    };

    return {
      enabled: false,
      requireAuth,
      requireSessionAuth,
      resolveAuthContext,
      handleSessionStatus: async (req: Request, res: Response) => {
        if (requireClientAuth) {
          const clientAuth = await authenticateClientRequest(req);
          if (clientAuth) {
            return res.json({ authenticated: true, disabled: true, scope: 'client' });
          }
          return res.status(401).json({ authenticated: false, locked: true, clientAuthRequired: true });
        }
        res.json({ authenticated: true, disabled: true });
      },
      handleSessionCreate: (_req: Request, res: Response) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handleUrlAuthToken: async (req: Request, res: Response) => {
        const scope = readRequestedUrlAuthScope(req);
        if (scope === undefined) {
          return res.status(400).json({ error: 'Unknown URL token scope' });
        }
        const clientAuth = await authenticateClientRequest(req, { allowUrlToken: false });
        if (clientAuth) {
          res.setHeader('Cache-Control', 'no-store');
          return res.json(issueUrlAuthTokenForSession(clientSessionToken(clientAuth), scope));
        }
        if (requireClientAuth) {
          return res.status(401).json({ error: 'Client authentication required', locked: true, clientAuthRequired: true });
        }
        const sessionToken = await ensureSessionToken(req, res);
        res.setHeader('Cache-Control', 'no-store');
        return res.json(issueUrlAuthTokenForSession(sessionToken, scope));
      },
      handlePasskeyStatus: (_req: Request, res: Response) => {
        res.json({ enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null });
      },
      handlePasskeyRegistrationOptions: (_req: Request, res: Response) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handlePasskeyRegistrationVerify: (_req: Request, res: Response) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handlePasskeyAuthenticationOptions: (_req: Request, res: Response) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handlePasskeyAuthenticationVerify: (_req: Request, res: Response) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handlePasskeyList: (_req: Request, res: Response) => {
        res.json({ passkeys: [] });
      },
      handlePasskeyRevoke: (_req: Request, res: Response) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handleResetAuth: (_req: Request, res: Response) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      ensureSessionToken: async (req: AuthRequest, res: CookieResponse) => {
        const clientAuth = await authenticateClientRequest(req);
        if (clientAuth) return clientSessionToken(clientAuth);
        return ensureSessionToken(req, res);
      },
      dispose: () => {

      },
    };
  }

  const salt = crypto.randomBytes(16);
  let expectedHash: Buffer | null = null;
  const readExpectedHash = () => {
    expectedHash ??= crypto.scryptSync(normalizedPassword, salt, 64);
    return expectedHash;
  };
  let jwtSecret = getOrCreateJwtSecret();
  let passwordBinding = crypto.createHmac('sha256', jwtSecret).update(normalizedPassword).digest('hex');
  const resolveSessionTtlMs = (trustDevice: boolean) => (trustDevice ? trustedSessionTtlMs : sessionTtlMs);
  let passkeyController = createUiPasskeys({
    passwordBinding,
    readSettingsFromDiskMigrated,
  });

  const rebuildPasskeyController = () => {
    passkeyController.dispose();
    passwordBinding = crypto.createHmac('sha256', jwtSecret).update(normalizedPassword).digest('hex');
    passkeyController = createUiPasskeys({
      passwordBinding,
      readSettingsFromDiskMigrated,
    });
  };

  const rotateJwtSecret = () => {
    const nextSecret = crypto.randomBytes(32).toString('hex');
    jwtSecret = persistJwtSecret(nextSecret);
    urlAuthTokens.clear();
    rebuildPasskeyController();
  };

  const getTokenFromRequest = (req: AuthRequest) => {
    const cookies = parseCookies(req.headers.cookie);
    const name = sessionCookieNameForRequest(req, cookieName);
    if (cookies[name]) {
      return cookies[name];
    }
    return null;
  };

  const setSessionCookie = (req: Request, res: Response, token: string, ttlMs: number) => {
    const secure = isSecureRequest(req);
    const maxAgeSeconds = Math.floor(ttlMs / 1000);
    const header = buildCookie({
      name: sessionCookieNameForRequest(req, cookieName),
      value: encodeURIComponent(token),
      maxAge: maxAgeSeconds,
      secure,
    });
    res.setHeader('Set-Cookie', header);
  };

  const clearSessionCookie = (req: Request, res: Response) => {
    const secure = isSecureRequest(req);
    const header = buildCookie({
      name: sessionCookieNameForRequest(req, cookieName),
      value: '',
      maxAge: 0,
      secure,
    });
    res.setHeader('Set-Cookie', header);
  };

  const verifyPassword = (candidate: string) => {
    if (!candidate) {
      return false;
    }
    const normalizedCandidate = normalizePassword(candidate);
    if (!normalizedCandidate) {
      return false;
    }
    try {
      const candidateHash = crypto.scryptSync(normalizedCandidate, salt, 64);
      return crypto.timingSafeEqual(candidateHash, readExpectedHash());
    } catch {
      return false;
    }
  };

  const isSessionValid = async (token: string | null | undefined) => {
    if (!token) {
      return false;
    }
    try {
      const { jwtVerify } = await loadJose();
      await jwtVerify(token, jwtSecret);
      return true;
    } catch {
      return false;
    }
  };

  const issueSession = async (req: Request, res: Response, { trustDevice = false } = {}) => {
    const ttlMs = resolveSessionTtlMs(trustDevice);
    const { SignJWT } = await loadJose();
    const token = await new SignJWT({ type: 'ui-session' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(ttlMs / 1000 + 's')
      .sign(jwtSecret);
    setSessionCookie(req, res, token, ttlMs);
    return token;
  };

  startRateLimitCleanup();

  const respondUnauthorized = (req: Request, res: Response) => {
    res.status(401);
    const acceptsJson = req.headers.accept?.includes('application/json');
    if (acceptsJson || req.path?.startsWith('/api')) {
      res.json({ error: 'UI authentication required', locked: true });
    } else {
      res.type('text/plain').send('Authentication required');
    }
  };

  const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'OPTIONS') {
      return next();
    }
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return next();
    }
    const clientAuth = await authenticateClientRequest(req);
    if (clientAuth) {
      return next();
    }
    clearSessionCookie(req, res);
    return respondUnauthorized(req, res);
  };

  const requireSessionAuth = async (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'OPTIONS') {
      return next();
    }
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return next();
    }
    clearSessionCookie(req, res);
    return respondUnauthorized(req, res);
  };

  const handleSessionStatus = async (req: Request, res: Response) => {
    const authorization = req.headers?.authorization;
    const hasBearer = isString(authorization) && authorization.toLowerCase().startsWith('bearer ');
    if (hasBearer) {
      const clientAuth = await authenticateClientRequest(req, { allowUrlToken: false });
      if (clientAuth) {
        res.json({ authenticated: true, scope: 'client' });
        return;
      }
      res.status(401).json({ authenticated: false, locked: true });
      return;
    }
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      res.json({ authenticated: true });
      return;
    }
    const clientAuth = await authenticateClientRequest(req);
    if (clientAuth) {
      res.json({ authenticated: true, scope: 'client' });
      return;
    }
    clearSessionCookie(req, res);
    res.status(401).json({ authenticated: false, locked: true });
  };

  const resolveAuthenticatedSessionToken = async (req: AuthRequest, { allowUrlToken = true } = {}) => {
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return token;
    }
    const clientAuth = await authenticateClientRequest(req, { allowUrlToken });
    return clientAuth ? clientSessionToken(clientAuth) : null;
  };

  const resolveAuthContext = async (req: AuthRequest, _res: CookieResponse, { allowClientAuth = true, allowUrlToken = true } = {}): Promise<AuthContext | null> => {
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return { type: 'session', token };
    }
    if (!allowClientAuth) return null;
    const clientAuth = await authenticateClientRequest(req, { allowUrlToken });
    return clientAuth ? clientAuthContext(clientAuth) : null;
  };

  const handleUrlAuthToken = async (req: Request, res: Response) => {
    const scope = readRequestedUrlAuthScope(req);
    if (scope === undefined) {
      return res.status(400).json({ error: 'Unknown URL token scope' });
    }
    const sessionToken = await resolveAuthenticatedSessionToken(req, { allowUrlToken: false });
    if (!sessionToken) {
      clearSessionCookie(req, res);
      return respondUnauthorized(req, res);
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json(issueUrlAuthTokenForSession(sessionToken, scope));
  };

  const admitLoginAttempt = async (req: Request, res: Response) => {
    const rateLimitResult = await checkRateLimit(req);

    res.setHeader('X-RateLimit-Limit', rateLimitResult.limit);
    res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining);
    res.setHeader('X-RateLimit-Reset', rateLimitResult.reset);

    if (!rateLimitResult.allowed) {
      res.setHeader('Retry-After', rateLimitResult.retryAfter);
      res.status(429).json({
        error: 'Too many login attempts, please try again later',
        retryAfter: rateLimitResult.retryAfter,
      });
      return false;
    }
    return true;
  };

  const handleSessionCreate = async (req: Request, res: Response) => {
    if (!(await admitLoginAttempt(req, res))) {
      return;
    }

    const body = readBody(req);
    const candidate = isString(body?.password) ? body.password : '';
    if (!verifyPassword(candidate)) {
      await recordFailedAttempt(req);
      clearSessionCookie(req, res);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    await clearRateLimit(req);

    const trustDevice = isTrustedDeviceRequest(body?.trustDevice);
    const ttlMs = resolveSessionTtlMs(trustDevice);
    await issueSession(req, res, { trustDevice });
    let clientTokenResult: CreatedClient | null = null;
    if (body?.issueClientToken === true && clientAuthController?.createClient) {
      clientTokenResult = await clientAuthController.createClient({
        fallbackLabel: body?.clientLabel,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        clientKind: body?.clientKind,
        dedupeKey: body?.dedupeKey,
        authMethod: 'password',
        deviceName: body?.deviceName,
        devicePlatform: body?.devicePlatform,
        deviceModel: body?.deviceModel,
        appVersion: body?.appVersion,
      });
    }
    res.setHeader('Cache-Control', 'no-store');
    const result: SessionCreated = { authenticated: true };
    if (clientTokenResult?.token) {
      result.clientToken = clientTokenResult.token;
      result.client = clientTokenResult.client;
    }
    res.json(result);
  };

  const respondPasskeyError = (res: Response, cause: unknown) => {
    const error = hasErrorDetails(cause) ? cause : undefined;
    const statusCode = isNumber(error?.statusCode) ? error.statusCode : 400;
    res.status(statusCode).json({ error: error?.message || 'Passkey request failed' });
  };

  const handlePasskeyStatus = (req: Request, res: Response) => {
    try {
      res.json(passkeyController.getStatus(req));
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyRegistrationOptions = async (req: Request, res: Response) => {
    try {
      const body = readBody(req);
      const label = isString(body?.label) ? body.label : '';
      const options = await passkeyController.beginRegistration(req, { label });
      res.json(options);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyRegistrationVerify = async (req: Request, res: Response) => {
    try {
      const result = await passkeyController.finishRegistration(req.body);
      res.json(result);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyAuthenticationOptions = async (req: Request, res: Response) => {
    try {
      const options = await passkeyController.beginAuthentication(req);
      res.json(options);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyAuthenticationVerify = async (req: Request, res: Response) => {
    if (!(await admitLoginAttempt(req, res))) {
      return;
    }

    try {
      await passkeyController.finishAuthentication(req.body);
    } catch (error) {
      await recordFailedAttempt(req);
      respondPasskeyError(res, error);
      return;
    }
    await clearRateLimit(req);

    try {
      const body = readBody(req);
      const trustDevice = isTrustedDeviceRequest(body?.trustDevice);
      const ttlMs = resolveSessionTtlMs(trustDevice);
      await issueSession(req, res, { trustDevice });
      let clientTokenResult: CreatedClient | null = null;
      if (body?.issueClientToken === true && clientAuthController?.createClient) {
        clientTokenResult = await clientAuthController.createClient({
          fallbackLabel: body?.clientLabel,
          expiresAt: new Date(Date.now() + ttlMs).toISOString(),
          clientKind: body?.clientKind,
          dedupeKey: body?.dedupeKey,
          authMethod: 'passkey',
          deviceName: body?.deviceName,
          devicePlatform: body?.devicePlatform,
          deviceModel: body?.deviceModel,
          appVersion: body?.appVersion,
        });
      }
      res.setHeader('Cache-Control', 'no-store');
      const result: SessionCreated = { authenticated: true };
      if (clientTokenResult?.token) {
        result.clientToken = clientTokenResult.token;
        result.client = clientTokenResult.client;
      }
      res.json(result);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyList = (req: Request, res: Response) => {
    try {
      res.json({ passkeys: passkeyController.listPasskeys(req) });
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyRevoke = (req: Request, res: Response) => {
    try {
      const result = passkeyController.revokePasskey(req, req.params?.id);
      res.json(result);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyRename = (req: Request, res: Response) => {
    try {
      const result = passkeyController.renamePasskey(req, req.params?.id, readBody(req)?.label);
      res.json(result);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handleResetAuth = (req: Request, res: Response) => {
    try {
      const passkeyResult = passkeyController.clearAllPasskeys();
      rotateJwtSecret();
      clearSessionCookie(req, res);
      res.json({
        cleared: true,
        clearedPasskeys: passkeyResult.clearedCount,
        signedOutEverywhere: true,
      });
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const dispose = () => {
    loginRateLimiter.clear();
    if (rateLimitCleanupTimer) {
      clearInterval(rateLimitCleanupTimer);
      rateLimitCleanupTimer = null;
    }
    passkeyController.dispose();
  };

  return {
    enabled: true,
    requireAuth,
    requireSessionAuth,
    resolveAuthContext,
    handleSessionStatus,
    handleSessionCreate,
    handleUrlAuthToken,
    handlePasskeyStatus,
    handlePasskeyRegistrationOptions,
    handlePasskeyRegistrationVerify,
    handlePasskeyAuthenticationOptions,
    handlePasskeyAuthenticationVerify,
    handlePasskeyList,
    handlePasskeyRevoke,
    handlePasskeyRename,
    handleResetAuth,
    ensureSessionToken: (req: AuthRequest, _res: CookieResponse) => {
      const urlAuth = authenticateUrlAuthToken(req);
      if (urlAuth) return clientSessionToken(urlAuth);
      return resolveAuthenticatedSessionToken(req);
    },
    dispose,
  };
};

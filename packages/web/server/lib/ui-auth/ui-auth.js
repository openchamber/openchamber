import crypto from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createUiPasskeys } from './ui-passkeys.js';

const SESSION_COOKIE_NAME = 'oc_ui_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TRUSTED_DEVICE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const URL_AUTH_TOKEN_TTL_MS = 60 * 1000;
const URL_AUTH_TOKEN_PREFIX = 'oc_url_';

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = Number(process.env.OPENCHAMBER_RATE_LIMIT_MAX_ATTEMPTS) || 10;
const RATE_LIMIT_LOCKOUT_MS = 15 * 60 * 1000;
const RATE_LIMIT_CLEANUP_MS = 60 * 60 * 1000;
const RATE_LIMIT_NO_IP_MAX_ATTEMPTS = Number(process.env.OPENCHAMBER_RATE_LIMIT_NO_IP_MAX_ATTEMPTS) || 3;

const loginRateLimiter = new Map();
let rateLimitCleanupTimer = null;

const rateLimitLocks = new Map();

const getClientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const ip = forwarded.split(',')[0].trim();
    if (ip.startsWith('::ffff:')) {
      return ip.substring(7);
    }
    return ip;
  }

  const ip = req.ip || req.connection?.remoteAddress;
  if (ip) {
    if (ip.startsWith('::ffff:')) {
      return ip.substring(7);
    }
    return ip;
  }
  return null;
};

const getRateLimitKey = (req) => {
  const ip = getClientIp(req);
  if (ip) return ip;
  return 'rate-limit:no-ip';
};

const getRateLimitConfig = (key) => {
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

const acquireRateLimitLock = async (key) => {
  const prev = rateLimitLocks.get(key) || Promise.resolve();
  const curr = prev.then(() => rateLimitLocks.delete(key));
  rateLimitLocks.set(key, curr);
  await curr;
};

const checkRateLimit = async (req) => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  const now = Date.now();
  const { maxAttempts } = getRateLimitConfig(key);

  let record;
  try {
    record = loginRateLimiter.get(key);
  } catch (err) {
    console.error('[RateLimit] Failed to get record', { key, error: err.message });
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
      console.error('[RateLimit] Failed to delete expired record', { key, error: err.message });
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
      console.error('[RateLimit] Failed to set lockout', { key, error: err.message });
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

const recordFailedAttempt = async (req) => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  const now = Date.now();
  const { maxAttempts } = getRateLimitConfig(key);
  const record = loginRateLimiter.get(key);

  if (!record || now - record.lastAttempt > RATE_LIMIT_WINDOW_MS) {
    try {
      loginRateLimiter.set(key, { count: 1, lastAttempt: now });
    } catch (err) {
      console.error('[RateLimit] Failed to record attempt', { key, error: err.message });
    }
  } else {
    const newCount = record.count + 1;
    try {
      loginRateLimiter.set(key, { count: newCount, lastAttempt: now });
    } catch (err) {
      console.error('[RateLimit] Failed to record attempt', { key, error: err.message });
    }
  }
};

const clearRateLimit = async (req) => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  try {
    loginRateLimiter.delete(key);
  } catch (err) {
    console.error('[RateLimit] Failed to clear', { key, error: err.message });
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
        console.error('[RateLimit] Cleanup failed', { key, error: err.message });
      }
    }
  }
};

const startRateLimitCleanup = () => {
  if (!rateLimitCleanupTimer) {
    rateLimitCleanupTimer = setInterval(cleanupRateLimitRecords, RATE_LIMIT_CLEANUP_MS);
    if (rateLimitCleanupTimer && typeof rateLimitCleanupTimer.unref === 'function') {
      rateLimitCleanupTimer.unref();
    }
  }
};

const stopRateLimitCleanup = () => {
  if (rateLimitCleanupTimer) {
    clearInterval(rateLimitCleanupTimer);
    rateLimitCleanupTimer = null;
  }
};

const isSecureRequest = (req) => {
  if (req.secure) {
    return true;
  }
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    const firstProto = forwardedProto.split(',')[0]?.trim().toLowerCase();
    return firstProto === 'https';
  }
  return false;
};

const parseCookies = (cookieHeader) => {
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return {};
  }

  return cookieHeader.split(';').reduce((acc, segment) => {
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

const getBearerTokenFromRequest = (req) => {
  const header = req?.headers?.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === 'string') {
    const match = value.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1]?.trim() || '';
    if (token) return token;
  }
  return null;
};

const getUrlAuthTokenFromRequest = (req) => {
  const queryToken = req?.query?.oc_url_token;
  let token = Array.isArray(queryToken) ? queryToken[0] : queryToken;
  if (typeof token !== 'string' && typeof req?.url === 'string') {
    try {
      token = new URL(req.url, 'http://localhost').searchParams.get('oc_url_token') || undefined;
    } catch {
      token = undefined;
    }
  }
  return typeof token === 'string' && token.trim() ? token.trim() : null;
};

const getRequestPathname = (req) => {
  if (typeof req?.path === 'string' && req.path) return req.path;
  const rawUrl = req?.originalUrl || req?.url;
  if (typeof rawUrl !== 'string' || !rawUrl) return '';
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return '';
  }
};

const isWebSocketUpgrade = (req) => {
  const upgrade = req?.headers?.upgrade;
  const upgradeValue = Array.isArray(upgrade) ? upgrade[0] : upgrade;
  return String(upgradeValue || '').toLowerCase() === 'websocket';
};

const isUrlAuthReadableHttpPath = (pathname) => {
  return pathname === '/api/event'
    || pathname === '/api/global/event'
    || pathname === '/api/openchamber/events'
    || pathname === '/api/notifications/stream'
    || pathname === '/api/fs/raw'
    || pathname.startsWith('/api/preview/proxy/')
    || /^\/api\/terminal\/[^/]+\/stream$/.test(pathname)
    || /^\/api\/projects\/[^/]+\/icon$/.test(pathname)
    || /^\/api\/provider\/[^/]+\/icon$/.test(pathname);
};

const isUrlAuthWebSocketPath = (pathname) => {
  return pathname === '/api/event/ws'
    || pathname === '/api/global/event/ws'
    || pathname === '/api/terminal/ws'
    || pathname.startsWith('/api/preview/proxy/');
};

const canUseUrlAuthTokenForRequest = (req) => {
  const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET';
  const pathname = getRequestPathname(req);
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
}) => {
  const attributes = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];

  if (typeof maxAge === 'number') {
    attributes.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  }

  const expires = maxAge === 0
    ? 'Thu, 01 Jan 1970 00:00:00 GMT'
    : new Date(Date.now() + maxAge * 1000).toUTCString();

  attributes.push(`Expires=${expires}`);

  if (secure) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
};

const normalizePassword = (candidate) => {
  if (typeof candidate !== 'string') {
    return '';
  }
  return candidate.normalize().trim();
};

const isTrustedDeviceRequest = (value) => value === true;

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
    console.warn('[JWT] Failed to read secret file:', e.message);
  }

  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(OPENCHAMBER_DATA_DIR, { recursive: true });
    fs.writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
    console.log('[JWT] Generated and persisted new secret to', JWT_SECRET_FILE);
  } catch (e) {
    console.warn('[JWT] Failed to persist secret:', e.message);
  }

  return new TextEncoder().encode(secret);
}

function persistJwtSecret(secret) {
  if (process.env.OPENCODE_JWT_SECRET) {
    const error = new Error('Global sign-out is unavailable while OPENCODE_JWT_SECRET is set');
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
  readSettingsFromDiskMigrated,
  clientAuthController = null,
  requireClientAuth = false,
} = {}) => {
  const normalizedPassword = normalizePassword(password);
  const urlAuthTokens = new Map();

  const sweepUrlAuthTokens = () => {
    const now = Date.now();
    for (const [token, entry] of urlAuthTokens.entries()) {
      if (!entry || entry.expiresAt <= now) {
        urlAuthTokens.delete(token);
      }
    }
  };

  const issueUrlAuthTokenForSession = (sessionToken) => {
    sweepUrlAuthTokens();
    const token = `${URL_AUTH_TOKEN_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
    const expiresAt = Date.now() + URL_AUTH_TOKEN_TTL_MS;
    urlAuthTokens.set(token, { sessionToken, expiresAt });
    return { token, expiresAt };
  };

  const authenticateUrlAuthToken = (req) => {
    if (!canUseUrlAuthTokenForRequest(req)) return null;
    const token = getUrlAuthTokenFromRequest(req);
    if (!token || !token.startsWith(URL_AUTH_TOKEN_PREFIX)) return null;
    const entry = urlAuthTokens.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      urlAuthTokens.delete(token);
      return null;
    }
    return { ok: true, sessionToken: entry.sessionToken || 'url:authenticated' };
  };

  const authenticateClientRequest = async (req, { allowUrlToken = true } = {}) => {
    if (allowUrlToken) {
      const urlAuth = authenticateUrlAuthToken(req);
      if (urlAuth) return urlAuth;
    }
    const token = getBearerTokenFromRequest(req);
    if (!token || typeof clientAuthController?.authenticateBearerToken !== 'function') {
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

  const clientSessionToken = (clientAuth) => {
    const raw = clientAuth?.sessionToken || clientAuth?.clientId || clientAuth?.id;
    if (typeof raw === 'string' && (raw.startsWith('client:') || raw.startsWith('url:'))) return raw;
    return typeof raw === 'string' && raw.length > 0 ? `client:${raw}` : 'client:authenticated';
  };

  const clientAuthClientId = (clientAuth) => {
    const raw = clientAuth?.client?.id || clientAuth?.clientId || clientAuth?.id || clientAuth?.sessionToken;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    return raw.startsWith('client:') ? raw.slice('client:'.length) : raw;
  };

  const clientAuthContext = (clientAuth) => ({
    type: 'client',
    token: clientSessionToken(clientAuth),
    clientId: clientAuthClientId(clientAuth),
    client: clientAuth?.client || null,
  });

  if (!normalizedPassword) {
    const setSessionCookie = (req, res, token, ttlMs = sessionTtlMs) => {
      const secure = isSecureRequest(req);
      const maxAgeSeconds = Math.floor(ttlMs / 1000);
      const header = buildCookie({
        name: cookieName,
        value: encodeURIComponent(token),
        maxAge: maxAgeSeconds,
        secure,
      });
      res.setHeader('Set-Cookie', header);
    };

    const ensureSessionToken = async (req, res) => {
      const cookies = parseCookies(req.headers.cookie);
      if (cookies[cookieName]) {
        return cookies[cookieName];
      }
      const token = crypto.randomBytes(32).toString('base64url');
      setSessionCookie(req, res, token, sessionTtlMs);
      return token;
    };

    const requireAuth = async (req, res, next) => {
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

    const requireSessionAuth = async (req, res, next) => {
      if (!requireClientAuth) {
        return next();
      }
      if (req.method === 'OPTIONS') {
        return next();
      }
      return res.status(401).json({ error: 'UI session authentication required', locked: true });
    };

    const resolveAuthContext = async (req, res, { allowClientAuth = true, allowUrlToken = true } = {}) => {
      const cookies = parseCookies(req.headers.cookie);
      if (cookies[cookieName]) {
        return { type: 'session', token: cookies[cookieName] };
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
      handleSessionStatus: async (req, res) => {
        if (requireClientAuth) {
          const clientAuth = await authenticateClientRequest(req);
          if (clientAuth) {
            return res.json({ authenticated: true, disabled: true, scope: 'client' });
          }
          return res.status(401).json({ authenticated: false, locked: true, clientAuthRequired: true });
        }
        res.json({ authenticated: true, disabled: true });
      },
      handleSessionCreate: (_req, res) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handleUrlAuthToken: async (req, res) => {
        const clientAuth = await authenticateClientRequest(req, { allowUrlToken: false });
        if (clientAuth) {
          res.setHeader('Cache-Control', 'no-store');
          return res.json(issueUrlAuthTokenForSession(clientSessionToken(clientAuth)));
        }
        if (requireClientAuth) {
          return res.status(401).json({ error: 'Client authentication required', locked: true, clientAuthRequired: true });
        }
        const sessionToken = await ensureSessionToken(req, res);
        res.setHeader('Cache-Control', 'no-store');
        return res.json(issueUrlAuthTokenForSession(sessionToken));
      },
      handlePasskeyStatus: (_req, res) => {
        res.json({ enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null });
      },
      handlePasskeyRegistrationOptions: (_req, res) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handlePasskeyRegistrationVerify: (_req, res) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handlePasskeyAuthenticationOptions: (_req, res) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handlePasskeyAuthenticationVerify: (_req, res) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handlePasskeyList: (_req, res) => {
        res.json({ passkeys: [] });
      },
      handlePasskeyRevoke: (_req, res) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handleResetAuth: (_req, res) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      ensureSessionToken: async (req, res) => {
        const clientAuth = await authenticateClientRequest(req);
        if (clientAuth) return clientSessionToken(clientAuth);
        return ensureSessionToken(req, res);
      },
      dispose: () => {

      },
    };
  }

  const salt = crypto.randomBytes(16);
  const expectedHash = crypto.scryptSync(normalizedPassword, salt, 64);
  let jwtSecret = getOrCreateJwtSecret();
  let passwordBinding = crypto.createHmac('sha256', jwtSecret).update(normalizedPassword).digest('hex');
  const resolveSessionTtlMs = (trustDevice) => (trustDevice ? TRUSTED_DEVICE_SESSION_TTL_MS : sessionTtlMs);
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

  const getTokenFromRequest = (req) => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[cookieName]) {
      return cookies[cookieName];
    }
    return null;
  };

  const setSessionCookie = (req, res, token, ttlMs) => {
    const secure = isSecureRequest(req);
    const maxAgeSeconds = Math.floor(ttlMs / 1000);
    const header = buildCookie({
      name: cookieName,
      value: encodeURIComponent(token),
      maxAge: maxAgeSeconds,
      secure,
    });
    res.setHeader('Set-Cookie', header);
  };

  const clearSessionCookie = (req, res) => {
    const secure = isSecureRequest(req);
    const header = buildCookie({
      name: cookieName,
      value: '',
      maxAge: 0,
      secure,
    });
    res.setHeader('Set-Cookie', header);
  };

  const verifyPassword = (candidate) => {
    if (!candidate) {
      return false;
    }
    const normalizedCandidate = normalizePassword(candidate);
    if (!normalizedCandidate) {
      return false;
    }
    try {
      const candidateHash = crypto.scryptSync(normalizedCandidate, salt, 64);
      return crypto.timingSafeEqual(candidateHash, expectedHash);
    } catch {
      return false;
    }
  };

  const isSessionValid = async (token) => {
    if (!token) {
      return false;
    }
    try {
      await jwtVerify(token, jwtSecret);
      return true;
    } catch {
      return false;
    }
  };

  const issueSession = async (req, res, { trustDevice = false } = {}) => {
    const ttlMs = resolveSessionTtlMs(trustDevice);
    const token = await new SignJWT({ type: 'ui-session' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(ttlMs / 1000 + 's')
      .sign(jwtSecret);
    setSessionCookie(req, res, token, ttlMs);
    return token;
  };

  startRateLimitCleanup();

  const respondUnauthorized = (req, res) => {
    res.status(401);
    const acceptsJson = req.headers.accept?.includes('application/json');
    if (acceptsJson || req.path?.startsWith('/api')) {
      res.json({ error: 'UI authentication required', locked: true });
    } else {
      res.type('text/plain').send('Authentication required');
    }
  };

  const requireAuth = async (req, res, next) => {
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

  const requireSessionAuth = async (req, res, next) => {
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

  const handleSessionStatus = async (req, res) => {
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

  const resolveAuthenticatedSessionToken = async (req, { allowUrlToken = true } = {}) => {
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return token;
    }
    const clientAuth = await authenticateClientRequest(req, { allowUrlToken });
    return clientAuth ? clientSessionToken(clientAuth) : null;
  };

  const resolveAuthContext = async (req, _res, { allowClientAuth = true, allowUrlToken = true } = {}) => {
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return { type: 'session', token };
    }
    if (!allowClientAuth) return null;
    const clientAuth = await authenticateClientRequest(req, { allowUrlToken });
    return clientAuth ? clientAuthContext(clientAuth) : null;
  };

  const handleUrlAuthToken = async (req, res) => {
    const sessionToken = await resolveAuthenticatedSessionToken(req, { allowUrlToken: false });
    if (!sessionToken) {
      clearSessionCookie(req, res);
      return respondUnauthorized(req, res);
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json(issueUrlAuthTokenForSession(sessionToken));
  };

  const handleSessionCreate = async (req, res) => {
    const rateLimitResult = await checkRateLimit(req);

    res.setHeader('X-RateLimit-Limit', rateLimitResult.limit);
    res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining);
    res.setHeader('X-RateLimit-Reset', rateLimitResult.reset);

    if (!rateLimitResult.allowed) {
      res.setHeader('Retry-After', rateLimitResult.retryAfter);
      res.status(429).json({ 
        error: 'Too many login attempts, please try again later',
        retryAfter: rateLimitResult.retryAfter 
      });
      return;
    }

    const candidate = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!verifyPassword(candidate)) {
      await recordFailedAttempt(req);
      clearSessionCookie(req, res);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    await clearRateLimit(req);

    const trustDevice = isTrustedDeviceRequest(req.body?.trustDevice);
    const ttlMs = resolveSessionTtlMs(trustDevice);
    await issueSession(req, res, { trustDevice });
    let clientTokenResult = null;
    if (req.body?.issueClientToken === true && typeof clientAuthController?.createClient === 'function') {
      clientTokenResult = await clientAuthController.createClient({
        label: req.body?.clientLabel,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        clientKind: req.body?.clientKind,
        dedupeKey: req.body?.dedupeKey,
      });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      authenticated: true,
      ...(clientTokenResult?.token ? { clientToken: clientTokenResult.token, client: clientTokenResult.client } : {}),
    });
  };

  const respondPasskeyError = (res, error) => {
    const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : 400;
    res.status(statusCode).json({ error: error?.message || 'Passkey request failed' });
  };

  const handlePasskeyStatus = (req, res) => {
    try {
      res.json(passkeyController.getStatus(req));
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyRegistrationOptions = async (req, res) => {
    try {
      const label = typeof req.body?.label === 'string' ? req.body.label : '';
      const options = await passkeyController.beginRegistration(req, { label });
      res.json(options);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyRegistrationVerify = async (req, res) => {
    try {
      const result = await passkeyController.finishRegistration(req.body);
      res.json(result);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyAuthenticationOptions = async (req, res) => {
    try {
      const options = await passkeyController.beginAuthentication(req);
      res.json(options);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyAuthenticationVerify = async (req, res) => {
    try {
      await passkeyController.finishAuthentication(req.body);
      const trustDevice = isTrustedDeviceRequest(req.body?.trustDevice);
      const ttlMs = resolveSessionTtlMs(trustDevice);
      await issueSession(req, res, { trustDevice });
      let clientTokenResult = null;
      if (req.body?.issueClientToken === true && typeof clientAuthController?.createClient === 'function') {
        clientTokenResult = await clientAuthController.createClient({
          label: req.body?.clientLabel,
          expiresAt: new Date(Date.now() + ttlMs).toISOString(),
          clientKind: req.body?.clientKind,
          dedupeKey: req.body?.dedupeKey,
        });
      }
      res.json({
        authenticated: true,
        ...(clientTokenResult?.token ? { clientToken: clientTokenResult.token, client: clientTokenResult.client } : {}),
      });
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyList = (req, res) => {
    try {
      res.json({ passkeys: passkeyController.listPasskeys(req) });
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyRevoke = (req, res) => {
    try {
      const result = passkeyController.revokePasskey(req, req.params?.id);
      res.json(result);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handleResetAuth = (req, res) => {
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
    handleResetAuth,
    ensureSessionToken: async (req, _res) => {
      return resolveAuthenticatedSessionToken(req);
    },
    dispose,
  };
};

// Platform auth route registration (plan section 9.1):
//   GET  /auth/login            start OIDC login (creates a one-time transaction)
//   GET  /auth/callback         OIDC login callback (full token validation)
//   POST /auth/logout           revoke the current platform session (CSRF-checked)
//   GET  /api/platform/me       current user view, capabilities and locale
//
// Registration is a complete no-op when the platform is disabled
// (OPENCHAMBER_PLATFORM_DATABASE_URL unset), preserving current server
// behavior. These routes MUST be registered before the generic /api auth gate
// in registerAuthAndAccessRoutes (which enforces the shared UI password) and
// before the OpenCode proxy fallback: the platform uses its own session and
// must not be gated by - or proxied to - the single-user OpenCode upstream.

import { randomUUID } from 'crypto';

import { isPlatformEnabled, createMigratedPlatformDb } from '../index.js';
import { writeAuditEvent } from '../audit/audit-writer.js';
import { resolveOidcConfig } from './oidc-config.js';
import { createPlatformAuth } from './platform-auth.js';
import { buildMeView } from './me-view.js';
import {
  DEFAULT_SESSION_TTL_MS,
  buildClearedSessionCookie,
  buildSessionCookie,
  createPlatformSession,
  readSessionCookie,
  resolvePlatformSession,
  revokePlatformSession,
} from './sessions.js';

// CSRF protection for platform write routes (plan section 7.1): the session
// cookie is SameSite=Lax, but same-site sibling origins and same-origin
// attacker pages can still POST with ambient credentials. Requiring a custom
// header (X-Requested-With) blocks classic cross-site form CSRF because a
// browser form cannot set custom headers without a CORS preflight the
// cross-origin response will not pass. The login callback is a GET and is
// protected by the single-use state/nonce/PKCE transaction instead.
const requireCsrfHeader = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  if (typeof req.get('x-requested-with') === 'string' && req.get('x-requested-with').length > 0) {
    return next();
  }
  return res.status(403).json({
    error: 'csrf_header_required',
    request_id: req.platformRequestId,
  });
};

export async function registerPlatformAuthRoutes(app, options = {}) {
  const { env = process.env, logger = console, db: dbOverride = null } = options;

  if (!dbOverride && !isPlatformEnabled()) {
    return { enabled: false };
  }

  const oidcConfig = resolveOidcConfig({ env, logger });
  const db = dbOverride ?? await createMigratedPlatformDb();
  const auth = createPlatformAuth({ db, oidcConfig, logger });
  const sessionTtlMs = Number.isFinite(Number(env.OPENCHAMBER_PLATFORM_SESSION_TTL_MS))
    && Number(env.OPENCHAMBER_PLATFORM_SESSION_TTL_MS) > 0
    ? Number(env.OPENCHAMBER_PLATFORM_SESSION_TTL_MS)
    : DEFAULT_SESSION_TTL_MS;

  // Stable per-request id: echoed in error payloads and stored on audit events.
  app.use(['/auth', '/api/platform'], (req, _res, next) => {
    req.platformRequestId = randomUUID();
    next();
  });

  // Attach the platform user (or 401) for session-gated platform routes.
  const requirePlatformSession = async (req, res, next) => {
    try {
      const token = readSessionCookie(req);
      const resolved = token ? await resolvePlatformSession(db, { token }) : null;
      // Expired, revoked, unknown, disabled and unbound all answer with the
      // same 401 - the caller cannot distinguish another account's state.
      if (!resolved || resolved.user.status !== 'active') {
        return res.status(401).json({
          error: 'unauthenticated',
          request_id: req.platformRequestId,
        });
      }
      req.platformUser = resolved.user;
      req.platformSession = resolved.session;
      return next();
    } catch (error) {
      logger.error?.(`[platform-auth] session lookup failed: ${error?.message || error}`);
      return res.status(500).json({
        error: 'internal_error',
        request_id: req.platformRequestId,
      });
    }
  };

  // Cookies are Secure whenever the request reached us over HTTPS (trust
  // proxy is enabled in the server). OPENCHAMBER_PLATFORM_INSECURE_COOKIES=true
  // is an explicit local-dev-only opt-out that forces Secure off; it must
  // never be set on a trial/production deployment.
  const isSecureRequest = (req) => {
    if (env.OPENCHAMBER_PLATFORM_INSECURE_COOKIES === 'true') return false;
    return req.secure === true;
  };

  app.get('/auth/login', async (req, res) => {
    try {
      const { redirectUrl } = await auth.startLogin(req);
      return res.redirect(302, redirectUrl);
    } catch (error) {
      logger.error?.(`[platform-auth] login start failed: ${error?.message || error}`);
      return res.status(503).json({
        error: 'auth_provider_unavailable',
        request_id: req.platformRequestId,
      });
    }
  });

  app.get('/auth/callback', async (req, res) => {
    const audit = async (outcome, targetUserId = null) => {
      try {
        await writeAuditEvent(db, {
          actorUserId: targetUserId,
          targetUserId,
          action: 'platform.auth.login',
          requestId: req.platformRequestId,
          outcome,
        });
      } catch (error) {
        logger.warn?.(`[platform-auth] failed to write audit event: ${error?.message || error}`);
      }
    };

    const state = typeof req.query?.state === 'string' ? req.query.state : '';
    const callbackUrl = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
    const result = await auth.completeLogin({ state, callbackUrl });

    if (result.error) {
      await audit('failure');
      return res.status(401).json({
        error: result.error,
        request_id: req.platformRequestId,
      });
    }

    const { token, expiresAt } = await createPlatformSession(db, { userId: result.user.id });
    const expiresMs = Date.parse(expiresAt) - Date.now();
    res.setHeader('Set-Cookie', buildSessionCookie(token, {
      secure: isSecureRequest(req),
      ttlMs: Number.isFinite(expiresMs) ? expiresMs : sessionTtlMs,
    }));
    await audit('success', result.user.id);
    return res.redirect(302, '/');
  });

  app.post('/auth/logout', requireCsrfHeader, async (req, res) => {
    const token = readSessionCookie(req);
    const resolved = token ? await resolvePlatformSession(db, { token }) : null;
    if (token) {
      await revokePlatformSession(db, { token });
    }
    res.setHeader('Set-Cookie', buildClearedSessionCookie({ secure: isSecureRequest(req) }));
    if (resolved) {
      try {
        await writeAuditEvent(db, {
          actorUserId: resolved.user.id,
          targetUserId: resolved.user.id,
          action: 'platform.auth.logout',
          requestId: req.platformRequestId,
          outcome: 'success',
        });
      } catch (error) {
        logger.warn?.(`[platform-auth] failed to write audit event: ${error?.message || error}`);
      }
    }
    // Logout revokes the platform session only; it does NOT stop the user's
    // sandboxes (plan section 8.5).
    return res.status(204).end();
  });

  app.get('/api/platform/me', requirePlatformSession, async (req, res) => {
    try {
      const view = await buildMeView(db, { user: req.platformUser });
      return res.status(200).json(view);
    } catch (error) {
      logger.error?.(`[platform-auth] me view failed: ${error?.message || error}`);
      return res.status(500).json({
        error: 'internal_error',
        request_id: req.platformRequestId,
      });
    }
  });

  return { enabled: true, db, auth, oidcConfig };
}

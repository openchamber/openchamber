import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTunnelAuth } from './tunnel-auth.js';

const request = (cookie, ip = '203.0.113.10') => ({
  headers: { host: 'tunnel.example.com', cookie, 'x-forwarded-proto': 'https' },
  hostname: 'tunnel.example.com',
  secure: false,
  ip,
  socket: { remoteAddress: ip },
});

const response = () => ({ setHeader: vi.fn() });

const activeAuth = () => {
  const auth = createTunnelAuth();
  auth.setActiveTunnel({
    tunnelId: 'tunnel-1',
    publicUrl: 'https://tunnel.example.com',
    mode: 'managed-remote',
  });
  return auth;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('tunnel authentication lifecycle', () => {
  it('exchanges a bootstrap token once, reads its cookie and revokes the session', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const auth = activeAuth();
    const bootstrap = auth.issueBootstrapToken({ ttlMs: 10_000 });
    expect(auth.getBootstrapStatus()).toEqual({ hasBootstrapToken: true, bootstrapExpiresAt: 11_000 });
    const res = response();
    const exchange = () => auth.exchangeBootstrapToken({
      req: request(), res, token: bootstrap.token, sessionTtlMs: 60_000,
    });

    expect(exchange()).toEqual({ ok: true, sessionExpiresAt: 61_000 });
    const cookie = res.setHeader.mock.calls[0][1];
    expect(cookie).toContain('HttpOnly; SameSite=Lax; Max-Age=60;');
    expect(cookie).toContain('; Secure');
    const sessionRequest = request(cookie.split(';')[0]);
    expect(auth.getTunnelSessionFromRequest(sessionRequest)).toMatchObject({
      tunnelId: 'tunnel-1', mode: 'managed-remote', expiresAt: 61_000,
    });
    expect(exchange()).toEqual({ ok: false, reason: 'expired' });
    expect(auth.getBootstrapStatus()).toEqual({ hasBootstrapToken: false, bootstrapExpiresAt: null });
    expect(auth.revokeTunnelArtifacts('tunnel-1')).toEqual({
      revokedBootstrapCount: 1, invalidatedSessionCount: 1,
    });
    expect(auth.getTunnelSessionFromRequest(sessionRequest)).toBeNull();
    expect(auth.listTunnelSessions()[0]).toMatchObject({
      status: 'inactive', inactiveReason: 'tunnel-revoked', revokedAt: 1_000,
    });
  });

  it('keeps an unlimited bootstrap token usable and expires sessions at the exact deadline', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const auth = activeAuth();
    const { token } = auth.issueBootstrapToken({ ttlMs: null });
    now.mockReturnValue(1_000_000);
    expect(auth.getBootstrapStatus()).toEqual({ hasBootstrapToken: true, bootstrapExpiresAt: null });
    const res = response();
    expect(auth.exchangeBootstrapToken({ req: request(), res, token, sessionTtlMs: 1_000 }).ok).toBe(true);
    const sessionRequest = request(res.setHeader.mock.calls[0][1].split(';')[0]);
    now.mockReturnValue(1_001_000);
    expect(auth.getTunnelSessionFromRequest(sessionRequest)).toBeNull();
    expect(auth.listTunnelSessions()[0]).toMatchObject({ status: 'inactive', inactiveReason: 'expired' });
  });

  it('keeps a bound socket alive for the full 30-day session, and forgets a disconnected one', () => {
    vi.useFakeTimers();
    try {
      const auth = activeAuth();
      const { token } = auth.issueBootstrapToken({ ttlMs: null });
      const res = response();
      const sessionTtlMs = 30 * 24 * 60 * 60 * 1000;
      auth.exchangeBootstrapToken({ req: request(), res, token, sessionTtlMs });
      const session = request(res.setHeader.mock.calls[0][1].split(';')[0]);
      const disconnected = vi.fn(), connected = vi.fn();
      auth.bindTunnelSession(session, disconnected)();
      const unbind = auth.bindTunnelSession(session, connected);
      vi.advanceTimersByTime(sessionTtlMs - 1);
      expect(connected).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(connected).toHaveBeenCalledOnce();
      expect(disconnected).not.toHaveBeenCalled();
      unbind();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects expired and non-text tokens without issuing cookies', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const auth = activeAuth();
    const { token } = auth.issueBootstrapToken({ ttlMs: 1_000 });
    const res = response();
    for (const invalidToken of [undefined, null, '', 12, {}, []]) {
      expect(auth.exchangeBootstrapToken({
        req: request(), res, token: invalidToken, sessionTtlMs: 1_000,
      })).toEqual({ ok: false, reason: 'missing-token' });
    }
    now.mockReturnValue(2_000);
    expect(auth.exchangeBootstrapToken({ req: request(), res, token, sessionTtlMs: 1_000 }))
      .toEqual({ ok: false, reason: 'expired' });
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it.each([[undefined, 5], ['203.0.113.10', 20]])('limits failed exchanges for %s', (ip, attempts) => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const auth = activeAuth();
    auth.issueBootstrapToken({ ttlMs: null });
    const req = request(undefined, ip);
    if (ip === undefined) {
      req.ip = undefined;
      req.socket.remoteAddress = undefined;
    }
    const res = response();
    const exchange = () => auth.exchangeBootstrapToken({ req, res, token: 'invalid', sessionTtlMs: 1_000 });
    for (let index = 0; index < attempts; index += 1) {
      expect(exchange()).toEqual({ ok: false, reason: 'invalid-token' });
    }
    expect(exchange()).toEqual({ ok: false, reason: 'rate-limited', retryAfter: 600 });
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('keys the exchange budget on the peer when a private address rotates X-Forwarded-For', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const auth = activeAuth();
    auth.issueBootstrapToken({ ttlMs: null });
    const res = response();
    const attempt = (forwardedFor) => {
      const req = request(undefined, forwardedFor);
      req.socket.remoteAddress = '192.168.1.50';
      return auth.exchangeBootstrapToken({ req, res, token: 'invalid', sessionTtlMs: 1_000 });
    };

    for (let index = 0; index < 20; index += 1) {
      expect(attempt(`203.0.113.${index}`)).toEqual({ ok: false, reason: 'invalid-token' });
    }
    expect(attempt('203.0.113.99')).toEqual({ ok: false, reason: 'rate-limited', retryAfter: 600 });
  });

  it('keeps separate exchange budgets for clients behind a configured LAN proxy', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    vi.stubEnv('OPENCHAMBER_TRUSTED_PROXIES', '172.18.0.2');
    const auth = activeAuth();
    auth.issueBootstrapToken({ ttlMs: null });
    const res = response();
    const attempt = (forwardedFor) => {
      const req = request(undefined, forwardedFor);
      req.socket.remoteAddress = '172.18.0.2';
      req.headers['x-forwarded-for'] = forwardedFor;
      return auth.exchangeBootstrapToken({ req, res, token: 'invalid', sessionTtlMs: 1_000 });
    };

    for (let index = 0; index < 20; index += 1) {
      expect(attempt('203.0.113.31')).toEqual({ ok: false, reason: 'invalid-token' });
    }
    expect(attempt('203.0.113.31')).toEqual({ ok: false, reason: 'rate-limited', retryAfter: 600 });
    expect(attempt('203.0.113.32')).toEqual({ ok: false, reason: 'invalid-token' });
  });

  it('preserves malformed cookie failures and ignores unrelated inherited cookie names', () => {
    const auth = activeAuth();
    expect(() => auth.getTunnelSessionFromRequest(request('oc_tunnel_session=%'))).toThrow(URIError);
    expect(auth.getTunnelSessionFromRequest(request('constructor=value; toString=other'))).toBeNull();
    expect(auth.getTunnelSessionFromRequest(request('oc_tunnel_session=constructor'))).toBeNull();
  });
});

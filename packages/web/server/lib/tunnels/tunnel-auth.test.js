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

afterEach(() => vi.restoreAllMocks());

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

  it('preserves malformed cookie failures and ignores unrelated inherited cookie names', () => {
    const auth = activeAuth();
    expect(() => auth.getTunnelSessionFromRequest(request('oc_tunnel_session=%'))).toThrow(URIError);
    expect(auth.getTunnelSessionFromRequest(request('constructor=value; toString=other'))).toBeNull();
    expect(auth.getTunnelSessionFromRequest(request('oc_tunnel_session=constructor'))).toBeNull();
  });
});

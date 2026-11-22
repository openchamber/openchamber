import { describe, expect, it } from 'vitest';

import { createTunnelAuth } from './tunnel-auth.js';

const makeSession = () => {
  const auth = createTunnelAuth();
  auth.setActiveTunnel({ tunnelId: 'tunnel-1', publicUrl: 'https://example.ts.net' });
  const { token } = auth.issueBootstrapToken({ ttlMs: 60_000 });
  let setCookie = null;
  const res = { setHeader: (name, value) => { if (name === 'Set-Cookie') setCookie = value; } };
  const result = auth.exchangeBootstrapToken({ req: { headers: {} }, res, token, sessionTtlMs: 60_000 });
  expect(result.ok).toBe(true);
  const sessionId = setCookie.split(';')[0].split('=').slice(1).join('=');
  return { auth, sessionId: decodeURIComponent(sessionId) };
};

const reqWithCookie = (cookie) => ({ headers: { cookie } });

describe('tunnel-auth cookie parsing', () => {
  it('does not throw on a malformed unrelated cookie and still resolves the session', () => {
    const { auth, sessionId } = makeSession();
    const session = auth.getTunnelSessionFromRequest(reqWithCookie(`other=%; oc_tunnel_session=${sessionId}`));
    expect(session?.sessionId).toBe(sessionId);
  });

  it('does not throw on a malformed session cookie value', () => {
    const { auth } = makeSession();
    expect(auth.getTunnelSessionFromRequest(reqWithCookie('oc_tunnel_session=%zz'))).toBeNull();
  });

  it('does not throw on a truncated UTF-8 sequence in an unrelated cookie', () => {
    const { auth, sessionId } = makeSession();
    const session = auth.getTunnelSessionFromRequest(reqWithCookie(`other=%E0%A4%A; oc_tunnel_session=${sessionId}`));
    expect(session?.sessionId).toBe(sessionId);
  });

  it('still decodes a valid percent-encoded session cookie value', () => {
    const { auth, sessionId } = makeSession();
    const session = auth.getTunnelSessionFromRequest(reqWithCookie(`oc_tunnel_session=${encodeURIComponent(sessionId)}`));
    expect(session?.sessionId).toBe(sessionId);
  });
});

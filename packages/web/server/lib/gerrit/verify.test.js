import { describe, expect, it } from 'vitest';
import { fakeGerrit, fixtures, ORIGIN, replay } from './fixtures/fake-fetch.js';
import { probeGerritVersion, verifyGerritCredentials } from './verify.js';

describe('Gerrit verification', () => {
  it('answers the account a username and HTTP password sign in as', async () => {
    // The recorded account has no avatar (no avatar plugin); one is added to cover it.
    const avatars = [{ url: `${ORIGIN}/accounts/1000096/avatar?s=32`, height: 32 }];
    const { fetch, calls } = fakeGerrit({ 'GET /accounts/self': { ...fixtures.accountSelf, avatars } });

    await expect(verifyGerritCredentials({ origin: ORIGIN, login: ' alice ', password: 'pw', fetch })).resolves.toEqual({
      id: 1000096, login: 'alice', name: 'Alice Admin', email: 'alice@example.invalid', avatarUrl: `${ORIGIN}/accounts/1000096/avatar?s=32`,
    });
    expect(calls[0].url.pathname).toBe('/a/accounts/self');
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from('alice:pw').toString('base64')}`);
  });

  it('refuses an account without a username, and missing credentials before any request', async () => {
    const { fetch, calls } = fakeGerrit({ 'GET /accounts/self': fixtures.accountSelfWithoutUsername });

    await expect(verifyGerritCredentials({ origin: ORIGIN, login: 'dana', password: 'pw', fetch })).rejects.toMatchObject({
      sourceControlResponse: { status: 400, body: { code: 'GERRIT_ACCOUNT_WITHOUT_USERNAME' } },
    });
    const sent = calls.length;
    await expect(verifyGerritCredentials({ origin: ORIGIN, login: '', password: 'pw', fetch })).rejects.toMatchObject({
      sourceControlResponse: { status: 400, body: { code: 'GERRIT_USERNAME_REQUIRED' } },
    });
    await expect(verifyGerritCredentials({ origin: ORIGIN, login: 'alice', password: '', fetch })).rejects.toMatchObject({
      sourceControlResponse: { status: 400, body: { code: 'GERRIT_PASSWORD_REQUIRED' } },
    });
    expect(calls).toHaveLength(sent);
  });

  it('names a refused password as an invalid token', async () => {
    const { fetch } = fakeGerrit({ 'GET /accounts/self': () => replay(fixtures.errors.unauthorized) });
    await expect(verifyGerritCredentials({ origin: ORIGIN, login: 'alice', password: 'bad', fetch })).rejects.toMatchObject({ status: 401, kind: 'invalid-token' });
  });

  it('reads the version anonymously and supports 3.8 and newer', async () => {
    const { fetch, calls } = fakeGerrit({ 'GET /config/server/version': fixtures.version });
    await expect(probeGerritVersion({ origin: ORIGIN, fetch })).resolves.toEqual({ version: '3.10.9', supported: true });
    expect(calls[0]).toMatchObject({ authenticated: false });
    expect(calls[0].headers.authorization).toBeUndefined();

    const old = fakeGerrit({ 'GET /config/server/version': '3.7.4' });
    await expect(probeGerritVersion({ origin: ORIGIN, fetch: old.fetch })).resolves.toEqual({ version: '3.7.4', supported: false });
  });

  it('asks again with the credentials when anonymous reads are refused, and lets an unknown instance through without them', async () => {
    const { fetch, calls } = fakeGerrit({
      'GET /config/server/version': (call) => (call.authenticated ? fixtures.version : replay(fixtures.errors.unauthorized)),
    });
    await expect(probeGerritVersion({ origin: ORIGIN, login: 'alice', password: 'pw', fetch })).resolves.toEqual({ version: '3.10.9', supported: true });
    expect(calls.map((call) => call.authenticated)).toEqual([false, true]);

    await expect(probeGerritVersion({ origin: ORIGIN, fetch })).resolves.toEqual({ version: null, supported: true });
  });

  it('refuses an instance that does not answer as Gerrit', async () => {
    const { fetch } = fakeGerrit({ 'GET /config/server/version': { version: '1.21' } });
    await expect(probeGerritVersion({ origin: ORIGIN, fetch })).rejects.toThrow('did not answer as Gerrit');
  });
});

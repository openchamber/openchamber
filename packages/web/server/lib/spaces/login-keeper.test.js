import { describe, expect, it } from 'vitest';

import { KEEP_INTERVAL_MS, RENEW_WINDOW_MS, createLoginExchange, createLoginKeeper, exchangeRequestOf, exchangedLoginOf } from './login-keeper.js';

const NOW = Date.parse('2026-10-10T10:00:00.000Z');
const REFRESH = 'rt-long-lived-of-the-host';
const tokenSharing = { methodID: 'chatgpt-token-sharing', refresh: REFRESH, metadata: { clientID: 'client_1', scopes: ['chatgpt.tokens.use.direct'] } };
const legacy = { methodID: 'chatgpt-browser', refresh: REFRESH, metadata: { accountID: 'acct_old' } };
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

describe('the issuer request of a login method', () => {
  it('asks the ChatGPT token endpoint with the login\'s own client id and the API as the resource', () => {
    expect(exchangeRequestOf(tokenSharing)).toEqual({
      url: 'https://auth.openai.com/api/accounts/oauth/token',
      body: { grant_type: 'refresh_token', client_id: 'client_1', refresh_token: REFRESH, resource: 'https://api.openai.com/v1' },
    });
  });

  it('asks the legacy endpoint with OpenAI\'s app client for the two Codex logins', () => {
    for (const methodID of ['chatgpt-browser', 'chatgpt-headless']) {
      expect(exchangeRequestOf({ ...legacy, methodID })).toEqual({
        url: 'https://auth.openai.com/oauth/token',
        body: { grant_type: 'refresh_token', refresh_token: REFRESH, client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' },
      });
    }
  });

  it('knows no other method, and no ChatGPT login without its client id', () => {
    expect(exchangeRequestOf({ ...tokenSharing, methodID: 'some-new-method' })).toBeNull();
    expect(exchangeRequestOf({ ...tokenSharing, metadata: {} })).toBeNull();
  });
});

describe('the login an answer makes', () => {
  const answer = { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 1800, scope: 'chatgpt.tokens.use.direct other' };

  it('keeps the client id and takes the scopes from the answer for a ChatGPT login, and its end from expires_in', () => {
    expect(exchangedLoginOf(tokenSharing, answer, NOW)).toEqual({ access: 'at-new', refresh: 'rt-new', expires: NOW + 1800_000, metadata: { clientID: 'client_1', scopes: ['chatgpt.tokens.use.direct', 'other'] } });
    expect(exchangedLoginOf(tokenSharing, { ...answer, scope: undefined, expires_in: undefined }, NOW)).toEqual({ access: 'at-new', refresh: 'rt-new', expires: NOW + 3600_000, metadata: { clientID: 'client_1', scopes: ['chatgpt.tokens.use.direct'] } });
  });

  it('reads the account id of a legacy login from the id token, then the access token, and keeps the old metadata without one', () => {
    expect(exchangedLoginOf(legacy, { ...answer, id_token: jwt({ chatgpt_account_id: 'acct_id' }), access_token: jwt({ chatgpt_account_id: 'acct_at' }) }, NOW).metadata).toEqual({ accountID: 'acct_id' });
    expect(exchangedLoginOf(legacy, { ...answer, access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_auth' } }) }, NOW).metadata).toEqual({ accountID: 'acct_auth' });
    expect(exchangedLoginOf(legacy, { ...answer, access_token: jwt({ organizations: [{ id: 'org_1' }] }) }, NOW).metadata).toEqual({ accountID: 'org_1' });
    expect(exchangedLoginOf(legacy, answer, NOW).metadata).toEqual({ accountID: 'acct_old' });
    expect(exchangedLoginOf(legacy, { ...answer, id_token: 'h.not-json.s' }, NOW).metadata).toEqual({ accountID: 'acct_old' });
  });
});

describe('the exchange', () => {
  const fetching = (status, body) => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: status === 200, status, text: async () => body };
    };
    return { calls, fetch };
  };

  it('posts the form to the issuer with its user agent and answers the new login', async () => {
    const { calls, fetch } = fetching(200, JSON.stringify({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }));
    const exchange = createLoginExchange({ fetch, now: () => NOW, userAgent: 'OpenChamber/2.2.0' });
    await expect(exchange(tokenSharing)).resolves.toEqual({ access: 'at-new', refresh: 'rt-new', expires: NOW + 3600_000, metadata: { clientID: 'client_1', scopes: ['chatgpt.tokens.use.direct'] } });
    expect(calls).toEqual([{ url: 'https://auth.openai.com/api/accounts/oauth/token', init: expect.objectContaining({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'OpenChamber/2.2.0', accept: 'application/json' } }) }]);
    expect(Object.fromEntries(new URLSearchParams(calls[0].init.body))).toEqual({ grant_type: 'refresh_token', client_id: 'client_1', refresh_token: REFRESH, resource: 'https://api.openai.com/v1' });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses a method it does not know before asking anyone', async () => {
    const { calls, fetch } = fetching(200, '{}');
    await expect(createLoginExchange({ fetch })({ ...tokenSharing, methodID: 'some-new-method' })).rejects.toThrow('some-new-method login cannot be renewed');
    expect(calls).toEqual([]);
  });

  it('fails on a refusal, a body that is not the token answer, and a body too large, without the tokens in the error', async () => {
    await expect(createLoginExchange({ fetch: fetching(401, '{"error":"invalid_grant"}').fetch })(tokenSharing)).rejects.toThrow('answered 401');
    await expect(createLoginExchange({ fetch: fetching(200, '{"access_token":"at"}').fetch })(tokenSharing)).rejects.toThrow('did not answer with tokens');
    await expect(createLoginExchange({ fetch: fetching(200, 'not json').fetch })(tokenSharing)).rejects.toThrow('did not answer with tokens');
    await expect(createLoginExchange({ fetch: fetching(200, 'x'.repeat(64 * 1024 + 1)).fetch })(tokenSharing)).rejects.toThrow('too large');
  });
});

describe('the keeper', () => {
  const ACCESS = 'at-of-the-host';
  const grant = { kind: 'login', id: 'openai', provider: 'openai', method: 'chatgpt-token-sharing' };
  const login = (expires, access = ACCESS) => ({ methodID: 'chatgpt-token-sharing', access, expires, metadata: { clientID: 'client_1' } });
  const make = ({ stored = login(NOW + 3600_000), holding = [{ spaceId: 'a1', grant }], renewed = null, renewFails = false, sayFails = false, readFails = false } = {}) => {
    const state = { stored, holding, renewed, renewFails, sayFails, readFails };
    const calls = [];
    const warnings = [];
    const exchange = async () => ({});
    const keeper = createLoginKeeper({
      readLogin: async (provider) => { calls.push(['read', provider]); if (state.readFails) throw new Error('OpenCode is away'); return provider === 'openai' ? state.stored : null; },
      renewLogin: async (provider, given) => {
        calls.push(['renew', provider]);
        expect(given).toBe(exchange);
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (state.renewFails) throw new Error('issuer answered 401');
        state.stored = state.renewed;
        return state.renewed;
      },
      exchange,
      holders: async () => state.holding,
      say: async (spaceId, said, givenLogin) => { calls.push(['say', spaceId, said.id, givenLogin.expires]); return state.sayFails === 'busy' ? null : !state.sayFails; },
      now: () => NOW,
      logger: { warn: (line) => warnings.push(line) },
    });
    return { keeper, calls, warnings, state };
  };

  it('answers a login with time as it is, and none when the host has none', async () => {
    const { keeper, calls } = make();
    await expect(keeper.fresh('openai')).resolves.toEqual(login(NOW + 3600_000));
    await expect(keeper.fresh('anthropic')).resolves.toBeNull();
    expect(calls).toEqual([['read', 'openai'], ['read', 'anthropic']]);
  });

  it('renews a login within ten minutes of its end, or past it, once for callers that arrive together', async () => {
    const renewed = login(NOW + 3600_000, 'at-renewed');
    const { keeper, calls } = make({ stored: login(NOW + RENEW_WINDOW_MS), renewed });
    const both = await Promise.all([keeper.fresh('openai'), keeper.fresh('openai')]);
    expect(both).toEqual([renewed, renewed]);
    expect(calls).toEqual([['read', 'openai'], ['read', 'openai'], ['renew', 'openai']]);
    const ended = make({ stored: login(NOW - 1), renewed });
    await expect(ended.keeper.fresh('openai')).resolves.toEqual(renewed);
  });

  it('keeps a login that still has time when the renewal fails, answers none for one that has ended, and asks the issuer again only for a login that changed', async () => {
    const soon = make({ stored: login(NOW + 60_000), renewFails: true });
    await expect(soon.keeper.fresh('openai')).resolves.toEqual(login(NOW + 60_000));
    expect(soon.warnings).toEqual([expect.stringContaining('could not be renewed: issuer answered 401')]);
    // The same login once a minute: the issuer that refused is not asked again.
    await expect(soon.keeper.fresh('openai')).resolves.toEqual(login(NOW + 60_000));
    expect(soon.calls.filter(([name]) => name === 'renew')).toEqual([['renew', 'openai']]);
    // The user signed in again: a different login, asked once more.
    soon.state.stored = login(NOW + 120_000, 'at-signed-in-again');
    soon.state.renewed = login(NOW + 3600_000, 'at-renewed');
    soon.state.renewFails = false;
    await expect(soon.keeper.fresh('openai')).resolves.toEqual(login(NOW + 3600_000, 'at-renewed'));
    expect(soon.calls.filter(([name]) => name === 'renew')).toEqual([['renew', 'openai'], ['renew', 'openai']]);
    const ended = make({ stored: login(NOW), renewFails: true });
    await expect(ended.keeper.fresh('openai')).resolves.toBeNull();
  });

  it('says the login to each holding space once per change, whoever changed it, and renews first when it is about to end', async () => {
    const { keeper, calls, state } = make({ holding: [{ spaceId: 'a1', grant }, { spaceId: 'b2', grant }] });
    await keeper.tick();
    expect(calls).toEqual([['read', 'openai'], ['say', 'a1', 'openai', NOW + 3600_000], ['say', 'b2', 'openai', NOW + 3600_000]]);
    calls.splice(0);
    await keeper.tick();
    expect(calls).toEqual([['read', 'openai']]);
    // The host's OpenCode refreshed on its own: the new token goes out.
    state.stored = login(NOW + 7200_000, 'at-by-opencode');
    calls.splice(0);
    await keeper.tick();
    expect(calls).toEqual([['read', 'openai'], ['say', 'a1', 'openai', NOW + 7200_000], ['say', 'b2', 'openai', NOW + 7200_000]]);
    // About to end: renewed by the keeper, then said.
    state.stored = login(NOW + RENEW_WINDOW_MS - 1, 'at-old');
    state.renewed = login(NOW + 3600_000, 'at-renewed');
    calls.splice(0);
    await keeper.tick();
    expect(calls).toEqual([['read', 'openai'], ['renew', 'openai'], ['say', 'a1', 'openai', NOW + 3600_000], ['say', 'b2', 'openai', NOW + 3600_000]]);
  });

  it('says it again on the next look when a space was busy but not when its gatekeeper refused, leaves a login of another method and a host without one to the list, and forgets a space that stopped', async () => {
    const busy = make({ sayFails: 'busy' });
    await busy.keeper.tick();
    busy.state.sayFails = false;
    busy.calls.splice(0);
    await busy.keeper.tick();
    expect(busy.calls).toEqual([['read', 'openai'], ['say', 'a1', 'openai', NOW + 3600_000]]);
    const refusing = make({ sayFails: true });
    await refusing.keeper.tick();
    refusing.calls.splice(0);
    await refusing.keeper.tick();
    expect(refusing.calls).toEqual([['read', 'openai']]);
    const other = make({ stored: { ...login(NOW + 3600_000), methodID: 'chatgpt-browser' } });
    await other.keeper.tick();
    const none = make({ stored: null });
    await none.keeper.tick();
    expect(other.calls).toEqual([['read', 'openai']]);
    expect(none.calls).toEqual([['read', 'openai']]);
    const gone = make();
    await gone.keeper.tick();
    gone.state.holding = [];
    await gone.keeper.tick();
    gone.state.holding = [{ spaceId: 'a1', grant }];
    gone.calls.splice(0);
    await gone.keeper.tick();
    expect(gone.calls).toEqual([['read', 'openai'], ['say', 'a1', 'openai', NOW + 3600_000]]);
  });

  it('reads the login once per look and never throws: a host OpenCode that is away is logged', async () => {
    const away = make({ readFails: true });
    await expect(away.keeper.tick()).resolves.toBeUndefined();
    expect(away.calls).toEqual([['read', 'openai']]);
    expect(away.warnings).toEqual([expect.stringContaining('could not be read: OpenCode is away')]);
    const listing = createLoginKeeper({ readLogin: async () => null, renewLogin: async () => null, exchange: async () => ({}), holders: async () => { throw new Error('docker is away'); }, say: async () => true, logger: { warn: () => {} } });
    await expect(listing.tick()).resolves.toBeUndefined();
  });

  it('looks once a minute', () => {
    expect(KEEP_INTERVAL_MS).toBe(60_000);
  });
});

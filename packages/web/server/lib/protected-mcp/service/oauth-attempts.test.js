import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdminSocketClient } from '../test-support/admin-socket-client.js';
import { startService } from '../test-support/fixtures.js';
import { startHttpFixture } from '../test-support/http-fixture.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(oauth = {}) {
  let clock = 1000;
  const server = await startHttpFixture({ oauth: true });
  cleanups.push(server.close);
  const fixture = await startService({ now: () => clock });
  cleanups.push(fixture.close);
  const admin = createAdminSocketClient(fixture.adminSocketPath);
  const { connection } = await admin.create({ name: 'oauth', transport: 'http', http: { url: server.url, oauth: { scopes: ['read'], ...oauth } } });
  return { server, fixture, admin, connection, expire: () => { clock += 600_001; }, start: (redirectUri = 'https://app.example/callback') => admin.oauthStart(connection.id, connection.revision, redirectUri) };
}

describe('socket OAuth attempts', () => {
  it('writes nothing at start and registers a fresh client for each sign-in', async () => {
    // Given
    const { fixture, server, start } = await setup();
    const before = await fs.readdir(`${fixture.stateDir}/credentials`);
    // When
    await start();
    await start();
    // Then
    expect(await fs.readdir(`${fixture.stateDir}/credentials`)).toEqual(before);
    expect(server.seen.registrations).toBe(2);
  });

  it('uses the fixed redirect URI when the connection configures one', async () => {
    // Given
    const { start, server } = await setup({ clientId: 'fixed-client', redirectUri: 'http://fixed.example/callback' });
    // When
    const flow = await start('https://caller.example/callback');
    // Then
    expect(new URL(flow.authorizationUrl).searchParams.get('redirect_uri')).toBe('http://fixed.example/callback');
    expect(server.seen.registrations).toBe(0);
  });

  it.each(['relative', 'file:///callback', 'https://user:pass@app.example/callback', 'https://app.example/callback#hash'])('refuses invalid caller redirect %s even with a fixed URI', async (redirectUri) => {
    // Given
    const { start } = await setup({ redirectUri: 'https://fixed.example/callback' });
    // When
    const answer = await start(redirectUri);
    // Then
    expect(answer).toMatchObject({ type: 'error', code: 'invalid_redirect_uri' });
  });

  it('reports pending, then denied, then unknown after expiration', async () => {
    // Given
    const { admin, start, expire } = await setup();
    const flow = await start();
    expect(await admin.oauthAttempt(flow.attempt)).toEqual({ type: 'oauth-attempt', status: 'pending' });
    // When
    const completed = await admin.oauthComplete({ state: new URL(flow.authorizationUrl).searchParams.get('state'), error: 'access_denied' });
    // Then
    expect(completed).toMatchObject({ outcome: 'oauth_denied', name: 'oauth' });
    expect(await admin.oauthAttempt(flow.attempt)).toMatchObject({ status: 'done', outcome: 'oauth_denied' });
    expire();
    expect(await admin.oauthAttempt(flow.attempt)).toEqual({ type: 'oauth-attempt', status: 'unknown' });
  });

  it('evicts the oldest pending state with a terminal attempt outcome', async () => {
    // Given
    const { admin, start } = await setup();
    const oldest = await start();
    // When
    for (let index = 0; index < 16; index += 1) await start();
    // Then
    expect(await admin.oauthAttempt(oldest.attempt)).toMatchObject({ status: 'done', outcome: 'oauth_state_invalid' });
    expect((await admin.oauthComplete({ state: new URL(oldest.authorizationUrl).searchParams.get('state'), code: 'unused' })).outcome).toBe('oauth_state_invalid');
  });

  it('refuses an expired pending state and forgets its attempt', async () => {
    // Given
    const { admin, start, expire } = await setup();
    const flow = await start();
    expire();
    // When
    const answer = await admin.oauthComplete({ state: new URL(flow.authorizationUrl).searchParams.get('state'), code: 'unused' });
    // Then
    expect(answer.outcome).toBe('oauth_state_invalid');
    expect(await admin.oauthAttempt(flow.attempt)).toMatchObject({ status: 'unknown' });
  });

  it('marks a pending attempt changed after revoke or removal', async () => {
    // Given
    const { admin, start, connection } = await setup();
    const flow = await start();
    await admin.apply({ kind: 'revoke-credentials', id: connection.id, expectedRevision: connection.revision });
    // When
    const answer = await admin.oauthComplete({ state: new URL(flow.authorizationUrl).searchParams.get('state'), code: 'unused' });
    // Then
    expect(answer.outcome).toBe('oauth_connection_changed');
    expect(await admin.oauthAttempt(flow.attempt)).toMatchObject({ status: 'done', outcome: 'oauth_connection_changed' });
  });

  it.each([{ code: 'bogus' }, {}])('consumes an invalid exchange %j without authorizing', async (fields) => {
    // Given
    const { admin, start } = await setup();
    const flow = await start();
    // When
    const answer = await admin.oauthComplete({ state: new URL(flow.authorizationUrl).searchParams.get('state'), ...fields });
    // Then
    expect(answer.outcome).toBe(fields.code ? 'oauth_exchange_failed' : 'oauth_state_invalid');
  });
});

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdminSocketClient } from '../test-support/admin-socket-client.js';
import { SENTINEL, engineRequest, engineSession, startService } from '../test-support/fixtures.js';
import { startHttpFixture } from '../test-support/http-fixture.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup({ oauth = true, now } = {}) {
  const server = await startHttpFixture(oauth ? { oauth } : { bearer: SENTINEL });
  cleanups.push(server.close);
  const fixture = await startService({ now });
  cleanups.push(fixture.close);
  const admin = createAdminSocketClient(fixture.adminSocketPath);
  const definition = { name: 'remote', transport: 'http', http: { url: server.url, ...(oauth ? { oauth: { scopes: ['read'] } } : { headers: { Authorization: { secret: 'token', prefix: 'Bearer ' } } }) } };
  const { connection } = await admin.create(definition, oauth ? {} : { token: SENTINEL });
  return { server, fixture, admin, connection, definition };
}
async function pendingCallback(admin, connection, redirectUri = 'https://app.example/api/protected-mcp/oauth/callback') {
  const flow = await admin.oauthStart(connection.id, connection.revision, redirectUri);
  expect(flow.type).toBe('oauth-started');
  const consent = await fetch(flow.authorizationUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  const callback = new URL(consent.headers.get('location'));
  return { flow, fields: Object.fromEntries(callback.searchParams), callback };
}
async function authorize(admin, connection) {
  const pending = await pendingCallback(admin, connection);
  return { ...pending, finished: await admin.oauthComplete(pending.fields) };
}
async function sessionFor(fixture, connection) {
  const session = engineSession(fixture.engineSocketPath, connection.id);
  await session.next();
  session.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  const { message } = await session.response(1);
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { session, init: message };
}
function gate(server) {
  let arrived;
  const reached = new Promise((resolve) => { arrived = resolve; });
  let release;
  server.state.tokenGate = { grant: 'authorization_code', arrived, release: new Promise((resolve) => { release = resolve; }) };
  cleanups.push(async () => release());
  return { reached: () => Promise.race([reached, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('exchange not reached')), 5000); timer.unref(); })]), release: () => release() };
}

describe('protected HTTP and socket OAuth', () => {
  it('adds bearer credentials upstream only and closes an upstream session', async () => {
    // Given
    const { server, fixture, connection } = await setup({ oauth: false });
    const { session, init } = await sessionFor(fixture, connection);
    // When
    session.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'remote_echo', arguments: { text: 'hi' } } });
    const { message, others } = await session.response(2);
    // Then
    expect(init.result.serverInfo.name).toBe('http-fixture');
    expect(message.result.content[0].text).toBe('echo hi');
    expect(others.map((item) => item.method)).toContain('notifications/progress');
    expect(server.seen.authorizations.every((hash) => hash === server.hash(SENTINEL))).toBe(true);
    expect(JSON.stringify([init, message, others])).not.toContain(SENTINEL);
    await session.close();
    await expect.poll(() => server.seen.deletes).toBe(1);
  });

  it('refuses upstream redirects and invalid bearer credentials without leaking detail', async () => {
    // Given
    const { server, fixture, connection } = await setup({ oauth: false });
    const elsewhere = await startHttpFixture({ bearer: 'other' });
    cleanups.push(elsewhere.close);
    server.state.redirectTo = elsewhere.url;
    // When
    const { session, init } = await sessionFor(fixture, connection);
    // Then
    expect(init.error.message).toContain('redirect');
    expect(elsewhere.seen.authorizations).toEqual([]);
    server.state.redirectTo = null;
    server.state.accessTokens.clear();
    session.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    const refused = (await session.response(2)).message;
    expect(refused.error.code).toBe(-32001);
    expect(JSON.stringify(refused)).not.toContain(SENTINEL);
    await session.close();
  });

  it('authorizes without a session at the caller callback, consumes state once and rotates refresh tokens', async () => {
    // Given
    let clock = Date.now();
    const { server, fixture, admin, connection } = await setup({ now: () => clock });
    // When
    const { finished, callback, flow, fields } = await authorize(admin, connection);
    // Then
    expect(callback.origin).toBe('https://app.example');
    expect(finished).toEqual({ type: 'oauth-completed', outcome: 'authorized', name: 'remote' });
    expect(await admin.oauthAttempt(flow.attempt)).toEqual({ type: 'oauth-attempt', status: 'done', outcome: 'authorized' });
    expect((await admin.oauthComplete(fields)).outcome).toBe('oauth_state_invalid');
    expect(server.seen.registrations).toBe(1);
    expect(JSON.stringify(await admin.get(connection.id))).not.toMatch(/at-|rt-/);
    const { session } = await sessionFor(fixture, connection);
    clock += 2 * 60 * 60 * 1000;
    session.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((await session.response(2)).message.result.tools[0].name).toBe('remote_echo');
    expect(server.seen.refreshes).toBe(1);
    server.state.rejectRefresh = true;
    clock += 2 * 60 * 60 * 1000;
    session.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect((await session.response(3)).message.error.message).toContain('needs authorization');
    expect((await engineRequest(fixture.engineSocketPath, { type: 'status' }))[0].connections[0].credential).toBe('authorization_required');
    await session.close();
  });

  it('drops a slower overlapping sign-in and keeps the faster grant', async () => {
    // Given
    const { server, fixture, admin, connection } = await setup();
    const first = await pendingCallback(admin, connection, 'https://first.example/callback');
    const second = await pendingCallback(admin, connection, 'https://second.example/callback');
    const exchange = gate(server);
    const finishing = admin.oauthComplete(first.fields);
    await exchange.reached();
    // When
    expect((await admin.oauthComplete(second.fields)).outcome).toBe('authorized');
    const [keptToken] = server.state.accessTokens;
    exchange.release();
    // Then
    expect((await finishing).outcome).toBe('oauth_connection_changed');
    const { session } = await sessionFor(fixture, connection);
    expect(server.seen.authorizations.at(-1)).toBe(createHash('sha256').update(keptToken).digest('hex'));
    expect(server.seen.registrations).toBe(2);
    await session.close();
  });

  it('drops a code exchange when credentials are revoked during sign-in', async () => {
    // Given
    const { server, admin, connection } = await setup();
    const { fields } = await pendingCallback(admin, connection);
    const exchange = gate(server);
    const finishing = admin.oauthComplete(fields);
    await exchange.reached();
    // When
    await admin.apply({ kind: 'revoke-credentials', id: connection.id, expectedRevision: connection.revision });
    exchange.release();
    // Then
    expect((await finishing).outcome).toBe('oauth_connection_changed');
    expect((await admin.get(connection.id)).connection.credential).toBe('authorization_required');
  });

  it('forgets a grant when the upstream still refuses it after refresh', async () => {
    // Given
    const { server, fixture, admin, connection } = await setup();
    await authorize(admin, connection);
    const { session } = await sessionFor(fixture, connection);
    server.state.refuseAccessTokens = true;
    // When
    session.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const refused = (await session.response(2)).message;
    // Then
    expect(refused.error.message).toContain('needs authorization');
    expect(server.seen.refreshes).toBe(1);
    expect((await admin.get(connection.id)).connection.credential).toBe('authorization_required');
    await session.close();
  });

  it('drops tokens for a new destination and revokes both upstream tokens on explicit revoke', async () => {
    // Given
    const { server, fixture, admin, connection, definition } = await setup();
    await authorize(admin, connection);
    // When
    const moved = await admin.update(connection.id, connection.revision, { ...definition, http: { ...definition.http, url: `${server.origin}/other` } });
    // Then
    expect(moved.connection.credential).toBe('authorization_required');
    const back = await admin.update(connection.id, moved.connection.revision, definition);
    await authorize(admin, back.connection);
    const revoked = await admin.apply({ kind: 'revoke-credentials', id: connection.id, expectedRevision: back.connection.revision });
    expect(revoked.connection.credential).toBe('authorization_required');
    // Local success precedes upstream revocation; shutdown waits for that work.
    await fixture.service.close();
    expect(server.seen.revocations).toEqual(['refresh_token', 'access_token']);
  });
});

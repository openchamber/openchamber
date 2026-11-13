import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createAdminSocketServer } from './admin-socket.js';
import { destinationFingerprint } from './definitions.js';
import { createOAuth } from './oauth.js';
import { openStore, parseOperation } from './store.js';
import { requestAdmin } from '../service-client.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const clientSecret = 'synthetic-client-secret';
const accessToken = 'synthetic-access-token';
const refreshToken = 'synthetic-refresh-token';
async function setup(fetchImpl) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pmcp-admin-revocation-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const store = await openStore({ stateDir: path.join(root, 'state') });
  cleanups.push(store.close);
  await store.apply(parseOperation({ kind: 'create', definition: { name: 'oauth', transport: 'http', http: { url: 'https://example.test/mcp', oauth: { clientId: 'static-client', clientSecret: { secret: 'client' } } } }, secrets: { client: clientSecret } }));
  const definition = store.get(store.adminViews()[0].id);
  await store.updateOAuth(definition.id, destinationFingerprint(definition), () => ({ revocationEndpoint: 'https://example.test/revoke', client: { clientId: 'static-client', clientSecret: null }, tokens: { accessToken, refreshToken } }));
  const logs = [];
  const log = (...entry) => logs.push(entry);
  const oauth = createOAuth({ store, fetchImpl, log });
  const socket = path.join(root, 'admin.sock');
  const server = createAdminSocketServer({ path: socket, store, views: () => store.adminViews(), status: () => ({}), oauth, log });
  await server.listen();
  cleanups.push(server.close);
  const config = path.join(root, 'client.json');
  await fs.writeFile(config, JSON.stringify({ version: 1, socket, adminSocket: socket, relay: ['/relay'] }));
  return { store, server, logs, definition, apply: (kind) => requestAdmin({ clientConfigPath: config, timeoutMs: 200, frame: { type: 'apply', operation: { kind, id: definition.id, expectedRevision: 1 } } }) };
}

it.each(['remove', 'revoke-credentials'])('answers %s before upstream revocation and waits for it on close', async (kind) => {
  // Given an upstream whose response remains on the wire.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const authenticated = [];
  const fixture = await setup(async (_url, init) => {
    authenticated.push(init.headers.authorization === `Basic ${Buffer.from(`static-client:${clientSecret}`).toString('base64')}`);
    await gate;
    return new Response('', { status: 200 });
  });
  try {
    // When local deletion commits while revocation is pending.
    const answer = await fixture.apply(kind);
    // Then local success is immediate and the wire answer contains no removed credential.
    expect(answer.ok).toBe(true);
    expect(answer.answer.type).toBe('applied');
    expect([clientSecret, accessToken, refreshToken].some((value) => JSON.stringify(answer).includes(value))).toBe(false);
    let closed = false;
    const closing = fixture.server.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    release();
    await closing;
    expect(authenticated).toEqual([true, true]);
  } finally { release(); }
});

it('authenticates both revocations with the removed static client secret', async () => {
  // Given a confidential static OAuth client.
  const authenticated = [];
  const fixture = await setup(async (_url, init) => {
    authenticated.push(init.headers.authorization === `Basic ${Buffer.from(`static-client:${clientSecret}`).toString('base64')}`);
    return new Response('', { status: 200 });
  });
  // When its credentials are deleted before revocation runs.
  await fixture.apply('remove');
  await fixture.server.close();
  // Then both requests retain client authentication.
  expect(authenticated).toEqual([true, true]);
});

it.each([400, 401, 500])('logs sanitized revocation failure on HTTP %i', async (status) => {
  // Given an upstream returning a body with credential material.
  const fixture = await setup(async () => new Response(accessToken, { status }));
  // When credentials are forgotten and background work finishes.
  await fixture.apply('revoke-credentials');
  await fixture.server.close();
  // Then every rejected token revocation is visible without its payload.
  expect(fixture.logs.filter(([event]) => event === 'oauth_revocation_failed')).toEqual([
    ['oauth_revocation_failed', { connection: fixture.definition.id, code: 'oauth_revocation_rejected', status }],
    ['oauth_revocation_failed', { connection: fixture.definition.id, code: 'oauth_revocation_rejected', status }],
  ]);
  expect([clientSecret, accessToken, refreshToken].some((value) => JSON.stringify(fixture.logs).includes(value))).toBe(false);
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { destinationFingerprint, parseDefinition } from './definitions.js';
import { createOAuth } from './oauth.js';
import { openStore } from './store.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DEFINITION = { name: 'remote', transport: 'http', http: { url: 'https://mcp.example.com/mcp', oauth: { scopes: [] } } };
const refreshed = () => new Response(JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2', token_type: 'Bearer', expires_in: 3600 }), { status: 200 });
const refused = () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });

/**
 * A connection with an expired grant and an authorization server whose token
 * answer waits until the test releases it, so the test can change the
 * connection while a refresh is on the wire.
 */
async function setup({ answer = refreshed } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protected-mcp-oauth-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const clock = 1_000_000;
  const store = await openStore({ stateDir: path.join(root, 'state') });
  cleanups.push(() => store.close());
  const { connection: created } = await store.apply({ kind: 'create', definition: parseDefinition(DEFINITION), secrets: {} });
  const { id } = created;
  const fingerprint = destinationFingerprint(store.get(id));
  const grant = (accessToken, refreshToken) => ({ accessToken, refreshToken, expiresAt: clock - 1, scope: null });
  await store.updateOAuth(id, fingerprint, () => ({
    issuer: 'https://as.example.com/',
    authorizationEndpoint: 'https://as.example.com/authorize',
    tokenEndpoint: 'https://as.example.com/token',
    revocationEndpoint: null,
    registrationEndpoint: null,
    client: { clientId: 'client', clientSecret: null, redirectUri: 'https://app.example/api/protected-mcp/oauth/callback' },
    tokens: grant('at-1', 'rt-1'),
  }));
  let arrived;
  const reached = new Promise((resolve) => { arrived = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => {
    arrived();
    await gate;
    return answer();
  };
  const oauth = createOAuth({ store, fetchImpl, now: () => clock });
  // What a new authorization stores: a new grant, here with whatever refresh token the server chose.
  const authorizeAgain = (accessToken, refreshToken) => store.updateOAuth(id, fingerprint, (previous) => ({ ...previous, tokens: grant(accessToken, refreshToken) }));
  return { store, id, oauth, reached, release, authorizeAgain };
}

const storedTokens = (store, id) => store.credentialsFor(store.get(id))?.oauth?.tokens ?? null;

describe('OAuth writes that race administrative changes', () => {
  it('does not bring tokens back when a refresh finishes after the administrator revoked them', async () => {
    const { store, id, oauth, reached, release } = await setup();
    const refreshing = oauth.tokensFor(store.get(id));
    await reached;
    await store.apply({ kind: 'revoke-credentials', id, expectedRevision: store.get(id).revision });
    release();
    await expect(refreshing).rejects.toMatchObject({ code: 'authorization_required' });
    expect(store.credentialState(store.get(id))).toBe('authorization_required');
    expect(store.credentialsFor(store.get(id))).toBeNull();
  });

  it('keeps a grant authorized while a refresh of the old one was on the wire, and answers with it', async () => {
    const { store, id, oauth, reached, release, authorizeAgain } = await setup();
    const refreshing = oauth.tokensFor(store.get(id));
    await reached;
    await authorizeAgain('at-new', 'rt-new');
    release();
    await expect(refreshing).resolves.toMatchObject({ accessToken: 'at-new' });
    expect(storedTokens(store, id)).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' });
  });

  it('keeps a new grant that received the same refresh token, over a late refresh of the old one', async () => {
    const { store, id, oauth, reached, release, authorizeAgain } = await setup();
    const refreshing = oauth.tokensFor(store.get(id));
    await reached;
    await authorizeAgain('at-new', 'rt-1');
    release();
    await expect(refreshing).resolves.toMatchObject({ accessToken: 'at-new' });
    expect(storedTokens(store, id)).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-1' });
  });

  it('keeps a new grant that received the same refresh token, when the old one\'s refresh is refused late', async () => {
    const { store, id, oauth, reached, release, authorizeAgain } = await setup({ answer: refused });
    const refreshing = oauth.tokensFor(store.get(id));
    await reached;
    await authorizeAgain('at-new', 'rt-1');
    release();
    await expect(refreshing).resolves.toMatchObject({ accessToken: 'at-new' });
    expect(store.credentialState(store.get(id))).toBe('authorized');
  });

  it('stores a refresh that finishes after a policy-only change', async () => {
    const { store, id, oauth, reached, release } = await setup();
    const refreshing = oauth.tokensFor(store.get(id));
    await reached;
    const policy = parseDefinition({ ...DEFINITION, policy: { denyTools: ['delete_everything'] } });
    await store.apply({ kind: 'update', id, expectedRevision: store.get(id).revision, definition: policy, secrets: {} });
    release();
    await expect(refreshing).resolves.toMatchObject({ accessToken: 'at-2' });
    expect(storedTokens(store, id)).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
  });

  it('forgets only the grant an upstream refused, told apart by identity', async () => {
    const { store, id, oauth } = await setup();
    const used = storedTokens(store, id);
    // Same strings, another grant: an equal copy is not the stored grant.
    await oauth.markUnauthorized(store.get(id), { tokens: { ...used } });
    expect(store.credentialState(store.get(id))).toBe('authorized');
    await oauth.markUnauthorized(store.get(id), { tokens: used });
    expect(store.credentialState(store.get(id))).toBe('authorization_required');
  });
});

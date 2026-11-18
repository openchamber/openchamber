import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createBotIdentityStore } from '../identities.js';
import { createBotServices } from '../services.js';
import { createCredentialResolver } from './credentials.js';
import { createJiraOAuthHttp, createProviderHttp } from './http.js';
import { createJiraAdapter } from './jira.js';
import { BotServiceError } from './contracts.js';
import { controlledUpstream, disconnectedPolicy, enterprisePolicy, issueResponse } from './http.test-support.js';

const cloudId = 'd313a597-a578-4b2e-bf98-93308087542e';
const site = 'https://fixture.atlassian.net';
const prefix = `/ex/jira/${cloudId}`;
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fixture = async ({ tenantCloudId = cloudId, policyOptions = disconnectedPolicy, onToken, onGateway } = {}) => {
  let tokenCount = 0;
  const upstream = await controlledUpstream(async (request) => {
    if (request.path === '/_edge/tenant_info') return { body: { cloudId: tenantCloudId } };
    if (request.path === '/oauth/token') {
      tokenCount += 1;
      if (onToken) return onToken(request, tokenCount);
      return { body: { access_token: `disposable-access-${tokenCount}`, expires_in: 60, token_type: 'Bearer' } };
    }
    if (request.path.startsWith(prefix) && onGateway) {
      const result = await onGateway(request);
      if (result) return result;
    }
    if (request.path === `${prefix}/rest/api/3/myself`) return { body: { accountId: 'piggyops', active: true } };
    if (request.path.startsWith(`${prefix}/rest/api/3/issue/TEST-7?`)) return { body: issueResponse() };
    if (request.path === `${prefix}/rest/api/3/issue/TEST-7/comment`) return { body: { id: 'comment-one' } };
    return { status: 404 };
  });
  cleanups.push(upstream.close);
  const dataDir = await fs.mkdtemp('/tmp/opencode/jira-oauth-');
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const identities = createBotIdentityStore({ dataDir });
  const definition = { kind: 'jira-oauth', label: 'PiggyOps', site, cloudId, clientId: 'disposable-client', clientSecret: 'disposable-secret' };
  const identity = await identities.create(definition);
  const services = createBotServices({ dataDir, identities, fetchImpl: upstream.fetchImpl, policyOptions });
  const target = { projectKey: 'TEST', issueKey: 'TEST-7' };
  const request = { identityId: identity.id, identityRevision: identity.revision, target };
  return { dataDir, upstream, identities, identity, definition, services, target, request };
};

it('binds the site to its cloud ID before exchanging credentials and reading through the Jira gateway', async () => {
  // Given a real identity/service composition and controlled Atlassian HTTP boundaries.
  const f = await fixture();
  // When the selected service account reads an issue.
  const result = await f.services.read({ ...f.request, operation: 'jira.issue' });
  // Then authentication uses the official form exchange and only the bound gateway receives Bearer credentials.
  expect(result).toMatchObject({ key: 'TEST-7', status: { id: '1' } });
  expect(f.upstream.origins).toEqual([site, 'https://auth.atlassian.com', 'https://api.atlassian.com', 'https://api.atlassian.com']);
  expect(f.upstream.requests[0].headers.authorization).toBeUndefined();
  expect(f.upstream.requests[1]).toMatchObject({ path: '/oauth/token', method: 'POST',
    body: { client_id: 'disposable-client', client_secret: 'disposable-secret', grant_type: 'client_credentials' } });
  expect(f.upstream.requests.slice(2).every((request) => request.path.startsWith(prefix)
    && request.headers.authorization === 'Bearer disposable-access-1')).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/disposable-|access_token|clientSecret/);
  expect(JSON.stringify(await f.identities.list())).not.toMatch(/disposable-secret|access_token|clientSecret/);
});

it('refuses a cloud ID belonging to another site before exchanging or sending credentials', async () => {
  // Given an identity whose supplied cloud ID differs from the site's authoritative ID.
  const f = await fixture({ tenantCloudId: '913601cb-ed1a-43cb-95ed-c4075a7f137d' });
  // When it attempts an authenticated read.
  await expect(f.services.read({ ...f.request, operation: 'jira.issue' })).rejects.toMatchObject({ state: 'needs-you' });
  // Then neither token exchange nor gateway access occurred.
  expect(f.upstream.requests.map((request) => request.path)).toEqual(['/_edge/tenant_info']);
  expect(f.upstream.requests[0].headers.authorization).toBeUndefined();
});

it('renews expired credentials before another gateway call and refuses a rotated identity', async () => {
  // Given one resolved credential with an injected authoritative clock.
  const f = await fixture();
  let clock = 1_000;
  const resolve = createCredentialResolver({ identities: f.identities,
    http: createProviderHttp({ fetchImpl: f.upstream.fetchImpl, policyOptions: disconnectedPolicy }),
    jiraOAuthHttp: createJiraOAuthHttp({ fetchImpl: f.upstream.fetchImpl, policyOptions: disconnectedPolicy }), now: () => clock });
  const credential = await resolve({ ...f.request, service: 'jira' });
  // When time passes beyond expiry, concurrent reads share a replacement token.
  clock += 60_000;
  await Promise.all([credential.request({ path: '/rest/api/3/myself' }), credential.request({ path: '/rest/api/3/myself' })]);
  // Then the expired token is not reused and later identity rotation invalidates this credential.
  expect(f.upstream.requests.filter((request) => request.path === '/oauth/token')).toHaveLength(2);
  expect(f.upstream.requests.slice(-2).map((request) => request.headers.authorization)).toEqual(['Bearer disposable-access-2', 'Bearer disposable-access-2']);
  await f.identities.update(f.identity.id, 1, { ...f.definition, clientSecret: 'replacement-secret' });
  await expect(credential.request({ path: '/rest/api/3/myself' })).rejects.toMatchObject({ code: 'BOT_IDENTITY_UNAVAILABLE' });
  expect(f.upstream.requests.filter((request) => request.path === '/oauth/token')).toHaveLength(2);
  expect((await fs.readdir(f.dataDir)).sort()).toEqual(['bot-identities.json']);
});

it.each([{ destinations: [] }, { destinations: [{ service: 'jira', origin: site, resource: 'TEST' }] }])('gates gateway writes by the original site/project enterprise destination $destinations', async ({ destinations }) => {
  // Given a prepared comment under the exact Jira site/project policy.
  const f = await fixture({ policyOptions: enterprisePolicy(destinations) });
  const input = { body: 'Controlled comment' };
  const effect = await f.services.prepare({ ...f.request, key: 'comment', operation: 'jira.comment', botId: 'bot', itemId: 'item', input });
  expect(effect.authority.origin).toBe(site);
  // When dispatch is attempted through the shared gateway.
  if (destinations.length) expect(await f.services.execute(effect, input)).toMatchObject({ result: { commentId: 'comment-one' } });
  else await expect(f.services.execute(effect, input)).rejects.toMatchObject({ code: 'enterprise_mode' });
  // Then the gateway does not grant another tenant or project content-write authority.
  expect(f.upstream.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/comment'))).toHaveLength(destinations.length ? 1 : 0);
});

it('reports an OAuth rejection without exposing its body, secret or token', async () => {
  // Given a token endpoint that rejects the supplied credential.
  const f = await fixture({ onToken: async () => ({ status: 401, body: { error_description: 'disposable-secret upstream body' } }) });
  // When a Jira operation needs that credential.
  const failure = await f.services.read({ ...f.request, operation: 'jira.issue' }).catch((error) => error);
  // Then the caller receives actionable attention without upstream credential material.
  expect(failure).toMatchObject({ state: 'needs-you' });
  expect(String(failure)).not.toMatch(/disposable-secret|upstream body/);
  expect(f.upstream.requests).toHaveLength(2);
});

it('refuses token redirects without forwarding the client secret to another origin', async () => {
  // Given an authentication endpoint that attempts a redirect.
  const f = await fixture({ onToken: async () => ({ status: 302, headers: { location: 'https://untrusted.example/token' } }) });
  // When the service tries to acquire an access token.
  await expect(f.services.read({ ...f.request, operation: 'jira.issue' })).rejects.toThrow();
  // Then the secret was sent only to the fixed Atlassian auth endpoint and no Jira call followed.
  expect(f.upstream.origins).toEqual([site, 'https://auth.atlassian.com']);
  expect(f.upstream.requests).toHaveLength(2);
});

it('does not use a token whose identity was replaced during the exchange', async () => {
  // Given a credential revision that changes while its token exchange is in flight.
  let f;
  f = await fixture({ onToken: async () => {
    await f.identities.update(f.identity.id, 1, { ...f.definition, clientSecret: 'replacement-secret' });
    return { body: { access_token: 'disposable-stale-access', expires_in: 3600, token_type: 'Bearer' } };
  } });
  // When the original operation receives the token.
  await expect(f.services.read({ ...f.request, operation: 'jira.issue' })).rejects.toMatchObject({ code: 'BOT_IDENTITY_UNAVAILABLE' });
  // Then that stale authority never reaches the gateway.
  expect(f.upstream.origins).toEqual([site, 'https://auth.atlassian.com']);
});

it('checks destination policy after renewal before sending content', async () => {
  // Given a policy revoked while an expired credential is renewed.
  let allowed = true; let clock = 1_000;
  const policyOptions = { env: {}, readFile: () => JSON.stringify({ enterpriseMode: true,
    allowedBotDestinations: allowed ? [{ service: 'jira', origin: site, resource: 'TEST' }] : [] }) };
  const f = await fixture({ policyOptions, onToken: async (_request, count) => {
    if (count === 2) allowed = false;
    return { body: { access_token: `disposable-${count}`, expires_in: 60, token_type: 'Bearer' } };
  } });
  const resolve = createCredentialResolver({ identities: f.identities, now: () => clock,
    http: createProviderHttp({ fetchImpl: f.upstream.fetchImpl, policyOptions }),
    jiraOAuthHttp: createJiraOAuthHttp({ fetchImpl: f.upstream.fetchImpl, policyOptions }) });
  const credential = await resolve({ ...f.request, service: 'jira' });
  clock += 60_000;
  // When the credential attempts a content write.
  await expect(credential.request({ path: '/rest/api/3/issue/TEST-7/comment', method: 'POST', body: {} }))
    .rejects.toMatchObject({ code: 'enterprise_mode' });
  // Then no content left the server under the revoked policy.
  expect(f.upstream.requests.filter((request) => request.path.endsWith('/comment'))).toHaveLength(0);
});

it('checks question authority after renewal and never repeats a refused content call', async () => {
  // Given a question whose approved recipient authority changes during token renewal.
  let approved = true; let clock = 1_000;
  const f = await fixture({ onGateway: async (request) => {
    if (request.path.includes('/issue/TEST-7?')) clock += 60_000;
  }, onToken: async (_request, count) => {
    if (count === 2) approved = false;
    return { body: { access_token: `disposable-${count}`, expires_in: 60, token_type: 'Bearer' } };
  } });
  const resolve = createCredentialResolver({ identities: f.identities, now: () => clock,
    http: createProviderHttp({ fetchImpl: f.upstream.fetchImpl, policyOptions: disconnectedPolicy }),
    jiraOAuthHttp: createJiraOAuthHttp({ fetchImpl: f.upstream.fetchImpl, policyOptions: disconnectedPolicy }) });
  const credential = await resolve({ ...f.request, service: 'jira' });
  const adapter = createJiraAdapter(credential, f.target, { beforeQuestionWrite: async () => {
    if (!approved) throw new BotServiceError('BOT_QUESTION_AUTHORITY_REQUIRED', 'Question authority changed.');
  } });
  // When the adapter attempts the question after reading its issue.
  await expect(adapter.perform('jira.question', { body: 'Question', recipients: [{ serviceId: 'approved-owner' }] }))
    .rejects.toMatchObject({ code: 'BOT_QUESTION_AUTHORITY_REQUIRED' });
  // Then renewed authentication cannot bypass the final recipient check.
  expect(f.upstream.requests.filter((request) => request.path.endsWith('/comment'))).toHaveLength(0);
});

it('confines requests to the bound tenant and Jira REST prefix', async () => {
  // Given a resolved credential for exactly one tenant.
  const f = await fixture();
  const resolve = createCredentialResolver({ identities: f.identities,
    http: createProviderHttp({ fetchImpl: f.upstream.fetchImpl, policyOptions: disconnectedPolicy }),
    jiraOAuthHttp: createJiraOAuthHttp({ fetchImpl: f.upstream.fetchImpl, policyOptions: disconnectedPolicy }) });
  const credential = await resolve({ ...f.request, service: 'jira' });
  const before = f.upstream.requests.length;
  // When internal callers supply paths that escape the captured transport.
  for (const value of ['https://untrusted.example', '//untrusted.example', '/rest/api/3/../../../../other',
    '/rest/api/3/..\\..\\other', `/ex/jira/913601cb-ed1a-43cb-95ed-c4075a7f137d/rest/api/3/myself`]) {
    await expect(credential.request({ path: value })).rejects.toMatchObject({ code: 'BOT_SERVICE_ORIGIN_INVALID' });
  }
  // Then no request reached another endpoint.
  expect(f.upstream.requests).toHaveLength(before);
});

it('does not renew and replay an authentication-rejected content write', async () => {
  // Given valid OAuth credentials whose content permission is refused by Jira.
  const f = await fixture({ onGateway: async (request) => request.path.endsWith('/comment')
    ? { status: 401, body: { error: 'disposable-secret rejected' } } : undefined });
  const input = { body: 'Do not repeat this content' };
  const effect = await f.services.prepare({ ...f.request, key: 'refused-comment', operation: 'jira.comment', botId: 'bot', itemId: 'item', input });
  // When the service submits the content once and receives the refusal.
  await expect(f.services.execute(effect, input)).rejects.toMatchObject({ code: 'BOT_SERVICE_AUTH_REQUIRED', state: 'needs-you' });
  // Then the original write is not replayed with another token.
  expect(f.upstream.requests.filter((request) => request.path.endsWith('/comment'))).toHaveLength(1);
  expect(f.upstream.requests.filter((request) => request.path === '/oauth/token')).toHaveLength(2);
});

it('rechecks the identity after the final content authority callback', async () => {
  // Given a credential that is replaced while the final question/authority callback runs.
  const f = await fixture();
  const resolve = createCredentialResolver({ identities: f.identities,
    http: createProviderHttp({ fetchImpl: f.upstream.fetchImpl, policyOptions: disconnectedPolicy }),
    jiraOAuthHttp: createJiraOAuthHttp({ fetchImpl: f.upstream.fetchImpl, policyOptions: disconnectedPolicy }) });
  const credential = await resolve({ ...f.request, service: 'jira' });
  // When the callback replaces the captured identity before content admission.
  await expect(credential.request({ path: '/rest/api/3/issue/TEST-7/comment', method: 'POST', body: {},
    beforeWrite: () => f.identities.update(f.identity.id, 1, { ...f.definition, clientSecret: 'replacement-secret' }) }))
    .rejects.toMatchObject({ code: 'BOT_IDENTITY_UNAVAILABLE' });
  // Then no stale credential authorizes the content POST.
  expect(f.upstream.requests.filter((request) => request.path.endsWith('/comment'))).toHaveLength(0);
});

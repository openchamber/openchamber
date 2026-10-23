import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createBotServices } from './services.js';
import { createBotIdentityStore } from './identities.js';
import { createMutationStore } from '../source-control/mutation-storage.js';
import { createSourceControlAuditStore } from '../source-control/audit-storage.js';
import { accountCredential, gitHubTarget, HEAD, BASE, pullResponse, issueResponse,
  controlledUpstream, disconnectedPolicy, enterprisePolicy } from './services/http.test-support.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const harness = async (handler, { policyOptions = disconnectedPolicy, git } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-services-test-'));
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const upstream = await controlledUpstream(handler);
  cleanups.push(() => upstream.close());
  const accounts = new Map([['account-one', accountCredential()], ['account-two', accountCredential('account-two', 99)]]);
  const identities = createBotIdentityStore({ dataDir, readGitHubAccount: async (id, revision) => {
    const account = accounts.get(id);
    return account?.credentialRevision === revision ? account : null;
  } });
  const services = createBotServices({ dataDir, identities, fetchImpl: upstream.fetchImpl, policyOptions,
    runtimeIdentity: { id: 'test-server', platform: 'web' }, git });
  const identity = await identities.create({ kind: 'github-account', label: 'Chosen', accountId: 'account-one', credentialRevision: 1 });
  const prepare = (operation, input, target = gitHubTarget, selected = identity, key = 'effect-one') => services.prepare({
    key, operation, botId: 'bot-one', itemId: 'item-one', identityId: selected.id, identityRevision: selected.revision, target, input,
  });
  return { dataDir, upstream, accounts, identities, services, identity, prepare };
};
const githubUser = (request) => request.headers.authorization === 'Bearer secret-account-two'
  ? { id: 99, login: 'user-99' } : { id: 42, login: 'user-42' };
const commentInput = { number: 17, headSha: HEAD, body: 'A private bot response' };

it('uses the selected account independently of binding, journals bot authority, and replays once', async () => {
  const h = await harness((request) => ({ body: request.path === '/user' ? githubUser(request)
    : request.path.endsWith('/comments') ? { id: 800 } : pullResponse() }));
  await fs.writeFile(path.join(h.dataDir, 'source-control-bindings.json'), 'unchanged-user-binding');
  const effect = await h.prepare('pr.comment', commentInput);
  expect(JSON.stringify(effect)).not.toContain('secret-');
  const result = await h.services.execute(effect, commentInput);
  expect(result).toMatchObject({ status: 'succeeded', result: { commented: true, commentId: 800 }, replayed: false,
    authority: { providerAccountId: 'github.com#42' } });
  await expect(h.services.execute(effect, commentInput)).resolves.toMatchObject({ replayed: true });
  expect(h.upstream.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  expect(h.upstream.requests.every((request) => request.headers.authorization === 'Bearer secret-account-one')).toBe(true);
  expect(await fs.readFile(path.join(h.dataDir, 'source-control-bindings.json'), 'utf8')).toBe('unchanged-user-binding');
  const records = await createMutationStore({ filePath: path.join(h.dataDir, 'source-control-mutations.json') }).list();
  expect(records[0].target).toMatchObject({ botAuthority: { botId: 'bot-one', itemId: 'item-one', credentialRevision: 1 } });
  expect(records[0].target.bindingRevision).toBeUndefined();
  const audit = await createSourceControlAuditStore({ filePath: path.join(h.dataDir, 'source-control-audit.json') }).list();
  expect(audit[0]).toMatchObject({ initiator: 'bot', providerAccountId: 'github.com#42', state: 'succeeded' });
  expect(JSON.stringify(records)).not.toMatch(/private bot response|secret-/);
});

it('refuses missing credentials, cross-account key reuse, stale revisions and body tampering without fallback', async () => {
  const h = await harness((request) => ({ body: request.path === '/user' ? githubUser(request)
    : request.path.endsWith('/comments') ? { id: 800 } : pullResponse() }));
  const effect = await h.prepare('pr.comment', commentInput);
  await expect(h.services.execute(effect, { ...commentInput, body: 'changed' })).rejects.toMatchObject({ code: 'BOT_EFFECT_CHANGED' });
  const other = await h.identities.create({ kind: 'github-account', label: 'Other', accountId: 'account-two', credentialRevision: 1 });
  await h.services.execute(effect, commentInput);
  const crossed = await h.prepare('pr.comment', commentInput, gitHubTarget, other);
  await expect(h.services.execute(crossed, commentInput)).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_CONFLICT' });
  h.accounts.delete('account-one');
  process.env.GH_TOKEN = 'must-not-be-used';
  try {
    await expect(h.services.execute(effect, commentInput)).rejects.toMatchObject({ code: 'BOT_IDENTITY_UNAVAILABLE', state: 'needs-you' });
  } finally { delete process.env.GH_TOKEN; }
  expect(h.upstream.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
});

it.each([401, 403])('returns needs-you for provider auth failure %s without retrying or leaking provider bodies', async (status) => {
  const h = await harness((request) => request.path === '/user' ? { body: githubUser(request) }
    : request.path.endsWith('/comments') ? { status, body: { token: 'provider-secret', message: 'unsafe error' } } : { body: pullResponse() });
  const effect = await h.prepare('pr.comment', commentInput);
  let error;
  try { await h.services.execute(effect, commentInput); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code: 'BOT_SERVICE_AUTH_REQUIRED', state: 'needs-you', status });
  expect(error.message).not.toMatch(/provider-secret|unsafe error/);
  await expect(h.services.execute(effect, commentInput)).rejects.toThrow();
  expect(h.upstream.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
});

it('blocks enterprise writes unless service, fixed origin and exact resource are allowed', async () => {
  const h = await harness((request) => ({ body: request.path === '/user' ? githubUser(request)
    : request.path.endsWith('/comments') ? { id: 800 } : pullResponse() }), {
    policyOptions: enterprisePolicy([{ service: 'github', origin: 'https://api.github.com', resource: 'acme/another' }]),
  });
  const effect = await h.prepare('pr.comment', commentInput);
  await expect(h.services.execute(effect, commentInput)).rejects.toMatchObject({ code: 'enterprise_mode', status: 403 });
  expect(h.upstream.requests.filter((request) => request.method === 'POST')).toEqual([]);
  const allowed = createBotServices({ dataDir: h.dataDir, identities: h.identities, fetchImpl: h.upstream.fetchImpl,
    policyOptions: enterprisePolicy([{ service: 'github', origin: 'https://api.github.com', resource: 'acme/example' }]) });
  // The refused logical key is terminal. Explicit new admission gets a fresh key.
  const next = await allowed.prepare({ key: 'allowed', operation: 'pr.comment', botId: 'bot-one', itemId: 'item-one',
    identityId: h.identity.id, identityRevision: 1, target: gitHubTarget, input: commentInput });
  await expect(allowed.execute(next, commentInput)).resolves.toMatchObject({ status: 'succeeded', result: { commentId: 800 } });
  expect(h.upstream.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
});

it.each(['disconnect', 'redirect', 'invalid-json'])('keeps a lost comment %s outcome unknown and never resends', async (failure) => {
  const h = await harness((request) => {
    if (request.path === '/user') return { body: githubUser(request) };
    if (request.method === 'GET') return { body: pullResponse() };
    if (failure === 'disconnect') return { disconnect: true };
    if (failure === 'redirect') return { status: 307, headers: { location: '/credential-stealing-destination' } };
    return { raw: '{bad' };
  });
  const effect = await h.prepare('pr.comment', commentInput);
  await expect(h.services.execute(effect, commentInput)).rejects.toMatchObject({ state: 'outcome-unknown' });
  await expect(h.services.reconcile(effect, commentInput)).resolves.toEqual({ state: 'outcome-unknown' });
  await expect(h.services.execute(effect, commentInput)).rejects.toMatchObject({ state: 'outcome-unknown' });
  expect(h.upstream.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  expect(h.upstream.requests.some((request) => request.path === '/credential-stealing-destination')).toBe(false);
});

it('reconciles a unique PR branch by exact destination, base and head without writing', async () => {
  const h = await harness((request) => ({ body: request.path === '/user' ? githubUser(request) : [pullResponse()] }));
  const input = { branch: 'bot/item-one', base: 'main', headSha: HEAD, title: 'Fix', body: 'Evidence', draft: false };
  const effect = await h.prepare('pr.open', input);
  await expect(h.services.reconcile(effect, input)).resolves.toMatchObject({ state: 'succeeded', result: { number: 17 } });
  expect(h.upstream.requests.every((request) => request.method === 'GET')).toBe(true);
});

it('rotates App tokens per operation, verifies the JWT and refuses a different installation', async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  let minted = 0;
  let wrongInstallation = false;
  const h = await harness((request) => {
    if (request.path === '/app') {
      const jwt = request.headers.authorization.slice(7).split('.');
      expect(verify('RSA-SHA256', Buffer.from(jwt.slice(0, 2).join('.')), keys.publicKey, Buffer.from(jwt[2], 'base64url'))).toBe(true);
      expect(JSON.parse(Buffer.from(jwt[1], 'base64url'))).toMatchObject({ iss: '7' });
      return { body: { id: 7, slug: 'developer' } };
    }
    if (request.path === '/app/installations/8') return { body: { id: 8, app_id: wrongInstallation ? 9 : 7, suspended_at: null } };
    if (request.path.endsWith('/access_tokens')) {
      expect(request.body.repositories).toEqual(['example']);
      minted += 1;
      return { body: { token: `installation-${minted}`, expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ full_name: 'acme/example' }] } };
    }
    if (request.path.startsWith('/users/')) return { body: { id: 777, login: 'developer[bot]', type: 'Bot' } };
    if (request.path.startsWith('/repos/')) return { body: pullResponse() };
    return { status: 404 };
  });
  const app = await h.identities.create({ kind: 'github-app', label: 'App', appId: '7', installationId: '8', privateKey: keys.privateKey });
  const effect = await h.prepare('pr.comment', commentInput, gitHubTarget, app);
  expect(effect.authority.providerAccountId).toBe('github.com#777');
  await h.services.read({ identityId: app.id, identityRevision: 1, operation: 'github.pull', target: gitHubTarget, input: { number: 17 } });
  expect(minted).toBe(2);
  expect(JSON.stringify(await h.identities.list())).not.toMatch(/PRIVATE KEY|installation-/);
  wrongInstallation = true;
  await expect(h.prepare('pr.comment', commentInput, gitHubTarget, app)).rejects.toMatchObject({ code: 'BOT_IDENTITY_UNAVAILABLE' });
  expect(minted).toBe(2);
});

it.each(['auto-merge', 'queue'])('pins %s admission to the proved head and never calls direct merge', async (mode) => {
  const h = await harness((request) => {
    if (request.path === '/user') return { body: githubUser(request) };
    if (request.path.includes('/rules/branches/')) return { body: [{ type: 'required_signatures' }, { type: 'merge_queue' }] };
    if (request.path !== '/graphql') return { body: pullResponse() };
    const { query, variables } = request.body;
    if (query.startsWith('query BotBranchRules')) return { body: { data: { repository: { ref: { target: { oid: BASE }, branchProtectionRule: null } } } } };
    expect(variables.head).toBe(HEAD);
    expect(query).toContain('expectedHeadOid:$head');
    expect(query).not.toMatch(/mergePullRequest|bypass|jump:true/);
    return { body: { data: mode === 'queue' ? { enqueuePullRequest: { mergeQueueEntry: { id: 'queue-entry' } } }
      : { enablePullRequestAutoMerge: { pullRequest: { headRefOid: HEAD, autoMergeRequest: { enabledAt: 'now' } } } } } };
  });
  const input = { number: 17, headSha: HEAD, baseSha: BASE, branch: 'bot/item-one', mode, mergeMethod: 'SQUASH' };
  const effect = await h.prepare('pr.auto-merge', input);
  await expect(h.services.execute(effect, input)).resolves.toMatchObject({ result: { status: mode === 'queue' ? 'enqueued' : 'pending' } });
  expect(h.upstream.requests.some((request) => /\/merge(?:-async)?$/.test(request.path))).toBe(false);
});

it.each(['pr.disable-auto-merge', 'pr.dequeue'])('refuses %s for another item branch or a retargeted PR', async (operation) => {
  const h = await harness((request) => ({ body: request.path === '/user' ? githubUser(request)
    : pullResponse({ head: { sha: HEAD, ref: 'bot/another-item', repo: { full_name: 'acme/example' } } }) }));
  await expect(h.prepare(operation, { number: 17, branch: 'bot/another-item' })).rejects.toMatchObject({ code: 'BOT_SERVICE_TARGET_CHANGED' });
  const input = { number: 17, branch: 'bot/item-one' };
  const effect = await h.prepare(operation, input);
  await expect(h.services.execute(effect, input)).rejects.toMatchObject({ code: 'BOT_SERVICE_TARGET_CHANGED' });
  expect(h.upstream.requests.filter((request) => request.method === 'POST')).toEqual([]);
});

it('uses Jira identity for comments, current transitions, bounded search and read errors', async () => {
  let transitioned = false;
  const h = await harness((request) => {
    if (request.path === '/rest/api/3/myself') return { body: { accountId: 'jira-person', active: true } };
    if (request.path.includes('/search/jql')) return { body: { issues: [issueResponse()], nextPageToken: 'next' } };
    if (request.path.endsWith('/transitions')) {
      if (request.method === 'POST') { transitioned = true; return { status: 204 }; }
      return { body: { transitions: [{ id: '31', name: 'Done', to: { id: '9', name: 'Done' } }] } };
    }
    if (request.path.endsWith('/comment')) return { body: { id: 'comment-99' } };
    return { body: issueResponse(transitioned ? '9' : '1') };
  });
  const jira = await h.identities.create({ kind: 'jira-service', label: 'Jira', site: 'https://acme.atlassian.net', email: 'bot@acme.test', apiToken: 'jira-secret' });
  const target = { projectKey: 'TEST', issueKey: 'TEST-7' };
  const comment = await h.prepare('jira.comment', { body: 'Line 1\nLine 2' }, target, jira);
  await expect(h.services.execute(comment, { body: 'Line 1\nLine 2' })).resolves.toMatchObject({ result: { commentId: 'comment-99' } });
  const posted = h.upstream.requests.find((request) => request.path.endsWith('/comment'));
  expect(posted.headers.authorization).toBe(`Basic ${Buffer.from('bot@acme.test:jira-secret').toString('base64')}`);
  expect(posted.body.body).toMatchObject({ type: 'doc', version: 1, content: [{ type: 'paragraph' }, { type: 'paragraph' }] });
  const input = { transitionId: '31', expectedStatusId: '9' };
  const effect = await h.prepare('jira.transition', input, target, jira, 'transition');
  await expect(h.services.execute(effect, input)).resolves.toMatchObject({ result: { statusId: '9' } });
  await expect(h.services.reconcile(effect, input)).resolves.toMatchObject({ state: 'succeeded' });
  await expect(h.services.reconcile(comment, { body: 'Line 1\nLine 2' })).resolves.toEqual({ state: 'outcome-unknown' });
  await expect(h.services.read({ identityId: jira.id, identityRevision: 1, operation: 'jira.search', target: {}, input: { jql: 'status = Open' } }))
    .resolves.toMatchObject({ nextPageToken: 'next', issues: [{ key: 'TEST-7' }] });
  const search = h.upstream.requests.find((request) => request.path.includes('/search/jql'));
  expect(new URL(search.path, 'https://fixture').searchParams.get('jql')).toBe('status = Open');
});

it('sends Discord bot messages only to the exact guild or known DM and suppresses pings', async () => {
  const h = await harness((request) => {
    if (request.path.endsWith('/oauth2/applications/@me')) return { body: { id: '12345678', bot: { id: '87654321', bot: true } } };
    if (request.path.endsWith('/messages')) return { body: { id: '33333333', channel_id: '22222222' } };
    return { body: { id: '22222222', type: 0, guild_id: '11111111' } };
  });
  const discord = await h.identities.create({ kind: 'discord-app', label: 'Discord', applicationId: '12345678', botToken: 'discord-secret' });
  const target = { guildId: '11111111', channelId: '22222222' };
  const input = { body: '@everyone hello' };
  const effect = await h.prepare('discord.send', input, target, discord);
  await expect(h.services.execute(effect, input)).resolves.toMatchObject({ result: { messageId: '33333333' } });
  expect(h.upstream.requests.find((request) => request.path.endsWith('/messages'))).toMatchObject({
    headers: { authorization: 'Bot discord-secret' }, body: { allowed_mentions: { parse: [] } },
  });
  const wrong = await h.prepare('discord.send', input, { ...target, guildId: '99999999' }, discord, 'wrong-guild');
  await expect(h.services.execute(wrong, input)).rejects.toMatchObject({ code: 'BOT_DISCORD_CHANNEL_DENIED' });
  expect(h.upstream.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  await expect(h.services.reconcile(effect, input)).resolves.toEqual({ state: 'outcome-unknown' });
});

it('preserves ordered Jira searches across projects with the selected identity and cursor', async () => {
  // Given the configured JQL spans projects and includes its own ordering.
  const jql = 'assignee = currentUser() ORDER BY updated DESC';
  const other = { ...issueResponse(), id: 'other-issue', key: 'OTHER-9',
    fields: { ...issueResponse().fields, project: { key: 'OTHER' } } };
  const h = await harness((request) => request.path === '/rest/api/3/myself'
    ? { body: { accountId: 'jira-person', active: true } }
    : { body: { issues: [issueResponse(), other], isLast: false, nextPageToken: 'next-page' } });
  const jira = await h.identities.create({ kind: 'jira-account', label: 'Jira',
    site: 'https://acme.atlassian.net', email: 'chosen@acme.test', apiToken: 'jira-fixture' });
  // When the source reads the next page through the production service boundary.
  const result = await h.services.read({ identityId: jira.id, identityRevision: 1,
    operation: 'jira.search', target: {}, input: { jql, nextPageToken: 'previous-page', maxResults: 2 } });
  // Then the upstream receives the exact query and both projects remain candidates.
  expect(result).toMatchObject({ issues: [{ key: 'TEST-7' }, { key: 'OTHER-9' }], nextPageToken: 'next-page' });
  const search = h.upstream.requests.find((request) => request.path.includes('/search/jql'));
  const params = new URL(search.path, 'https://fixture').searchParams;
  expect(params.get('jql')).toBe(jql);
  expect(params.get('nextPageToken')).toBe('previous-page');
  expect(params.get('maxResults')).toBe('2');
  expect(search.headers.authorization).toBe(`Basic ${Buffer.from('chosen@acme.test:jira-fixture').toString('base64')}`);
  expect(h.upstream.requests.every((request) => request.method === 'GET')).toBe(true);
});

it.each(['jira', 'discord'])('enforces the enterprise destination at the %s write', async (service) => {
  const h = await harness((request) => {
    if (request.path.endsWith('/myself')) return { body: { accountId: 'jira-person', active: true } };
    if (request.path.endsWith('/oauth2/applications/@me')) return { body: { id: '12345678', bot: { id: '87654321', bot: true } } };
    if (request.path.includes('/channels/')) return { body: { id: '22222222', type: 0, guild_id: '11111111' } };
    return { body: issueResponse() };
  }, { policyOptions: enterprisePolicy([]) });
  const identity = await h.identities.create(service === 'jira'
    ? { kind: 'jira-account', label: 'Jira', site: 'https://acme.atlassian.net', email: 'a@b.test', apiToken: 'secret' }
    : { kind: 'discord-app', label: 'Discord', applicationId: '12345678', botToken: 'secret' });
  const target = service === 'jira' ? { projectKey: 'TEST', issueKey: 'TEST-7' } : { guildId: '11111111', channelId: '22222222' };
  const operation = service === 'jira' ? 'jira.comment' : 'discord.send';
  const effect = await h.prepare(operation, { body: 'Blocked content' }, target, identity);
  await expect(h.services.execute(effect, { body: 'Blocked content' })).rejects.toMatchObject({ code: 'enterprise_mode', state: 'needs-you' });
  expect(h.upstream.requests.filter((request) => request.method === 'POST')).toEqual([]);
});

it('publishes verified App objects, checks parent trees and records new signed SHAs', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const tree = 'c'.repeat(40);
  const blob = 'd'.repeat(40);
  const signed = 'e'.repeat(40);
  let published = false;
  const h = await harness((request) => {
    if (request.path === '/app') return { body: { id: 7, slug: 'developer' } };
    if (request.path === '/app/installations/8') return { body: { id: 8, app_id: 7, suspended_at: null } };
    if (request.path.endsWith('/access_tokens')) return { body: { token: 'temporary-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ full_name: 'acme/example' }] } };
    if (request.path.startsWith('/users/')) return { body: { id: 777, login: 'developer[bot]', type: 'Bot' } };
    if (request.path.includes('/rules/branches/')) return { body: [{ type: 'required_signatures' }] };
    if (request.path === '/graphql') return { body: { data: { repository: { ref: { target: { oid: BASE }, branchProtectionRule: null } } } } };
    if (request.path.includes('/git/ref/heads/')) return published ? { body: { ref: 'refs/heads/bot/item-one', object: { sha: signed } } } : { status: 404 };
    if (request.path.endsWith(`/git/commits/${BASE}`)) return { body: { sha: BASE, tree: { sha: BASE } } };
    if (request.path.endsWith('/git/blobs')) return { body: { sha: blob } };
    if (request.path.endsWith('/git/trees')) return { body: { sha: tree } };
    if (request.path.endsWith('/git/commits')) {
      expect(request.body).toEqual({ tree, parents: [BASE], message: 'Proved fix' });
      return { body: { sha: signed, tree: { sha: tree }, parents: [{ sha: BASE }], verification: { verified: true } } };
    }
    if (request.path.endsWith('/git/refs')) { published = true; return { body: { ref: 'refs/heads/bot/item-one', object: { sha: signed } } }; }
    return { status: 404 };
  }, { git: { resolveRepository: async () => ({ supported: true, repositoryId: 'repo-one' }),
    readSnapshot: async () => ({ baseTreeSha: BASE, commits: [{ sourceSha: HEAD, treeSha: tree, message: 'Proved fix',
      files: [{ path: 'fix.js', mode: '100644', sha: blob, content: Buffer.from('fix').toString('base64') }] }] }),
  } });
  const app = await h.identities.create({ kind: 'github-app', label: 'App', appId: '7', installationId: '8', privateKey });
  const input = { directory: '/trusted/item', branch: 'bot/item-one', headSha: HEAD, baseSha: BASE, expectedRemoteSha: null, base: 'main' };
  const effect = await h.prepare('git.push', input, gitHubTarget, app);
  await expect(h.services.execute(effect, input)).resolves.toMatchObject({ result: {
    headSha: signed, sourceHeadSha: HEAD, commitMap: [{ sourceSha: HEAD, publishedSha: signed }],
  } });
  expect(published).toBe(true);
  expect((await createMutationStore({ filePath: path.join(h.dataDir, 'source-control-mutations.json') }).list())[0].kind).toBe('bot-git-push');
});

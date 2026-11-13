import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { createBotIdentityStore } from './identities.js';
import { createBotServices } from './services.js';
import { createBotServiceContext } from './service-context.js';
import { createProductionBotWorktrees } from './production-worktrees.js';
import { botGit } from './production-git.js';

/** Real Git and real provider owners, with only HTTP and credential storage controlled. */
export async function productionFixture() {
  await fs.mkdir('/tmp/opencode', { recursive: true });
  const root = await fs.mkdtemp('/tmp/opencode/bot-production-');
  const directory = path.join(root, 'repository');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(directory);
  await botGit(directory, ['init', '--initial-branch=main', '--quiet']);
  await botGit(directory, ['config', 'user.name', 'Repository owner']);
  await botGit(directory, ['config', 'user.email', 'owner@example.test']);
  await botGit(directory, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(directory, 'old.js'), 'export const value = 1;\n');
  await botGit(directory, ['add', '.']);
  await botGit(directory, ['commit', '-m', 'Initial repository']);
  await botGit(directory, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const base = (await botGit(directory, ['rev-parse', 'HEAD'])).trim();
  const state = { base, remote: null, head: base, mergeQueue: false, merged: false, approved: false,
    feedback: [], checks: [], requests: [], admissions: [], signed: new Map(), failReads: false, permission: 'write' };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    const url = new URL(req.url, 'http://fixture');
    state.requests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization });
    const reply = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (state.failReads) return reply({}, 503);
    if (url.pathname === '/user') return reply({ id: 42, login: 'selected-bot' });
    if (url.pathname === '/app') return reply({ id: 9, slug: 'selected-app' });
    if (url.pathname === '/app/installations/11') return reply({ id: 11, app_id: 9, suspended_at: null });
    if (url.pathname === '/app/installations/11/access_tokens') return reply({ token: 'fixture-app-token',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ full_name: 'acme/app' }] });
    if (decodeURIComponent(url.pathname) === '/users/selected-app[bot]') return reply({ id: 43, login: 'selected-app[bot]', type: 'Bot' });
    if (url.pathname === '/repos/acme/app') return reply({ default_branch: 'main' });
    if (url.pathname === '/repos/acme/app/git/ref/heads/main') return reply({ ref: 'refs/heads/main', object: { sha: state.base } });
    if (decodeURIComponent(url.pathname) === '/repos/acme/app/git/ref/heads/bot/item-1') return state.remote
      ? reply({ ref: 'refs/heads/bot/item-1', object: { sha: state.remote } }) : reply({}, 404);
    if (url.pathname.startsWith('/repos/acme/app/git/commits/')) return state.signed.has(url.pathname.split('/').at(-1))
      ? reply(state.signed.get(url.pathname.split('/').at(-1))) : reply({}, 404);
    if (url.pathname === '/repos/acme/app/pulls/7') return reply({ number: 7, node_id: 'PR_7', state: state.merged ? 'closed' : 'open',
      head: { sha: state.head, ref: 'bot/item-1', repo: { full_name: 'acme/app' } },
      base: { ref: 'main', repo: { full_name: 'acme/app' } } });
    if (url.pathname.endsWith('/permission')) return reply({ permission: state.permission, user: { login: decodeURIComponent(url.pathname.split('/').at(-2)) } });
    if (url.pathname === '/apps/ai-review') return reply({ id: 77, slug: 'ai-review' });
    if (decodeURIComponent(url.pathname) === '/users/ai-review[bot]') return reply({ id: 88, login: 'ai-review[bot]', type: 'Bot' });
    if (url.pathname === '/graphql') {
      if (body.query.includes('mutation BotEnqueue')) {
        state.admissions.push({ mode: 'queue', ...body.variables });
        return reply({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'MQ_1' } } } });
      }
      if (body.query.includes('mutation BotAutoMerge')) {
        state.admissions.push({ mode: 'auto-merge', ...body.variables });
        return reply({ data: { enablePullRequestAutoMerge: { pullRequest: {
          headRefOid: state.head, autoMergeRequest: { enabledAt: new Date().toISOString() },
        } } } });
      }
      if (body.query.includes('BotBranchRules')) return reply({ data: { repository: { autoMergeAllowed: true, ref: {
        target: { oid: state.base }, branchProtectionRule: null,
        rules: { pageInfo: { hasNextPage: false }, nodes: state.mergeQueue ? [{ type: 'MERGE_QUEUE' }] : [] },
      } } } });
      if (body.query.includes('BotPullAdmission')) return reply({ data: { repository: { pullRequest: { number: 7, headRefOid: state.head,
        baseRefOid: state.base, headRefName: 'bot/item-1', baseRefName: 'main', merged: state.merged,
        reviewDecision: state.approved ? 'APPROVED' : null, headRepository: { nameWithOwner: 'acme/app' }, baseRepository: { nameWithOwner: 'acme/app' } } } } });
      const connection = (nodes) => ({ nodes, pageInfo: { hasPreviousPage: false, hasNextPage: false } });
      return reply({ data: { viewer: { login: 'selected-bot' }, repository: { pullRequest: {
        number: 7, title: 'Fix item', url: 'https://github.com/acme/app/pull/7', state: state.merged ? 'MERGED' : 'OPEN',
        headRefName: 'bot/item-1', headRefOid: state.head, baseRefName: 'main', reviewDecision: null,
        headRepository: { id: 'R_app', name: 'app', owner: { login: 'acme' } },
        reviews: connection([]), comments: connection([]), reviewThreads: connection(state.feedback),
        commits: { nodes: [{ commit: { oid: state.head, statusCheckRollup: { contexts: connection(state.checks) } } }] },
      } } } });
    }
    return reply({}, 404);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const fetchImpl = (url, options) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, options);
  const identities = createBotIdentityStore({ dataDir, readGitHubAccount: async (id, revision) => id === 'selected-account' && revision === 1
    ? { credentialId: id, credentialRevision: revision, status: 'valid', accessToken: 'fixture-selected-token', providerUserId: 'github.com#42' } : null });
  await identities.create({ kind: 'github-account', accountId: 'selected-account', credentialRevision: 1, label: 'Selected bot' });
  const services = createBotServices({ identities, dataDir, fetchImpl, policyOptions: { env: {}, paths: [] } });
  const context = createBotServiceContext({ identities, services, fetchImpl, policyOptions: { env: {}, paths: [] } });
  const project = { id: 'project-1', path: directory };
  const bot = { id: 'bot-1', identity: { github: { kind: 'account', accountId: 'selected-account' } }, limits: { dailyTokens: null, maxPendingHuman: null } };
  const item = { id: 'item-1', botId: bot.id, source: { kind: 'manual', id: 'manual-1' }, title: 'Fix item', effects: [], sessions: { fixing: 'ses_fixing' } };
  const request = { project, bot, item, key: 'item-1:worktree' };
  const makeWorktrees = (options = {}) => createProductionBotWorktrees({ dataDir, context, readItem: async () => item, ...options });
  return { root, directory, dataDir, base, state, services, identities, context, project, bot, item, request, makeWorktrees,
    async selectApp() {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
      const identity = await identities.create({ kind: 'github-app', appId: '9', installationId: '11', privateKey, label: 'Fixture app' });
      bot.identity.github = { kind: 'app', identityId: identity.id };
    },
    async close() { await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); } };
}

export async function commitFiles(directory, files, message) {
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), content);
  }
  await botGit(directory, ['add', '.']);
  await botGit(directory, ['commit', '-m', message]);
  return (await botGit(directory, ['rev-parse', 'HEAD'])).trim();
}

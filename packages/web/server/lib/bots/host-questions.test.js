import fs from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createHostFixture } from './host-test-support.js';
import { createBotsConfig } from './config.js';
import { createBotStore } from './store.js';
import { createBotItem } from './schema.js';
import { createBotExecutionStore } from './execution-store.js';
import { createBotIdentityStore } from './identities.js';
import { createBotServices } from './services.js';
import { createBotServiceContext } from './service-context.js';
import { createProductionBotWorktrees } from './production-worktrees.js';
import { botGit } from './production-git.js';
import { controlledUpstream, disconnectedPolicy, issueResponse } from './services/http.test-support.js';

const cleanups = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const contentWrites = (upstream) => upstream.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/comment'));

async function fixture() {
  let base; let store; let journal; let beforeIssueRead = async () => {};
  const upstream = await controlledUpstream(async (request) => {
    if (request.path === '/app') return { body: { id: 1, slug: 'fixture' } };
    if (request.path === '/app/installations/2') return { body: { id: 2, app_id: 1, suspended_at: null } };
    if (request.path === '/app/installations/2/access_tokens') return { body: { token: 'disposable-installation', expires_at: new Date(Date.now() + 3600_000).toISOString() } };
    if (request.path === '/users/fixture%5Bbot%5D') return { body: { id: 42, login: 'fixture[bot]', type: 'Bot' } };
    if (request.path === '/repos/fixture/repository') return { body: { default_branch: 'main' } };
    if (request.path === '/repos/fixture/repository/git/ref/heads/main') return { body: { ref: 'refs/heads/main', object: { sha: base } } };
    if (request.path.startsWith('/repos/fixture/repository/git/ref/heads/bot')) return { status: 404 };
    if (request.path === '/rest/api/3/myself') return { body: { accountId: 'fixture-bot', active: true } };
    if (request.path.startsWith('/rest/api/3/issue/TEST-7?')) { await beforeIssueRead(); return { body: issueResponse() }; }
    if (request.path === '/rest/api/3/issue/TEST-7/comment' && request.method === 'POST') {
      const item = (await store.read('project')).items.find((entry) => entry.effects.some((effect) => effect.state === 'dispatching'));
      expect(item).toBeDefined();
      const execution = await journal.read('project', item.id);
      expect(item.effects).toContainEqual(expect.objectContaining({ key: execution.data.pendingQuestion, state: 'dispatching' }));
      expect(execution.operations[execution.data.pendingQuestion].prepared.operation).toBe('jira.question');
      return { body: { id: 'comment-one' } };
    }
    return { status: 404 };
  });
  cleanups.push(upstream.close);
  const f = await createHostFixture({ fetchImpl: upstream.fetchImpl, policyOptions: disconnectedPolicy });
  cleanups.push(f.close);
  base = (await botGit(f.project.path, ['rev-parse', 'HEAD'])).trim();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const github = await f.request('/identities', 'POST', { kind: 'github-app', label: 'Disposable app', appId: '1', installationId: '2', privateKey });
  expect(github.status).toBe(200);
  const jiraDefinition = { kind: 'jira-service', label: 'Disposable Jira', site: 'https://fixture.atlassian.net', email: 'bot@fixture.test', apiToken: 'disposable-jira' };
  const jira = await f.request('/identities', 'POST', jiraDefinition);
  expect(jira.status).toBe(200);
  const config = createBotsConfig({ projectConfigRuntime: f.projectConfigRuntime });
  await config.update('project', { definitions: [{ id: 'bot', name: 'Bot', mission: 'Fix verified bugs', enabled: false,
    identity: { github: { kind: 'app', identityId: github.body.identity.id }, jira: { identityId: jira.body.identity.id } } }] });
  const peopleFile = path.join(f.project.path, '.openchamber/people.json');
  await fs.mkdir(path.dirname(peopleFile));
  await fs.writeFile(peopleFile, JSON.stringify([{ id: 'owner', name: 'Owner', roles: ['tech-lead'], jira: 'approved-owner' }]));
  const policy = await f.request('/policy');
  expect((await f.request('/policy/approve', 'POST', { file: policy.body.people.file, fingerprint: policy.body.people.fingerprint })).status).toBe(200);
  store = createBotStore({ projectsDirPath: path.join(f.dataDir, 'projects') });
  journal = createBotExecutionStore({ store });
  const identities = createBotIdentityStore({ dataDir: f.dataDir });
  const services = createBotServices({ dataDir: f.dataDir, identities, fetchImpl: upstream.fetchImpl, policyOptions: disconnectedPolicy });
  const context = createBotServiceContext({ identities, services, fetchImpl: upstream.fetchImpl, policyOptions: disconnectedPolicy });
  const worktrees = createProductionBotWorktrees({ dataDir: f.dataDir, context,
    readItem: async (projectId, itemId) => (await store.read(projectId)).items.find((item) => item.id === itemId) });
  const mutate = (itemId, change) => store.update('project', (snapshot) => ({ snapshot: { ...snapshot,
    items: snapshot.items.map((item) => item.id === itemId ? change(item) : item) } }));
  const bot = (await config.read('project')).definitions[0];
  for (const id of ['valid', 'revoked']) {
    // Distinct source keys are required per bot; the issue target stays server-owned.
    const item = createBotItem({ id, botId: id === 'valid' ? 'bot' : 'second-bot', title: 'Question', source: { kind: 'jira', id: 'TEST-7' } });
    if (id === 'revoked') await config.update('project', { ...(await config.read('project')),
      definitions: [bot, { ...bot, id: 'second-bot' }] });
    await store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: [...snapshot.items, item] } }));
    const currentBot = { ...bot, id: item.botId };
    const checkout = await worktrees.create({ project: f.project, bot: currentBot, item, key: `checkout:${id}` });
    await mutate(id, (current) => ({ ...current, state: 'investigating' }));
    await mutate(id, (current) => ({ ...current, state: 'needs-you', worktree: checkout.directory, branch: checkout.branch,
      sessions: { fixing: `ses_${id}` }, wait: { reason: 'Fixture paused', since: 1, channel: 'ui', people: [] } }));
    await journal.update('project', id, (entry) => ({ ...entry, data: { ...entry.data, runs: {
      'fixing:0': { projectId: 'project', itemId: id, directory: checkout.directory, stage: 'fixing', dispatchedAt: 1, bot: currentBot },
    } } }));
    f.records.set(`ses_${id}`, { id: `ses_${id}`, location: { directory: checkout.directory }, metadata: { openchamber: {
      automation: { source: 'bot', projectId: 'project', botId: item.botId, itemId: id, stage: 'fixing' },
    } } });
  }
  expect(await f.host.start()).toEqual({ failures: [] });
  await config.update('project', { ...(await config.read('project')), definitions: (await config.read('project')).definitions.map((entry) => ({ ...entry, enabled: true })) });
  for (const id of ['valid', 'revoked']) await mutate(id, (item) => ({ ...item, state: 'fixing', wait: undefined }));
  const ask = (id) => f.host.runtime.handleTool({ sessionId: `ses_${id}`, action: 'item.ask',
    input: { operationId: 'ask-one', question: 'Which behavior is expected?', requestedRole: 'tech-lead' } });
  return { ...f, upstream, store, journal, config, peopleFile, jira, jiraDefinition, ask,
    beforeIssueRead: (callback) => { beforeIssueRead = callback; } };
}

it.each(['disabled bot', 'changed selected identity', 'changed people policy', 'changed identity credential'])(
  'production host sends once and refuses %s during the final issue preflight', async (invalidation) => {
    const f = await fixture();
    const valid = await f.ask('valid');
    expect(valid.question.code).toBeNull();
    expect(valid.receipt).toEqual({ id: 'comment-one' });
    expect(valid.item).toMatchObject({ state: 'waiting-answer', wait: { channel: 'jira', people: ['owner'] } });
    expect(valid.item.effects).toEqual([expect.objectContaining({ key: valid.question.key, state: 'succeeded' })]);
    await f.ask('valid');
    expect(contentWrites(f.upstream)).toHaveLength(1);
    expect(contentWrites(f.upstream)[0]).toMatchObject({ path: '/rest/api/3/issue/TEST-7/comment', body: { body: { type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'approved-owner' } }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Which behavior is expected?' }] }] } } });
    let invalidated = false;
    f.beforeIssueRead(async () => {
      const item = (await f.store.read('project')).items.find((entry) => entry.id === 'revoked');
      if (invalidated || !item.effects.some((effect) => effect.state === 'dispatching')) return;
      const execution = await f.journal.read('project', item.id);
      expect(execution.operations[execution.data.pendingQuestion].prepared.operation).toBe('jira.question');
      invalidated = true;
      if (invalidation === 'changed people policy') await fs.writeFile(f.peopleFile, '[]');
      else if (invalidation === 'changed identity credential') {
        expect((await f.request(`/identities/${f.jira.body.identity.id}`, 'PUT', { expectedRevision: 1,
          definition: { ...f.jiraDefinition, apiToken: 'replacement-disposable-jira' } })).status).toBe(200);
      } else {
        const settings = await f.config.read('project');
        await f.config.update('project', { ...settings, definitions: settings.definitions.map((bot) => bot.id !== 'second-bot' ? bot
          : invalidation === 'disabled bot' ? { ...bot, enabled: false }
            : { ...bot, identity: { ...bot.identity, jira: { identityId: 'another-identity' } } }) });
      }
    });
    const refused = await f.ask('revoked');
    expect(invalidated).toBe(true);
    expect(refused.question.code).toBe(invalidation === 'changed identity credential' ? 'BOT_IDENTITY_UNAVAILABLE' : 'BOT_QUESTION_AUTHORITY_REQUIRED');
    expect(refused.receipt).toBeUndefined();
    expect(refused.item).toMatchObject({ state: 'waiting-answer', wait: { channel: 'ui' } });
    expect(contentWrites(f.upstream)).toHaveLength(1);
    const persisted = await f.journal.read('project', 'revoked');
    expect(persisted.data.pendingQuestion).toBe(refused.question.key);
    expect(persisted.operations[refused.question.key].prepared.operation).toBe('jira.question');
  }, 30_000,
);

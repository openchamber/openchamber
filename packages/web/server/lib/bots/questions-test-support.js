import fs from 'node:fs/promises';
import path from 'node:path';
import { createBotQuestions } from './questions.js';
import { createBotsConfig } from './config.js';
import { createBotStore } from './store.js';
import { createBotItem } from './schema.js';
import { createBotIdentityStore } from './identities.js';
import { createBotServices } from './services.js';
import { createBotServiceContext } from './service-context.js';
import { createProductionBotWorktrees } from './production-worktrees.js';
import { createBotProviderRuntime } from './provider-runtime.js';
import { createBotAttention } from './attention.js';
import { createBotEvents } from './events.js';
import { createBotExecutionStore } from './execution-store.js';
import { readRepositoryPolicy } from './repository-policy.js';
import { botGit } from './production-git.js';
import { controlledUpstream, disconnectedPolicy, issueResponse, accountCredential } from './services/http.test-support.js';

export const questionPeople = [
  { id: 'owner', name: 'Owner', roles: [], github: 'owner-gh', discord: '44444444', jira: 'jira-owner' },
  { id: 'lead', name: 'Lead', roles: ['tech-lead'], github: 'lead-gh', discord: '55555555', jira: 'jira-lead' },
  { id: 'author', name: 'Author', roles: [], github: 'code-author', discord: '66666666', jira: 'jira-author' },
];
export const questionArea = (owners = ['owner'], paths = ['src/**']) => `---\nname: Core\npaths: ${JSON.stringify(paths)}\nlevel: judgment\nowners: ${JSON.stringify(owners)}\n---\nReview changes.\n`;
const unavailable = () => { throw new Error('Provider event delivery is outside this question fixture'); };

/** Creates commit objects in a disposable repository, without signing or host credentials. */
export async function questionCommit(directory, files) {
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await fs.writeFile(path.join(directory, file), content);
  }
  if (Object.keys(files).length) await botGit(directory, ['add', '--', ...Object.keys(files)]);
  const tree = (await botGit(directory, ['write-tree'])).trim();
  const parents = (await botGit(directory, ['for-each-ref', '--format=%(objectname)', 'refs/heads/'])).trim();
  const parent = parents ? (await botGit(directory, ['rev-parse', 'HEAD'])).trim() : null;
  const args = ['-c', 'user.name=Untrusted local author', '-c', 'user.email=attacker@invalid.test', 'commit-tree', tree, '-m', 'Question fixture'];
  if (parent) args.push('-p', parent);
  const commit = (await botGit(directory, args)).trim();
  await botGit(directory, ['update-ref', 'HEAD', commit]);
  return commit;
}

export async function questionsFixture({ people = questionPeople, area = questionArea(), source = 'manual', policyOptions = disconnectedPolicy } = {}) {
  const root = await fs.mkdtemp('/tmp/opencode/bot-questions-');
  const directory = path.join(root, 'repository');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(directory);
  await botGit(directory, ['init', '--initial-branch=main', '--quiet']);
  const base = await questionCommit(directory, { 'src/core.js': 'export const value = 1;\n', 'other.js': 'export const other = 1;\n' });
  await botGit(directory, ['remote', 'add', 'origin', 'https://github.com/acme/example.git']);
  await fs.mkdir(path.join(directory, '.agents/areas'), { recursive: true });
  await fs.mkdir(path.join(directory, '.openchamber'));
  await fs.writeFile(path.join(directory, '.openchamber/people.json'), JSON.stringify(people));
  if (area) await fs.writeFile(path.join(directory, '.agents/areas/core.md'), area);
  const controls = { loseWrite: false, denyAuth: false, commitAuthor: 'code-author', commitSha: base,
    approvedAtSend: [], sentBody: null, beforeContentRead: null };
  let store; let journal;
  const upstream = await controlledUpstream(async (request) => {
    if (controls.denyAuth) return { status: 401 };
    if (request.method === 'POST' && /\/(messages|comment)$/.test(request.path)) {
      const item = (await store.read('project')).items[0];
      const execution = await journal.read('project', item.id);
      const effect = item.effects.find((entry) => entry.key === execution.data.pendingQuestion);
      if (effect?.state !== 'dispatching' || !execution.operations[effect.key]) throw new Error('Write preceded durable admission');
      controls.approvedAtSend.push(effect.key);
      controls.sentBody = request.body;
      if (controls.loseWrite) return { disconnect: true };
      return { body: request.path.endsWith('/comment') ? { id: 'comment-1' } : { id: '33333333', channel_id: '22222222' } };
    }
    if (request.path === '/user') return { body: { id: 42, login: 'selected-bot' } };
    if (request.path === '/rest/api/3/myself') return { body: { accountId: 'jira-bot', active: true } };
    if (request.path.startsWith('/rest/api/3/issue/')) {
      if (controls.beforeContentRead) await controls.beforeContentRead();
      return { body: issueResponse() };
    }
    if (request.path.endsWith('/oauth2/applications/@me')) return { body: { id: '12345678', bot: { id: '87654321', bot: true } } };
    if (request.path.startsWith('/api/v10/channels/')) {
      if (controls.beforeContentRead) await controls.beforeContentRead();
      return { body: { id: '22222222', type: 0, guild_id: '11111111' } };
    }
    if (request.path === '/repos/acme/example') return { body: { default_branch: 'main' } };
    if (request.path === '/repos/acme/example/git/ref/heads/main') return { body: { ref: 'refs/heads/main', object: { sha: base } } };
    if (request.path.startsWith('/repos/acme/example/git/ref/heads/bot')) return { status: 404 };
    if (request.path.startsWith('/repos/acme/example/commits/')) return { body: { sha: controls.commitSha,
      author: controls.commitAuthor === null ? null : { login: controls.commitAuthor, id: 77, type: 'User' },
      commit: { committer: { date: '2026-10-22T12:00:00Z' } } } };
    return { status: 404 };
  });
  const identities = createBotIdentityStore({ dataDir, readGitHubAccount: async () => accountCredential() });
  await identities.create({ kind: 'github-account', label: 'GitHub', accountId: 'account-one', credentialRevision: 1 });
  const discord = await identities.create({ kind: 'discord-app', label: 'Discord', applicationId: '12345678', botToken: 'fixture-discord' });
  const jira = await identities.create({ kind: 'jira-service', label: 'Jira', site: 'https://acme.atlassian.net', email: 'bot@acme.test', apiToken: 'fixture-jira' });
  let savedConfig = { definitions: [{ id: 'bot', name: 'Bot', mission: 'Fix verified bugs', enabled: true,
    identity: { github: { kind: 'account', accountId: 'account-one' }, discord: { identityId: discord.id }, jira: { identityId: jira.id } },
    discord: { channels: [{ guildId: '11111111', channelId: '22222222' }] } }] };
  const config = createBotsConfig({ projectConfigRuntime: { readBotsSection: async () => savedConfig,
    updateBotsSection: async (_projectId, change) => { savedConfig = await change(savedConfig); return savedConfig; } } });
  const approve = async () => {
    const policy = await readRepositoryPolicy(directory);
    for (const entry of [...policy.areas, policy.people]) await config.setApproval('project', entry.file, entry.fingerprint);
  };
  await approve();
  store = createBotStore({ projectsDirPath: path.join(root, 'projects') });
  journal = createBotExecutionStore({ store });
  const resolveQuestionAuthority = async ({ botId, itemId, key }) => {
    const item = (await store.read('project')).items.find((entry) => entry.id === itemId && entry.botId === botId);
    if (item?.state !== 'waiting-answer') return null;
    const execution = await journal.read('project', itemId);
    if (execution.data.pendingQuestion !== key) return null;
    return { policy: await readRepositoryPolicy(directory, (await config.read('project')).approvals),
      question: execution.data.questions[key] ?? null };
  };
  const services = createBotServices({ dataDir, identities, fetchImpl: upstream.fetchImpl, policyOptions, resolveQuestionAuthority });
  let providers;
  const context = createBotServiceContext({ identities, services, fetchImpl: upstream.fetchImpl, policyOptions,
    resolveDiscordTarget: (request) => providers.resolveDiscordTarget(request) });
  const project = { id: 'project', path: directory };
  const bot = (await config.read(project.id)).definitions[0];
  const create = createBotItem({ id: 'item', botId: bot.id, source: { kind: source, id: source === 'jira' ? 'TEST-7' : 'manual-1' }, title: 'Question fixture' });
  await store.update(project.id, (snapshot) => ({ snapshot: { ...snapshot, items: [create] } }));
  const mutate = async (change) => store.update(project.id, (snapshot) => ({ snapshot: { ...snapshot, items: snapshot.items.map(change) } }));
  await mutate((item) => ({ ...item, state: 'investigating' }));
  const worktrees = createProductionBotWorktrees({ dataDir, context, readItem: async () => (await store.read(project.id)).items[0] });
  const checkout = await worktrees.create({ project, bot, item: create, key: 'fixture-worktree' });
  await mutate((item) => ({ ...item, state: 'fixing', worktree: checkout.directory, branch: checkout.branch }));
  await questionCommit(checkout.directory, { 'src/core.js': 'export const value = 2;\n' });
  providers = createBotProviderRuntime({ dataDir, config, store, identities, services,
    runtime: { admit: unavailable, receiveFeedback: unavailable, answer: unavailable, pump: unavailable },
    listProjects: async () => [project], resolveProject: async () => project, serviceContext: context.serviceContext, onNeedsYou: unavailable });
  const central = new Map();
  const attention = createBotAttention({ center: {
    upsertBot: async (entry) => { central.set(entry.itemId, entry); return { changed: true, entry }; },
    resolveBot: async ({ itemId }) => central.delete(itemId),
  }, notify: async () => {} });
  const dependencies = { config, store, worktrees, context, services, attention, events: createBotEvents() };
  const questions = createBotQuestions(dependencies);
  const input = { project, bot, itemId: create.id, eventId: 'fixing:0:tool:ask-one', questions: ['Which behavior is expected?'], resumeState: 'fixing' };
  return { root, dataDir, directory, checkout, base, project, bot, store, journal, config, identities, services, context, controls, upstream, central,
    questions, input, mutate, approve, dependencies,
    close: async () => { await upstream.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

import path from 'node:path';
import { createBotDriver, TEST_HEAD } from './runtime-test-support.js';
import { createBotServices } from './services.js';
import { createBotIdentityStore } from './identities.js';
import { createBotExecutionStore } from './execution-store.js';
import { accountCredential, controlledUpstream, disconnectedPolicy, gitHubTarget } from './services/http.test-support.js';

/** Real coordinator, provider HTTP, identity and both durable mutation journals.
 * GitHub and OpenCode are controlled upstreams; no live account is used.
 */
export const createMergeAuthorizationDriver = async (root) => {
  const driver = await createBotDriver(root);
  driver.controls.remoteSha = TEST_HEAD;
  const remote = { autoMerge: false, queued: false, mode: 'auto-merge', lose: null, applyLost: true,
    blocked: false, failRead: false, mergeDuringRevoke: false, beforePrepare: null, beforeMutation: null };
  let item;
  const policyOptions = { ...disconnectedPolicy, readFile: () => {
    if (remote.blocked) return JSON.stringify({ enterpriseMode: true, allowedBotDestinations: [] });
    throw Object.assign(new Error(), { code: 'ENOENT' });
  } };
  const pull = () => ({ number: 42, node_id: 'PR_owned', state: driver.controls.merged ? 'closed' : 'open',
    head: { sha: driver.controls.headSha, ref: item.branch, repo: { full_name: 'acme/example' } },
    base: { ref: 'main', repo: { full_name: 'acme/example' } } });
  const node = () => ({ id: 'PR_owned', number: 42, headRefName: item.branch, baseRefName: 'main',
    headRefOid: driver.controls.headSha, baseRefOid: driver.controls.baseSha, merged: driver.controls.merged,
    headRepository: { nameWithOwner: 'acme/example' }, baseRepository: { nameWithOwner: 'acme/example' },
    autoMergeRequest: remote.autoMerge ? { enabledAt: 'now' } : null,
    mergeQueueEntry: remote.queued ? { id: 'QUEUE_not_the_pull_id' } : null });
  const upstream = await controlledUpstream(async (request) => {
    if (request.path === '/user') return { body: { id: 42, login: 'user-42' } };
    if (request.path.includes('/rules/branches/')) return { body: remote.mode === 'queue' ? [{ type: 'merge_queue' }] : [] };
    if (request.path.includes('/git/ref/heads/')) return { body: { ref: `refs/heads/${decodeURIComponent(request.path.split('/heads/')[1])}`, object: { sha: driver.controls.headSha } } };
    if (request.path.includes('/pulls?')) return { body: [pull()] };
    if (request.path.includes('/pulls/42')) return { body: pull() };
    if (request.path !== '/graphql') return { status: 404 };
    const { query, variables } = request.body;
    if (query.startsWith('query BotBranchRules')) return { body: { data: { repository: { ref: { target: { oid: driver.controls.baseSha }, branchProtectionRule: null } } } } };
    if (query.startsWith('query BotAuthorization') || query.startsWith('query BotQueuedPull')) {
      if (remote.failRead) return { status: 503 };
      return { body: { data: { node: node() } } };
    }
    if (variables.id !== 'PR_owned') return { status: 422 };
    const operation = query.includes('disablePullRequestAutoMerge') ? 'disable' : query.includes('dequeuePullRequest') ? 'dequeue'
      : query.includes('enqueuePullRequest') ? 'queue' : query.includes('enablePullRequestAutoMerge') ? 'enable' : null;
    if (!operation) return { status: 400 };
    await remote.beforeMutation?.(operation);
    if (remote.mergeDuringRevoke && ['disable', 'dequeue'].includes(operation)) {
      driver.controls.merged = true; remote.autoMerge = false; remote.queued = false;
    } else if (remote.lose !== operation || remote.applyLost) {
      if (operation === 'enable') remote.autoMerge = true;
      if (operation === 'queue') remote.queued = true;
      if (operation === 'disable') remote.autoMerge = false;
      if (operation === 'dequeue') remote.queued = false;
    }
    if (remote.lose === operation) return { disconnect: true };
    const data = operation === 'disable' ? { disablePullRequestAutoMerge: { __typename: 'DisablePullRequestAutoMergePayload' } }
      : operation === 'dequeue' ? { dequeuePullRequest: { __typename: 'DequeuePullRequestPayload' } }
        : operation === 'queue' ? { enqueuePullRequest: { mergeQueueEntry: { id: 'QUEUE_not_the_pull_id' } } }
          : { enablePullRequestAutoMerge: { pullRequest: { headRefOid: driver.controls.headSha, autoMergeRequest: { enabledAt: 'now' } } } };
    return { body: { data } };
  });
  const dataDir = path.join(root, 'providers');
  const identities = createBotIdentityStore({ dataDir, readGitHubAccount: async () => accountCredential() });
  const identity = await identities.create({ kind: 'github-account', label: 'Driver', accountId: 'account-one', credentialRevision: 1 });
  const makeServices = () => {
    const services = createBotServices({ dataDir, identities, fetchImpl: upstream.fetchImpl, policyOptions });
    return { ...services, async prepare(request) {
      const result = await services.prepare(request);
      if (request.operation === 'pr.auto-merge') await remote.beforePrepare?.();
      return result;
    } };
  };
  driver.dependencies.services = makeServices();
  driver.dependencies.serviceContext = async () => ({ github: { identityId: identity.id, identityRevision: 1, target: gitHubTarget } });
  driver.dependencies.pullRequests.read = async () => ({ headSha: driver.controls.headSha, baseSha: driver.controls.baseSha,
    merged: driver.controls.merged, approved: driver.controls.approved, mergeMode: remote.mode });
  let runtime = driver.restart();
  return { ...driver, runtime, remote, upstream,
    journal: createBotExecutionStore({ store: driver.store }),
    async admit() { const created = await runtime.admit('project', 'bugs', { source: { kind: 'manual', id: 'merge' }, title: 'Fix' }); item = { ...created, branch: `bot/${created.id}` }; return created; },
    restart() { driver.dependencies.services = makeServices(); runtime = driver.restart(); return runtime; },
    writes: () => upstream.requests.filter((entry) => entry.body?.query?.startsWith('mutation')),
    close: () => upstream.close(),
  };
};

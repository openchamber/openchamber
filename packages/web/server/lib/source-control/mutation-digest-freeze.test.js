import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createMutationExecutor, digestMutationInput } from './mutation-executor.js';
import { registerProviderRoutes } from './provider-routes.js';
import { createProviderDescriptors } from './provider-descriptors.js';
import { createSourceControlProviders } from './provider-registry.js';
import { githubDescriptor } from '../github/descriptor.js';
import { gitlabDescriptor } from '../gitlab/descriptor.js';
import { createProvider as createGiteaProvider } from '../gitea/provider.js';
import { createProvider as createGitLabProvider } from '../gitlab/provider.js';
import { createGitHubMutations } from '../github/mutations.js';
import { createProvider as createGerritProvider } from '../gerrit/provider.js';
import { createProvider as createForgejoProvider } from '../forgejo/provider.js';

/**
 * `source-control-mutations.json` keeps `running` and `outcome-unknown`
 * records forever, and a retry with the same idempotency key must replay
 * them, not conflict. These records were written before the route shell
 * existed; their kinds and digests are frozen here as literal values, so a
 * provider moving onto the shell, or a change to how a digest is computed,
 * cannot quietly turn every retained record into a conflict.
 */
const origin = 'https://gitlab.example.com';
const accountId = `${origin}#9`;
const glActor = { provider: 'gitlab', instance: origin, accountId };
const glCredential = { accountId, credentialRevision: 1 };
const glTarget = {
  repositoryId: 'repo_one', bindingRevision: 3, primaryRemote: 'origin',
  project: { id: '2', owner: 'team', name: 'repo' }, head: 'feature', base: 'main',
};
const FROZEN = {
  gitlabCreate: '7f0264dad24dae6cdde4f3e715f7ab12ccd5f6ce8ad786752ee855e8d1e2c5ba',
  gitlabMerge: '64bf79662435a6bc77412f9c58dcb0e74b3ecf3f531c1b378141b7214cfea93c',
  githubCreate: 'f6632b40999c900bee81a07d43db8ec10dca09c751974ae16fd828119dd5fc0e',
  giteaCreate: '23035f5a7c84b6b8b9ec44c0d049581892e4d15b5d566ae6f9f8a9041477c3b4',
  giteaMerge: '77bebc0991b4c34029b850ae251f8bbcd80f9821d734c02b447d7fb4aac63ed4',
  giteaIssueLabels: 'ad9ec5b59683686e705b85b5f6866b1835a6306c81a73fb920bc0724d8890455',
  githubReviewApprove: '28deb8fd6560413fe85aaf7bc82fb69542b6190ac2d60c09721c68d277fa5a13',
  githubReviewRequestChanges: 'f0ebd3fb413a7e9c1d2c7baab40668eb17f3f5ac3ec8cfeee68fb6505debd762',
  githubReviewApproveNoBody: '10545115bfda6624c3262370ed9f67535b2cc0166d35141fc155a89a57dcc451',
  gitlabReviewApprove: '34d3eada3fe0e1f6a84ef54b1c8c8e96db68d9903d6750ab544a469bbf52f370',
  gitlabReviewRequestChanges: '39a2cf4b2a8791e18a3931c3f65eca808698ff98772460cb9ed2b5d2920a34b0',
  giteaReviewApprove: 'a1581e82d4df9ed62961f829fd3e870b87f39b6ef3676070c25630c91c9044ba',
  giteaReviewRequestChanges: '8bb0fd8f0c6b4fe515f8b4f7bf454f341855fa38fab6a8203dae62afc65114a3',
  giteaReviewApproveNoBody: 'b44110e9b23bf70a4326230a69b34b1398ce0f24c071bca9c0ef4da56ec9008c',
  forgejoCreate: '1810de7888d41517fc1618072127236ebc6107467a8071dd0b840cc6aaa8ff05',
  forgejoMerge: '47be2711e41210cc26042419efc08a7b1fb15136e1aa9d1201e94b4646189208',
  forgejoReviewApprove: '8368ef10a4748b6ab894f62b6cf798a41837e9aef6ac5496c18df6db57bfc91e',
  gerritSubmit: '4473b7f7a3d939ced0c85bca30e6bce3e8f289bbd621a9ddb1e2337da643b1f1',
  gerritVotes: '4fd47905b510db66309e7539296b6e4d8781a12f726f940af841adfeeaeddb0e',
  gerritVotesNoBody: 'dda0eb5b26714cde0f71362205281948a83a5dff6f07851dfdcea1ee83a2c1f3',
};

const ghAccount = 'occred:v1:github:one:r1';
const ghActor = { provider: 'github', instance: 'github.com', accountId: ghAccount };
const ghTarget = {
  repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
  project: { id: 'acme/app', owner: 'acme', name: 'app' }, head: 'feature', base: 'main',
};

const persisted = [
  {
    key: 'gitlab-create', kind: 'change-request-create', actor: glActor, target: glTarget,
    inputDigest: FROZEN.gitlabCreate, state: 'succeeded', result: {},
  },
  {
    key: 'gitlab-merge', kind: 'change-request-merge', actor: glActor, target: { ...glTarget, number: 5 },
    inputDigest: FROZEN.gitlabMerge, state: 'succeeded', result: { merged: true },
  },
  {
    key: 'github-create', kind: 'change-request-create', actor: ghActor, target: ghTarget,
    inputDigest: FROZEN.githubCreate, state: 'succeeded', result: { number: 12 },
  },
];

const mutationStore = () => {
  const records = new Map(persisted.map((record) => [record.key, structuredClone(record)]));
  return {
    withExecutionLock: async (_key, operation) => operation(),
    read: async (key) => records.get(key) ?? null,
    claim: async (record) => {
      const existing = records.get(record.key);
      if (existing) return { status: existing.inputDigest === record.inputDigest ? 'existing' : 'conflict', record: existing };
      records.set(record.key, { ...record, state: 'running' });
      return { status: 'claimed', record: records.get(record.key) };
    },
    complete: async () => { throw new Error('a replay never completes a record'); },
  };
};

const appWith = () => {
  const account = {
    id: accountId, credentialId: accountId, credentialRevision: 1, providerUserId: accountId,
    token: 'stored', user: { id: 9 }, source: 'pat', scope: '', status: 'valid',
  };
  const store = {
    readInstance: vi.fn(async () => ({ activeAccountId: account.id, accounts: [account], cliDisabled: false, cliActive: false })),
    readAccount: vi.fn(async (_origin, id) => (id === account.id ? account : null)),
  };
  const service = {
    resolveCreateMutation: vi.fn(async () => ({ providerTarget: { sourceProjectId: '1', targetProjectId: '2' }, target: glTarget })),
    createChangeRequest: vi.fn(),
    mergeChangeRequest: vi.fn(),
  };
  // GitHub's account resolves to an Octokit that must never be called: a replay is not a write.
  const octokit = new Proxy({ openChamberHost: 'github.com' }, {
    get: (target, key) => {
      if (key in target) return target[key];
      throw new Error('a replay never calls GitHub');
    },
  });
  const github = {
    getOctokitForAccountId: vi.fn(async (id) => (id === ghAccount
      ? { credentialRevision: 1, providerUserId: 'github.com#7', source: 'oauth', user: { id: 7, login: 'octo' }, octokit }
      : null)),
  };
  const providers = createSourceControlProviders({
    descriptors: createProviderDescriptors([githubDescriptor, gitlabDescriptor]),
    hostServices: {
      gitlab: { store, createClient: () => ({}), createDownloader: () => ({}), createResourceService: () => service },
      github: { modules: async () => ({ octokit: github }) },
    },
  });
  const app = express();
  app.use(express.json());
  registerProviderRoutes(app, {
    providers,
    validateMutationContext: async (body) => (body.provider === 'github'
      ? {
        directory: '/repo', repositoryId: 'repo-one', provider: 'github', instance: 'github.com', accountId: ghAccount,
        bindingRevision: 3, primaryRemote: 'origin', idempotencyKey: body.idempotencyKey, target: body.target,
      }
      : {
        directory: '/repo', repositoryId: 'repo_one', provider: 'gitlab', instance: origin, accountId,
        bindingRevision: 3, primaryRemote: 'origin', idempotencyKey: body.idempotencyKey, target: body.target,
      }),
    mutationExecutor: createMutationExecutor({ store: mutationStore() }),
  });
  return { app, service, github };
};

describe('persisted mutation digests', () => {
  it('computes the frozen digests from the fields each provider has always covered', () => {
    expect(digestMutationInput({
      kind: 'change-request-create', actor: glActor, credential: glCredential, target: glTarget,
      title: 'Feature', body: null, draft: false, remote: 'origin', headRemote: 'origin',
    })).toBe(FROZEN.gitlabCreate);
    expect(digestMutationInput({
      kind: 'change-request-merge', actor: glActor, credential: glCredential, target: { ...glTarget, number: 5 }, method: 'squash',
    })).toBe(FROZEN.gitlabMerge);
    // GitHub digests its short kind (`create`) while the record keeps `change-request-create`.
    expect(digestMutationInput({
      kind: 'create',
      actor: ghActor,
      credential: { accountId: ghAccount, credentialRevision: 1 },
      target: ghTarget,
      title: 'Title',
      headRemote: 'origin',
    })).toBe(FROZEN.githubCreate);
  });

  it('keeps Gitea\'s kinds and digests, which its stored records replay by', () => {
    const giteaOrigin = 'https://gitea.example.com';
    const giteaAccount = 'occred:v1:gitea:one:r1';
    const actor = { provider: 'gitea', instance: giteaOrigin, accountId: giteaAccount };
    const credential = { accountId: giteaAccount, credentialRevision: 1 };
    const target = { ...glTarget };
    const numbered = { ...target, number: 5 };
    const { mutations } = createGiteaProvider({ store: {}, events: {} });
    const prepare = (route, input, context) => mutations.prepare({
      route, input, context: { primaryRemote: 'origin', target: context }, actor, credential,
    });

    const create = prepare('/pr/create', { title: 'Feature' }, target);
    expect(create.kind).toBe('change-request-create');
    expect(create.digest(target)).toBe(FROZEN.giteaCreate);
    const merge = prepare('/pr/merge', { method: 'squash' }, numbered);
    expect(merge.kind).toBe('change-request-merge');
    expect(merge.digest(numbered)).toBe(FROZEN.giteaMerge);
    // A whole set, sorted and without repeats, so a retry in another order is the same request.
    const labels = prepare('/issues/labels', { labels: ['bug', 'a', 'bug'] }, numbered);
    expect(labels.kind).toBe('issue-labels');
    expect(labels.digest(numbered)).toBe(FROZEN.giteaIssueLabels);
  });

  // Forgejo shares Gitea's table: the same kinds, digests that differ by the actor.
  it('keeps Forgejo\'s kinds and digests', () => {
    const actor = { provider: 'forgejo', instance: 'https://codeberg.org', accountId: 'occred:v1:forgejo:one:r1' };
    const credential = { accountId: actor.accountId, credentialRevision: 1 };
    const numbered = { ...glTarget, number: 5 };
    const reviewTarget = { ...numbered, headSha: 'a'.repeat(40) };
    delete reviewTarget.head;
    delete reviewTarget.base;
    const { mutations } = createForgejoProvider({ store: {}, events: {} });
    const prepare = (route, input, target) => mutations.prepare({ route, input, context: { primaryRemote: 'origin', target }, actor, credential });

    expect(prepare('/pr/create', { title: 'Feature' }, glTarget)).toMatchObject({ kind: 'change-request-create' });
    expect(prepare('/pr/create', { title: 'Feature' }, glTarget).digest(glTarget)).toBe(FROZEN.forgejoCreate);
    expect(prepare('/pr/merge', { method: 'squash' }, numbered).digest(numbered)).toBe(FROZEN.forgejoMerge);
    expect(prepare('/pr/review', { verdict: 'approve', body: 'Looks good' }, reviewTarget)).toMatchObject({ kind: 'change-request-review' });
    expect(prepare('/pr/review', { verdict: 'approve', body: 'Looks good' }, reviewTarget).digest(reviewTarget)).toBe(FROZEN.forgejoReviewApprove);
  });

  it('keeps every built-in\'s review kind and digest, which a retried review replays by', () => {
    const reviewOf = (prepare, input, target, actor, credential) => {
      const prepared = prepare({ route: '/pr/review', input, context: { primaryRemote: 'origin', target }, actor, credential });
      return { kind: prepared.kind, digest: prepared.digest(target) };
    };
    const review = (digest) => ({ kind: 'change-request-review', digest });

    const ghReviewTarget = { ...ghTarget, number: 12, headSha: 'b'.repeat(40) };
    delete ghReviewTarget.head;
    delete ghReviewTarget.base;
    const ghCredential = { accountId: ghAccount, credentialRevision: 1 };
    const github = createGitHubMutations({ descriptor: githubDescriptor }).prepare;
    expect(reviewOf(github, { verdict: 'approve', body: 'Looks good' }, ghReviewTarget, ghActor, ghCredential))
      .toEqual(review(FROZEN.githubReviewApprove));
    expect(reviewOf(github, { verdict: 'request-changes', body: 'Please fix' }, ghReviewTarget, ghActor, ghCredential))
      .toEqual(review(FROZEN.githubReviewRequestChanges));
    expect(reviewOf(github, { verdict: 'approve' }, ghReviewTarget, ghActor, ghCredential))
      .toEqual(review(FROZEN.githubReviewApproveNoBody));

    const reviewTarget = { ...glTarget, number: 5, headSha: 'a'.repeat(40) };
    delete reviewTarget.head;
    delete reviewTarget.base;
    const gitlab = createGitLabProvider({ store: {}, events: {} }).mutations.prepare;
    expect(reviewOf(gitlab, { verdict: 'approve', body: 'Looks good' }, reviewTarget, glActor, glCredential))
      .toEqual(review(FROZEN.gitlabReviewApprove));
    expect(reviewOf(gitlab, { verdict: 'request-changes', body: 'Please fix' }, reviewTarget, glActor, glCredential))
      .toEqual(review(FROZEN.gitlabReviewRequestChanges));

    const giteaAccount = 'occred:v1:gitea:one:r1';
    const giteaActor = { provider: 'gitea', instance: 'https://gitea.example.com', accountId: giteaAccount };
    const giteaCredential = { accountId: giteaAccount, credentialRevision: 1 };
    const gitea = createGiteaProvider({ store: {}, events: {} }).mutations.prepare;
    expect(reviewOf(gitea, { verdict: 'approve', body: 'Looks good' }, reviewTarget, giteaActor, giteaCredential))
      .toEqual(review(FROZEN.giteaReviewApprove));
    expect(reviewOf(gitea, { verdict: 'request-changes', body: 'Please fix' }, reviewTarget, giteaActor, giteaCredential))
      .toEqual(review(FROZEN.giteaReviewRequestChanges));
    expect(reviewOf(gitea, { verdict: 'approve' }, reviewTarget, giteaActor, giteaCredential))
      .toEqual(review(FROZEN.giteaReviewApproveNoBody));
  });

  it('keeps Gerrit\'s submit and votes digests, under the merge and review kinds', () => {
    const PS3 = '3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f';
    const actor = { provider: 'gerrit', instance: 'https://gerrit.example.com', accountId: 'acct-1' };
    const credential = { accountId: 'acct-1', credentialRevision: 1 };
    const context = {
      repositoryId: 'repo-1', bindingRevision: 2, primaryRemote: 'origin', directory: '/repo',
      target: { project: { owner: 'platform', name: 'app' }, number: 42, headSha: PS3 },
    };
    const target = {
      repositoryId: 'repo-1', bindingRevision: 2, primaryRemote: 'origin', project: { id: 'platform/app', owner: 'platform', name: 'app' },
      number: 42, head: 'refs/changes/42/42/3', base: 'master', headSha: PS3,
    };
    const { mutations } = createGerritProvider({ store: {}, events: {} });
    const prepared = (route, input) => {
      const result = mutations.prepare({ route, input, context, actor, credential });
      return { kind: result.kind, digest: result.digest(target) };
    };
    expect(prepared('/pr/merge', { method: 'submit' })).toEqual({ kind: 'change-request-merge', digest: FROZEN.gerritSubmit });
    expect(prepared('/pr/review', { votes: { 'Code-Review': 2, Verified: 1 }, body: 'LGTM' }))
      .toEqual({ kind: 'change-request-review', digest: FROZEN.gerritVotes });
    expect(prepared('/pr/review', { votes: { 'Code-Review': -1 } })).toEqual({ kind: 'change-request-review', digest: FROZEN.gerritVotesNoBody });
  });

  it('replays GitLab records written before the shell, without provider work', async () => {
    const { app, service } = appWith();
    const create = await request(app).post('/api/source-control/gitlab/pr/create').send({
      idempotencyKey: 'gitlab-create', title: 'Feature',
      target: { project: { owner: 'team', name: 'repo' }, head: 'feature', base: 'main' },
    }).expect(200);
    expect(create.body).toMatchObject({ status: 'succeeded', replayed: true, target: glTarget });

    const merge = await request(app).post('/api/source-control/gitlab/pr/merge').send({
      idempotencyKey: 'gitlab-merge', method: 'squash',
      target: { project: { owner: 'team', name: 'repo' }, number: 5 },
    }).expect(200);
    expect(merge.body).toMatchObject({ status: 'succeeded', replayed: true, result: { merged: true } });

    expect(service.createChangeRequest).not.toHaveBeenCalled();
    expect(service.mergeChangeRequest).not.toHaveBeenCalled();
  });

  it('replays a GitHub record written before the shell, without GitHub calls, naming the created pull request', async () => {
    const { app, github } = appWith();
    const create = await request(app).post('/api/source-control/github/pr/create').send({
      provider: 'github', idempotencyKey: 'github-create', title: 'Title',
      target: { project: { owner: 'acme', name: 'app' }, head: 'feature', base: 'main' },
    }).expect(200);
    expect(create.body).toEqual({
      status: 'succeeded',
      actor: { provider: 'github', instance: 'github.com', providerAccountId: 'github.com#7' },
      target: { ...ghTarget, number: 12 },
      replayed: true,
      result: {},
    });
    expect(github.getOctokitForAccountId).toHaveBeenCalledWith(ghAccount, expect.any(Object));

    const changed = await request(app).post('/api/source-control/github/pr/create').send({
      provider: 'github', idempotencyKey: 'github-create', title: 'Another title',
      target: { project: { owner: 'acme', name: 'app' }, head: 'feature', base: 'main' },
    }).expect(409);
    expect(changed.body.code).toBe('SOURCE_CONTROL_MUTATION_CONFLICT');
  });

  it('still reports a conflict when the retried input differs', async () => {
    const { app } = appWith();
    const response = await request(app).post('/api/source-control/gitlab/pr/merge').send({
      idempotencyKey: 'gitlab-merge', method: 'merge',
      target: { project: { owner: 'team', name: 'repo' }, number: 5 },
    }).expect(409);
    expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_CONFLICT');
  });
});

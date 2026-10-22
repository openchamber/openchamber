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

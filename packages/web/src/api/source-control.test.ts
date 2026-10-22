import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CreateChangeRequestInput,
  MergeChangeRequestInput,
  ReadyChangeRequestInput,
  SourceControlCreateMutationTarget,
  SourceControlExistingMutationTarget,
  SourceControlIdentity,
  SourceControlMutationContext,
  SourceControlReadContext,
  UpdateChangeRequestInput,
} from '@openchamber/ui/lib/api/types';
import { configureWebTransportBinding, createWebSourceControlAPI, removeWebTransportBinding } from './source-control';

const runtimeFetchMock = vi.fn(async (): Promise<Response> => Response.json({}));
const identity: SourceControlIdentity = { provider: 'github', instance: 'https://GitHub.com/' };
const readContext: SourceControlReadContext = {
  ...identity,
  directory: '/workspace/a b',
  repositoryId: 'repo_one',
  accountId: 'github.com#7',
  bindingRevision: 4,
  primaryRemote: 'upstream',
};
const mutationContext: SourceControlMutationContext<SourceControlExistingMutationTarget> = {
  ...readContext,
  idempotencyKey: 'mutation-1',
  target: { project: { owner: 'openchamber', name: 'openchamber' }, number: 5, head: 'feature', base: 'main', headSha: 'abc123' },
};
const createMutationContext: SourceControlMutationContext<SourceControlCreateMutationTarget> = {
  ...readContext,
  idempotencyKey: 'mutation-1',
  target: { project: { owner: 'openchamber', name: 'openchamber' }, head: 'feature', base: 'main' },
};

interface MutationTestResult {
  merged?: boolean | string;
  message?: string;
  ready?: boolean;
  commented?: boolean | string;
  state?: string;
  unexpected?: boolean;
}

const mutationReceipt = (result: MutationTestResult = {}) => ({
  status: 'succeeded',
  actor: { provider: 'github', instance: 'github.com', providerAccountId: 'github.com#7' },
  target: {
    repositoryId: 'repo_one',
    bindingRevision: 4,
    primaryRemote: 'upstream',
    project: { id: 'R_1', owner: 'openchamber', name: 'openchamber' },
    number: 5,
    head: 'feature',
    base: 'main',
    headSha: 'abc123',
  },
  replayed: false,
  result,
});

const githubIdentity = { provider: 'github', instance: 'github.com' };
const githubUser = (id: string, username: string) => ({ ...githubIdentity, id, username });
const githubProject = (owner: string, name: string) => ({
  ...githubIdentity, id: `${owner}/${name}`, owner, name, url: `https://github.com/${owner}/${name}`,
});

afterEach(() => {
  runtimeFetchMock.mockReset();
});

describe('createWebSourceControlAPI', () => {
  it('posts across-search contexts and parses items with their directory and folder outcomes', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    const payload = { items: [{ kind: 'issue', number: 1, title: 'Issue', url: 'https://github.com/acme/app/issues/1',
      body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
      sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' }, state: 'open', directory: readContext.directory,
    }], cursor: null, hasMore: false, total: 1,
    repositories: [{ directory: readContext.directory, status: 'included', repo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app' } },
      { directory: '/missing', status: 'no-repo' }],
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(payload));
    // Each item is stamped with the provider it was read from.
    expect(await api.referencesAcross?.([readContext], { kind: 'issue', query: ' fix ' }))
      .toEqual({ ...payload, items: payload.items.map((item) => ({ ...item, provider: 'github' })) });
    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/source-control/github/references/across', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ contexts: [readContext], kind: 'issue', query: 'fix' }),
    });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ ...payload, items: payload.items.map(({ directory: _directory, ...item }) => item) }));
    await expect(api.referencesAcross?.([readContext], { kind: 'issue' })).rejects.toThrow();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ ...payload, repositories: [{ directory: '/missing', status: 'unknown' }] }));
    await expect(api.referencesAcross?.([readContext], { kind: 'issue' })).rejects.toThrow();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ error: 'GitHub rate limited' }, { status: 503 }));
    await expect(api.referencesAcross?.([readContext], { kind: 'issue' })).rejects.toThrow('GitHub rate limited');
  });
  it('rejects failed and malformed transport configuration responses without retry or an applied empty binding', async () => {
    const intent = { directory: '/repo', expectedRepositoryId: 'repo_one', expectedRevision: 0,
      expectedConfigRevision: 'config_one', expectedFetchFingerprint: 'fetch', expectedPushFingerprint: 'push',
      remote: 'origin', transport: 'system' as const, unverifiedConfirmed: true as const,
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ error: 'Read failed' }, { status: 500 }));
    await expect(configureWebTransportBinding(intent, runtimeFetchMock)).rejects.toThrow('Read failed');
    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    runtimeFetchMock.mockResolvedValueOnce(Response.json({}));
    await expect(configureWebTransportBinding(intent, runtimeFetchMock)).rejects.toThrow();
    expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
  });
  it('serializes narrow provider intent with captured repository identity and revision, without transport fields or retries', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    const context = { directory: '/repo', expectedRepositoryId: 'repo_one', expectedRevision: 4 };
    const provider = { provider: 'github' as const, instance: 'github.com', accountId: 'github#7', primaryRemote: 'origin' };
    const repository = { repositoryId: 'repo_one', configRevision: 'config_one', bare: false, remotes: [] };
    for (const input of [
      { ...context, operation: 'add' as const, provider },
      { ...context, operation: 'replace' as const, target: provider, provider: { ...provider, primaryRemote: 'upstream' } },
      { ...context, operation: 'remove' as const, target: provider },
    ]) {
      runtimeFetchMock.mockResolvedValueOnce(Response.json({ repository, revision: 5, binding: {
        repositoryId: repository.repositoryId, configRevision: repository.configRevision, remotes: [],
        revision: 5, state: 'bound', providers: [], auxiliary: [],
      } }));
      await expect(api.repositoryProviderBindingMutate(input)).resolves.toMatchObject({ status: 'bound', revision: 5 });
      expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/source-control/binding/provider', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
    }
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ code: 'SOURCE_CONTROL_BINDING_STALE', error: 'Repair transport independently' }, { status: 409 }));
    await expect(api.repositoryProviderBindingMutate({ ...context, operation: 'remove', target: provider }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE', message: 'Repair transport independently' });
    expect(runtimeFetchMock).toHaveBeenCalledTimes(4);
  });
  it('parses repository binding reads into explicit states', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      repository: {
        supported: true,
        repositoryId: 'repo_one',
        configRevision: 'config_one',
        bare: false,
        remotes: [{
          name: 'origin',
          fetch: { displayUrl: 'https://github.com/team/repo.git', fingerprint: 'fetch' },
          push: { displayUrl: 'git@github.com:team/repo.git', fingerprint: 'push' },
        }],
      },
      revision: 4,
      binding: {
        repositoryId: 'repo_one',
        revision: 4,
        state: 'bound',
        configRevision: 'config_one',
        providers: [{ provider: 'github', instance: 'https://GitHub.com/', accountId: 'github.com#7', primaryRemote: 'origin',
          readiness: 'ready', endpoint: { displayUrl: 'https://github.com/team/repo.git', fingerprint: 'fetch' } }],
        remotes: [],
        auxiliary: [{
          kind: 'submodule', mode: 'managed', credentialId: 'child-credential', readiness: 'ready',
          endpoint: { displayUrl: 'https://github.com/team/child.git', fingerprint: 'child-fingerprint' },
        }],
      },
    }));

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).repositoryBinding('/repo')).resolves.toEqual({
      status: 'bound',
      repository: {
        repositoryId: 'repo_one', configRevision: 'config_one', bare: false,
        remotes: [{
          name: 'origin',
          fetch: { displayUrl: 'https://github.com/team/repo.git', fingerprint: 'fetch' },
          push: { displayUrl: 'git@github.com:team/repo.git', fingerprint: 'push' },
        }],
      },
      revision: 4,
      binding: expect.objectContaining({
        repositoryId: 'repo_one', revision: 4, state: 'bound',
        providers: [{ provider: 'github', instance: 'github.com', accountId: 'github.com#7', primaryRemote: 'origin',
          readiness: 'ready', endpoint: { displayUrl: 'https://github.com/team/repo.git', fingerprint: 'fetch' } }],
        auxiliary: [{
          kind: 'submodule', mode: 'managed', credentialId: 'child-credential', readiness: 'ready',
          endpoint: { displayUrl: 'https://github.com/team/child.git', fingerprint: 'child-fingerprint' },
        }],
      }),
    });
    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/source-control/binding', {
      query: new URLSearchParams({ directory: '/repo' }),
      headers: { Accept: 'application/json' },
    });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      repository: {
        supported: true, repositoryId: 'repo_one', configRevision: 'config_one', bare: false, remotes: [],
      },
      revision: 5,
      binding: null,
    }));
    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).repositoryBinding('/repo')).resolves.toEqual({
      status: 'missing',
      repository: { repositoryId: 'repo_one', configRevision: 'config_one', bare: false, remotes: [] },
      revision: 5,
      binding: null,
    });
  });

  it('parses only safe managed credential presentation from binding responses', async () => {
    const endpoint = { displayUrl: 'https://gitlab.example.com/team/repo.git', fingerprint: 'endpoint' };
    const payload = {
      repository: { supported: true, repositoryId: 'repo_one', configRevision: 'config_one', bare: false,
        remotes: [{ name: 'origin', fetch: endpoint, push: endpoint }] },
      revision: 4,
      binding: { repositoryId: 'repo_one', revision: 4, state: 'bound', configRevision: 'config_one',
        providers: [], auxiliary: [], remotes: [{ name: 'origin', fetch: endpoint, push: endpoint,
          mode: 'managed', credentialId: 'opaque-internal-reference', readiness: 'ready',
          presentation: { status: 'available', transport: 'https', provider: 'gitlab',
            instance: 'https://gitlab.example.com', source: 'oauth', username: 'safe-user',
            providerUserId: 'https://gitlab.example.com#42' },
        }] },
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(payload));

    const read = await createWebSourceControlAPI({ fetch: runtimeFetchMock }).repositoryBinding('/repo');
    expect(read.binding?.remotes[0]).toMatchObject({
      credentialId: 'opaque-internal-reference',
      presentation: { status: 'available', transport: 'https', provider: 'gitlab',
        instance: 'https://gitlab.example.com', source: 'oauth', username: 'safe-user',
        providerUserId: 'https://gitlab.example.com#42' },
    });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ ...payload, binding: { ...payload.binding,
      remotes: [{ ...payload.binding.remotes[0], presentation: { status: 'unavailable' } }] } }));
    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).repositoryBinding('/repo'))
      .resolves.toMatchObject({ binding: { remotes: [{ presentation: { status: 'unavailable' } }] } });

    for (const presentation of [
      { status: 'available', transport: 'ssh', fingerprint: 'SHA256:not-a-public-fingerprint', privateKeyPath: '/private/key' },
      { status: 'available', transport: 'https', provider: 'github', instance: 'github.com', source: 'oauth',
        username: 'user', providerUserId: 'github.com#1', credentialId: 'private' },
      { status: 'available', transport: 'https', provider: 'github', instance: 'github.com', source: 'pat',
        username: '/private/key', providerUserId: 'occred:v1:github:opaque' },
      { status: 'unavailable', label: 'opaque-internal-reference' },
    ]) {
      runtimeFetchMock.mockResolvedValueOnce(Response.json({ ...payload, binding: { ...payload.binding,
        remotes: [{ ...payload.binding.remotes[0], presentation }] } }));
      await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).repositoryBinding('/repo')).rejects.toThrow();
    }
  });

  it.each([
    ['credential-bearing HTTPS', { displayUrl: 'https://token@github.com/team/repo.git', fingerprint: 'safe' }],
    ['unsupported protocol', { displayUrl: 'file:///private/repo.git', fingerprint: 'safe' }],
    ['unsafe fingerprint', { displayUrl: 'git@github.com:team/repo.git', fingerprint: '../private' }],
  ])('rejects repository contexts with %s endpoint metadata', async (_label, endpoint) => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      supported: true, repositoryId: 'repo_one', configRevision: 'config_one', bare: false,
      remotes: [{ name: 'origin', fetch: endpoint, push: endpoint }],
    }));
    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).repositoryContext('/repo'))
      .rejects.toThrow('invalid repository remote');
  });

  it('serializes exact remote removal and confirmed full reset intents without retry', async () => {
    const repository = { repositoryId: 'repo_one', configRevision: 'config_one', bare: false, remotes: [{
      name: 'origin', fetch: { displayUrl: 'https://github.com/team/repo.git', fingerprint: 'fetch' },
      push: { displayUrl: 'https://github.com/team/repo.git', fingerprint: 'push' },
    }] };
    const removal = { directory: '/repo', expectedRepositoryId: repository.repositoryId, expectedRevision: 4,
      expectedConfigRevision: repository.configRevision, expectedFetchFingerprint: 'fetch', expectedPushFingerprint: 'push', remote: 'origin',
    };
    const removed = { repository, revision: 5, binding: { repositoryId: repository.repositoryId, revision: 5,
      configRevision: repository.configRevision, state: 'bound', providers: [], remotes: [], auxiliary: [],
    } };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(removed));
    await expect(removeWebTransportBinding(removal, runtimeFetchMock)).resolves.toMatchObject({ status: 'removed', binding: { revision: 5 } });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/source-control/binding/transport/remove', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(removal),
    });

    const reset = { directory: '/repo', expectedRepositoryId: repository.repositoryId, expectedRevision: 5,
      expectedConfigRevision: repository.configRevision, confirmed: true as const,
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ repository, revision: 6, binding: null }));
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    await expect(api.resetRepositoryBinding(reset)).resolves.toMatchObject({ status: 'missing', revision: 6, binding: null });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/source-control/binding/reset', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(reset),
    });
    expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
  });

  it('removes one exact provider account', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ removed: true }));

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).authDisconnect(identity, 'github.com#7'))
      .resolves.toEqual({ removed: true });
    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/source-control/github/auth', {
      method: 'DELETE',
      query: new URLSearchParams({ instance: 'github.com', accountId: 'github.com#7' }),
      headers: { Accept: 'application/json' },
    });
  });

  it('rejects account removal without an exact credential accountId before transport', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });

    // @ts-expect-error account removal requires an exact credential accountId
    await expect(api.authDisconnect(identity)).rejects.toThrow('credential accountId is required');
    await expect(api.authDisconnect(identity, ' ')).rejects.toThrow('credential accountId is required');
    expect(runtimeFetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed account removal result', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ success: true }));

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).authDisconnect(identity, 'credential-one'))
      .rejects.toThrow('invalid account removal result');
  });

  it.each([
    ['system credential', { mode: 'system', credentialId: 'credential_one' }],
    ['managed without credential', { mode: 'managed' }],
  ])('rejects a bound remote with %s', async (_label, transport) => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      repository: {
        supported: true, repositoryId: 'repo_one', configRevision: 'config_one', bare: false,
        remotes: [{
          name: 'origin',
          fetch: { displayUrl: 'https://github.com/team/repo.git', fingerprint: 'fetch' },
          push: { displayUrl: 'https://github.com/team/repo.git', fingerprint: 'push' },
        }],
      },
      revision: 1,
      binding: {
        repositoryId: 'repo_one', revision: 1, state: 'bound', configRevision: 'config_one', providers: [],
        auxiliary: [],
        remotes: [{
          name: 'origin',
          fetch: { displayUrl: 'https://github.com/team/repo.git', fingerprint: 'fetch' },
          push: { displayUrl: 'https://github.com/team/repo.git', fingerprint: 'push' },
          ...transport,
          readiness: 'ready',
        }],
      },
    }));
    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).repositoryBinding('/repo'))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDINGS' });
  });

  it('serializes immutable bound context for status reads', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      identity: githubIdentity, project: null, branch: 'feature', changeRequest: null, ci: null, fetchedAt: 42,
    }));
    const context = {
      directory: '/repo', repositoryId: 'repo_one', provider: 'github' as const, instance: 'github.com',
      accountId: 'github.com#7', bindingRevision: 4, primaryRemote: 'upstream',
    };

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).changeRequestStatus(context, 'feature', { force: true }))
      .resolves.toEqual({ identity: githubIdentity, project: null, branch: 'feature', changeRequest: null, ci: null, fetchedAt: 42 });

    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/source-control/github/pr/status', {
      query: new URLSearchParams({
        instance: 'github.com', directory: '/repo', repositoryId: 'repo_one', accountId: 'github.com#7',
        bindingRevision: '4', primaryRemote: 'upstream', branch: 'feature', force: 'true',
      }),
      headers: { Accept: 'application/json' },
    });
  });

  it.each([
    ['invalid GitHub CI counts', {
      identity: githubIdentity,
      project: null,
      branch: 'feature',
      changeRequest: null,
      ci: { summary: { state: 'success', total: 1, success: -1, failure: 0, pending: 0 } },
    }, 'invalid CI summary'],
    ['invalid GitHub change-request URL', {
      identity: githubIdentity,
      project: githubProject('acme', 'app'),
      branch: 'feature',
      changeRequest: {
        ...githubIdentity, id: 'acme/app#3', number: 3, project: githubProject('acme', 'app'),
        title: 'Feature', url: 'javascript:alert(1)', state: 'open', draft: false, base: 'main', head: 'feature',
      },
    }, 'invalid change request'],
    ['a GitHub status of another instance', {
      identity: { provider: 'github', instance: 'ghe.example.com' },
      project: null,
      branch: 'feature',
      changeRequest: null,
    }, 'invalid change request status'],
  ])('rejects %s in a successful status response', async (_label, payload, message) => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json(payload));
    const context = {
      directory: '/repo', repositoryId: 'repo_one', provider: 'github' as const, instance: 'github.com',
      accountId: 'github.com#7', bindingRevision: 4, primaryRemote: 'origin',
    };

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).changeRequestStatus(context, 'feature'))
      .rejects.toThrow(message);
  });

  it.each([
    ['invalid GitLab change-request discriminant', {
      identity: { provider: 'gitlab', instance: 'https://gitlab.example.com' },
      project: { provider: 'gitlab', instance: 'https://gitlab.example.com', id: '1', owner: 'acme', name: 'app', url: 'https://gitlab.example.com/acme/app' },
      branch: 'feature',
      changeRequest: {
        provider: 'gitlab', instance: 'https://gitlab.example.com', id: '1#3', number: 3,
        project: { provider: 'gitlab', instance: 'https://gitlab.example.com', id: '1', owner: 'acme', name: 'app', url: 'https://gitlab.example.com/acme/app' },
        title: 'Feature', url: 'https://gitlab.example.com/acme/app/-/merge_requests/3', state: 'opened', draft: false,
        base: 'main', head: 'feature',
      },
    }],
    ['invalid GitLab CI state', {
      identity: { provider: 'gitlab', instance: 'https://gitlab.example.com' },
      project: null,
      branch: 'feature',
      changeRequest: null,
      ci: { summary: { state: 'running', total: 1, success: 0, failure: 0, pending: 1 } },
    }],
    ['invalid GitLab CI run identity', {
      identity: { provider: 'gitlab', instance: 'https://gitlab.example.com' },
      project: null,
      branch: 'feature',
      changeRequest: null,
      ci: {
        summary: { state: 'pending', total: 1, success: 0, failure: 0, pending: 1 },
        runs: [{ provider: 'github', instance: 'github.com', id: '9', name: 'test' }],
      },
    }],
    ['invalid GitLab CI output', {
      identity: { provider: 'gitlab', instance: 'https://gitlab.example.com' },
      project: null,
      branch: 'feature',
      changeRequest: null,
      ci: {
        summary: { state: 'failure', total: 1, success: 0, failure: 1, pending: 0 },
        runs: [{
          provider: 'gitlab', instance: 'https://gitlab.example.com', id: '9', name: 'test',
          output: { title: { unsafe: true } },
        }],
      },
    }],
    ['invalid GitLab project clone URL field', {
      identity: { provider: 'gitlab', instance: 'https://gitlab.example.com' },
      project: {
        provider: 'gitlab', instance: 'https://gitlab.example.com', id: '1', owner: 'acme', name: 'app',
        url: 'https://gitlab.example.com/acme/app', cloneUrl: { unsafe: true },
      },
      branch: 'feature',
      changeRequest: null,
    }],
  ])('rejects %s in a successful status response', async (_label, payload) => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json(payload));
    const context = {
      directory: '/repo', repositoryId: 'repo_one', provider: 'gitlab' as const, instance: 'https://gitlab.example.com',
      accountId: 'https://gitlab.example.com#7', bindingRevision: 4, primaryRemote: 'origin',
    };

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).changeRequestStatus(context, 'feature'))
      .rejects.toThrow('invalid');
  });

  it('lists and normalizes available provider instances', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      instances: [
        { provider: 'github', instance: 'https://GitHub.com/' },
        { provider: 'gitlab', instance: 'gitlab.example.com' },
      ],
    }));

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).authInstances()).resolves.toEqual([
      { provider: 'github', instance: 'github.com' },
      { provider: 'gitlab', instance: 'https://gitlab.example.com' },
    ]);
    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/source-control/instances', {
      headers: { Accept: 'application/json' },
    });
  });

  it('calls the canonical issue alias and normalizes repository, user, labels, and pagination', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      items: [{
        ...githubIdentity,
        id: 'openchamber/openchamber#17',
        number: 17,
        project: githubProject('openchamber', 'openchamber'),
        title: 'Migrate source control',
        url: 'https://github.com/openchamber/openchamber/issues/17',
        state: 'open',
        author: { ...githubUser('7', 'octocat'), avatarUrl: 'https://avatars.example/7' },
        labels: [{ name: 'migration', color: '123456' }],
      }],
      page: 2,
      hasMore: true,
      incompleteProjectIds: ['upstream/openchamber'],
    }));

    const result = await createWebSourceControlAPI({ fetch: runtimeFetchMock })
      .issuesList(readContext, { page: 2, query: 'needs triage' });

    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/source-control/github/issues/list', {
      query: new URLSearchParams({
        instance: 'github.com',
        directory: '/workspace/a b',
        repositoryId: 'repo_one',
        accountId: 'github.com#7',
        bindingRevision: '4',
        primaryRemote: 'upstream',
        page: '2',
        query: 'needs triage',
      }),
      headers: { Accept: 'application/json' },
    });
    expect(result).toEqual({
      items: [{
        provider: 'github',
        instance: 'github.com',
        id: 'openchamber/openchamber#17',
        number: 17,
        project: {
          provider: 'github',
          instance: 'github.com',
          id: 'openchamber/openchamber',
          owner: 'openchamber',
          name: 'openchamber',
          url: 'https://github.com/openchamber/openchamber',
        },
        title: 'Migrate source control',
        url: 'https://github.com/openchamber/openchamber/issues/17',
        state: 'open',
        author: {
          provider: 'github',
          instance: 'github.com',
          id: '7',
          username: 'octocat',
          avatarUrl: 'https://avatars.example/7',
        },
        labels: [{ name: 'migration', color: '123456' }],
      }],
      page: 2,
      hasMore: true,
      incompleteProjectIds: ['upstream/openchamber'],
    });
  });

  it('serializes immutable bound context and selectors for issue and project reads', async () => {
    runtimeFetchMock
      // Null is an issue outside the bound repository network.
      .mockResolvedValueOnce(Response.json(null))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ identity: githubIdentity, isFork: false, upstream: null }))
      .mockResolvedValueOnce(Response.json({ branches: ['main'] }));
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });

    await expect(api.issueGet(readContext, 17, { owner: 'openchamber', name: 'openchamber' })).resolves.toBeNull();
    await expect(api.issueComments(readContext, 17, { owner: 'openchamber', name: 'openchamber' })).resolves.toEqual([]);
    await expect(api.projectUpstream(readContext)).resolves.toEqual({
      identity: { provider: 'github', instance: 'github.com' }, isFork: false, upstream: null,
    });
    await expect(api.projectBranches(readContext, 'openchamber', 'openchamber')).resolves.toEqual(['main']);

    const base = {
      instance: 'github.com', directory: '/workspace/a b', repositoryId: 'repo_one', accountId: 'github.com#7',
      bindingRevision: '4', primaryRemote: 'upstream',
    };
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(1, '/api/source-control/github/issues/get', {
      query: new URLSearchParams({ ...base, number: '17', owner: 'openchamber', repo: 'openchamber' }),
      headers: { Accept: 'application/json' },
    });
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(2, '/api/source-control/github/issues/comments', {
      query: new URLSearchParams({ ...base, number: '17', owner: 'openchamber', repo: 'openchamber' }),
      headers: { Accept: 'application/json' },
    });
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(3, '/api/source-control/github/repo/upstream', {
      query: new URLSearchParams(base), headers: { Accept: 'application/json' },
    });
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(4, '/api/source-control/github/repo/branches', {
      query: new URLSearchParams({ ...base, owner: 'openchamber', repo: 'openchamber' }),
      headers: { Accept: 'application/json' },
    });
  });

  it('rejects malformed issue and project read payloads', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ page: 1, hasMore: false }));
    await expect(api.issuesList(readContext)).rejects.toThrow('invalid issues');

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ items: [], page: 0, hasMore: false }));
    await expect(api.issuesList(readContext)).rejects.toThrow('invalid pagination');

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ items: [], page: 1, hasMore: 'no' }));
    await expect(api.issuesList(readContext)).rejects.toThrow('invalid pagination');

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ items: [], page: 1, hasMore: false, incompleteProjectIds: [''] }));
    await expect(api.issuesList(readContext)).rejects.toThrow('invalid incomplete projects');

    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      ...githubIdentity, id: 'team/repo#1', number: 1, project: githubProject('team', 'repo'),
      title: '', url: 'https://github.com/team/repo/issues/1', state: 'open',
    }));
    await expect(api.issueGet(readContext, 1)).rejects.toThrow('invalid issue');

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ items: [] }));
    await expect(api.issueComments(readContext, 1)).rejects.toThrow('invalid comments');

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ identity: githubIdentity, isFork: true, upstream: null }));
    await expect(api.projectUpstream(readContext)).rejects.toThrow('invalid upstream');

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ branches: ['main', 7] }));
    await expect(api.projectBranches(readContext, 'team', 'repo')).rejects.toThrow('invalid branches');
  });

  it('preserves GitLab issue-list responses and applies trusted context identity', async () => {
    const context: SourceControlReadContext = {
      provider: 'gitlab', instance: 'gitlab.example.com', directory: '/repo', repositoryId: 'repo_two',
      accountId: 'https://gitlab.example.com#7', bindingRevision: 6, primaryRemote: 'origin',
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      items: [{
        provider: 'gitlab', instance: 'https://gitlab.example.com', id: '2#3', number: 3,
        project: { provider: 'gitlab', instance: 'https://gitlab.example.com', id: '2', owner: 'team', name: 'repo', url: 'https://gitlab.example.com/team/repo' },
        title: 'Bug', url: 'https://gitlab.example.com/team/repo/-/issues/3', state: 'open',
      }],
      page: 1,
      hasMore: false,
    }));

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).issuesList(context)).resolves.toEqual({
      items: [expect.objectContaining({ provider: 'gitlab', instance: 'https://gitlab.example.com', id: '2#3' })],
      page: 1,
      hasMore: false,
    });
    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/source-control/gitlab/issues/list', {
      query: new URLSearchParams({
        instance: 'https://gitlab.example.com', directory: '/repo', repositoryId: 'repo_two',
        accountId: 'https://gitlab.example.com#7', bindingRevision: '6', primaryRemote: 'origin', page: '1',
      }),
      headers: { Accept: 'application/json' },
    });
  });

  it('parses the neutral github.com auth status with its accounts and CLI identity', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      ...githubIdentity,
      status: 'connected',
      connected: true,
      user: githubUser('7', 'octocat'),
      scope: 'repo',
      accounts: [
        { id: 'oauth-account', credentialId: 'oauth-account', credentialRevision: 1, providerUserId: 'github.com#7', providerUserStatus: 'available', user: githubUser('7', 'octocat'), current: true, source: 'oauth', status: 'valid' },
        { id: 'gh-cli', credentialId: 'gh-cli', credentialRevision: 1, providerUserId: 'github.com#8', providerUserStatus: 'available', user: githubUser('8', 'cli-user'), current: false, source: 'cli', status: 'valid' },
      ],
      cli: { available: true, disabled: false, active: false, user: githubUser('8', 'cli-user') },
    }));

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).authStatus(identity)).resolves.toEqual({
      provider: 'github',
      instance: 'github.com',
      status: 'connected',
      connected: true,
      user: { provider: 'github', instance: 'github.com', id: '7', username: 'octocat' },
      scope: 'repo',
      accounts: [
        { id: 'oauth-account', credentialId: 'oauth-account', credentialRevision: 1, providerUserId: 'github.com#7', providerUserStatus: 'available', user: { provider: 'github', instance: 'github.com', id: '7', username: 'octocat' }, scope: undefined, current: true, source: 'oauth', status: 'valid' },
        { id: 'gh-cli', credentialId: 'gh-cli', credentialRevision: 1, providerUserId: 'github.com#8', providerUserStatus: 'available', user: { provider: 'github', instance: 'github.com', id: '8', username: 'cli-user' }, scope: undefined, current: false, source: 'cli', status: 'valid' },
      ],
      cli: {
        available: true,
        disabled: false,
        active: false,
        user: { provider: 'github', instance: 'github.com', id: '8', username: 'cli-user' },
      },
    });
  });

  it('keeps gh CLI metadata when GitHub is disconnected', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      ...githubIdentity,
      status: 'disconnected',
      connected: false,
      accounts: [],
      cli: { available: true, disabled: true, active: false },
    }));

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).authStatus(identity)).resolves.toEqual({
      provider: 'github',
      instance: 'github.com',
      status: 'disconnected',
      connected: false,
      accounts: [],
      cli: { available: true, disabled: true, active: false },
    });
  });

  it('rejects auth inventory that does not preserve exact credential identity', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      ...githubIdentity,
      status: 'connected',
      connected: true,
      user: githubUser('7', 'octocat'),
      accounts: [{
        id: 'credential-one', credentialId: 'credential-two', credentialRevision: 1,
        providerUserId: 'github.com#7', providerUserStatus: 'available',
        user: githubUser('7', 'octocat'), current: true, source: 'oauth', status: 'valid',
      }],
    }));

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).authStatus(identity))
      .rejects.toThrow('Source control response contained an invalid auth credential');
  });

  it('keeps device grants opaque and maps unavailable flows to terminal expiry', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      flowId: 'oauth_opaque',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 300,
      interval: 5,
    }));

    await expect(api.authStart(identity)).resolves.toMatchObject({ flowId: 'oauth_opaque', userCode: 'ABCD-1234' });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/source-control/github/auth/start', expect.objectContaining({
      body: '{}',
      query: new URLSearchParams({ instance: 'github.com' }),
    }));

    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      error: 'OAuth flow is unavailable',
      code: 'SOURCE_CONTROL_OAUTH_FLOW_UNAVAILABLE',
    }, { status: 410 }));
    await expect(api.authComplete(identity, 'oauth_opaque')).resolves.toEqual({
      status: 'error',
      code: 'expired',
      message: 'OAuth flow is unavailable',
    });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/source-control/github/auth/complete', expect.objectContaining({
      body: JSON.stringify({ flowId: 'oauth_opaque' }),
    }));
  });

  it('reads github.com device-flow users, activation and the CLI switch through the neutral auth routes', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    const user = { ...githubUser('7', 'octocat'), avatarUrl: 'https://avatars.example/7' };
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: true, user, scope: 'repo' }));
    await expect(api.authComplete(identity, 'oauth_opaque')).resolves.toEqual({ status: 'connected', user, scope: 'repo' });

    // A user stamped with another instance is not this instance's user.
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      connected: true, user: { ...user, instance: 'ghe.example.com' }, scope: 'repo',
    }));
    await expect(api.authComplete(identity, 'oauth_opaque')).rejects.toThrow('invalid user');

    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      ...githubIdentity, status: 'connected', connected: true, user: githubUser('7', 'octocat'), accounts: [{
        id: 'oauth-account', credentialId: 'oauth-account', credentialRevision: 2, providerUserId: 'github.com#7',
        providerUserStatus: 'available', user: githubUser('7', 'octocat'), current: true, source: 'oauth', status: 'valid',
      }],
    }));
    await expect(api.authActivate(identity, 'oauth-account')).resolves.toMatchObject({
      ...githubIdentity, status: 'connected', user: githubUser('7', 'octocat'),
      accounts: [{ id: 'oauth-account', credentialRevision: 2, current: true }],
    });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/source-control/github/auth/activate', expect.objectContaining({
      body: JSON.stringify({ accountId: 'oauth-account' }), query: new URLSearchParams({ instance: 'github.com' }),
    }));

    // github.com switches its CLI on the same route as every instance; /auth/gh-cli is only a server alias.
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ available: true, disabled: true }));
    await expect(api.authSetCliDisabled(identity, true)).resolves.toEqual({ disabled: true });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/source-control/github/auth/cli', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
      query: new URLSearchParams({ instance: 'github.com' }),
    });
  });

  it('serializes immutable bound context for change-request lists', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      items: [],
      page: 2,
      hasMore: false,
      incompleteProjectIds: ['upstream/openchamber'],
    }));
    const context = {
      ...identity,
      directory: '/workspace',
      repositoryId: 'repo_one',
      accountId: 'github.com#7',
      bindingRevision: 4,
      primaryRemote: 'upstream',
    };

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).changeRequestsList(context, { page: 2, query: 'fix' }))
      .resolves.toEqual({ items: [], page: 2, hasMore: false, incompleteProjectIds: ['upstream/openchamber'] });

    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/source-control/github/pulls/list', {
      query: new URLSearchParams({
        instance: 'github.com', directory: '/workspace', repositoryId: 'repo_one', accountId: 'github.com#7',
        bindingRevision: '4', primaryRemote: 'upstream', page: '2', query: 'fix',
      }),
      headers: { Accept: 'application/json' },
    });
  });

  it('normalizes pull-request context, files, comments, and detailed checks', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      identity: githubIdentity,
      fetchedAt: 42,
      project: githubProject('openchamber', 'openchamber'),
      changeRequest: {
        ...githubIdentity,
        id: 'openchamber/openchamber#4',
        number: 4,
        project: githubProject('openchamber', 'openchamber'),
        title: 'Generic adapter',
        body: 'Body',
        url: 'https://github.com/openchamber/openchamber/pull/4',
        state: 'open',
        draft: false,
        base: 'main',
        head: 'source-control',
        headSha: 'abc',
        author: githubUser('7', 'octocat'),
      },
      issueComments: [{ ...githubIdentity, id: '10', url: 'https://example/comment/10', body: 'Looks good', author: githubUser('9', 'reviewer') }],
      reviewComments: [{ ...githubIdentity, id: '11', url: 'https://example/comment/11', body: 'Nit', path: 'api.ts', line: 5, position: null }],
      files: [{ path: 'api.ts', status: 'modified', additions: 8, deletions: 2, changes: 10, patch: '@@' }],
      diff: 'diff text',
      ci: {
        summary: { state: 'pending', total: 1, success: 0, failure: 0, pending: 1, inProgress: 1 },
        runs: [{
          ...githubIdentity,
          id: '99',
          name: 'test',
          status: 'in_progress',
          detailsUrl: 'https://github.com/actions/runs/1',
          job: { runId: '1', jobId: '2', name: 'unit', steps: [{ name: 'run', status: 'in_progress' }] },
          annotations: [{ path: 'api.ts', startLine: 5, message: 'Failure' }],
        }],
      },
    }));

    const result = await createWebSourceControlAPI({ fetch: runtimeFetchMock }).changeRequestContext(
      { ...identity, directory: '/workspace', repositoryId: 'repo_one', accountId: 'github.com#7', bindingRevision: 4, primaryRemote: 'upstream' },
      4,
      { includeDiff: true, includeCIDetails: true, project: { owner: 'openchamber', name: 'openchamber' } },
    );

    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/source-control/github/pulls/context', {
      query: new URLSearchParams({
        instance: 'github.com', directory: '/workspace', repositoryId: 'repo_one', accountId: 'github.com#7', bindingRevision: '4',
        primaryRemote: 'upstream', number: '4', diff: '1', checkDetails: '1', owner: 'openchamber', repo: 'openchamber',
      }),
      headers: { Accept: 'application/json' },
    });
    expect(result).toMatchObject({ identity: githubIdentity, fetchedAt: 42, diff: 'diff text', project: { id: 'openchamber/openchamber' } });
    expect(result.changeRequest).toMatchObject({ id: 'openchamber/openchamber#4', headSha: 'abc', author: { id: '7', username: 'octocat' } });
    expect(result.issueComments[0]).toMatchObject({ id: '10', author: { id: '9', username: 'reviewer' } });
    expect(result.reviewComments[0]).toMatchObject({ id: '11', path: 'api.ts', line: 5, position: null });
    expect(result.files).toEqual([{ path: 'api.ts', status: 'modified', additions: 8, deletions: 2, changes: 10, patch: '@@' }]);
    expect(result.ci).toMatchObject({
      summary: { state: 'pending', total: 1, inProgress: 1 },
      runs: [{ id: '99', name: 'test', job: { runId: '1', jobId: '2' }, annotations: [{ message: 'Failure', path: 'api.ts', startLine: 5 }] }],
    });

    // A selector outside the bound network reads as no project and no change request.
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      identity: githubIdentity, project: null, changeRequest: null, issueComments: [], reviewComments: [], files: [],
    }));
    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).changeRequestContext(
      { ...identity, directory: '/workspace', repositoryId: 'repo_one', accountId: 'github.com#7', bindingRevision: 4, primaryRemote: 'upstream' },
      4,
      { project: { owner: 'elsewhere', name: 'app' } },
    )).resolves.toEqual({
      identity: githubIdentity, project: null, changeRequest: null, issueComments: [], reviewComments: [], files: [], ci: null,
    });
  });

  it('rejects malformed nested GitHub check details', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      identity: githubIdentity,
      project: githubProject('openchamber', 'openchamber'),
      changeRequest: {
        ...githubIdentity, id: 'openchamber/openchamber#4', number: 4, project: githubProject('openchamber', 'openchamber'),
        title: 'Generic adapter', url: 'https://github.com/openchamber/openchamber/pull/4',
        state: 'open', draft: false, base: 'main', head: 'source-control',
      },
      issueComments: [],
      reviewComments: [],
      files: [],
      ci: {
        summary: { state: 'failure', total: 1, success: 0, failure: 1, pending: 0 },
        runs: [{ ...githubIdentity, id: '99', name: 'test', output: 'unsafe' }],
      },
    }));

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).changeRequestContext(
      { ...identity, directory: '/workspace', repositoryId: 'repo_one', accountId: 'github.com#7', bindingRevision: 4, primaryRemote: 'origin' },
      4,
      { includeCIDetails: true, project: { owner: 'openchamber', name: 'openchamber' } },
    )).rejects.toThrow('invalid CI output');
  });

  it('rejects malformed GitHub check-run containers', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      identity: githubIdentity,
      project: null,
      changeRequest: null,
      issueComments: [],
      reviewComments: [],
      files: [],
      ci: { summary: { state: 'pending', total: 1, success: 0, failure: 0, pending: 1 }, runs: false },
    }));

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).changeRequestContext(
      { ...identity, directory: '/workspace', repositoryId: 'repo_one', accountId: 'github.com#7', bindingRevision: 4, primaryRemote: 'origin' },
      4,
      { includeCIDetails: true },
    )).rejects.toThrow('invalid CI runs');
  });

  it('serializes mutation authority and parses compact receipts for every operation', async () => {
    runtimeFetchMock
      .mockResolvedValueOnce(Response.json(mutationReceipt()))
      .mockResolvedValueOnce(Response.json(mutationReceipt()))
      .mockResolvedValueOnce(Response.json(mutationReceipt({ merged: true, message: 'Merged' })))
      .mockResolvedValueOnce(Response.json(mutationReceipt({ ready: true })));
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    const createContext = createMutationContext;

    await expect(api.changeRequestCreate({
      ...createContext,
      title: 'Create adapter',
      draft: true,
      remote: 'upstream',
      headRemote: 'origin',
    })).resolves.toEqual(mutationReceipt());
    await expect(api.changeRequestUpdate({ ...mutationContext, title: 'Updated', body: 'Body' }))
      .resolves.toEqual(mutationReceipt());
    await expect(api.changeRequestMerge({ ...mutationContext, method: 'squash' }))
      .resolves.toEqual(mutationReceipt({ merged: true, message: 'Merged' }));
    await expect(api.changeRequestReady(mutationContext)).resolves.toEqual(mutationReceipt({ ready: true }));

    const authority = {
      provider: 'github', instance: 'github.com', directory: '/workspace/a b', repositoryId: 'repo_one',
      accountId: 'github.com#7', bindingRevision: 4, primaryRemote: 'upstream', idempotencyKey: 'mutation-1',
      target: mutationContext.target,
    };
    const createAuthority = { ...authority, target: createContext.target };
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(1, '/api/source-control/github/pr/create', expect.objectContaining({
      query: new URLSearchParams({ instance: 'github.com' }),
      body: JSON.stringify({ ...createAuthority, title: 'Create adapter', draft: true, remote: 'upstream', headRemote: 'origin' }),
    }));
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(2, '/api/source-control/github/pr/update', expect.objectContaining({
      body: JSON.stringify({ ...authority, title: 'Updated', body: 'Body' }),
    }));
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(3, '/api/source-control/github/pr/merge', expect.objectContaining({
      body: JSON.stringify({ ...authority, method: 'squash' }),
    }));
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(4, '/api/source-control/github/pr/ready', expect.objectContaining({
      body: JSON.stringify(authority),
    }));
  });

  it("posts comments and reviews to their routes and reads whether a review's text posted", async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    runtimeFetchMock
      .mockResolvedValueOnce(Response.json(mutationReceipt()))
      .mockResolvedValueOnce(Response.json(mutationReceipt({ commented: false })))
      .mockResolvedValueOnce(Response.json(mutationReceipt()))
      .mockResolvedValueOnce(Response.json(mutationReceipt({ commented: 'yes' })))
      .mockResolvedValueOnce(Response.json(mutationReceipt({ state: 'closed' })))
      .mockResolvedValueOnce(Response.json(mutationReceipt({ state: 'merged' })));

    await expect(api.changeRequestComment({ ...mutationContext, body: 'Looks good' })).resolves.toMatchObject({ result: {} });
    await expect(api.changeRequestReview({ ...mutationContext, verdict: 'approve', body: 'Nice' }))
      .resolves.toMatchObject({ result: { commented: false } });
    await api.issueComment({ ...mutationContext, body: 'On it' });
    await expect(api.changeRequestReview({ ...mutationContext, verdict: 'approve' })).rejects.toThrow('invalid review result');
    await expect(api.issueSetState({ ...mutationContext, state: 'closed' })).resolves.toMatchObject({ result: { state: 'closed' } });
    await expect(api.changeRequestSetState({ ...mutationContext, state: 'open' })).rejects.toThrow('invalid state result');

    expect(runtimeFetchMock).toHaveBeenNthCalledWith(1, '/api/source-control/github/pr/comment', expect.objectContaining({
      body: expect.stringContaining('"body":"Looks good"'),
    }));
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(2, '/api/source-control/github/pr/review', expect.objectContaining({
      body: expect.stringContaining('"verdict":"approve","body":"Nice"'),
    }));
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(3, '/api/source-control/github/issues/comment', expect.anything());
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(5, '/api/source-control/github/issues/state', expect.objectContaining({
      body: expect.stringContaining('"state":"closed"'),
    }));
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(6, '/api/source-control/github/pr/state', expect.anything());
  });

  it('posts thread replies, resolutions and new threads to their routes', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    runtimeFetchMock
      .mockResolvedValueOnce(Response.json(mutationReceipt()))
      .mockResolvedValueOnce(Response.json(mutationReceipt()))
      .mockResolvedValueOnce(Response.json(mutationReceipt()));

    await api.changeRequestReplyToThread({ ...mutationContext, threadId: 'PRRT_one', body: 'Fixed' });
    await api.changeRequestResolveThread({ ...mutationContext, threadId: 'PRRT_one', resolved: false });
    await api.changeRequestStartThread({ ...mutationContext, body: 'Please rename' });

    expect(runtimeFetchMock).toHaveBeenNthCalledWith(1, '/api/source-control/github/pr/thread/reply', expect.objectContaining({
      body: expect.stringContaining('"threadId":"PRRT_one","body":"Fixed"'),
    }));
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(2, '/api/source-control/github/pr/thread/resolve', expect.objectContaining({
      body: expect.stringContaining('"threadId":"PRRT_one","resolved":false'),
    }));
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(3, '/api/source-control/github/pr/thread/start', expect.anything());
  });

  it("sets labels and reviewers, and reads the pickers' choices as checked lists", async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    runtimeFetchMock
      .mockResolvedValueOnce(Response.json(mutationReceipt()))
      .mockResolvedValueOnce(Response.json(mutationReceipt()))
      .mockResolvedValueOnce(Response.json(mutationReceipt()))
      .mockResolvedValueOnce(Response.json({ connected: true, items: [{ name: 'bug', color: 'd73a4a' }, { name: 'docs' }] }))
      .mockResolvedValueOnce(Response.json({ connected: true, items: [{ id: 'octo', login: 'octo', avatarUrl: 'https://avatars/octo' }] }))
      .mockResolvedValueOnce(Response.json({ connected: false }))
      .mockResolvedValueOnce(Response.json({ connected: true, items: [{ id: 'octo', login: 'octo', avatarUrl: 'javascript:alert(1)' }] }));
    const project = { owner: 'openchamber', repo: 'openchamber' };

    await api.changeRequestSetLabels({ ...mutationContext, labels: ['bug'] });
    await api.issueSetLabels({ ...mutationContext, labels: [] });
    await api.changeRequestSetReviewers({ ...mutationContext, reviewers: ['octo'] });
    await expect(api.referenceLabels(readContext, project)).resolves.toEqual([{ name: 'bug', color: 'd73a4a' }, { name: 'docs' }]);
    await expect(api.referenceReviewers(readContext, project)).resolves.toEqual([{ id: 'octo', login: 'octo', avatarUrl: 'https://avatars/octo' }]);
    await expect(api.referenceLabels(readContext, project)).rejects.toThrow('not connected');
    await expect(api.referenceReviewers(readContext, project)).rejects.toThrow('invalid user');

    expect(runtimeFetchMock).toHaveBeenNthCalledWith(1, '/api/source-control/github/pr/labels', expect.objectContaining({ body: expect.stringContaining('"labels":["bug"]') }));
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(2, '/api/source-control/github/issues/labels', expect.anything());
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(3, '/api/source-control/github/pr/reviewers', expect.objectContaining({ body: expect.stringContaining('"reviewers":["octo"]') }));
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(4, '/api/source-control/github/references/labels', expect.objectContaining({
      query: expect.objectContaining({ toString: expect.any(Function) }),
    }));
  });

  it('keeps credential authority separate from provider actor metadata', async () => {
    const credentialContext = { ...mutationContext, accountId: 'occred:v1:github:credential:r1' };
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      ...mutationReceipt({ ready: true }),
      actor: { provider: 'github', instance: 'github.com', providerAccountId: 'github.com#7' },
    }));

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).changeRequestReady(credentialContext))
      .resolves.toMatchObject({
        actor: { provider: 'github', instance: 'github.com', providerAccountId: 'github.com#7' },
      });
    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/source-control/github/pr/ready', expect.objectContaining({
      body: expect.stringContaining('occred:v1:github:credential:r1'),
    }));
  });

  it('models create and existing mutation targets as distinct compile-time contracts', () => {
    const project = { owner: 'openchamber', name: 'openchamber' };
    const createTarget: SourceControlCreateMutationTarget = { project, head: 'feature', base: 'main' };
    const existingTarget: SourceControlExistingMutationTarget = { project, number: 5 };
    // @ts-expect-error create targets require a head
    const createWithoutHead: SourceControlCreateMutationTarget = { project, base: 'main' };
    // @ts-expect-error create targets forbid existing-request numbers
    const createWithNumber: SourceControlCreateMutationTarget = { project, head: 'feature', base: 'main', number: 5 };
    // @ts-expect-error create targets forbid resolved head SHAs
    const createWithHeadSha: SourceControlCreateMutationTarget = { project, head: 'feature', base: 'main', headSha: 'abc' };
    // @ts-expect-error existing-request targets require a number
    const existingWithoutNumber: SourceControlExistingMutationTarget = { project };

    expect([createTarget, existingTarget, createWithoutHead, createWithNumber, createWithHeadSha, existingWithoutNumber]).toHaveLength(6);
  });

  it.each([
    ['create head', 'changeRequestCreate', 'head'],
    ['create base', 'changeRequestCreate', 'base'],
    ['update number', 'changeRequestUpdate', 'number'],
    ['merge number', 'changeRequestMerge', 'number'],
    ['ready number', 'changeRequestReady', 'number'],
  ])('rejects a mutation missing its required %s target field', async (_label, method, field) => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    let operation: Promise<unknown>;
    if (method === 'changeRequestCreate') {
      const payload: CreateChangeRequestInput = {
        ...createMutationContext,
        target: { ...createMutationContext.target },
        title: 'Create',
      };
      Object.defineProperty(payload.target, field, { value: undefined, enumerable: true });
      operation = api.changeRequestCreate(payload);
    } else if (method === 'changeRequestUpdate') {
      const payload: UpdateChangeRequestInput = { ...mutationContext, target: { ...mutationContext.target }, title: 'Update' };
      Object.defineProperty(payload.target, field, { value: undefined, enumerable: true });
      operation = api.changeRequestUpdate(payload);
    } else if (method === 'changeRequestMerge') {
      const payload: MergeChangeRequestInput = { ...mutationContext, target: { ...mutationContext.target }, method: 'merge' };
      Object.defineProperty(payload.target, field, { value: undefined, enumerable: true });
      operation = api.changeRequestMerge(payload);
    } else {
      const payload: ReadyChangeRequestInput = { ...mutationContext, target: { ...mutationContext.target } };
      Object.defineProperty(payload.target, field, { value: undefined, enumerable: true });
      operation = api.changeRequestReady(payload);
    }
    await expect(operation).rejects.toThrow('mutation context is invalid');
    expect(runtimeFetchMock).not.toHaveBeenCalled();
  });

  it.each([['number', 5], ['headSha', 'abc123']])('rejects the forbidden create target field %s', async (field, value) => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    const payload: CreateChangeRequestInput = {
      ...createMutationContext,
      target: { ...createMutationContext.target },
      title: 'Create',
    };
    Object.defineProperty(payload.target, field, { value, enumerable: true });
    await expect(api.changeRequestCreate(payload))
      .rejects.toThrow('mutation context is invalid');
    expect(runtimeFetchMock).not.toHaveBeenCalled();
  });

  it.each([-1, Number.MAX_SAFE_INTEGER + 1])('rejects invalid mutation binding revision %s', async (bindingRevision) => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    const payload = { ...mutationContext, bindingRevision };
    await expect(api.changeRequestReady(payload))
      .rejects.toThrow('mutation context is invalid');
    expect(runtimeFetchMock).not.toHaveBeenCalled();
  });

  it.each([0, Number.MAX_SAFE_INTEGER + 1])('rejects invalid mutation target number %s', async (number) => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    const payload = { ...mutationContext, target: { ...mutationContext.target, number } };
    await expect(api.changeRequestReady(payload))
      .rejects.toThrow('mutation context is invalid');
    expect(runtimeFetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['negative binding revision', { bindingRevision: -1 }],
    ['unsafe binding revision', { bindingRevision: Number.MAX_SAFE_INTEGER + 1 }],
    ['number zero', { number: 0 }],
    ['unsafe number', { number: Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects a receipt with %s', async (_label, targetOverride) => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      ...mutationReceipt({ ready: true }),
      target: { ...mutationReceipt().target, ...targetOverride },
    }));

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).changeRequestReady(mutationContext))
      .rejects.toThrow('invalid mutation receipt');
  });

  it.each([
    ['a provider payload without a receipt', {
      number: 5, title: 'Legacy response', url: 'https://github.com/openchamber/openchamber/pull/5',
      state: 'open', draft: false, base: 'main', head: 'feature',
    }],
    ['an invalid actor', { ...mutationReceipt(), actor: { provider: 'github', instance: 'github.com', providerAccountId: '' } }],
    ['a mismatched provider', { ...mutationReceipt(), actor: { provider: 'gitlab', instance: 'github.com', providerAccountId: 'github.com#7' } }],
    ['a mismatched instance', { ...mutationReceipt(), actor: { provider: 'github', instance: 'github.example.com', providerAccountId: 'github.com#7' } }],
    ['a credential-shaped actor field', { ...mutationReceipt(), actor: { provider: 'github', instance: 'github.com', providerAccountId: 'occred:v1:github:credential:r1' } }],
    ['a legacy actor field', { ...mutationReceipt(), actor: { provider: 'github', instance: 'github.com', accountId: 'github.com#7' } }],
    ['a provider user of another instance', { ...mutationReceipt(), actor: { provider: 'github', instance: 'github.com', providerAccountId: 'ghe.example.com#7' } }],
    ['a non-numeric provider user', { ...mutationReceipt(), actor: { provider: 'github', instance: 'github.com', providerAccountId: 'github.com#octocat' } }],
    ['a mismatched repository', { ...mutationReceipt(), target: { ...mutationReceipt().target, repositoryId: 'repo_other' } }],
    ['a mismatched binding revision', { ...mutationReceipt(), target: { ...mutationReceipt().target, bindingRevision: 5 } }],
    ['a mismatched primary remote', { ...mutationReceipt(), target: { ...mutationReceipt().target, primaryRemote: 'origin' } }],
    ['a mismatched project', {
      ...mutationReceipt(),
      target: { ...mutationReceipt().target, project: { id: 'R_2', owner: 'other', name: 'repository' } },
    }],
    ['a mismatched expected target', { ...mutationReceipt(), target: { ...mutationReceipt().target, number: 6 } }],
    ['an invalid operation result', mutationReceipt({ merged: 'yes' })],
    ['a non-empty create result', mutationReceipt({ unexpected: true })],
    ['an invalid ready result', mutationReceipt({ ready: false, unexpected: true })],
    ['an extra receipt field', { ...mutationReceipt(), providerPayload: { private: true } }],
  ])('rejects %s returned with HTTP success', async (_label, payload) => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json(payload));
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    const operation = _label === 'an invalid operation result'
      ? api.changeRequestMerge({ ...mutationContext, method: 'merge' })
      : _label === 'an invalid ready result'
        ? api.changeRequestReady(mutationContext)
        : _label === 'a mismatched expected target'
          ? api.changeRequestUpdate({ ...mutationContext, title: 'Update' })
      : api.changeRequestCreate({ ...createMutationContext, title: 'Create' });
    await expect(operation).rejects.toThrow('invalid');
  });

  it('preserves stable mutation error codes from non-success responses', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      error: 'Mutation outcome is unknown', code: 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN',
    }, { status: 409 }));

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).changeRequestCreate({
      ...createMutationContext, title: 'Create',
    })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN' });
  });

  it('normalizes GitLab identities and uses GitLab auth routes', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      connected: false,
      accounts: [{ id: 'credential-42', credentialId: 'credential-42', credentialRevision: 1, providerUserId: 'https://gitlab.example.com#42', providerUserStatus: 'unavailable', user: { id: 42, login: 'pat-user' }, current: true, source: 'pat', status: 'invalid' }],
      cli: { available: false, disabled: true, active: false },
    }));
    await expect(api.authStatus({ provider: 'gitlab', instance: 'https://GitLab.Example.com/' })).resolves.toEqual({
      provider: 'gitlab', instance: 'https://gitlab.example.com', status: 'disconnected', connected: false,
      accounts: [{
        id: 'credential-42', credentialId: 'credential-42', credentialRevision: 1,
        providerUserId: 'https://gitlab.example.com#42', providerUserStatus: 'unavailable',
        user: { provider: 'gitlab', instance: 'https://gitlab.example.com', id: '42', username: 'pat-user' },
        scope: undefined, current: true, source: 'pat', status: 'invalid',
      }],
      cli: { available: false, disabled: true, active: false, user: undefined },
    });
    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/source-control/gitlab/auth/status', {
      query: new URLSearchParams({ instance: 'https://gitlab.example.com' }), headers: { Accept: 'application/json' },
    });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: true, user: { id: 42, login: 'pat-user' } }));
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: true, user: { id: 42, login: 'pat-user' }, accounts: [] }));
    await expect(api.authSetToken({ provider: 'gitlab', instance: 'gitlab.example.com' }, 'secret-token')).resolves.toMatchObject({
      status: 'connected', user: { provider: 'gitlab', instance: 'https://gitlab.example.com', id: '42', username: 'pat-user' },
    });
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(2, '/api/source-control/gitlab/auth/token', expect.objectContaining({
      body: JSON.stringify({ token: 'secret-token' }), query: new URLSearchParams({ instance: 'https://gitlab.example.com' }),
    }));

    // A GitHub Enterprise host is a GHE instance; the request goes to the github
    // provider with the host as the instance and the neutral auth status.
    const gheUser = { provider: 'github', instance: 'github.example.com', id: '42', username: 'ghe-user' };
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      provider: 'github',
      instance: 'github.example.com',
      status: 'connected',
      connected: true,
      user: gheUser,
      accounts: [{
        id: 'github.example.com#cli:42', credentialId: 'github.example.com#cli:42', credentialRevision: 1,
        providerUserId: 'github.example.com#42', providerUserStatus: 'available',
        user: gheUser, current: true, source: 'cli', status: 'valid',
      }],
      cli: { available: true, disabled: false, active: true, user: gheUser },
    }));
    await expect(api.authStatus({ provider: 'github', instance: 'github.example.com' })).resolves.toMatchObject({
      status: 'connected', user: { provider: 'github', instance: 'github.example.com', id: '42', username: 'ghe-user' },
    });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/source-control/github/auth/status', expect.objectContaining({
      query: new URLSearchParams({ instance: 'github.example.com' }),
    }));
  });

  it('parses provider-neutral GitLab merge request context without GitHub identities', async () => {
    const gitlab: SourceControlIdentity = { provider: 'gitlab', instance: 'gitlab.example.com' };
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      identity: { provider: 'gitlab', instance: 'https://gitlab.example.com' },
      project: { provider: 'gitlab', instance: 'https://gitlab.example.com', id: '2', owner: 'team', name: 'repo', url: 'https://gitlab.example.com/team/repo' },
      changeRequest: {
        provider: 'gitlab', instance: 'https://gitlab.example.com', id: '2#5', number: 5,
        project: { provider: 'gitlab', instance: 'https://gitlab.example.com', id: '2', owner: 'team', name: 'repo', url: 'https://gitlab.example.com/team/repo' },
        title: 'Feature', url: 'https://gitlab.example.com/team/repo/-/merge_requests/5', state: 'open', draft: false,
        base: 'main', head: 'feature', author: { provider: 'gitlab', instance: 'https://gitlab.example.com', id: '7', username: 'alex' },
      },
      issueComments: [{ provider: 'gitlab', instance: 'https://gitlab.example.com', id: '9', url: 'mr-url', body: 'General' }],
      reviewComments: [{ provider: 'gitlab', instance: 'https://gitlab.example.com', id: '10', url: 'mr-url', body: 'Line', path: 'src/a.ts', line: 4 }],
      files: [{ path: 'src/a.ts', status: 'modified', patch: '@@' }],
      ci: { summary: { state: 'pending', total: 1, success: 0, failure: 0, pending: 1 } },
    }));

    const result = await createWebSourceControlAPI({ fetch: runtimeFetchMock }).changeRequestContext({
      ...gitlab, directory: '/repo', repositoryId: 'repo_two', accountId: 'https://gitlab.example.com#7', bindingRevision: 6, primaryRemote: 'fork',
    }, 5, {
      includeDiff: true,
      includeCIDetails: true,
      project: { owner: 'team', name: 'repo' },
    });

    expect(result).toMatchObject({
      identity: { provider: 'gitlab', instance: 'https://gitlab.example.com' },
      changeRequest: { provider: 'gitlab', instance: 'https://gitlab.example.com', number: 5, author: { username: 'alex' } },
      reviewComments: [{ provider: 'gitlab', path: 'src/a.ts', line: 4 }],
      ci: { summary: { state: 'pending' } },
    });
    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/source-control/gitlab/pulls/context', expect.objectContaining({
      query: new URLSearchParams({
        instance: 'https://gitlab.example.com', directory: '/repo', repositoryId: 'repo_two', accountId: 'https://gitlab.example.com#7',
        bindingRevision: '6', primaryRemote: 'fork', number: '5', diff: '1', checkDetails: '1', owner: 'team', repo: 'repo',
      }),
    }));
  });

  it('preserves transport failures and an unavailable account as errors', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    runtimeFetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(api.issuesList(readContext)).rejects.toThrow('network down');

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ error: 'GitHub account is unavailable' }, { status: 401 }));
    await expect(api.issuesList(readContext)).rejects.toThrow('GitHub account is unavailable');

    // A disconnected envelope is never read as an empty list.
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: false }));
    await expect(api.issuesList(readContext)).rejects.toThrow('invalid issues');
  });
});

describe('GitHub Enterprise (GHE) auth flows', () => {
  const gheIdentity: SourceControlIdentity = { provider: 'github', instance: 'https://ghe.example.com/' };
  const providerUser = (id: string | number, username: string) => ({ id: String(id), username, provider: 'github', instance: 'ghe.example.com' });
  const gheContext: SourceControlReadContext = {
    ...gheIdentity, directory: '/repo', repositoryId: 'repo_one', accountId: 'ghe.example.com#7', bindingRevision: 4, primaryRemote: 'origin',
  };
  const gheProject = {
    provider: 'github', instance: 'ghe.example.com', id: 'team/app', owner: 'team', name: 'app', url: 'https://ghe.example.com/team/app',
  };

  it('reads capabilities for a GHE instance against the github route with the host instance', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      identity: { provider: 'github', instance: 'ghe.example.com' },
      authentication: true,
      authenticationMethods: {
        device: { available: false },
        pat: { available: true },
        cli: { available: true },
      },
      multipleAccounts: true,
      projects: true,
      issues: true,
      changeRequests: true,
      draftChangeRequests: true,
      mergeChangeRequests: true,
      mergeMethods: ['merge', 'squash'],
      ci: true,
    }));

    const result = await createWebSourceControlAPI({ fetch: runtimeFetchMock }).capabilities(gheIdentity);
    expect(result.identity).toEqual({ provider: 'github', instance: 'ghe.example.com' });
    expect(result.authenticationMethods.pat).toEqual({ available: true });
    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/source-control/github/capabilities', {
      query: new URLSearchParams({ instance: 'ghe.example.com' }),
      headers: { Accept: 'application/json' },
    });
  });

  it('connects a GHE personal access token and reads the neutral auth status', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    const statusDto = {
      provider: 'github',
      instance: 'ghe.example.com',
      status: 'connected',
      connected: true,
      user: providerUser(42, 'ghe-user'),
      scope: 'repo',
      accounts: [
        {
          id: 'pat-account', credentialId: 'pat-account', credentialRevision: 1,
          providerUserId: 'ghe.example.com#42', providerUserStatus: 'available',
          user: providerUser(42, 'ghe-user'), current: true, source: 'pat', status: 'valid',
        },
        {
          id: 'ghe.example.com#cli:7', credentialId: 'ghe.example.com#cli:7', credentialRevision: 1,
          providerUserId: 'ghe.example.com#7', providerUserStatus: 'available',
          user: providerUser(7, 'cli-user'), current: false, source: 'cli', status: 'valid',
        },
      ],
      cli: { available: true, disabled: false, active: false, user: providerUser(7, 'cli-user') },
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: true, user: providerUser(42, 'ghe-user') }));
    runtimeFetchMock.mockResolvedValueOnce(Response.json(statusDto));

    const result = await api.authSetToken(gheIdentity, 'ghp_ghe_token');

    expect(runtimeFetchMock).toHaveBeenNthCalledWith(1, '/api/source-control/github/auth/token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'ghp_ghe_token' }),
      query: new URLSearchParams({ instance: 'ghe.example.com' }),
    });
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(2, '/api/source-control/github/auth/status', expect.objectContaining({
      query: new URLSearchParams({ instance: 'ghe.example.com' }),
    }));
    expect(result).toMatchObject({
      provider: 'github',
      instance: 'ghe.example.com',
      status: 'connected',
      connected: true,
      user: { provider: 'github', instance: 'ghe.example.com', id: '42', username: 'ghe-user' },
    });
    expect(result.accounts).toBeDefined();
    expect(result.accounts!).toHaveLength(2);
    expect(result.accounts![0]).toMatchObject({ source: 'pat', status: 'valid', current: true });
    expect(result.accounts![1]).toMatchObject({ source: 'cli', status: 'valid' });
  });

  it('surfaces a refused GHE token as INVALID_TOKEN', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ error: 'GitHub token is invalid', code: 'INVALID_TOKEN' }, { status: 401 }));

    await expect(createWebSourceControlAPI({ fetch: runtimeFetchMock }).authSetToken(gheIdentity, 'bad-token'))
      .rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('reads a disconnected GHE auth status with its cli account and activates it', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    const disconnected = {
      provider: 'github',
      instance: 'ghe.example.com',
      status: 'disconnected',
      connected: false,
      accounts: [
        {
          id: 'ghe.example.com#cli:7', credentialId: 'ghe.example.com#cli:7', credentialRevision: 1,
          providerUserId: 'ghe.example.com#7', providerUserStatus: 'available',
          user: providerUser(7, 'cli-user'), current: false, source: 'cli', status: 'valid',
        },
      ],
      cli: { available: true, disabled: false, active: false, user: providerUser(7, 'cli-user') },
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(disconnected));
    await expect(api.authStatus(gheIdentity)).resolves.toMatchObject({
      provider: 'github', instance: 'ghe.example.com', status: 'disconnected', connected: false,
      cli: { available: true, disabled: false, active: false },
      accounts: [{ id: 'ghe.example.com#cli:7', source: 'cli', current: false }],
    });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ ...disconnected, status: 'connected', connected: true, user: providerUser(7, 'cli-user') }));
    await expect(api.authActivate(gheIdentity, 'ghe.example.com#cli:7')).resolves.toMatchObject({
      provider: 'github', instance: 'ghe.example.com', status: 'connected', user: { username: 'cli-user' },
    });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/source-control/github/auth/activate', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'ghe.example.com#cli:7' }),
      query: new URLSearchParams({ instance: 'ghe.example.com' }),
    });
  });

  it('disconnects an account and toggles the gh cli through the shared cli route', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ removed: true }));
    await expect(api.authDisconnect(gheIdentity, 'ghe.example.com#7')).resolves.toEqual({ removed: true });
    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/source-control/github/auth', {
      method: 'DELETE',
      query: new URLSearchParams({ instance: 'ghe.example.com', accountId: 'ghe.example.com#7' }),
      headers: { Accept: 'application/json' },
    });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ available: false, disabled: true }));
    await expect(api.authSetCliDisabled(gheIdentity, true)).resolves.toEqual({ disabled: true });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/source-control/github/auth/cli', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
      query: new URLSearchParams({ instance: 'ghe.example.com' }),
    });
  });

  it('reads github.com auth status on the same route and neutral parser as an enterprise host', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      provider: 'github',
      instance: 'github.com',
      status: 'disconnected',
      connected: false,
      accounts: [],
      cli: { available: true, disabled: true, active: false },
    }));

    const result = await api.authStatus({ provider: 'github', instance: 'github.com' });
    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/source-control/github/auth/status', {
      query: new URLSearchParams({ instance: 'github.com' }),
      headers: { Accept: 'application/json' },
    });
    expect(result).toMatchObject({
      provider: 'github', instance: 'github.com', status: 'disconnected', connected: false,
      cli: { available: true, disabled: true, active: false },
    });
  });

  it('reads enterprise DTOs that carry the enterprise host as their identity', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    const changeRequest = {
      provider: 'github', instance: 'ghe.example.com', id: 'team/app#3', number: 3, project: gheProject,
      title: 'Feature', url: 'https://ghe.example.com/team/app/pull/3', state: 'open', draft: false,
      base: 'main', head: 'feature', author: providerUser(7, 'octocat'),
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      identity: { provider: 'github', instance: 'ghe.example.com' }, project: gheProject, branch: 'feature', changeRequest, ci: null,
    }));
    await expect(api.changeRequestStatus(gheContext, 'feature')).resolves.toMatchObject({
      identity: { provider: 'github', instance: 'ghe.example.com' },
      project: { instance: 'ghe.example.com', id: 'team/app', url: 'https://ghe.example.com/team/app' },
      changeRequest: { instance: 'ghe.example.com', id: 'team/app#3', author: { instance: 'ghe.example.com', id: '7' } },
    });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/source-control/github/pr/status', expect.objectContaining({
      query: new URLSearchParams({
        instance: 'ghe.example.com', directory: '/repo', repositoryId: 'repo_one', accountId: 'ghe.example.com#7',
        bindingRevision: '4', primaryRemote: 'origin', branch: 'feature',
      }),
    }));

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ items: [changeRequest], page: 1, hasMore: false, incompleteProjectIds: ['upstream/app'] }));
    await expect(api.changeRequestsList(gheContext)).resolves.toMatchObject({
      items: [{ instance: 'ghe.example.com', id: 'team/app#3' }], incompleteProjectIds: ['upstream/app'],
    });

    // A DTO that names github.com is not an answer about the enterprise host.
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      items: [{ ...changeRequest, instance: 'github.com', project: { ...gheProject, instance: 'github.com' } }], page: 1, hasMore: false,
    }));
    await expect(api.changeRequestsList(gheContext)).rejects.toThrow('invalid change request');
  });

  it('accepts an enterprise mutation receipt only when its actor is a user of that host', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    const gheMutation: SourceControlMutationContext<SourceControlExistingMutationTarget> = {
      ...gheContext, idempotencyKey: 'mutation-ghe', target: { project: { owner: 'team', name: 'app' }, number: 3 },
    };
    const receipt = (providerAccountId: string) => ({
      status: 'succeeded',
      actor: { provider: 'github', instance: 'ghe.example.com', providerAccountId },
      target: { repositoryId: 'repo_one', bindingRevision: 4, primaryRemote: 'origin', project: { id: 'team/app', owner: 'team', name: 'app' }, number: 3 },
      replayed: false,
      result: { ready: true },
    });

    runtimeFetchMock.mockResolvedValueOnce(Response.json(receipt('ghe.example.com#7')));
    await expect(api.changeRequestReady(gheMutation)).resolves.toMatchObject({
      actor: { provider: 'github', instance: 'ghe.example.com', providerAccountId: 'ghe.example.com#7' },
      target: { number: 3 },
      result: { ready: true },
    });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/source-control/github/pr/ready', expect.objectContaining({
      query: new URLSearchParams({ instance: 'ghe.example.com' }),
    }));

    runtimeFetchMock.mockResolvedValueOnce(Response.json(receipt('github.com#7')));
    await expect(api.changeRequestReady(gheMutation)).rejects.toThrow('invalid mutation receipt');
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WorktreeCreationError, createWorktreeCreation } from './worktree-creation.js';
import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';

const sourceRequest = {
  context: {
    provider: 'github', instance: 'github.com', directory: '/repo', repositoryId: 'repo_one',
    accountId: 'account_one', bindingRevision: 2, primaryRemote: 'origin',
  },
  project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 42,
  expectedHeadSha: 'a'.repeat(40), requestedRemoteName: 'pr-alice',
};
const resolvedSource = {
  context: sourceRequest.context,
  targetProject: sourceRequest.project,
  sourceProject: { id: 'Alice/app', owner: 'Alice', name: 'app' },
  number: 42, headRef: 'refs/heads/feature', headSha: 'a'.repeat(40),
  requestedRemoteName: 'pr-alice', endpoint: 'https://github.com/Alice/app.git',
  classification: 'contributor-fork',
};
const validAccount = {
  credentialId: 'account_one', credentialRevision: 3, providerUserId: 'github.com#42', status: 'valid',
};

const setup = (overrides = {}) => {
  const libraries = {
    createWorktree: vi.fn(async () => ({ path: '/worktrees/feature', branch: 'feature' })),
    validateWorktreeCreate: vi.fn(async () => ({ ok: false, errors: [{ code: 'contributor_transfer_unavailable', message: 'transfer first' }] })),
    getRepositoryRemoteUrls: vi.fn(async () => []),
    ...overrides.libraries,
  };
  const dependencies = {
    getGitLibraries: async () => libraries,
    networkOperations: {
      hydrateBoundCheckout: vi.fn(),
      transferContributorHead: vi.fn(async () => ({ state: 'succeeded' })),
    },
    getSourceControlBinding: vi.fn(async () => ({ revision: 0, repository: { repositoryId: 'repo_one' }, binding: null })),
    contributorProvenance: { compareAndSwap: vi.fn() },
    resolveChangeRequestSource: vi.fn(async () => resolvedSource),
    createHttpsCredentialReference: vi.fn(() => 'credential_reference'),
    resolveSourceControlAccount: vi.fn(async () => validAccount),
    worktreeBootstrapStore: { read: vi.fn(), write: vi.fn() },
    ...overrides.dependencies,
  };
  return { libraries, dependencies, creation: createWorktreeCreation(dependencies) };
};

const request = { mode: 'existing', branchName: 'feature', worktreeName: 'feature', changeRequestSource: sourceRequest };

describe('worktree creation from a change request', () => {
  it('creates a contributor worktree from the server-resolved head only', async () => {
    const { libraries, dependencies, creation } = setup();

    await expect(creation.create('/repo', request)).resolves.toEqual({ path: '/worktrees/feature', branch: 'feature' });

    expect(dependencies.resolveChangeRequestSource).toHaveBeenCalledExactlyOnceWith(sourceRequest);
    expect(dependencies.networkOperations.transferContributorHead).toHaveBeenCalledExactlyOnceWith({
      directory: '/repo', sourceRequest, source: { ...resolvedSource, requestedRemoteName: 'pr-alice' },
      destinationRef: 'refs/remotes/pr-alice/feature', credentialId: 'credential_reference',
    });
    const [, input, options] = libraries.createWorktree.mock.calls[0];
    expect(input).toMatchObject({
      mode: 'existing', branchName: 'feature', worktreeName: 'feature',
      contributorFork: true, changeRequestTransfer: true, contributorTransferComplete: true,
      ensureRemoteName: 'pr-alice', ensureRemoteUrl: 'https://github.com/Alice/app.git',
      existingBranch: 'remotes/pr-alice/feature', expectedRevision: 'a'.repeat(40), setUpstream: false,
    });
    expect(input.changeRequestSource).toBeUndefined();
    expect(options).toMatchObject({
      contributorProvenance: dependencies.contributorProvenance,
      contributorSource: { ...resolvedSource, requestedRemoteName: 'pr-alice' },
      bootstrapStore: dependencies.worktreeBootstrapStore,
    });
  });

  describe('service-login primary remote', () => {
    const provider = 'ext-codebase-cli';
    const context = { ...sourceRequest.context, provider, primaryRemote: 'company' };
    const source = {
      ...resolvedSource, context, classification: 'same-repository', sourceProject: sourceRequest.project,
      endpoint: 'https://code.example.com/acme/app.git',
    };
    const remoteUrl = 'git@code.example.com:acme/app.git';
    const input = { ...request, changeRequestSource: { ...sourceRequest, context } };
    const descriptor = { id: provider, capabilities: {}, authMethods: { cli: { kind: 'service' } } };
    const serviceSetup = (transfer = { state: 'succeeded' }) => setup({
      libraries: { getRepositoryRemoteUrls: vi.fn(async () => [{ name: 'company', fetchUrl: remoteUrl }]) },
      dependencies: {
        resolveChangeRequestSource: vi.fn(async () => source),
        resolveSourceControlAccount: vi.fn(async () => null),
        getSourceControlBinding: vi.fn(async () => ({ repository: { configRevision: 'config_one' }, binding: null })),
        networkOperations: {
          plan: vi.fn(async () => ({ operationId: 'git_fetch' })),
          execute: vi.fn(async () => transfer),
          transferContributorHead: vi.fn(), hydrateBoundCheckout: vi.fn(),
        },
      },
    });

    beforeAll(() => sourceControlProviderDescriptors.attachExtension(descriptor));
    afterAll(() => sourceControlProviderDescriptors.detachExtension(provider));

    it('uses ordinary fetch without requesting a provider credential', async () => {
      const { creation, dependencies, libraries } = serviceSetup();
      await creation.create('/repo', input);
      expect(dependencies.networkOperations.plan).toHaveBeenCalledExactlyOnceWith({
        operation: 'fetch', directory: '/repo', repositoryId: 'repo_one', bindingRevision: 2,
        configRevision: 'config_one', transportMode: 'system',
        remote: { name: 'company', endpoint: { displayUrl: remoteUrl, fingerprint: expect.any(String) } },
        sourceRef: source.headRef, destinationRef: 'refs/remotes/company/feature',
      });
      expect(dependencies.networkOperations.execute).toHaveBeenCalledExactlyOnceWith('git_fetch');
      expect(dependencies.networkOperations.transferContributorHead).not.toHaveBeenCalled();
      expect(dependencies.resolveSourceControlAccount).not.toHaveBeenCalled();
      expect(dependencies.createHttpsCredentialReference).not.toHaveBeenCalled();
      expect(dependencies.resolveChangeRequestSource).toHaveBeenCalledTimes(2);
      expect(libraries.createWorktree).toHaveBeenCalledWith('/repo', expect.objectContaining({
        existingBranch: 'remotes/company/feature', expectedRevision: source.headSha,
        ensureRemoteName: 'company', ensureRemoteUrl: remoteUrl, contributorFork: false,
      }), expect.anything());
      const [, , options] = libraries.createWorktree.mock.calls[0];
      await options.hydrateCheckout({ directory: '/worktrees/feature', parentRemoteName: 'company' });
      expect(dependencies.networkOperations.hydrateBoundCheckout).toHaveBeenCalledWith(expect.objectContaining({ parentEndpoint: remoteUrl }));
    });

    it('preserves a fetch refusal without creating a checkout', async () => {
      const { creation, dependencies, libraries } = serviceSetup({ state: 'conflicted', error: { code: 'REMOTE_CHANGED', message: 'Remote changed' } });
      await expect(creation.create('/repo', input)).rejects.toMatchObject({ code: 'REMOTE_CHANGED', message: 'Remote changed' });
      expect(libraries.createWorktree).not.toHaveBeenCalled();
      expect(dependencies.networkOperations.transferContributorHead).not.toHaveBeenCalled();
    });

    it('refuses a fork instead of fetching it through the primary remote', async () => {
      const { creation, dependencies, libraries } = serviceSetup();
      dependencies.resolveChangeRequestSource.mockResolvedValue({ ...source, classification: 'contributor-fork' });
      await expect(creation.create('/repo', input)).rejects.toMatchObject({ status: 501, code: 'RUNTIME_UNSUPPORTED' });
      expect(dependencies.networkOperations.plan).not.toHaveBeenCalled();
      expect(dependencies.networkOperations.transferContributorHead).not.toHaveBeenCalled();
      expect(libraries.createWorktree).not.toHaveBeenCalled();
    });

    it('keeps managed contributor transfer for a provider that also offers token login', async () => {
      sourceControlProviderDescriptors.attachExtension({ ...descriptor, authMethods: { ...descriptor.authMethods, pat: true } });
      try {
        const { creation, dependencies } = setup({ dependencies: {
          resolveChangeRequestSource: vi.fn(async () => ({ ...resolvedSource, context })),
        } });
        await creation.create('/repo', input);
        expect(dependencies.networkOperations.transferContributorHead).toHaveBeenCalledWith(expect.objectContaining({ credentialId: 'credential_reference' }));
      } finally {
        sourceControlProviderDescriptors.attachExtension(descriptor);
      }
    });
  });

  it('refuses contributor authority supplied by the caller before reading anything', async () => {
    const { libraries, dependencies, creation } = setup();

    await expect(creation.create('/repo', { ...request, ensureRemoteUrl: 'https://attacker.example/app.git' }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_CONTRIBUTOR_WORKTREE' });
    expect(dependencies.resolveChangeRequestSource).not.toHaveBeenCalled();
    expect(libraries.createWorktree).not.toHaveBeenCalled();
  });

  it('refuses a remote name that already points elsewhere, before any transfer', async () => {
    const { libraries, dependencies, creation } = setup({ libraries: {
      validateWorktreeCreate: vi.fn(async () => ({
        ok: false,
        errors: [{ code: 'remote_name_collision', message: 'Remote pr-alice already exists with a different endpoint' }],
      })),
    } });

    const error = await creation.create('/repo', request).catch((caught) => caught);
    expect(error).toBeInstanceOf(WorktreeCreationError);
    expect(error).toMatchObject({
      status: 409, code: 'CONTRIBUTOR_REMOTE_COLLISION', remoteName: 'pr-alice',
      message: 'Remote pr-alice already exists with a different endpoint',
    });
    expect(dependencies.networkOperations.transferContributorHead).not.toHaveBeenCalled();
    expect(libraries.createWorktree).not.toHaveBeenCalled();
  });

  it('refuses when the account that would fetch the head is not the context\'s exact one', async () => {
    const { libraries, dependencies, creation } = setup({ dependencies: {
      resolveSourceControlAccount: vi.fn(async () => ({ ...validAccount, credentialId: 'other_account' })),
    } });

    await expect(creation.create('/repo', request)).rejects.toMatchObject({ status: 409, code: 'AUTHENTICATION_REQUIRED' });
    expect(dependencies.networkOperations.transferContributorHead).not.toHaveBeenCalled();
    expect(libraries.createWorktree).not.toHaveBeenCalled();
  });

  it('reports a failed transfer and creates nothing', async () => {
    const { libraries, creation } = setup({ dependencies: {
      networkOperations: {
        hydrateBoundCheckout: vi.fn(),
        transferContributorHead: vi.fn(async () => ({ state: 'failed', error: { code: 'TIMEOUT', message: 'Git network operation timed out' } })),
      },
    } });

    await expect(creation.create('/repo', request))
      .rejects.toMatchObject({ status: 409, code: 'TIMEOUT', message: 'Git network operation timed out' });
    expect(libraries.createWorktree).not.toHaveBeenCalled();
  });

  it('passes a provider refusal through and creates nothing', async () => {
    const stale = Object.assign(new Error('Change request head changed'), { status: 409, code: 'SOURCE_CONTROL_CHANGE_REQUEST_STALE' });
    const { libraries, dependencies, creation } = setup({ dependencies: {
      resolveChangeRequestSource: vi.fn(async () => { throw stale; }),
    } });

    await expect(creation.create('/repo', request)).rejects.toBe(stale);
    expect(dependencies.networkOperations.transferContributorHead).not.toHaveBeenCalled();
    expect(libraries.createWorktree).not.toHaveBeenCalled();
  });

  it('refuses where contributor transfer is not served, with no plain worktree instead', async () => {
    const { libraries, creation } = setup({ dependencies: { resolveChangeRequestSource: undefined } });

    await expect(creation.create('/repo', request)).rejects.toMatchObject({ status: 501, code: 'RUNTIME_UNSUPPORTED' });
    expect(libraries.createWorktree).not.toHaveBeenCalled();
  });

  it('turns a remote collision found while creating into the route\'s collision answer', async () => {
    const collision = Object.assign(new Error('Remote pr-alice already exists with a different endpoint'), {
      code: 'CONTRIBUTOR_REMOTE_COLLISION', status: 409, remoteName: 'pr-alice',
    });
    const { creation } = setup({ libraries: { createWorktree: vi.fn(async () => { throw collision; }) } });

    await expect(creation.create('/repo', request)).rejects.toMatchObject({
      status: 409, code: 'CONTRIBUTOR_REMOTE_COLLISION', remoteName: 'pr-alice',
      message: 'Contributor remote name is already used by a different endpoint',
    });
  });

  describe('a change host\'s revision head', () => {
    const changeContext = { ...sourceRequest.context, provider: 'gerrit', instance: 'https://gerrit.example.com' };
    const changeSource = {
      ...resolvedSource, context: changeContext, sourceProject: sourceRequest.project, headRef: 'refs/changes/42/42/3',
      classification: 'same-repository', requestedRemoteName: 'origin', endpoint: 'https://gerrit.example.com/acme/app',
    };
    const changeRequest = { ...request, branchName: 'whatever', changeRequestSource: { ...sourceRequest, context: changeContext } };
    const libraries = { getRepositoryRemoteUrls: vi.fn(async () => [{ name: 'origin', fetchUrl: 'https://gerrit.example.com/acme/app' }]) };

    it('fetches the revision ref and checks it out on change-<number>', async () => {
      const { dependencies, creation, libraries: used } = setup({ libraries, dependencies: { resolveChangeRequestSource: vi.fn(async () => changeSource) } });
      await creation.create('/repo', changeRequest);
      expect(dependencies.networkOperations.transferContributorHead).toHaveBeenCalledWith(expect.objectContaining({
        destinationRef: 'refs/remotes/origin/change-42',
      }));
      const [, input] = used.createWorktree.mock.calls[0];
      expect(input).toMatchObject({ branchName: 'change-42', existingBranch: 'remotes/origin/change-42', contributorFork: false });
    });

    it.each([
      ['a provider that creates by API', { context: { ...changeContext, provider: 'gitea' } }],
      ['a fork', { classification: 'contributor-fork' }],
      ['a malformed revision ref', { headRef: 'refs/changes/41/42/3' }],
    ])('refuses it from %s', async (_name, overrides) => {
      const { dependencies, creation } = setup({ libraries, dependencies: { resolveChangeRequestSource: vi.fn(async () => ({ ...changeSource, ...overrides })) } });
      await expect(creation.create('/repo', changeRequest)).rejects.toMatchObject({ status: 409, code: 'INVALID_REQUEST' });
      expect(dependencies.networkOperations.transferContributorHead).not.toHaveBeenCalled();
    });
  });
});

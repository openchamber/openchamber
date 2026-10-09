import { describe, expect, it, vi } from 'vitest';
import { WorktreeCreationError, createWorktreeCreation } from './worktree-creation.js';

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
});

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeCreationError, createWorktreeCreation } from './worktree-creation.js';
import * as gitLibraries from './service.js';
import { createContributorProvenanceStore } from './contributor-provenance-storage.js';
import { createWithPlannedRemote, hydrateFollowingPlannedRemotes } from './planned-remotes.js';
import { createNetworkOperations } from './network-operations.js';
import { createWorktreeBootstrapStore } from './worktree-bootstrap-storage.js';
import { createSourceControlAuditStore } from '../source-control/audit-storage.js';
import { createBindingService } from '../source-control/binding-service.js';
import { createBindingStore } from '../source-control/binding-storage.js';
import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';
import { resolveRepositoryId, resolveRepositoryIdentity } from '../source-control/repository-identity.js';

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
    getSourceControlBinding: vi.fn(async () => ({ revision: 0, repository: { repositoryId: 'repo_one', remotes: [] }, binding: null })),
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
        getSourceControlBinding: vi.fn(async () => ({ repository: { configRevision: 'config_one', remotes: [{ name: 'origin' }, { name: 'company' }] }, binding: null })),
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

  describe('GitHub Enterprise primary remote', () => {
    const instance = 'git.example.com';
    const context = { ...sourceRequest.context, instance };
    const input = { ...request, changeRequestSource: { ...sourceRequest, context } };
    const source = {
      ...resolvedSource, context, classification: 'same-repository', sourceProject: sourceRequest.project,
      endpoint: `https://${instance}/acme/app.git`,
    };
    const enterpriseSetup = (remoteUrl, mode) => setup({
      libraries: { getRepositoryRemoteUrls: vi.fn(async () => [{ name: 'origin', fetchUrl: remoteUrl }]) },
      dependencies: {
        resolveChangeRequestSource: vi.fn(async () => source),
        getSourceControlBinding: vi.fn(async () => ({
          repository: { configRevision: 'config_one', remotes: [{ name: 'origin' }, { name: 'company' }] },
          binding: mode ? { remotes: [{ name: 'origin', mode }] } : null,
        })),
        networkOperations: {
          plan: vi.fn(async () => ({ operationId: 'git_fetch' })),
          execute: vi.fn(async () => ({ state: 'succeeded' })),
          transferContributorHead: vi.fn(), hydrateBoundCheckout: vi.fn(),
        },
      },
    });

    it.each([
      [`https://${instance}/acme/app.git`, undefined, 'system'],
      [`git@${instance}:acme/app.git`, 'managed', 'managed'],
    ])('uses the configured fetch transport for %s and pins the checkout revision', async (remoteUrl, mode, transportMode) => {
      const { creation, dependencies, libraries } = enterpriseSetup(remoteUrl, mode);
      await creation.create('/repo', input);
      expect(dependencies.networkOperations.plan).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        operation: 'fetch', transportMode, sourceRef: source.headRef, destinationRef: 'refs/remotes/origin/feature',
        remote: { name: 'origin', endpoint: { displayUrl: remoteUrl, fingerprint: expect.any(String) } },
      }));
      expect(dependencies.networkOperations.execute).toHaveBeenCalledExactlyOnceWith('git_fetch');
      expect(dependencies.resolveChangeRequestSource).toHaveBeenCalledTimes(2);
      expect(dependencies.createHttpsCredentialReference).not.toHaveBeenCalled();
      expect(dependencies.networkOperations.transferContributorHead).not.toHaveBeenCalled();
      expect(libraries.createWorktree).toHaveBeenCalledWith('/repo', expect.objectContaining({
        existingBranch: 'remotes/origin/feature', expectedRevision: source.headSha,
        ensureRemoteUrl: remoteUrl, contributorFork: false,
      }), expect.anything());
    });

    it('fetches through System Git when the primary HTTPS remote carries only a username', async () => {
      const remoteUrl = `https://alice@${instance}/acme/app.git`;
      const { creation, dependencies, libraries } = enterpriseSetup(remoteUrl);
      await creation.create('/repo', input);
      expect(dependencies.networkOperations.plan).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        operation: 'fetch', transportMode: 'system',
        remote: { name: 'origin', endpoint: { displayUrl: `https://${instance}/acme/app.git`, fingerprint: expect.any(String) } },
      }));
      expect(libraries.createWorktree).toHaveBeenCalledWith('/repo', expect.objectContaining({
        ensureRemoteUrl: remoteUrl, expectedRevision: source.headSha,
      }), expect.anything());
    });

    it.each([
      [`https://alice:secret@${instance}/acme/app.git`, undefined],
      [`https://alice@${instance}/acme/app.git`, 'managed'],
    ])('rejects the primary remote %s outside a username-only System HTTPS remote', async (remoteUrl, mode) => {
      const { creation, dependencies, libraries } = enterpriseSetup(remoteUrl, mode);
      await expect(creation.create('/repo', input)).rejects.toMatchObject({ code: 'RUNTIME_UNSUPPORTED' });
      expect(dependencies.networkOperations.plan).not.toHaveBeenCalled();
      expect(libraries.createWorktree).not.toHaveBeenCalled();
    });

    it('treats a remote spelled in a different case as the head repository', async () => {
      const { creation, dependencies } = enterpriseSetup(`https://${instance}/acme/app.git`);
      dependencies.resolveChangeRequestSource.mockImplementation(async () => ({
        ...source, sourceProject: { id: 'Acme/App', owner: 'Acme', name: 'App' }, endpoint: `https://${instance}/Acme/App.git`,
      }));
      await creation.create('/repo', input);
      expect(dependencies.networkOperations.plan).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'fetch' }));
      expect(dependencies.createHttpsCredentialReference).not.toHaveBeenCalled();
    });

    it('rejects a primary remote that names a different repository', async () => {
      const { creation, dependencies, libraries } = enterpriseSetup(`https://${instance}/someone/app.git`);
      await expect(creation.create('/repo', input)).rejects.toMatchObject({ code: 'RUNTIME_UNSUPPORTED' });
      expect(dependencies.networkOperations.plan).not.toHaveBeenCalled();
      expect(libraries.createWorktree).not.toHaveBeenCalled();
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

describe('the first worktree from a contributor fork, with real Git', () => {
  const FORK_URL = 'https://github.com/Alice/app.git';
  let root;
  let repository;
  let child;
  let headSha;

  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const initRepository = (name) => {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    git(directory, 'init', '-q', '-b', 'main');
    git(directory, 'config', 'user.name', 'Fixture');
    git(directory, 'config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(directory, 'README.md'), `${name}\n`);
    git(directory, 'add', '.');
    git(directory, 'commit', '-qm', 'base');
    return directory;
  };

  const forkSetup = ({ submodule = true, hydrate, clone, onStart } = {}) => {
    git(repository, 'checkout', '-q', '-b', 'fork-head');
    if (submodule) {
      fs.writeFileSync(path.join(repository, '.gitmodules'), '[submodule "child"]\n\tpath = vendor/child\n\turl = https://github.com/acme/child.git\n');
      git(repository, 'add', '.gitmodules');
      git(repository, 'update-index', '--add', '--cacheinfo', `160000,${git(child, 'rev-parse', 'HEAD')},vendor/child`);
      git(repository, 'commit', '-qm', 'submodule');
    } else {
      git(repository, 'commit', '-q', '--allow-empty', '-m', 'head');
    }
    headSha = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'checkout', '-q', 'main');
    git(repository, 'branch', '-qD', 'fork-head');

    const binding = createBindingService({
      store: createBindingStore({ filePath: path.join(root, 'bindings.json') }),
      resolveRepository: resolveRepositoryIdentity,
    });
    const auditStore = createSourceControlAuditStore({ filePath: path.join(root, 'audit.json') });
    const clones = [];
    const operations = createNetworkOperations({
      validateGitTransportContext: binding.validateGitTransportContext,
      validateGitAuxiliaryContext: binding.validateGitAuxiliaryContext,
      credentialResolver: { resolve: async () => { throw new Error('System transport needs no credential'); } },
      credentialBroker: { start: async () => {}, issue: vi.fn(), revoke: vi.fn() },
      auditStore: { ...auditStore, start: async (id) => { await onStart?.(id); return auditStore.start(id); } },
      runtimeIdentity: { id: 'fixture', platform: 'web' },
      // Only the network is replaced: the child comes from a local repository.
      spawnImpl: (binary, args, options) => {
        const at = args.indexOf('clone');
        if (at < 0) return spawn(binary, args, options);
        clones.push(args);
        const failed = clone?.(clones.length) === false;
        return spawn(binary, ['clone', '--no-checkout', '--no-tags', '--', failed ? path.join(root, 'missing') : child, args.at(-1)],
          { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: 'file' } });
      },
    });
    const provenance = createContributorProvenanceStore({
      filePath: path.join(root, 'provenance.json'),
      resolveRepositoryIdentity: resolveRepositoryId,
      resolveGitPaths: gitLibraries.resolveRepositoryGitPaths,
    });
    const disposeInstance = vi.fn(async (directory) => {
      expect((await bootstrapStore.read(directory)).phase).toBe('directory-created');
    });
    const bootstrapStore = createWorktreeBootstrapStore({ filePath: path.join(root, 'bootstrap.json') });
    const source = { ...resolvedSource, headSha, context: { ...resolvedSource.context, bindingRevision: 0 } };
    const resolve = vi.fn(async () => source);
    const creation = createWorktreeCreation({
      getGitLibraries: async () => gitLibraries,
      networkOperations: {
        ...operations,
        transferContributorHead: async ({ destinationRef }) => {
          git(repository, 'update-ref', destinationRef, headSha);
          return { state: 'succeeded' };
        },
        hydrateBoundCheckout: async (input) => {
          await hydrate?.(input);
          return operations.hydrateBoundCheckout(input);
        },
      },
      getSourceControlBinding: binding.get,
      contributorProvenance: provenance,
      resolveChangeRequestSource: resolve,
      createHttpsCredentialReference: () => 'credential_reference',
      resolveSourceControlAccount: async () => validAccount,
      worktreeBootstrapStore: bootstrapStore,
      disposeInstance,
    });
    const settled = async (created) => {
      await gitLibraries.waitForActiveWorktreeBootstrap(created.path);
      return gitLibraries.getWorktreeBootstrapStatus(created.path, { bootstrapStore });
    };
    return { creation, resolve, source, settled, clones, provenance, bootstrapStore, disposeInstance };
  };
  const forkRequest = { ...request, returnAfterDirectoryCreated: true };
  const childReadme = (created) => fs.readFileSync(path.join(created.path, 'vendor/child/README.md'), 'utf8');

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-fork-worktree-')));
    vi.stubEnv('HOME', root);
    vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
    vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'config'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    child = initRepository('child');
    repository = initRepository('app');
    git(repository, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['no rewrite', null],
    ['a pushInsteadOf rule', ['url.git@github.com:.pushInsteadOf', 'https://github.com/']],
    ['an insteadOf rule', ['url.git@github.com:.insteadOf', 'https://github.com/']],
  ])('checks out a submodule under %s', async (_name, rule) => {
    if (rule) git(repository, 'config', ...rule);
    const { creation, settled, clones } = forkSetup();
    const created = await creation.create(repository, forkRequest);
    expect(await settled(created)).toMatchObject({ status: 'ready', error: null });
    expect(childReadme(created)).toBe('child\n');
    expect(clones).toHaveLength(1);
    expect(git(repository, 'config', '--get-all', 'remote.pr-alice.url')).toBe(FORK_URL);
  });

  it('checks out a head that needs no transfer', async () => {
    const { creation, settled, clones } = forkSetup({ submodule: false });
    const created = await creation.create(repository, forkRequest);
    expect(await settled(created)).toMatchObject({ status: 'ready', error: null });
    expect(clones).toEqual([]);
  });

  it.each([
    ['another remote was added', () => git(repository, 'remote', 'add', 'other', 'https://github.com/other/app.git')],
    ['another remote was repointed', () => git(repository, 'remote', 'set-url', 'origin', 'https://github.com/other/app.git')],
    ['the fork remote was repointed', () => git(repository, 'remote', 'set-url', 'pr-alice', 'https://github.com/other/app.git')],
    ['the fork remote got another push URL', () => git(repository, 'remote', 'set-url', '--push', 'pr-alice', 'https://github.com/other/app.git')],
  ])('refuses the transfer when %s after planning', async (_name, change) => {
    const { creation, settled, clones } = forkSetup({ hydrate: change });
    const created = await creation.create(repository, forkRequest);
    expect(await settled(created)).toMatchObject({ status: 'failed', errorCode: 'STALE_BINDING' });
    expect(clones).toEqual([]);
  });

  it('finishes a checkout that needs no transfer even when a remote changed after planning', async () => {
    const changes = [];
    const { creation, settled } = forkSetup({
      submodule: false,
      hydrate: () => {
        changes.push(`other-${changes.length}`);
        git(repository, 'remote', 'add', changes.at(-1), 'https://github.com/other/app.git');
      },
    });
    expect(await settled(await creation.create(repository, forkRequest))).toMatchObject({ status: 'ready' });

    const plain = await creation.create(repository, { mode: 'new', branchName: 'plain', worktreeName: 'plain', startRef: 'HEAD' });
    expect(await settled(plain)).toMatchObject({ status: 'ready' });
    expect(changes).toHaveLength(2);
  });

  it('finishes a checkout whose submodule the create command already filled, whatever changed after planning', async () => {
    let change = () => {};
    const { creation, settled, clones } = forkSetup({ hydrate: () => change() });
    await settled(await creation.create(repository, forkRequest));
    change = () => git(repository, 'remote', 'add', 'other', 'https://github.com/other/app.git');
    const script = path.join(root, 'create.sh');
    fs.writeFileSync(script, `git worktree add "$WORKTREE_PATH" "$WORKTREE_BRANCH" && rmdir "$WORKTREE_PATH/vendor/child" && git clone -q "${child}" "$WORKTREE_PATH/vendor/child"\n`);
    const created = await creation.create(repository, {
      mode: 'new', branchName: 'copied', worktreeName: 'copied', startRef: headSha, createCommand: `sh "${script}"`,
    });
    expect(await settled(created)).toMatchObject({ status: 'ready' });
    expect(clones).toHaveLength(1);
  });

  it.each([
    ['both finish', false],
    ['a remote nobody planned between them still refuses the first', true],
  ])('two first-time forks at once: %s', async (_name, unplanned) => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let first = true;
    const { creation, resolve, source, settled, clones } = forkSetup({ hydrate: async () => {
      if (!first) return;
      first = false;
      await held;
    } });
    const other = {
      ...source, number: 43, headRef: 'refs/heads/other',
      sourceProject: { id: 'Bob/app', owner: 'Bob', name: 'app' }, endpoint: 'https://github.com/Bob/app.git',
    };
    resolve.mockImplementation(async ({ number }) => (number === 43 ? other : source));
    const otherRequest = { ...forkRequest, branchName: 'other', worktreeName: 'other', changeRequestSource: { ...sourceRequest, number: 43 } };
    let created;
    if (unplanned) {
      const alice = await creation.create(repository, forkRequest);
      git(repository, 'remote', 'add', 'evil', 'https://github.com/evil/app.git');
      created = [alice, await creation.create(repository, otherRequest)];
    } else {
      created = await Promise.all([creation.create(repository, forkRequest), creation.create(repository, otherRequest)]);
    }
    release();
    const states = [await settled(created[0]), await settled(created[1])];
    expect(states.map(({ status }) => status)).toEqual(unplanned ? ['failed', 'ready'] : ['ready', 'ready']);
    expect(clones).toHaveLength(unplanned ? 1 : 2);
  });

  it.each([
    ['a fork remote someone else added meanwhile', true],
    ['a fork remote whose addition also changes another remote', false],
  ])('records no step for %s', async (_name, stays) => {
    const base = { name: 'origin' };
    let remotes = [base];
    const read = () => ({ revision: 0, repository: { repositoryId: 'repo_step', configRevision: JSON.stringify(remotes), remotes } });
    const pinned = await createWithPlannedRemote({ directory: '/repo', remote: undefined, serialize: true, readBinding: async () => read(), create: async (value) => value });
    let planning = false;
    await createWithPlannedRemote({
      directory: '/repo', remote: { name: 'pr-x', url: FORK_URL }, serialize: true, create: async () => null,
      readBinding: async (_directory, planned) => {
        if (planned) planning = true;
        remotes = planned || (planning && stays)
          ? [stays ? base : { name: 'origin', fetch: 'rewritten' }, { name: 'pr-x', push: 'elsewhere' }]
          : [base];
        return read();
      },
    });
    const hydrate = vi.fn(async () => { throw Object.assign(new Error('stale'), { code: 'STALE_BINDING' }); });
    await expect(hydrateFollowingPlannedRemotes(pinned, hydrate)).rejects.toThrow('stale');
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it.each([['failed', 2], ['cancelled', 1]])('runs a %s stale hydration %i time(s) along a recorded step', async (status, runs) => {
    const base = [{ name: 'origin' }];
    const readBinding = async (_directory, planned) => {
      const remotes = planned ? [...base, { name: planned.name }] : base;
      return { revision: 0, repository: { repositoryId: `repo_${status}`, configRevision: JSON.stringify(remotes), remotes } };
    };
    const pinned = await createWithPlannedRemote({ directory: '/repo', remote: undefined, serialize: false, readBinding, create: async (value) => value });
    await createWithPlannedRemote({ directory: '/repo', remote: { name: 'pr-x', url: FORK_URL }, serialize: true, readBinding, create: async () => null });
    const result = { status, submodules: [{ path: 'a', status: 'failed', error: { code: 'STALE_BINDING', message: 'stale' } }], lfs: [] };
    const hydrate = vi.fn(async () => result);
    await expect(hydrateFollowingPlannedRemotes(pinned, hydrate)).resolves.toBe(result);
    expect(hydrate).toHaveBeenCalledTimes(runs);
  });

  it('finishes a running transfer when another first-time fork is created in the middle of it', async () => {
    let interrupt = async () => {};
    const { creation, resolve, source, settled } = forkSetup({ onStart: () => interrupt() });
    const other = {
      ...source, number: 43, headRef: 'refs/heads/other',
      sourceProject: { id: 'Bob/app', owner: 'Bob', name: 'app' }, endpoint: 'https://github.com/Bob/app.git',
    };
    resolve.mockImplementation(async ({ number }) => (number === 43 ? other : source));
    let second;
    interrupt = async () => {
      interrupt = async () => {};
      second = await creation.create(repository, {
        ...forkRequest, branchName: 'other', worktreeName: 'other', changeRequestSource: { ...sourceRequest, number: 43 },
      });
    };
    const first = await creation.create(repository, forkRequest);
    expect(await settled(first)).toMatchObject({ status: 'ready', error: null });
    expect(await settled(second)).toMatchObject({ status: 'ready', error: null });
    expect([childReadme(first), childReadme(second)]).toEqual(['child\n', 'child\n']);
  });

  it('resumes the same checkout when setup failed, keeping what is in it', async () => {
    const { creation, settled, clones, provenance, disposeInstance } = forkSetup({ clone: (count) => count > 1 });
    const failed = await creation.create(repository, forkRequest);
    expect(await settled(failed)).toMatchObject({ status: 'failed', errorCode: 'TRANSPORT_FAILED' });
    expect(disposeInstance).not.toHaveBeenCalled();
    fs.writeFileSync(path.join(failed.path, 'README.md'), 'edited\n');

    const [first, second] = (await Promise.allSettled([
      creation.create(repository, forkRequest), creation.create(repository, forkRequest),
    ])).sort((left, right) => left.status.localeCompare(right.status));
    expect(first).toMatchObject({ status: 'fulfilled', value: { path: failed.path, branch: 'feature', provenance: failed.provenance } });
    expect(second).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('already checked out') } });
    expect(await settled(first.value)).toMatchObject({ status: 'ready', error: null });
    expect(childReadme(failed)).toBe('child\n');
    expect(clones).toHaveLength(2);
    expect(disposeInstance).toHaveBeenCalledExactlyOnceWith(failed.path);
    expect(fs.readFileSync(path.join(failed.path, 'README.md'), 'utf8')).toBe('edited\n');
    expect((await provenance.read(failed.path)).revision).toBe(1);

    await expect(creation.create(repository, forkRequest)).rejects.toThrow('already checked out');
  });

  it('leaves a checkout without an index alone', async () => {
    const { creation, settled, bootstrapStore } = forkSetup({ submodule: false });
    const created = await creation.create(repository, forkRequest);
    await settled(created);
    fs.rmSync(path.join(git(created.path, 'rev-parse', '--absolute-git-dir'), 'index'));
    fs.writeFileSync(path.join(created.path, 'README.md'), 'edited\n');
    await bootstrapStore.write(created.path, { status: 'failed', phase: 'directory-created', error: 'failed', errorCode: 'UNKNOWN', updatedAt: Date.now() });
    await expect(creation.create(repository, forkRequest)).rejects.toThrow('already checked out');
    expect(fs.readFileSync(path.join(created.path, 'README.md'), 'utf8')).toBe('edited\n');
  });

  it.each([
    ['runs the setup commands once on resume', 'directory-created', 1, true],
    ['never reruns setup commands after an unknown outcome', 'directory-created', 1, false, 'OUTCOME_UNKNOWN'],
    ['never reruns setup commands that may have run', 'git-ready', 1, false],
    ['leaves a checkout newer than the failure alone', 'directory-created', -60_000, false],
  ])('same-repository head: %s', async (_name, phase, offset, resumes, errorCode = 'UNKNOWN') => {
    const { creation, source, settled, bootstrapStore } = forkSetup({ submodule: false });
    Object.assign(source, { classification: 'same-repository', sourceProject: source.targetProject, endpoint: 'https://github.com/acme/app.git' });
    const marker = path.join(root, 'setup-runs');
    const input = { ...request, startCommand: `echo run >> ${JSON.stringify(marker)}` };
    const created = await creation.create(repository, input);
    expect(await settled(created)).toMatchObject({ status: 'ready' });
    await bootstrapStore.write(created.path, { status: 'failed', phase, error: 'failed', errorCode, updatedAt: Date.now() + offset });
    fs.rmSync(marker);
    if (resumes) expect(await settled(await creation.create(repository, input))).toMatchObject({ status: 'ready' });
    else await expect(creation.create(repository, input)).rejects.toThrow('already checked out');
    expect(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '').toBe(resumes ? 'run\n' : '');
  });

  it('leaves a failed checkout alone for a different change request', async () => {
    const { creation, settled, source } = forkSetup({ clone: () => false });
    await settled(await creation.create(repository, forkRequest));
    source.sourceProject = { id: 'Alice/other', owner: 'Alice', name: 'other' };
    await expect(creation.create(repository, forkRequest)).rejects.toThrow('already checked out');
  });

  it('says on validation that the checkout holding the branch failed its setup', async () => {
    const { creation, settled, bootstrapStore } = forkSetup({ clone: (count) => count > 1 });
    await settled(await creation.create(repository, forkRequest));
    const validate = async () => (await gitLibraries.validateWorktreeCreate(
      repository, { mode: 'new', branchName: 'feature', worktreeName: 'feature' }, { bootstrapStore },
    )).errors.find((entry) => entry.code === 'branch_in_use');
    expect(await validate()).toMatchObject({ setupFailed: true });
    await settled(await creation.create(repository, forkRequest));
    expect((await validate()).setupFailed).toBeUndefined();
  });
});

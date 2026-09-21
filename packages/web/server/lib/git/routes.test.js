import { beforeEach, describe, expect, it, vi } from 'vitest';

const gitLibraries = {
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
  isGitRepository: vi.fn(),
  getStatus: vi.fn(),
  createWorktree: vi.fn(),
  validateWorktreeCreate: vi.fn(),
  getWorktrees: vi.fn(),
  getGlobalIdentity: vi.fn(),
  getCurrentIdentity: vi.fn(),
  getRemoteUrl: vi.fn(),
  getRemotes: vi.fn(),
  getProfiles: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  getProfile: vi.fn(),
  setLocalIdentity: vi.fn(),
  clearLocalIdentity: vi.fn(),
  observeWorktreeTopology: vi.fn(),
  subscribeWorktreeTopologyChanges: vi.fn(),
};

vi.mock('./index.js', () => ({
  stageFiles: gitLibraries.stageFiles,
  unstageFiles: gitLibraries.unstageFiles,
  isGitRepository: gitLibraries.isGitRepository,
  getStatus: gitLibraries.getStatus,
  createWorktree: gitLibraries.createWorktree,
  validateWorktreeCreate: gitLibraries.validateWorktreeCreate,
  getWorktrees: gitLibraries.getWorktrees,
  getGlobalIdentity: gitLibraries.getGlobalIdentity,
  getCurrentIdentity: gitLibraries.getCurrentIdentity,
  getRemoteUrl: gitLibraries.getRemoteUrl,
  getRemotes: gitLibraries.getRemotes,
  getProfiles: gitLibraries.getProfiles,
  createProfile: gitLibraries.createProfile,
  updateProfile: gitLibraries.updateProfile,
  getProfile: gitLibraries.getProfile,
  setLocalIdentity: gitLibraries.setLocalIdentity,
  clearLocalIdentity: gitLibraries.clearLocalIdentity,
  observeWorktreeTopology: gitLibraries.observeWorktreeTopology,
  subscribeWorktreeTopologyChanges: gitLibraries.subscribeWorktreeTopologyChanges,
}));

const { registerGitRoutes } = await import('./routes.js');

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
      put(routePath, handler) {
        routes.set(`PUT ${routePath}`, handler);
      },
      delete(routePath, handler) {
        routes.set(`DELETE ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;

  return {
    status(code) {
      statusCode = code;
      return this;
    },
    set() {
      return this;
    },
    json(payload) {
      body = payload;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

describe('git route renderer DTOs', () => {
  beforeEach(() => {
    gitLibraries.getGlobalIdentity.mockReset();
    gitLibraries.getCurrentIdentity.mockReset();
    gitLibraries.getRemoteUrl.mockReset();
    gitLibraries.getRemotes.mockReset();
    gitLibraries.getProfiles.mockReset();
    gitLibraries.createProfile.mockReset();
    gitLibraries.updateProfile.mockReset();
    gitLibraries.getProfile.mockReset();
    gitLibraries.setLocalIdentity.mockReset();
  });

  it('omits SSH transport configuration from identity summaries', async () => {
    gitLibraries.getGlobalIdentity.mockResolvedValue({
      userName: 'Global Author', userEmail: 'global@example.com', sshCommand: 'ssh -i /private/global-key',
    });
    gitLibraries.getCurrentIdentity.mockResolvedValue({
      userName: 'Local Author', userEmail: 'local@example.com', sshCommand: 'ssh -i /private/local-key',
    });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const globalResponse = createMockResponse();
    const currentResponse = createMockResponse();

    await getRoute('GET', '/api/git/global-identity')({ query: {} }, globalResponse);
    await getRoute('GET', '/api/git/current-identity')({ query: { directory: '/repo' } }, currentResponse);

    expect(globalResponse.body).toEqual({ userName: 'Global Author', userEmail: 'global@example.com' });
    expect(currentResponse.body).toEqual({ userName: 'Local Author', userEmail: 'local@example.com' });
  });

  it('redacts remote credentials, query parameters, and fragments', async () => {
    const rawUrl = 'https://token:password@Example.com/team/repo.git?access=secret#fragment';
    gitLibraries.getRemoteUrl.mockResolvedValue(rawUrl);
    gitLibraries.getRemotes.mockResolvedValue([{ name: 'origin', fetchUrl: rawUrl, pushUrl: rawUrl }]);
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const urlResponse = createMockResponse();
    const remotesResponse = createMockResponse();

    await getRoute('GET', '/api/git/remote-url')({ query: { directory: '/repo' } }, urlResponse);
    await getRoute('GET', '/api/git/remotes')({ query: { directory: '/repo' } }, remotesResponse);

    expect(urlResponse.body).toEqual({ url: 'https://example.com/team/repo.git' });
    expect(remotesResponse.body).toEqual([{
      name: 'origin', fetchUrl: 'https://example.com/team/repo.git', pushUrl: 'https://example.com/team/repo.git',
    }]);
  });

  it('drops malformed URL-like remotes instead of exposing their raw text', async () => {
    gitLibraries.getRemoteUrl.mockResolvedValue('https://token:secret@');
    gitLibraries.getRemotes.mockResolvedValue([{
      name: 'origin', fetchUrl: 'https://token:secret@', pushUrl: 'https://token:secret@',
    }]);
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const urlResponse = createMockResponse();
    const remotesResponse = createMockResponse();

    await getRoute('GET', '/api/git/remote-url')({ query: { directory: '/repo' } }, urlResponse);
    await getRoute('GET', '/api/git/remotes')({ query: { directory: '/repo' } }, remotesResponse);

    expect(urlResponse.body).toEqual({ url: null });
    expect(remotesResponse.body).toEqual([{ name: 'origin', fetchUrl: '', pushUrl: '' }]);
  });

  it('projects stored profiles to the public author DTO', async () => {
    gitLibraries.getProfiles.mockReturnValue([{
      id: 'author-one', name: 'Work', userName: 'Author', userEmail: 'author@example.com',
      authType: 'ssh', sshKey: '/private/key', host: 'legacy.example',
      signCommits: true, signingKey: '/public/signing.pub', color: 'string', icon: 'briefcase',
    }]);
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/identities')({ query: {} }, response);

    expect(response.body).toEqual([{
      id: 'author-one', name: 'Work', userName: 'Author', userEmail: 'author@example.com',
      // The legacy transport fields name no credential this build can resolve,
      // so the identity reads as System Git with no account.
      account: null, transport: 'system',
      signCommits: true, signingKey: '/public/signing.pub', color: 'string', icon: 'briefcase',
    }]);
  });

  it('rejects legacy profile fields before create or update', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const createResponse = createMockResponse();
    const updateResponse = createMockResponse();
    const profile = { id: 'author-one', name: 'Work', userName: 'Author', userEmail: 'author@example.com' };

    await getRoute('POST', '/api/git/identities')({ body: { ...profile, sshKey: '/client/key' } }, createResponse);
    await getRoute('PUT', '/api/git/identities/:id')({
      params: { id: profile.id }, body: { ...profile, authType: 'token', host: 'legacy.example' },
    }, updateResponse);

    expect(createResponse.statusCode).toBe(400);
    expect(updateResponse.statusCode).toBe(400);
    expect(gitLibraries.createProfile).not.toHaveBeenCalled();
    expect(gitLibraries.updateProfile).not.toHaveBeenCalled();
  });

  it('applies the global author by removing the repository own, never copying it in', async () => {
    gitLibraries.getGlobalIdentity.mockResolvedValue({
      userName: 'Global Author', userEmail: 'global@example.com', sshCommand: 'ssh -i /private/global-key',
    });
    gitLibraries.clearLocalIdentity.mockResolvedValue(true);
    gitLibraries.setLocalIdentity.mockResolvedValue(undefined);
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/set-identity')({
      query: { directory: '/repo' }, body: { profileId: 'global' },
    }, response);

    // The global identity is the machine's own setup: System Git, no account.
    const globalProfile = {
      id: 'global', name: 'Global Author', userName: 'Global Author', userEmail: 'global@example.com',
      account: null, transport: 'system',
    };
    // Choosing it means no override applies here, so the repository stops
    // naming an author rather than pinning the machine's current one.
    expect(gitLibraries.clearLocalIdentity).toHaveBeenCalledWith('/repo');
    expect(gitLibraries.setLocalIdentity).not.toHaveBeenCalled();
    expect(response.body).toEqual({ success: true, profile: globalProfile });
  });

  it('applies the global author on a machine that has none of its own', async () => {
    // A fresh install has no user.name anywhere. "No override applies here" is
    // still a true thing to say about a repository, and refusing it left the
    // provider and transport applied with the author half-written.
    gitLibraries.getGlobalIdentity.mockResolvedValue({ userName: null, userEmail: null, sshCommand: null });
    gitLibraries.clearLocalIdentity.mockResolvedValue(true);
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/set-identity')({
      query: { directory: '/repo' }, body: { profileId: 'global' },
    }, response);

    expect(gitLibraries.clearLocalIdentity).toHaveBeenCalledWith('/repo');
    expect(gitLibraries.setLocalIdentity).not.toHaveBeenCalled();
    expect(response.body).toEqual({ success: true, profile: null });
    expect(response.statusCode).toBe(200);
  });

  it('does not pass retained migration fields into author application', async () => {
    gitLibraries.getProfile.mockReturnValue({
      id: 'author-one', name: 'Work', userName: 'Author', userEmail: 'author@example.com',
      authType: 'ssh', sshKey: '/private/key', host: 'legacy.example',
      signCommits: true, signingKey: '/public/signing.pub',
    });
    gitLibraries.setLocalIdentity.mockResolvedValue(undefined);
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/set-identity')({
      query: { directory: '/repo' }, body: { profileId: 'author-one' },
    }, response);

    const publicProfile = {
      id: 'author-one', name: 'Work', userName: 'Author', userEmail: 'author@example.com',
      account: null, transport: 'system',
      signCommits: true, signingKey: '/public/signing.pub',
    };
    expect(gitLibraries.setLocalIdentity).toHaveBeenCalledWith('/repo', publicProfile);
    expect(response.body).toEqual({ success: true, profile: publicProfile });
  });
});

describe('git routes index mutations', () => {
  beforeEach(() => {
    gitLibraries.stageFiles.mockReset();
    gitLibraries.unstageFiles.mockReset();
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getStatus.mockReset();
  });

  it('accepts legacy stage path payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { path: 'a.ts' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.stageFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk stage paths payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { paths: ['a.ts', 'b.ts'] } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.stageFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('accepts legacy unstage path payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/unstage')(
      { query: { directory: '/repo' }, body: { path: 'a.ts' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.unstageFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk unstage paths payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/unstage')(
      { query: { directory: '/repo' }, body: { paths: ['a.ts', 'b.ts'] } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.unstageFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('rejects invalid path payloads before calling git', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { paths: [' ', null] } },
      response,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'path parameter is required' });
    expect(gitLibraries.stageFiles).not.toHaveBeenCalled();
  });
});

describe('contributor worktree authority', () => {
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
    sourceProject: { id: 'alice/app', owner: 'alice', name: 'app' },
    number: 42, headRef: 'refs/heads/feature', headSha: 'a'.repeat(40),
    requestedRemoteName: 'pr-alice', endpoint: 'https://github.com/alice/app.git',
    classification: 'contributor-fork',
  };

  beforeEach(() => {
    gitLibraries.createWorktree.mockReset();
    gitLibraries.validateWorktreeCreate.mockReset();
    gitLibraries.validateWorktreeCreate.mockResolvedValue({ ok: true, errors: [] });
    gitLibraries.createWorktree.mockResolvedValue({ path: '/repo-pr-42' });
  });

  it('uses only a server-resolved endpoint and managed transfer', async () => {
    const resolveChangeRequestSource = vi.fn(async () => resolvedSource);
    const resolvedAccount = {
      credentialId: resolvedSource.context.accountId, credentialRevision: 3,
      providerUserId: 'github.com#42', status: 'valid',
    };
    const resolveSourceControlAccount = vi.fn(async () => resolvedAccount);
    const transferContributorHead = vi.fn(async () => ({ state: 'succeeded' }));
    const createHttpsCredentialReference = vi.fn(() => 'credential_reference');
    const contributorProvenance = { compareAndSwap: vi.fn() };
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, {
      resolveChangeRequestSource, createHttpsCredentialReference,
      resolveSourceControlAccount,
      networkOperations: {
        transferContributorHead,
        hydrateBoundCheckout: vi.fn(async () => ({ status: 'not-needed', submodules: [], lfs: [] })),
      },
      contributorProvenance,
      worktreeBootstrapStore: { read: vi.fn(), write: vi.fn() },
    });
    const response = createMockResponse();

    await getRoute('POST', '/api/git/worktrees')({
      query: { directory: '/repo' },
      body: { mode: 'existing', worktreeName: 'pr-42', branchName: 'feature', changeRequestSource: sourceRequest },
    }, response);

    expect(response.statusCode).toBe(200);
    expect(resolveChangeRequestSource).toHaveBeenCalledWith(sourceRequest);
    expect(resolveSourceControlAccount).toHaveBeenCalledExactlyOnceWith(resolvedSource.context);
    expect(createHttpsCredentialReference).toHaveBeenCalledExactlyOnceWith({
      provider: 'github', instance: 'github.com', credentialId: resolvedSource.context.accountId,
      credentialRevision: 3, providerUserId: 'github.com#42',
    });
    expect(transferContributorHead).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo', sourceRequest, source: resolvedSource,
      credentialId: 'credential_reference', destinationRef: 'refs/remotes/pr-alice/feature',
    }));
    expect(gitLibraries.createWorktree).toHaveBeenCalledWith('/repo', expect.objectContaining({
      contributorFork: true, ensureRemoteName: 'pr-alice',
      ensureRemoteUrl: 'https://github.com/alice/app.git', contributorTransferComplete: true,
    }), expect.objectContaining({ contributorProvenance, contributorSource: resolvedSource }));
  });

  it('passes the exact contributor source to hydration', async () => {
    const hydrateBoundCheckout = vi.fn(async () => ({ status: 'not-needed', submodules: [], lfs: [] }));
    gitLibraries.createWorktree.mockImplementationOnce(async (_directory, _input, options) => {
      await options.hydrateCheckout({ directory: '/repo-pr-42', parentRemoteName: 'pr-alice' });
      return { path: '/repo-pr-42' };
    });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, {
      resolveChangeRequestSource: vi.fn(async () => resolvedSource),
      resolveSourceControlAccount: vi.fn(async () => ({
        credentialId: resolvedSource.context.accountId, credentialRevision: 3,
        providerUserId: 'github.com#42', status: 'valid',
      })),
      createHttpsCredentialReference: vi.fn(() => 'credential_reference'),
      networkOperations: {
        transferContributorHead: vi.fn(async () => ({ state: 'succeeded' })),
        hydrateBoundCheckout,
      },
      contributorProvenance: { compareAndSwap: vi.fn() },
      worktreeBootstrapStore: { read: vi.fn(), write: vi.fn() },
    });
    const response = createMockResponse();

    await getRoute('POST', '/api/git/worktrees')({
      query: { directory: '/repo' },
      body: { mode: 'existing', worktreeName: 'pr-42', branchName: 'feature', changeRequestSource: sourceRequest },
    }, response);

    expect(hydrateBoundCheckout).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo-pr-42', parentRemoteName: 'pr-alice', parentEndpoint: resolvedSource.endpoint,
    }));
  });

  it('does not choose a provider remote when checkout authority is absent', async () => {
    const hydrateBoundCheckout = vi.fn(async () => ({ status: 'authorization-required', submodules: [], lfs: [] }));
    gitLibraries.createWorktree.mockImplementationOnce(async (_directory, _input, options) => {
      await options.hydrateCheckout({ directory: '/repo-local', parentRemoteName: '' });
      return { path: '/repo-local' };
    });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, {
      getSourceControlBinding: vi.fn(async () => ({
        revision: 7,
        repository: { repositoryId: 'repo_one', configRevision: 'config_one' },
        binding: {
          providers: [{ primaryRemote: 'github' }, { primaryRemote: 'gitlab' }],
          remotes: [{ name: 'github' }, { name: 'gitlab' }, { name: 'backup' }],
        },
      })),
      networkOperations: { hydrateBoundCheckout },
      worktreeBootstrapStore: { read: vi.fn(), write: vi.fn() },
    });
    const response = createMockResponse();

    await getRoute('POST', '/api/git/worktrees')({
      query: { directory: '/repo' }, body: { mode: 'new', branchName: 'feature' },
    }, response);

    expect(hydrateBoundCheckout).toHaveBeenCalledWith(expect.objectContaining({ parentRemoteName: '' }));
  });

  it('inspects an unbound local checkout and passes the durable store', async () => {
    const hydrateBoundCheckout = vi.fn(async () => ({ status: 'not-needed', submodules: [], lfs: [] }));
    const worktreeBootstrapStore = { read: vi.fn(), write: vi.fn(), remove: vi.fn() };
    gitLibraries.createWorktree.mockImplementationOnce(async (_directory, _input, options) => {
      expect(options.bootstrapStore).toBe(worktreeBootstrapStore);
      await options.hydrateCheckout({ directory: '/repo-local', parentRemoteName: '' });
      return { path: '/repo-local' };
    });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, {
      getSourceControlBinding: vi.fn(async () => ({
        revision: 0,
        repository: { repositoryId: 'repo_one', configRevision: 'config_one' },
        binding: null,
      })),
      networkOperations: { hydrateBoundCheckout },
      worktreeBootstrapStore,
    });
    const response = createMockResponse();

    await getRoute('POST', '/api/git/worktrees')({
      query: { directory: '/repo' }, body: { mode: 'new', branchName: 'feature' },
    }, response);

    expect(response.statusCode).toBe(200);
    expect(hydrateBoundCheckout).toHaveBeenCalledWith({
      directory: '/repo-local',
      parentRemoteName: '',
      parentEndpoint: undefined,
      repositoryAuthority: null,
    });
  });

  it('rejects client-supplied contributor endpoint and classification', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();
    await getRoute('POST', '/api/git/worktrees')({
      query: { directory: '/repo' },
      body: { contributorFork: true, ensureRemoteUrl: 'https://attacker.example/repository.git' },
    }, response);
    expect(response.statusCode).toBe(400);
    expect(gitLibraries.createWorktree).not.toHaveBeenCalled();
  });
});

describe('worktree provenance listing', () => {
  it('uses one bounded provenance batch and keeps completed records visible', async () => {
    gitLibraries.getWorktrees.mockResolvedValueOnce([
      { path: '/repo-main', branch: 'main' },
      { path: '/repo-contributor', branch: 'feature' },
    ]);
    const readMany = vi.fn(async () => [
      { revision: 0, provenance: null },
      { revision: 3, provenance: { kind: 'contributor-fork' } },
    ]);
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { contributorProvenance: { readMany } });
    const response = createMockResponse();

    await getRoute('GET', '/api/git/worktrees')({ query: { directory: '/repo' } }, response);

    expect(readMany).toHaveBeenCalledOnce();
    expect(readMany).toHaveBeenCalledWith(['/repo-main', '/repo-contributor']);
    expect(response.body).toEqual([
      { path: '/repo-main', branch: 'main' },
      {
        path: '/repo-contributor', branch: 'feature',
        provenance: { kind: 'contributor-fork', revision: 3, trust: 'untrusted', push: 'destination-selection-required' },
      },
    ]);
  });
});

describe('git worktree topology routes', () => {
  beforeEach(() => {
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getStatus.mockReset();
    gitLibraries.getWorktrees.mockReset();
    gitLibraries.observeWorktreeTopology.mockReset();
    gitLibraries.subscribeWorktreeTopologyChanges.mockReset();
    gitLibraries.observeWorktreeTopology.mockResolvedValue(undefined);
  });

  it('observes the repository topology while serving status, never for non-repositories', async () => {
    gitLibraries.isGitRepository.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    gitLibraries.getStatus.mockResolvedValue({ current: 'main' });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const route = getRoute('GET', '/api/git/status');

    const repoResponse = createMockResponse();
    await route({ query: { directory: '/repo' } }, repoResponse);
    expect(repoResponse.body).toEqual({ current: 'main' });
    expect(gitLibraries.observeWorktreeTopology).toHaveBeenCalledWith('/repo');

    await route({ query: { directory: '/plain-folder' } }, createMockResponse());
    expect(gitLibraries.observeWorktreeTopology).toHaveBeenCalledTimes(1);
  });

  it('observes topology after a repository listing and reports listing failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    gitLibraries.getWorktrees
      .mockResolvedValueOnce([{ path: '/repo', branch: 'main' }])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('git failed'));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const route = getRoute('GET', '/api/git/worktrees');

    const listed = createMockResponse();
    await route({ query: { directory: '/repo' } }, listed);
    expect(listed.body).toEqual([{ path: '/repo', branch: 'main' }]);
    expect(gitLibraries.observeWorktreeTopology).toHaveBeenCalledWith('/repo');

    await route({ query: { directory: '/plain-folder' } }, createMockResponse());
    expect(gitLibraries.observeWorktreeTopology).toHaveBeenCalledTimes(1);

    const failed = createMockResponse();
    await route({ query: { directory: '/repo' } }, failed);
    expect(failed.statusCode).toBe(500);
    expect(failed.body).toEqual({ error: 'git failed' });
    errorSpy.mockRestore();
  });

  it('forwards topology changes to the control event emitter once', async () => {
    let listener = null;
    gitLibraries.subscribeWorktreeTopologyChanges.mockImplementation((next) => {
      listener = next;
      return () => undefined;
    });
    gitLibraries.getWorktrees.mockResolvedValue([]);
    const emitWorktreeChanged = vi.fn();
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { emitWorktreeChanged });
    const route = getRoute('GET', '/api/git/worktrees');

    await route({ query: { directory: '/repo' } }, createMockResponse());
    await route({ query: { directory: '/repo' } }, createMockResponse());
    expect(gitLibraries.subscribeWorktreeTopologyChanges).toHaveBeenCalledTimes(1);

    listener({ directories: ['/repo'], at: 123 });
    expect(emitWorktreeChanged).toHaveBeenCalledWith({ directories: ['/repo'], at: 123 });
  });
});

describe('git routes status discovery', () => {
  beforeEach(() => {
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getStatus.mockReset();
  });

  it('returns a soft non-repo payload for non-git folders', async () => {
    gitLibraries.isGitRepository.mockResolvedValue(false);
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/status')(
      { query: { directory: '/tmp/not-a-repo' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      isGitRepository: false,
      files: [],
      branch: null,
      ahead: 0,
      behind: 0,
    });
    expect(gitLibraries.getStatus).not.toHaveBeenCalled();
  });

  it('does not abort when getStatus throws a non-repo GitError', async () => {
    gitLibraries.isGitRepository.mockResolvedValue(true);
    gitLibraries.getStatus.mockRejectedValue(
      Object.assign(new Error('fatal: not a git repository (or any of the parent directories): .git'), {
        task: { commands: ['status'] },
      }),
    );
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/status')(
      { query: { directory: '/opened/project' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ isGitRepository: false });
    expect(gitLibraries.getStatus).toHaveBeenCalledWith('/opened/project', { mode: undefined });
  });

  it('uses the opened project path from query arrays without falling back to cwd', async () => {
    gitLibraries.isGitRepository.mockResolvedValue(true);
    gitLibraries.getStatus.mockResolvedValue({ current: 'main', files: [], isClean: true, ahead: 0, behind: 0 });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/status')(
      { query: { directory: ['/opened/git-project', '/ignored'] } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.isGitRepository).toHaveBeenCalledWith('/opened/git-project');
    expect(gitLibraries.getStatus).toHaveBeenCalledWith('/opened/git-project', { mode: undefined });
    expect(response.body).toMatchObject({ current: 'main' });
  });
});

describe('git network operation routes', () => {
  const snapshot = {
    operationId: 'git_one',
    runtimeIdentity: { id: 'server_one', platform: 'web' },
    transport: { mode: 'system', verification: { status: 'unverified', reason: 'system-credentials' } },
    target: {
      operation: 'clone',
      remote: { displayUrl: 'https://example.com/repository.git', fingerprint: 'remote' },
      destination: { displayName: 'repository', fingerprint: 'destination' },
    },
    completedSteps: [],
    state: 'planned',
  };

  it('registers plan, execute, read, and cancel against one service', async () => {
    const networkOperations = {
      plan: vi.fn(async () => snapshot),
      execute: vi.fn(async () => ({ ...snapshot, state: 'succeeded' })),
      get: vi.fn(() => snapshot),
      cancel: vi.fn(() => ({ ...snapshot, state: 'cancelled', error: { code: 'CANCELLED', message: 'Cancelled' } })),
    };
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { networkOperations });

    const planned = createMockResponse();
    await getRoute('POST', '/api/git/network-operations')({ body: { operation: 'clone' } }, planned);
    expect(planned.statusCode).toBe(201);
    expect(planned.body).toEqual(snapshot);

    const executed = createMockResponse();
    await getRoute('POST', '/api/git/network-operations/:id/execute')({ params: { id: 'git_one' }, body: {} }, executed);
    expect(executed.body.state).toBe('succeeded');

    const read = createMockResponse();
    await getRoute('GET', '/api/git/network-operations/:id')({ params: { id: 'git_one' } }, read);
    expect(read.body).toEqual(snapshot);

    const cancelled = createMockResponse();
    await getRoute('POST', '/api/git/network-operations/:id/cancel')({ params: { id: 'git_one' }, body: {} }, cancelled);
    expect(cancelled.body).toMatchObject({ state: 'cancelled', error: { code: 'CANCELLED' } });
    expect(networkOperations.execute).toHaveBeenCalledWith('git_one');
    expect(networkOperations.cancel).toHaveBeenCalledWith('git_one');
  });

  it('issues exact contributor destination selections through the network service', async () => {
    const selection = { selectionId: 'git_destination_one', provenanceRevision: 2, sourceSha: 'a'.repeat(40), expiresInMs: 900_000 };
    const networkOperations = { issueContributorDestination: vi.fn(async () => selection) };
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { networkOperations });
    const response = createMockResponse();
    const body = { directory: '/repo', destinationRef: 'refs/heads/feature' };
    await getRoute('POST', '/api/git/contributor-destinations')({ body }, response);
    expect(response.statusCode).toBe(201);
    expect(response.body).toEqual(selection);
    expect(networkOperations.issueContributorDestination).toHaveBeenCalledWith(body);
  });

  const contributorListingFixture = () => {
    const contributorFingerprint = 'c'.repeat(43);
    const record = {
      repositoryId: 'repo-one', worktreeId: 'worktree-one', revision: 4,
      provenance: {
        kind: 'contributor-fork', endpointFingerprint: contributorFingerprint,
        provider: 'github', instance: 'github.com', accountId: 'account-one', primaryRemote: 'upstream',
      },
    };
    const remotes = ['contributor', 'upstream', 'mine', 'other', 'system'].map((name) => {
      const endpoint = { displayUrl: `https://example.com/${name}/app.git`,
        fingerprint: name === 'contributor' ? contributorFingerprint : name.repeat(8) };
      return { name, fetch: endpoint, push: endpoint };
    });
    const repository = { repositoryId: 'repo-one', configRevision: 'config-current', bare: false, remotes };
    const binding = {
      state: 'needs-attention', repositoryId: 'repo-one', revision: 7, configRevision: 'config-old', auxiliary: [],
      providers: [
        { provider: 'github', instance: 'github.com', accountId: 'account-one', primaryRemote: 'upstream', repository: { owner: 'team', name: 'app' },
          readiness: 'ready', endpoint: remotes[1].fetch },
        { provider: 'github', instance: 'github.com', accountId: 'account-one', primaryRemote: 'mine', repository: { owner: 'alice', name: 'app' },
          readiness: 'ready', endpoint: remotes[2].fetch },
        { provider: 'gitlab', instance: 'https://gitlab.com', accountId: 'removed', primaryRemote: 'other',
          readiness: 'account-unavailable', endpoint: remotes[3].fetch },
      ],
      remotes: remotes.map((remote) => remote.name === 'system' ? { ...remote, mode: 'system', readiness: 'ready' }
        : { ...remote, mode: 'managed', credentialId: `credential-${remote.name}`, readiness: 'ready' }),
    };
    const read = { repository, revision: 7, binding };
    const getSourceControlBinding = vi.fn(async () => read);
    const resolveSourceControlAccount = vi.fn(async () => ({ user: { login: 'alice' } }));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, {
      contributorProvenance: { read: vi.fn(async () => record) }, getSourceControlBinding, resolveSourceControlAccount,
    });
    const list = async () => {
      const response = createMockResponse();
      await getRoute('GET', '/api/git/contributor-destinations')({ query: { directory: '/repo' } }, response);
      return response;
    };
    return { repository, binding, record, read, resolveSourceControlAccount, list };
  };

  it('lists independently authorized contributor and sibling transports through provider outage without offering System', async () => {
    const fixture = contributorListingFixture();
    const response = await fixture.list();
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ kind: 'contributor', configRevision: 'config-current', bindingRevision: 7, provenanceRevision: 4, candidates: [
      { remote: { name: 'contributor' }, classification: 'contributor-fork' },
      { remote: { name: 'upstream' }, classification: 'bound-repository' },
      { remote: { name: 'mine' }, classification: 'own-fork' },
      { remote: { name: 'other' }, classification: 'other' },
    ] });
    expect(fixture.resolveSourceControlAccount).toHaveBeenCalledTimes(1);
    expect(fixture.resolveSourceControlAccount).toHaveBeenCalledWith(fixture.binding.providers[1]);
    expect(JSON.stringify(response.body)).not.toContain('credential-');
  });

  it.each(['account-unavailable', 'confirmation-required', 'config-changed', 'endpoint-drift'])(
    'does not derive ownership from a provider with %s while retaining independent transport', async (readiness) => {
      const fixture = contributorListingFixture();
      fixture.binding.providers = fixture.binding.providers.map((provider) => readiness === 'endpoint-drift'
        ? { ...provider, readiness: 'ready', endpoint: { ...provider.endpoint, fingerprint: 'old-endpoint' } }
        : { ...provider, readiness });
      const response = await fixture.list();
      expect(response.statusCode).toBe(200);
      expect(response.body.candidates.map((candidate) => candidate.classification)).toEqual(['contributor-fork', 'other', 'other', 'other']);
      expect(fixture.resolveSourceControlAccount).not.toHaveBeenCalled();
    });

  it.each([
    { readiness: 'confirmation-required' }, { readiness: 'config-changed' }, { readiness: undefined },
    { credentialId: undefined }, { fetch: { displayUrl: 'https://example.com/stale', fingerprint: 'stale' } },
    { push: { displayUrl: 'https://example.com/stale', fingerprint: 'stale' } },
  ])('omits a remote without exact ready authority while preserving healthy siblings: %j', async (override) => {
    const fixture = contributorListingFixture();
    fixture.binding.remotes[1] = { ...fixture.binding.remotes[1], ...override };
    const response = await fixture.list();
    expect(response.statusCode).toBe(200);
    expect(response.body.candidates.map((candidate) => candidate.remote.name)).toEqual(['contributor', 'mine', 'other']);
  });

  it('accepts only the contributor fork when it has an independent ready managed grant', async () => {
    const fixture = contributorListingFixture();
    fixture.binding.remotes = [fixture.binding.remotes[0]];
    const response = await fixture.list();
    expect(response.statusCode).toBe(200);
    expect(response.body.candidates).toHaveLength(1);
    expect(response.body.candidates[0]).toMatchObject({ remote: { name: 'contributor' }, classification: 'contributor-fork' });
    expect(fixture.resolveSourceControlAccount).not.toHaveBeenCalled();
  });

  it.each(['missing-binding', 'no-grant', 'system-only', 'unready-only', 'repository-mismatch', 'revision-mismatch'])(
    'fails missing actual contributor destination authority for %s', async (condition) => {
      const fixture = contributorListingFixture();
      if (condition === 'missing-binding') fixture.read.binding = null;
      if (condition === 'no-grant') fixture.binding.remotes = [];
      if (condition === 'system-only') fixture.binding.remotes = [fixture.binding.remotes[4]];
      if (condition === 'unready-only') fixture.binding.remotes = fixture.binding.remotes.map((remote) => ({ ...remote, readiness: 'confirmation-required' }));
      if (condition === 'repository-mismatch') fixture.record.repositoryId = 'different-repository';
      if (condition === 'revision-mismatch') fixture.read.revision += 1;
      const response = await fixture.list();
      expect(response.statusCode).toBe(409);
      expect(response.body.code).toBe('DESTINATION_SELECTION_REQUIRED');
      expect(fixture.resolveSourceControlAccount).not.toHaveBeenCalled();
    });

  it('identifies an ordinary worktree without attempting contributor sync', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, {
      contributorProvenance: { read: vi.fn(async () => ({ revision: 0, provenance: null })) },
      getSourceControlBinding: vi.fn(async () => ({ binding: null })),
    });
    const response = createMockResponse();
    await getRoute('GET', '/api/git/contributor-destinations')({ query: { directory: '/repo' } }, response);
    expect(response.body).toEqual({ kind: 'ordinary' });
  });

  it('rejects malformed IDs and non-empty execute bodies before service access', async () => {
    const networkOperations = { execute: vi.fn(), cancel: vi.fn() };
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { networkOperations });

    const invalidId = createMockResponse();
    await getRoute('POST', '/api/git/network-operations/:id/execute')({ params: { id: '../secret' }, body: {} }, invalidId);
    expect(invalidId.statusCode).toBe(400);

    const invalidBody = createMockResponse();
    await getRoute('POST', '/api/git/network-operations/:id/cancel')({ params: { id: 'git_one' }, body: { retry: true } }, invalidBody);
    expect(invalidBody.statusCode).toBe(400);
    expect(networkOperations.execute).not.toHaveBeenCalled();
    expect(networkOperations.cancel).not.toHaveBeenCalled();
  });

  it('maps missing operations without exposing private error text', async () => {
    const error = Object.assign(new Error('missing https://user:secret@example.com/private.git'), {
      code: 'GIT_NETWORK_OPERATION_NOT_FOUND',
    });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { networkOperations: { get: () => { throw error; } } });
    const response = createMockResponse();
    await getRoute('GET', '/api/git/network-operations/:id')({ params: { id: 'git_missing' } }, response);
    expect(response.statusCode).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('awaits persistence-backed operation reads', async () => {
    const operation = { operationId: 'git_restart', state: 'outcome-unknown' };
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { networkOperations: { get: vi.fn(async () => operation) } });
    const response = createMockResponse();

    await getRoute('GET', '/api/git/network-operations/:id')({ params: { id: 'git_restart' } }, response);

    expect(response.body).toEqual(operation);
  });

  it('preserves a planning timeout code', async () => {
    const error = Object.assign(new Error('Git network operation timed out'), { code: 'TIMEOUT', status: 408 });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { networkOperations: { plan: vi.fn(async () => { throw error; }) } });
    const response = createMockResponse();

    await getRoute('POST', '/api/git/network-operations')({ body: { operation: 'fetch' } }, response);

    expect(response.statusCode).toBe(408);
    expect(response.body).toEqual({ error: 'Git network operation timed out', code: 'TIMEOUT' });
  });

  it('maps system push acknowledgement requirements to the stable public code', async () => {
    const error = Object.assign(new Error('System Git transport acknowledgement is required'), {
      code: 'ACKNOWLEDGEMENT_REQUIRED', status: 409,
    });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { networkOperations: { plan: vi.fn(async () => { throw error; }) } });
    const response = createMockResponse();
    await getRoute('POST', '/api/git/network-operations')({ body: { operation: 'push' } }, response);
    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: 'System Git transport acknowledgement is required', code: 'ACKNOWLEDGEMENT_REQUIRED',
    });
  });

  it('does not expose native planning paths in responses or logs', async () => {
    const canary = '/private/openchamber-store/git-system-push-acknowledgements.json';
    const error = Object.assign(new Error(`ENOENT: no such file or directory, open '${canary}'`), { code: 'ENOENT' });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, {
      networkOperations: { plan: vi.fn(async () => { throw error; }) },
      errorRedactionSecrets: ['/private/openchamber-store'],
    });
    const response = createMockResponse();
    await getRoute('POST', '/api/git/network-operations')({ body: { operation: 'fetch' } }, response);
    expect(response.body).toEqual({ error: 'Git network operation request failed', code: 'UNKNOWN' });
    expect(JSON.stringify(response.body)).not.toContain(canary);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(canary);
    logged.mockRestore();
  });
});

describe('legacy git network route binding gate', () => {
  it.each([
    ['POST', '/api/git/pull'],
    ['POST', '/api/git/push'],
    ['POST', '/api/git/fetch'],
    ['DELETE', '/api/git/remote-branches'],
  ])('rejects legacy %s before Git execution', async (method, routePath) => {
    const getSourceControlBinding = vi.fn(async () => ({ revision: 3, binding: { state: 'bound' } }));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { getSourceControlBinding });
    const response = createMockResponse();

    await getRoute(method, routePath)({ query: { directory: '/repo' }, body: {} }, response);

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: 'Git network operations require the planned operation API',
      code: 'GIT_NETWORK_OPERATION_REQUIRED',
    });
  });

  it('rejects contributor push before binding lookup or legacy Git execution', async () => {
    const getSourceControlBinding = vi.fn();
    const contributorProvenance = {
      read: vi.fn(async () => ({ provenance: { kind: 'contributor-fork' }, revision: 2 })),
    };
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { getSourceControlBinding, contributorProvenance });
    const response = createMockResponse();
    await getRoute('POST', '/api/git/push')({ query: { directory: '/repo' }, body: {} }, response);
    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: 'Contributor worktrees require an exact managed destination selection',
      code: 'DESTINATION_SELECTION_REQUIRED',
    });
    expect(getSourceControlBinding).not.toHaveBeenCalled();
  });

  it('rejects remote branch deletion without reading binding state', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, {
      getSourceControlBinding: vi.fn(async () => ({ revision: 4, binding: { state: 'needs-attention' } })),
    });
    const response = createMockResponse();

    await getRoute('DELETE', '/api/git/remote-branches')({
      query: { directory: '/repo' }, body: { remote: 'origin', branch: 'feature' },
    }, response);

    expect(response.statusCode).toBe(409);
  });

  it.each([
    ['POST', '/api/git/pull'],
    ['POST', '/api/git/push'],
    ['POST', '/api/git/fetch'],
    ['DELETE', '/api/git/remote-branches'],
  ])('does not restore legacy %s execution for a binding tombstone', async (method, routePath) => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { getSourceControlBinding: vi.fn(async () => ({ revision: 7, binding: null })) });
    const response = createMockResponse();
    const body = routePath.endsWith('remote-branches')
      ? { remote: 'origin', branch: 'feature' }
      : { remote: 'origin' };

    await getRoute(method, routePath)({ query: { directory: '/repo' }, body }, response);

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: 'Git network operations require the planned operation API',
      code: 'GIT_NETWORK_OPERATION_REQUIRED',
    });
  });
});

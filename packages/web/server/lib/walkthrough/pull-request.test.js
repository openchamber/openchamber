import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getPullRequestDiff, getPullRequestFileContents } = await import('./pull-request.js');

const PATCH = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
+const added = true;
`;

describe('getPullRequestDiff', () => {
  let request;
  let getOctokitForAccountId;
  let resolveGitHubRepoFromDirectory;
  let onAccountUnavailable;
  let resolveRepoNetwork;
  const readContext = {
    provider: 'github',
    instance: 'github.com',
    accountId: 'github.com#7',
    repositoryId: 'repo-1',
    bindingRevision: 4,
    directory: '/repo',
    primaryRemote: 'upstream',
  };

  const read = (overrides = {}) => getPullRequestDiff('/repo', 2122, readContext, {
    getOctokitForAccountId,
    resolveGitHubRepoFromDirectory,
    resolveRepoNetwork,
    onAccountUnavailable,
    ...overrides,
  });

  beforeEach(() => {
    request = vi.fn().mockResolvedValue({ data: PATCH });
    getOctokitForAccountId = vi.fn().mockResolvedValue({ octokit: { request } });
    onAccountUnavailable = vi.fn();
    // The bound repository is a fork of `upstream/project`: the same network the
    // bound pull request list reads.
    resolveRepoNetwork = vi.fn().mockResolvedValue([
      { owner: 'openchamber', repo: 'openchamber', source: 'origin' },
      { owner: 'upstream', repo: 'project', source: 'upstream' },
    ]);
    // The resolver hands back a wrapper, not the repo. Reading `.owner` off the
    // wrapper made every repository look remote-less, which is what this suite
    // exists to prevent.
    resolveGitHubRepoFromDirectory = vi.fn().mockResolvedValue({
      repo: { owner: 'openchamber', repo: 'openchamber' },
      remoteUrl: 'git@github.com:openchamber/openchamber.git',
    });
  });

  it('requests the diff for the resolved repository', async () => {
    const result = await read();

    expect(result.patch).toBe(PATCH);
    expect(result.meta).toEqual({ owner: 'openchamber', repo: 'openchamber', number: 2122 });
    expect(request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: 'openchamber',
      repo: 'openchamber',
      pull_number: 2122,
      headers: { accept: 'application/vnd.github.v3.diff' },
    });
    expect(getOctokitForAccountId).toHaveBeenCalledWith(readContext.accountId, expect.any(Object));
    expect(resolveGitHubRepoFromDirectory).toHaveBeenCalledWith('/repo', 'upstream');
  });

  it('reports a missing GitHub remote only when there really is none', async () => {
    resolveGitHubRepoFromDirectory.mockResolvedValue({ repo: null, remoteUrl: null });

    await expect(read()).rejects.toMatchObject({
      code: 'no-github-remote',
      statusCode: 400,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('reads a named source repository when it is the bound one, without resolving the network', async () => {
    const result = await read({ sourceRepo: { owner: 'OpenChamber', repo: 'OpenChamber' } });

    expect(result.meta).toEqual({ owner: 'openchamber', repo: 'openchamber', number: 2122 });
    expect(request).toHaveBeenCalledOnce();
    expect(resolveRepoNetwork).not.toHaveBeenCalled();
  });

  it('reads an upstream pull request the bound repository was forked from', async () => {
    const result = await read({ sourceRepo: { owner: 'upstream', repo: 'project' } });

    expect(result.meta).toEqual({ owner: 'upstream', repo: 'project', number: 2122 });
    expect(resolveRepoNetwork).toHaveBeenCalledWith(expect.anything(), '/repo', 'upstream', { strictErrors: true });
    expect(request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/pulls/{pull_number}', expect.objectContaining({
      owner: 'upstream', repo: 'project', pull_number: 2122,
    }));
  });

  // The bound pull request list reads the repository and its upstream with this
  // account. The diff keeps that boundary: a name outside it would reach a
  // repository the binding never covered, and the same number there is a
  // different pull request.
  it('refuses a named repository outside the bound repository network', async () => {
    await expect(read({ sourceRepo: { owner: 'stranger', repo: 'elsewhere' } })).rejects.toMatchObject({
      code: 'PULL_REQUEST_REPOSITORY_MISMATCH',
      statusCode: 409,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('allows an empty comparison but rejects malformed GitHub bodies', async () => {
    request.mockResolvedValue({ data: '' });
    expect((await read({ allowEmpty: true })).patch).toBe('');
    request.mockResolvedValue({ data: { message: 'Not a diff' } });
    await expect(read()).rejects.toThrow();
  });

  it('requires the exact bound account before repository resolution', async () => {
    getOctokitForAccountId.mockResolvedValue(null);

    await expect(read()).rejects.toMatchObject({
      code: 'github-not-connected',
      statusCode: 401,
    });
    expect(resolveGitHubRepoFromDirectory).not.toHaveBeenCalled();
  });

  it('treats an empty diff as a missing pull request rather than an empty review', async () => {
    request.mockResolvedValue({ data: '   ' });

    await expect(read()).rejects.toMatchObject({
      code: 'empty-diff',
      statusCode: 404,
    });
  });

  it('reconciles only an exact-account 401', async () => {
    getOctokitForAccountId.mockImplementation(async (_accountId, options) => {
      await options.onUnauthorized({ provider: 'github', instance: 'github.com', accountId: readContext.accountId }, false);
      throw Object.assign(new Error('bad credentials'), { status: 401 });
    });

    await expect(read()).rejects.toMatchObject({ status: 401 });
    expect(onAccountUnavailable).toHaveBeenCalledWith({
      provider: 'github', instance: 'github.com', accountId: readContext.accountId,
    });
  });

  it.each([403, undefined])('does not reconcile a %s provider failure', async (status) => {
    request.mockRejectedValue(Object.assign(new Error('provider failed'), status ? { status } : {}));

    await expect(read()).rejects.toThrow('provider failed');
    expect(onAccountUnavailable).not.toHaveBeenCalled();
  });
});

describe('getPullRequestFileContents', () => {
  const HEAD = 'a'.repeat(40);
  const BASE_TIP = 'b'.repeat(40);
  const MERGE_BASE = 'c'.repeat(40);
  const readContext = {
    provider: 'github',
    instance: 'github.com',
    accountId: 'github.com#7',
    repositoryId: 'repo-1',
    bindingRevision: 4,
    directory: '/repo',
    primaryRemote: 'origin',
  };
  let request;
  let dependencies;

  // The bound repository is a fork of `upstream/project`; the named file's
  // repository has to be inside that network.
  const read = (sourceRepo, file) => getPullRequestFileContents('/repo', 7, readContext, {
    ...file,
    sourceRepo,
    ...dependencies,
  });

  beforeEach(() => {
    request = vi.fn(async (route, params) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: { head: { sha: HEAD }, base: { sha: BASE_TIP } } };
      if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') return { data: { merge_base_commit: { sha: MERGE_BASE } } };
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}') return { data: `${params.path}@${params.ref}` };
      throw new Error(`unexpected ${route}`);
    });
    dependencies = {
      getOctokitForAccountId: vi.fn().mockResolvedValue({ octokit: { request } }),
      resolveGitHubRepoFromDirectory: vi.fn().mockResolvedValue({ repo: { owner: 'o', repo: 'r' }, remoteUrl: null }),
      resolveRepoNetwork: vi.fn().mockResolvedValue([
        { owner: 'o', repo: 'r', source: 'origin' },
        { owner: 'upstream', repo: 'project', source: 'upstream' },
      ]),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reads the base side at the merge base and the head side at the PR head', async () => {
    const result = await read({ owner: 'upstream', repo: 'project' }, { path: 'src/a.ts', status: 'M' });
    expect(result).toEqual({ original: `src/a.ts@${MERGE_BASE}`, modified: `src/a.ts@${HEAD}` });
    expect(request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/compare/{basehead}', {
      owner: 'upstream', repo: 'project', basehead: `${BASE_TIP}...${HEAD}`,
    });
    expect(request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/contents/{path}', expect.objectContaining({
      owner: 'upstream', repo: 'project', headers: { accept: 'application/vnd.github.raw+json' },
    }));
  });

  it('skips the missing side of added and deleted files and follows renames', async () => {
    expect(await read({ owner: 'o', repo: 'r' }, { path: 'new.ts', status: 'A' }))
      .toEqual({ original: '', modified: `new.ts@${HEAD}` });
    expect(await read({ owner: 'o', repo: 'r' }, { path: 'gone.ts', status: 'D' }))
      .toEqual({ original: `gone.ts@${MERGE_BASE}`, modified: '' });
    expect(await read({ owner: 'o', repo: 'r' }, { path: 'new.ts', previousPath: 'old.ts', status: 'R' }))
      .toEqual({ original: `old.ts@${MERGE_BASE}`, modified: `new.ts@${HEAD}` });
  });

  it('rejects oversized files and malformed GitHub metadata', async () => {
    request.mockImplementationOnce(async () => ({ data: { head: { sha: 'nope' }, base: { sha: BASE_TIP } } }));
    await expect(read({ owner: 'o', repo: 'r' }, { path: 'a.ts', status: 'M' })).rejects.toThrow(/invalid pull request head/);

    request.mockImplementation(async (route) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: { head: { sha: HEAD }, base: { sha: BASE_TIP } } };
      if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') return { data: { merge_base_commit: { sha: MERGE_BASE } } };
      return { data: 'x'.repeat(5 * 1024 * 1024 + 1) };
    });
    await expect(read({ owner: 'o', repo: 'r' }, { path: 'a.ts', status: 'M' })).rejects.toMatchObject({ code: 'file-too-large', statusCode: 413 });
  });
});

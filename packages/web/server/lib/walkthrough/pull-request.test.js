import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getPullRequestDiff } = await import('./pull-request.js');

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

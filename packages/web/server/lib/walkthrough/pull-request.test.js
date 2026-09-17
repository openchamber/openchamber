import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../github/octokit.js', () => ({ getOctokitOrNull: vi.fn() }));
vi.mock('../github/repo/index.js', () => ({ resolveGitHubRepoFromDirectory: vi.fn() }));

const { getPullRequestDiff } = await import('./pull-request.js');
const { getOctokitOrNull } = await import('../github/octokit.js');
const { resolveGitHubRepoFromDirectory } = await import('../github/repo/index.js');

const PATCH = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
+const added = true;
`;

describe('getPullRequestDiff', () => {
  let request;

  beforeEach(() => {
    request = vi.fn().mockResolvedValue({ data: PATCH });
    getOctokitOrNull.mockReturnValue({ request });
    // The resolver hands back a wrapper, not the repo. Reading `.owner` off the
    // wrapper made every repository look remote-less, which is what this suite
    // exists to prevent.
    resolveGitHubRepoFromDirectory.mockResolvedValue({
      repo: { owner: 'openchamber', repo: 'openchamber', host: 'github.com' },
      remoteUrl: 'git@github.com:openchamber/openchamber.git',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requests the diff for the resolved repository', async () => {
    const result = await getPullRequestDiff('/repo', 2122);

    expect(result.patch).toBe(PATCH);
    expect(result.meta).toEqual({ owner: 'openchamber', repo: 'openchamber', number: 2122 });
    expect(getOctokitOrNull).toHaveBeenCalledWith('github.com');
    expect(request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: 'openchamber',
      repo: 'openchamber',
      pull_number: 2122,
      headers: { accept: 'application/vnd.github.v3.diff' },
    });
  });

  it('reports a missing GitHub remote only when there really is none', async () => {
    resolveGitHubRepoFromDirectory.mockResolvedValue({ repo: null, remoteUrl: null });

    await expect(getPullRequestDiff('/repo', 2122)).rejects.toMatchObject({
      code: 'no-github-remote',
      statusCode: 400,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('uses the selected upstream repository rather than the local fork', async () => {
    const result = await getPullRequestDiff('/repo', 42, { owner: 'upstream', repo: 'project' });
    expect(result.meta).toEqual({ owner: 'upstream', repo: 'project', number: 42 });
    // The directory is still resolved: its host selects the token even when the
    // pull request lives on the upstream repo.
    expect(resolveGitHubRepoFromDirectory).toHaveBeenCalledWith('/repo');
    expect(getOctokitOrNull).toHaveBeenCalledWith('github.com');
    expect(request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: 'upstream', repo: 'project', pull_number: 42, headers: { accept: 'application/vnd.github.v3.diff' },
    });
  });

  it('targets the enterprise host of the checkout, not github.com', async () => {
    resolveGitHubRepoFromDirectory.mockResolvedValue({
      repo: { owner: 'octocat', repo: 'hello', host: 'github.example.com' },
      remoteUrl: 'git@github.example.com:octocat/hello.git',
    });

    const result = await getPullRequestDiff('/repo', 80, { owner: 'octocat', repo: 'hello' });

    expect(getOctokitOrNull).toHaveBeenCalledWith('github.example.com');
    expect(result.meta).toEqual({ owner: 'octocat', repo: 'hello', number: 80 });
  });

  it('allows an empty comparison but rejects malformed GitHub bodies', async () => {
    request.mockResolvedValue({ data: '' });
    expect((await getPullRequestDiff('/repo', 42, undefined, { allowEmpty: true })).patch).toBe('');
    request.mockResolvedValue({ data: { message: 'Not a diff' } });
    await expect(getPullRequestDiff('/repo', 42)).rejects.toThrow();
  });

  it('asks the user to connect GitHub before anything else', async () => {
    getOctokitOrNull.mockReturnValue(null);

    await expect(getPullRequestDiff('/repo', 2122)).rejects.toMatchObject({
      code: 'github-not-connected',
      statusCode: 401,
    });
    // The host is read from the checkout before the connection check, because
    // the token to verify depends on that host.
    expect(resolveGitHubRepoFromDirectory).toHaveBeenCalled();
  });

  it('treats an empty diff as a missing pull request rather than an empty review', async () => {
    request.mockResolvedValue({ data: '   ' });

    await expect(getPullRequestDiff('/repo', 2122)).rejects.toMatchObject({
      code: 'empty-diff',
      statusCode: 404,
    });
  });
});

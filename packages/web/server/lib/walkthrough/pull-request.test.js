import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../github/octokit.js', () => ({ getOctokitOrNull: vi.fn() }));
vi.mock('../github/repo/index.js', () => ({ resolveGitHubRepoFromDirectory: vi.fn() }));
vi.mock('../gitlab/client.js', () => ({
  getGitLabClientOrNull: vi.fn(),
  createGitLabClient: vi.fn(),
}));
vi.mock('../gitlab/auth.js', () => ({
  getGitLabAuth: vi.fn(),
  getGitLabDefaultBaseUrl: vi.fn(() => 'https://gitlab.com'),
}));
vi.mock('../git-providers/project-config.js', () => ({
  getEffectiveProviderApiBaseUrl: vi.fn(() => null),
}));
vi.mock('../gitlab/repo.js', () => ({ resolveGitLabRepoFromDirectory: vi.fn() }));

const { getPullRequestDiff } = await import('./pull-request.js');
const { getOctokitOrNull } = await import('../github/octokit.js');
const { resolveGitHubRepoFromDirectory } = await import('../github/repo/index.js');
const { getGitLabClientOrNull, createGitLabClient } = await import('../gitlab/client.js');
const { getGitLabAuth } = await import('../gitlab/auth.js');
const { getEffectiveProviderApiBaseUrl } = await import('../git-providers/project-config.js');
const { resolveGitLabRepoFromDirectory } = await import('../gitlab/repo.js');

const PATCH = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
+const added = true;
`;

const GITLAB_DIFF_ONE = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,2 @@
+hello
`;

const GITLAB_DIFF_TWO = `diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1 +1,2 @@
+world
`;

const GITLAB_REPO = {
  namespace: 'acme',
  project: 'widgets',
  host: 'gitlab.com',
  baseUrl: 'https://gitlab.com',
  url: 'https://gitlab.com/acme/widgets',
};

describe('getPullRequestDiff', () => {
  let request;

  beforeEach(() => {
    request = vi.fn().mockResolvedValue({ data: PATCH });
    getOctokitOrNull.mockReturnValue({ request });
    // The resolver hands back a wrapper, not the repo. Reading `.owner` off the
    // wrapper made every repository look remote-less, which is what this suite
    // exists to prevent.
    resolveGitHubRepoFromDirectory.mockResolvedValue({
      repo: { owner: 'openchamber', repo: 'openchamber' },
      remoteUrl: 'git@github.com:openchamber/openchamber.git',
    });
    // Default to a non-GitLab directory so the GitHub cases keep routing to
    // the GitHub path.
    resolveGitLabRepoFromDirectory.mockResolvedValue({ repo: null, remoteUrl: null });
    getGitLabClientOrNull.mockReturnValue(null);
    getGitLabAuth.mockReturnValue({ accessToken: 'test-token' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requests the diff for the resolved repository', async () => {
    const result = await getPullRequestDiff('/repo', 2122);

    expect(result.patch).toBe(PATCH);
    expect(result.meta).toEqual({ owner: 'openchamber', repo: 'openchamber', number: 2122 });
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

  it('asks the user to connect GitHub before anything else', async () => {
    getOctokitOrNull.mockReturnValue(null);

    await expect(getPullRequestDiff('/repo', 2122)).rejects.toMatchObject({
      code: 'github-not-connected',
      statusCode: 401,
    });
    expect(resolveGitHubRepoFromDirectory).not.toHaveBeenCalled();
  });

  it('treats an empty diff as a missing pull request rather than an empty review', async () => {
    request.mockResolvedValue({ data: '   ' });

    await expect(getPullRequestDiff('/repo', 2122)).rejects.toMatchObject({
      code: 'empty-diff',
      statusCode: 404,
    });
  });

  describe('with a GitLab repository', () => {
    let mergeRequestDiffs;

    beforeEach(() => {
      mergeRequestDiffs = vi.fn().mockResolvedValue({
        status: 200,
        data: [{ diff: GITLAB_DIFF_ONE }],
        page: { page: 1, next: null, total: 1, hasMore: false },
      });
      getGitLabClientOrNull.mockReturnValue({ mergeRequestDiffs });
      resolveGitLabRepoFromDirectory.mockResolvedValue({
        repo: GITLAB_REPO,
        remoteUrl: 'git@gitlab.com:acme/widgets.git',
      });
    });

    it('concatenates merge request diffs across pages into a single patch', async () => {
      mergeRequestDiffs
        .mockResolvedValueOnce({
          status: 200,
          data: [{ diff: GITLAB_DIFF_ONE }],
          page: { page: 1, next: 2, total: 2, hasMore: true },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: [{ diff: GITLAB_DIFF_TWO }],
          page: { page: 2, next: null, total: 2, hasMore: false },
        });

      const result = await getPullRequestDiff('/repo', 7);

      expect(result.patch).toBe(`${GITLAB_DIFF_ONE}\n${GITLAB_DIFF_TWO}`);
      expect(result.meta).toEqual({ namespace: 'acme', project: 'widgets', number: 7 });
      // The unencoded namespace/project path is passed to the client, which
      // URL-encodes it internally.
      expect(mergeRequestDiffs).toHaveBeenCalledTimes(2);
      expect(mergeRequestDiffs).toHaveBeenNthCalledWith(1, 'acme/widgets', 7, { per_page: 100, page: 1 });
      expect(mergeRequestDiffs).toHaveBeenNthCalledWith(2, 'acme/widgets', 7, { per_page: 100, page: 2 });
    });

    it('asks the user to connect GitLab before fetching diffs', async () => {
      getGitLabAuth.mockReturnValue(null);
      getGitLabClientOrNull.mockReturnValue(null);

      await expect(getPullRequestDiff('/repo', 7)).rejects.toMatchObject({
        code: 'gitlab-not-connected',
        statusCode: 401,
      });
      expect(mergeRequestDiffs).not.toHaveBeenCalled();
    });

    it('treats an MR with no diff as missing rather than an empty review', async () => {
      mergeRequestDiffs.mockResolvedValue({
        status: 200,
        data: [{ diff: '   ' }],
        page: { page: 1, next: null, total: 1, hasMore: false },
      });

      await expect(getPullRequestDiff('/repo', 7)).rejects.toMatchObject({
        code: 'empty-diff',
        statusCode: 404,
      });
    });

    it('reports a GitLab repo without namespace or project as having no remote', async () => {
      resolveGitLabRepoFromDirectory.mockResolvedValue({
        repo: { namespace: '', project: '' },
        remoteUrl: 'git@gitlab.com:acme/widgets.git',
      });

      await expect(getPullRequestDiff('/repo', 7)).rejects.toMatchObject({
        code: 'no-gitlab-remote',
        statusCode: 400,
      });
      expect(mergeRequestDiffs).not.toHaveBeenCalled();
    });
  });
});

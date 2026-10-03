import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../github/octokit.js', () => ({ getOctokitOrNull: vi.fn() }));
vi.mock('../github/repo/index.js', () => ({ resolveGitHubRepoFromDirectory: vi.fn() }));

const { getPullRequestDiff, getPullRequestFileContents } = await import('./pull-request.js');
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
      repo: { owner: 'openchamber', repo: 'openchamber' },
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
    expect(resolveGitHubRepoFromDirectory).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: 'upstream', repo: 'project', pull_number: 42, headers: { accept: 'application/vnd.github.v3.diff' },
    });
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
    expect(resolveGitHubRepoFromDirectory).not.toHaveBeenCalled();
  });

  it('treats an empty diff as a missing pull request rather than an empty review', async () => {
    request.mockResolvedValue({ data: '   ' });

    await expect(getPullRequestDiff('/repo', 2122)).rejects.toMatchObject({
      code: 'empty-diff',
      statusCode: 404,
    });
  });
});

describe('getPullRequestFileContents', () => {
  const HEAD = 'a'.repeat(40);
  const BASE_TIP = 'b'.repeat(40);
  const MERGE_BASE = 'c'.repeat(40);
  let request;

  beforeEach(() => {
    request = vi.fn(async (route, params) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: { head: { sha: HEAD }, base: { sha: BASE_TIP } } };
      if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') return { data: { merge_base_commit: { sha: MERGE_BASE } } };
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}') return { data: `${params.path}@${params.ref}` };
      throw new Error(`unexpected ${route}`);
    });
    getOctokitOrNull.mockReturnValue({ request });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reads the base side at the merge base and the head side at the PR head', async () => {
    const result = await getPullRequestFileContents('/repo', 7, { owner: 'upstream', repo: 'project' }, { path: 'src/a.ts', status: 'M' });
    expect(result).toEqual({ original: `src/a.ts@${MERGE_BASE}`, modified: `src/a.ts@${HEAD}` });
    expect(request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/compare/{basehead}', {
      owner: 'upstream', repo: 'project', basehead: `${BASE_TIP}...${HEAD}`,
    });
    expect(request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/contents/{path}', expect.objectContaining({
      owner: 'upstream', repo: 'project', headers: { accept: 'application/vnd.github.raw+json' },
    }));
  });

  it('skips the missing side of added and deleted files and follows renames', async () => {
    expect(await getPullRequestFileContents('/repo', 7, { owner: 'o', repo: 'r' }, { path: 'new.ts', status: 'A' }))
      .toEqual({ original: '', modified: `new.ts@${HEAD}` });
    expect(await getPullRequestFileContents('/repo', 7, { owner: 'o', repo: 'r' }, { path: 'gone.ts', status: 'D' }))
      .toEqual({ original: `gone.ts@${MERGE_BASE}`, modified: '' });
    expect(await getPullRequestFileContents('/repo', 7, { owner: 'o', repo: 'r' }, { path: 'new.ts', previousPath: 'old.ts', status: 'R' }))
      .toEqual({ original: `old.ts@${MERGE_BASE}`, modified: `new.ts@${HEAD}` });
  });

  it('rejects oversized files and malformed GitHub metadata', async () => {
    request.mockImplementationOnce(async () => ({ data: { head: { sha: 'nope' }, base: { sha: BASE_TIP } } }));
    await expect(getPullRequestFileContents('/repo', 7, { owner: 'o', repo: 'r' }, { path: 'a.ts', status: 'M' })).rejects.toThrow(/invalid pull request head/);

    request.mockImplementation(async (route) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: { head: { sha: HEAD }, base: { sha: BASE_TIP } } };
      if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') return { data: { merge_base_commit: { sha: MERGE_BASE } } };
      return { data: 'x'.repeat(5 * 1024 * 1024 + 1) };
    });
    await expect(getPullRequestFileContents('/repo', 7, { owner: 'o', repo: 'r' }, { path: 'a.ts', status: 'M' })).rejects.toMatchObject({ code: 'file-too-large', statusCode: 413 });
  });
});

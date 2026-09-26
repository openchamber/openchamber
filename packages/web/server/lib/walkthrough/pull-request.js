import { getOctokitOrNull } from '../github/octokit.js';
import assert from 'node:assert/strict';
import { resolveGitHubRepoFromDirectory } from '../github/repo/index.js';

const MAX_FULL_FILE_BYTES = 5 * 1024 * 1024;

const resolvePullRequestRepo = async (
  directory,
  sourceRepo,
  { getOctokit, resolveRepo, signal },
) => {
  const octokit = getOctokit();
  if (!octokit) {
    throw Object.assign(new Error('Connect a GitHub account to review pull requests'), {
      statusCode: 401,
      code: 'github-not-connected',
    });
  }

  // The resolver returns `{ repo, remoteUrl }`, not the repo itself. Reading
  // `.owner` off the wrapper made this check fail for every repository.
  if (signal?.aborted) {
    throw signal.reason || new Error('Pull request diff request was cancelled');
  }

  const resolved = sourceRepo
    ? { repo: sourceRepo }
    : await resolveRepo(directory, 'origin', { signal });
  const { repo } = resolved;
  if (!repo?.owner || !repo?.repo) {
    throw Object.assign(new Error('This directory has no GitHub remote'), {
      statusCode: 400,
      code: 'no-github-remote',
    });
  }
  return { octokit, repo };
};

/**
 * Raw unified diff for a pull request.
 *
 * GitHub already returns the merge-base diff for a PR, so this matches the
 * three-dot semantics used for local branch reviews: work merged in from the
 * base branch is not part of it.
 */
export const createPullRequestDiff = ({
  getOctokit = getOctokitOrNull,
  resolveRepo = resolveGitHubRepoFromDirectory,
} = {}) => async (
  directory,
  number,
  sourceRepo,
  { allowEmpty = false, signal = undefined } = {},
) => {
  const { octokit, repo } = await resolvePullRequestRepo(directory, sourceRepo, {
    getOctokit,
    resolveRepo,
    signal,
  });

  const requestOptions = {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: number,
    headers: { accept: 'application/vnd.github.v3.diff' },
  };
  if (signal) requestOptions.signal = signal;
  const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', requestOptions);

  if (signal?.aborted) {
    throw signal.reason || new Error('Pull request diff request was cancelled');
  }

  assert.match(response.data, /^(?:diff --git |\s*$)/, 'GitHub returned an invalid pull request diff');
  const patch = response.data;
  if (!allowEmpty && !patch.trim()) {
    throw Object.assign(new Error(`Pull request #${number} has no diff`), {
      statusCode: 404,
      code: 'empty-diff',
    });
  }

  return { patch, meta: { owner: repo.owner, repo: repo.repo, number } };
};

export const getPullRequestDiff = createPullRequestDiff();

/**
 * Both sides of one file as GitHub has them, so the comparison view can expand
 * collapsed context for a PR whose commits are not on disk (a fork, a branch
 * that was never fetched) without ever reading the working tree.
 *
 * The base side is the merge base, not the base branch tip: the PR diff is
 * three-dot, and reading the tip would leak unrelated base-branch work into
 * the expanded context. Head commits of a fork PR are reachable through the
 * base repository (`refs/pull/<n>/head`), so every read goes to one repo.
 */
export const createPullRequestFileContents = ({
  getOctokit = getOctokitOrNull,
  resolveRepo = resolveGitHubRepoFromDirectory,
} = {}) => async (
  directory,
  number,
  sourceRepo,
  { path, previousPath, status, signal = undefined },
) => {
  const { octokit, repo } = await resolvePullRequestRepo(directory, sourceRepo, {
    getOctokit,
    resolveRepo,
    signal,
  });
  const pullOptions = {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: number,
  };
  if (signal) pullOptions.signal = signal;
  const pull = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', pullOptions);
  const headSha = pull.data?.head?.sha;
  const baseSha = pull.data?.base?.sha;
  assert.match(String(headSha), /^[0-9a-f]{40}$/, 'GitHub returned an invalid pull request head');
  assert.match(String(baseSha), /^[0-9a-f]{40}$/, 'GitHub returned an invalid pull request base');

  const compareOptions = {
    owner: repo.owner,
    repo: repo.repo,
    basehead: `${baseSha}...${headSha}`,
  };
  if (signal) compareOptions.signal = signal;
  const compare = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', compareOptions);
  const mergeBaseSha = compare.data?.merge_base_commit?.sha;
  assert.match(String(mergeBaseSha), /^[0-9a-f]{40}$/, 'GitHub returned an invalid merge base');

  const readFile = async (filePath, ref) => {
    const requestOptions = {
      owner: repo.owner,
      repo: repo.repo,
      path: filePath,
      ref,
      headers: { accept: 'application/vnd.github.raw+json' },
    };
    if (signal) requestOptions.signal = signal;
    const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', requestOptions);
    const content = response.data;
    assert.ok(
      Object.prototype.toString.call(content) === '[object String]' && Object.is(content.valueOf(), content),
      'GitHub returned invalid file contents',
    );
    if (Buffer.byteLength(content) > MAX_FULL_FILE_BYTES) {
      throw Object.assign(new Error('This file is too large to show in full'), { statusCode: 413, code: 'file-too-large' });
    }
    return content;
  };

  const [original, modified] = await Promise.all([
    status === 'A' ? '' : readFile(previousPath || path, mergeBaseSha),
    status === 'D' ? '' : readFile(path, headSha),
  ]);
  return { original, modified };
};

export const getPullRequestFileContents = createPullRequestFileContents();

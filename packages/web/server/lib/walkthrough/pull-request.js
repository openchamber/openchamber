import { getOctokitOrNull } from '../github/octokit.js';
import assert from 'node:assert/strict';
import { resolveGitHubRepoFromDirectory } from '../github/repo/index.js';

/**
 * Raw unified diff for a pull request.
 *
 * GitHub already returns the merge-base diff for a PR, so this matches the
 * three-dot semantics used for local branch reviews: work merged in from the
 * base branch is not part of it.
 */
export async function getPullRequestDiff(directory, number, sourceRepo, { allowEmpty = false } = {}) {
  // The host comes from the local checkout, not the pull request: sourceRepo
  // carries only owner/repo (the upstream for a fork), never the enterprise
  // host. Resolve the directory first so the Octokit pairs that host with the
  // token for that host instead of defaulting to github.com.
  const { repo: dirRepo } = await resolveGitHubRepoFromDirectory(directory);
  const octokit = getOctokitOrNull(dirRepo?.host);
  if (!octokit) {
    throw Object.assign(new Error('Connect a GitHub account to review pull requests'), {
      statusCode: 401,
      code: 'github-not-connected',
    });
  }

  // The resolver returns `{ repo, remoteUrl }`, not the repo itself. Reading
  // `.owner` off the wrapper made this check fail for every repository.
  const { repo } = sourceRepo ? { repo: sourceRepo } : { repo: dirRepo };
  if (!repo?.owner || !repo?.repo) {
    throw Object.assign(new Error('This directory has no GitHub remote'), {
      statusCode: 400,
      code: 'no-github-remote',
    });
  }

  const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: number,
    headers: { accept: 'application/vnd.github.v3.diff' },
  });

  assert.match(response.data, /^(?:diff --git |\s*$)/, 'GitHub returned an invalid pull request diff');
  const patch = response.data;
  if (!allowEmpty && !patch.trim()) {
    throw Object.assign(new Error(`Pull request #${number} has no diff`), {
      statusCode: 404,
      code: 'empty-diff',
    });
  }

  return { patch, meta: { owner: repo.owner, repo: repo.repo, number } };
}

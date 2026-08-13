import { getOctokitOrNull } from '../github/octokit.js';
import { resolveGitHubRepoFromDirectory } from '../github/repo/index.js';
import { getGitLabClientOrNull } from '../gitlab/client.js';
import { resolveGitLabRepoFromDirectory } from '../gitlab/repo.js';

// GitLab diff pagination cap: never loop more than 10 pages of 100 files,
// mirroring gitlab/routes.js.
const GITLAB_DIFFS_MAX_PAGES = 10;

/**
 * Raw unified diff for a GitHub pull request.
 *
 * GitHub already returns the merge-base diff for a PR, so this matches the
 * three-dot semantics used for local branch reviews: work merged in from the
 * base branch is not part of it.
 */
async function getGitHubPullRequestDiff(directory, number) {
  const octokit = getOctokitOrNull();
  if (!octokit) {
    throw Object.assign(new Error('Connect a GitHub account to review pull requests'), {
      statusCode: 401,
      code: 'github-not-connected',
    });
  }

  // The resolver returns `{ repo, remoteUrl }`, not the repo itself. Reading
  // `.owner` off the wrapper made this check fail for every repository.
  const { repo } = await resolveGitHubRepoFromDirectory(directory);
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

  const patch = typeof response?.data === 'string' ? response.data : '';
  if (!patch.trim()) {
    throw Object.assign(new Error(`Pull request #${number} has no diff`), {
      statusCode: 404,
      code: 'empty-diff',
    });
  }

  return { patch, meta: { owner: repo.owner, repo: repo.repo, number } };
}

/**
 * Raw unified diff for a GitLab merge request.
 *
 * GitLab's merge request diffs endpoint returns one entry per file, so the
 * pages are concatenated into a single patch. `repo` comes from the
 * dispatcher's `resolveGitLabRepoFromDirectory` call and is never re-resolved
 * here.
 */
async function getGitLabMergeRequestDiff(repo, number) {
  const client = getGitLabClientOrNull();
  if (!client) {
    throw Object.assign(new Error('Connect a GitLab account to review merge requests'), {
      statusCode: 401,
      code: 'gitlab-not-connected',
    });
  }

  // The parser always populates both fields; this guards a malformed repo so
  // the failure is explicit rather than a downstream TypeError.
  if (!repo?.namespace || !repo?.project) {
    throw Object.assign(new Error('This directory has no GitLab remote'), {
      statusCode: 400,
      code: 'no-gitlab-remote',
    });
  }

  // The client URL-encodes the path internally; never pre-encode it.
  const projectPath = `${repo.namespace}/${repo.project}`;

  const diffs = [];
  for (let page = 1; page <= GITLAB_DIFFS_MAX_PAGES; page += 1) {
    const response = await client.mergeRequestDiffs(projectPath, number, { per_page: 100, page });
    if (response.status !== 200 || !Array.isArray(response.data)) {
      break;
    }
    diffs.push(...response.data);
    // The page object is the authoritative signal; the 10-page cap above is
    // what stops a server that lies about hasMore from looping forever.
    if (!response.page?.hasMore) {
      break;
    }
  }

  const patch = diffs
    .map((item) => (typeof item?.diff === 'string' ? item.diff : ''))
    .filter(Boolean)
    .join('\n');
  if (!patch.trim()) {
    throw Object.assign(new Error(`Merge request #${number} has no diff`), {
      statusCode: 404,
      code: 'empty-diff',
    });
  }

  return { patch, meta: { namespace: repo.namespace, project: repo.project, number } };
}

/**
 * Raw unified diff for a pull request or merge request.
 *
 * The provider is chosen by the repository's git remote: a GitLab remote uses
 * the GitLab merge request API, anything else falls back to the GitHub pull
 * request API.
 */
export async function getPullRequestDiff(directory, number) {
  const { repo } = await resolveGitLabRepoFromDirectory(directory);
  if (repo) {
    return getGitLabMergeRequestDiff(repo, number);
  }
  return getGitHubPullRequestDiff(directory, number);
}

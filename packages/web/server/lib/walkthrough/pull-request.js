import assert from 'node:assert/strict';
import { markGitHubAuthAccountInvalid } from '../github/auth.js';
import { getOctokitForAccountId } from '../github/octokit.js';
import { resolveGitHubRepoFromDirectory } from '../github/repo/index.js';
import { resolveRepoNetwork } from '../github/repo/fork-detection.js';

const sameRepository = (left, right) => left.owner.toLowerCase() === right.owner.toLowerCase()
  && left.repo.toLowerCase() === right.repo.toLowerCase();

/**
 * Raw unified diff for a pull request.
 *
 * GitHub already returns the merge-base diff for a PR, so this matches the
 * three-dot semantics used for local branch reviews: work merged in from the
 * base branch is not part of it.
 *
 * The account comes from the exact read context and the repository from the
 * binding's primary remote. A caller may name the repository the pull request
 * lives in (`sourceRepo`). It is honoured only inside the bound repository's
 * network, the repository and the upstream it was forked from, which is exactly
 * what the bound pull request list reads with the same account. So every listed
 * pull request can be opened, and a name outside that network fails instead of
 * reaching a repository the binding never covered. `allowEmpty` lets the
 * comparison view show a pull request that has no diff yet.
 */
export async function getPullRequestDiff(directory, number, readContext, {
  allowEmpty = false,
  sourceRepo = null,
  ...dependencies
} = {}) {
  if (!readContext || readContext.provider !== 'github') {
    throw Object.assign(new Error('A trusted GitHub read context is required'), {
      statusCode: 400,
      code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT',
    });
  }
  const getExactOctokit = dependencies.getOctokitForAccountId ?? getOctokitForAccountId;
  const account = await getExactOctokit(readContext.accountId, {
    onUnauthorized: async (identity, persisted) => {
      await dependencies.onAccountUnavailable?.(identity);
      if (persisted) await markGitHubAuthAccountInvalid(identity.accountId, 'unauthorized');
    },
  });
  if (!account) {
    throw Object.assign(new Error('GitHub account is unavailable'), {
      statusCode: 401,
      code: 'github-not-connected',
    });
  }

  // The resolver returns `{ repo, remoteUrl }`, not the repo itself. Reading
  // `.owner` off the wrapper made this check fail for every repository.
  const resolveRepository = dependencies.resolveGitHubRepoFromDirectory ?? resolveGitHubRepoFromDirectory;
  const { repo } = await resolveRepository(directory, readContext.primaryRemote);
  if (!repo?.owner || !repo?.repo) {
    throw Object.assign(new Error('This directory has no GitHub remote'), {
      statusCode: 400,
      code: 'no-github-remote',
    });
  }
  let target = repo;
  if (sourceRepo && !sameRepository(sourceRepo, repo)) {
    const resolveNetwork = dependencies.resolveRepoNetwork ?? resolveRepoNetwork;
    const network = await resolveNetwork(account.octokit, directory, readContext.primaryRemote, { strictErrors: true });
    const member = Array.isArray(network) ? network.find((entry) => sameRepository(entry, sourceRepo)) : null;
    if (!member) {
      throw Object.assign(new Error(`Pull request #${number} belongs to ${sourceRepo.owner}/${sourceRepo.repo}, which is outside this checkout's repository network`), {
        statusCode: 409,
        code: 'PULL_REQUEST_REPOSITORY_MISMATCH',
      });
    }
    target = { owner: member.owner, repo: member.repo };
  }

  const response = await account.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: target.owner,
    repo: target.repo,
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

  return { patch, meta: { owner: target.owner, repo: target.repo, number } };
}

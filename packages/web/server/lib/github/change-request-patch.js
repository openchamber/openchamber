import assert from 'node:assert/strict';
import { markGitHubAuthAccountInvalid } from './auth.js';
import { getOctokitForAccountId, getOctokitForHost } from './octokit.js';
import { resolveGitHubRepoFromDirectory } from './repo/index.js';
import { resolveRepoNetwork } from './repo/fork-detection.js';

/**
 * GitHub's pull request patch and file reads behind
 * `resources.readChangeRequestPatch` / `readChangeRequestFile`. The input is
 * the shell's: `session` (`{ instance, accountId }`, the read context's
 * account), `directory` and `remote` (the context's primary remote), the
 * number and an optional `sourceRepo`. The last argument holds dependency
 * overrides for tests and `onAccountUnavailable`.
 */

const sameRepository = (left, right) => left.owner.toLowerCase() === right.owner.toLowerCase()
  && left.repo.toLowerCase() === right.repo.toLowerCase();

/**
 * The account and repository a pull request read goes to.
 *
 * The host comes from the local checkout, not the pull request: sourceRepo
 * carries only owner/repo (the upstream for a fork), never the enterprise
 * host. github.com takes the read context's exact account; an enterprise host
 * is served by its own host-pinned token. A named `sourceRepo` is honoured
 * only inside the bound repository's network, the repository and the
 * upstream it was forked from, which is exactly what the bound pull request
 * list reads with the same account. So every listed pull request can be
 * opened, and a name outside that network fails instead of reaching a
 * repository the binding never covered.
 */
async function resolvePullRequestRepo({ session, directory, remote, number, sourceRepo = null }, dependencies) {
  const resolveRepository = dependencies.resolveGitHubRepoFromDirectory ?? resolveGitHubRepoFromDirectory;
  const { repo } = await resolveRepository(directory, remote);
  if (!repo?.owner || !repo?.repo) {
    throw Object.assign(new Error('This directory has no GitHub remote'), {
      statusCode: 400,
      code: 'no-github-remote',
    });
  }
  const hostKey = String(repo.host ?? '').trim().toLowerCase();
  let account;
  if (hostKey && hostKey !== 'github.com') {
    const getHostOctokit = dependencies.getOctokitForHost ?? getOctokitForHost;
    const octokit = await getHostOctokit(hostKey);
    account = octokit ? { accountId: null, octokit } : null;
  } else {
    const getExactOctokit = dependencies.getOctokitForAccountId ?? getOctokitForAccountId;
    account = await getExactOctokit(session?.accountId, {
      onUnauthorized: async (identity, persisted) => {
        await dependencies.onAccountUnavailable?.(identity);
        if (persisted) await markGitHubAuthAccountInvalid(identity.accountId, 'unauthorized');
      },
    });
  }
  if (!account) {
    throw Object.assign(new Error('GitHub account is unavailable'), {
      statusCode: 401,
      code: 'github-not-connected',
    });
  }

  let target = repo;
  if (sourceRepo && !sameRepository(sourceRepo, repo)) {
    const resolveNetwork = dependencies.resolveRepoNetwork ?? resolveRepoNetwork;
    const network = await resolveNetwork(account.octokit, directory, remote, { strictErrors: true });
    const member = Array.isArray(network) ? network.find((entry) => sameRepository(entry, sourceRepo)) : null;
    if (!member) {
      throw Object.assign(new Error(`Pull request #${number} belongs to ${sourceRepo.owner}/${sourceRepo.repo}, which is outside this checkout's repository network`), {
        statusCode: 409,
        code: 'PULL_REQUEST_REPOSITORY_MISMATCH',
      });
    }
    target = { owner: member.owner, repo: member.repo };
  }
  return { octokit: account.octokit, repo: { owner: target.owner, repo: target.repo } };
}

/**
 * Raw unified diff for a pull request. GitHub already returns the merge-base
 * diff, which matches the three-dot semantics of local branch reviews: work
 * merged in from the base branch is not part of it.
 */
export async function readGitHubChangeRequestPatch(input, dependencies = {}) {
  const { octokit, repo: target } = await resolvePullRequestRepo(input, dependencies);
  const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: target.owner,
    repo: target.repo,
    pull_number: input.number,
    headers: { accept: 'application/vnd.github.v3.diff' },
  });
  assert.match(response.data, /^(?:diff --git |\s*$)/, 'GitHub returned an invalid pull request diff');
  return { patch: response.data, meta: { owner: target.owner, repo: target.repo, number: input.number } };
}

/** Above this the full-context view is no longer a readable diff, and the round trip is wasted. */
const MAX_FULL_FILE_BYTES = 5 * 1024 * 1024;

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
export async function readGitHubChangeRequestFile(input, dependencies = {}) {
  const { path, previousPath, status } = input;
  const { octokit, repo } = await resolvePullRequestRepo(input, dependencies);
  const pull = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: repo.owner, repo: repo.repo, pull_number: input.number,
  });
  const headSha = pull.data?.head?.sha;
  const baseSha = pull.data?.base?.sha;
  assert.match(String(headSha), /^[0-9a-f]{40}$/, 'GitHub returned an invalid pull request head');
  assert.match(String(baseSha), /^[0-9a-f]{40}$/, 'GitHub returned an invalid pull request base');
  const compare = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
    owner: repo.owner, repo: repo.repo, basehead: `${baseSha}...${headSha}`,
  });
  const mergeBaseSha = compare.data?.merge_base_commit?.sha;
  assert.match(String(mergeBaseSha), /^[0-9a-f]{40}$/, 'GitHub returned an invalid merge base');

  const readFile = async (filePath, ref) => {
    const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: repo.owner, repo: repo.repo, path: filePath, ref,
      headers: { accept: 'application/vnd.github.raw+json' },
    });
    const content = response.data;
    assert.equal(typeof content, 'string', 'GitHub returned invalid file contents');
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
}

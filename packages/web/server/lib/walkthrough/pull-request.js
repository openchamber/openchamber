import assert from 'node:assert/strict';
import { markGitHubAuthAccountInvalid } from '../github/auth.js';
import { getOctokitForAccountId } from '../github/octokit.js';
import { resolveGitHubRepoFromDirectory } from '../github/repo/index.js';
import { resolveRepoNetwork } from '../github/repo/fork-detection.js';

const sameRepository = (left, right) => left.owner.toLowerCase() === right.owner.toLowerCase()
  && left.repo.toLowerCase() === right.repo.toLowerCase();

/**
 * The account and repository a pull request read goes to.
 *
 * The account comes from the exact read context and the repository from the
 * binding's primary remote. A caller may name the repository the pull request
 * lives in (`sourceRepo`). It is honoured only inside the bound repository's
 * network, the repository and the upstream it was forked from, which is exactly
 * what the bound pull request list reads with the same account. So every listed
 * pull request can be opened, and a name outside that network fails instead of
 * reaching a repository the binding never covered.
 */
async function resolvePullRequestRepo(directory, number, readContext, { sourceRepo = null, ...dependencies } = {}) {
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
  return { octokit: account.octokit, repo: { owner: target.owner, repo: target.repo } };
}

/**
 * Raw unified diff for a pull request.
 *
 * GitHub already returns the merge-base diff for a PR, so this matches the
 * three-dot semantics used for local branch reviews: work merged in from the
 * base branch is not part of it. `allowEmpty` lets the comparison view show a
 * pull request that has no diff yet.
 */
export async function getPullRequestDiff(directory, number, readContext, {
  allowEmpty = false,
  ...options
} = {}) {
  const { patch, meta } = readContext?.provider === 'gitlab'
    ? await readGitLab(options.readGitLabChangeRequestPatch, { context: readContext, number, sourceRepo: options.sourceRepo ?? null })
    : await readGitHubPullRequestDiff(directory, number, readContext, options);
  if (!allowEmpty && !patch.trim()) {
    const label = readContext?.provider === 'gitlab' ? `Merge request !${number}` : `Pull request #${number}`;
    throw Object.assign(new Error(`${label} has no diff`), {
      statusCode: 404,
      code: 'empty-diff',
    });
  }
  return { patch, meta };
}

/**
 * GitLab merge requests are read by the GitLab module, which owns the
 * account, the project network and the patch shape; the runtime hands its
 * readers in. Without them a GitLab context is not served here.
 */
async function readGitLab(reader, input) {
  if (!(reader instanceof Function)) {
    throw Object.assign(new Error('GitLab merge request reads are unavailable'), {
      statusCode: 501,
      code: 'SOURCE_CONTROL_BINDING_UNAVAILABLE',
    });
  }
  return reader(input);
}

async function readGitHubPullRequestDiff(directory, number, readContext, options) {
  const { octokit, repo: target } = await resolvePullRequestRepo(directory, number, readContext, options);

  const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: target.owner,
    repo: target.repo,
    pull_number: number,
    headers: { accept: 'application/vnd.github.v3.diff' },
  });

  assert.match(response.data, /^(?:diff --git |\s*$)/, 'GitHub returned an invalid pull request diff');
  return { patch: response.data, meta: { owner: target.owner, repo: target.repo, number } };
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
export async function getPullRequestFileContents(directory, number, readContext, { path, previousPath, status, ...options }) {
  if (readContext?.provider === 'gitlab') {
    return readGitLab(options.readGitLabChangeRequestFile, {
      context: readContext, number, sourceRepo: options.sourceRepo ?? null, path, previousPath, status,
    });
  }
  const { octokit, repo } = await resolvePullRequestRepo(directory, number, readContext, options);
  const pull = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: repo.owner, repo: repo.repo, pull_number: number,
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

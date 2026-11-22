import { documentDataUrl } from '../source-control/document-versions.js';
import assert from 'node:assert/strict';
import { readBoundedResponseText } from '../shared/response-body.js';
import { markGitHubAuthAccountInvalid } from './auth.js';
import { getOctokitForAccountId, getOctokitForHost } from './octokit.js';
import { resolveGitHubRepoFromDirectory } from './repo/index.js';
import { resolveRepoNetwork } from './repo/fork-detection.js';
import { changeRequestNetworkTarget } from '../source-control/repository-network.js';
import type { SourceControlIdentity } from './octokit.js';
import type { GitHubEnvelope } from './contracts.js';

interface Repository { owner: string; repo: string }
export interface ChangeRequestPatchInput {
  session?: { accountId: string };
  directory: string;
  remote: string;
  number: number;
  sourceRepo?: Repository | null | undefined;
  linked?: boolean;
}
export interface ChangeRequestFileInput extends ChangeRequestPatchInput {
  path: string;
  previousPath?: string | undefined;
  status?: string;
  binary?: boolean | undefined;
}
export interface ChangeRequestPatchDependencies {
  resolveGitHubRepoFromDirectory?: typeof resolveGitHubRepoFromDirectory;
  resolveRepoNetwork?: typeof resolveRepoNetwork;
  getOctokitForHost?: typeof getOctokitForHost;
  getOctokitForAccountId?: typeof getOctokitForAccountId;
  onAccountUnavailable?: ((identity: SourceControlIdentity) => void | Promise<void>) | undefined;
}

const sameRepository = (left: Repository, right: Repository) => left.owner.toLowerCase() === right.owner.toLowerCase()
  && left.repo.toLowerCase() === right.repo.toLowerCase();

async function resolvePullRequestRepo({ session, directory, remote, number, sourceRepo = null, linked = false }: ChangeRequestPatchInput, dependencies: ChangeRequestPatchDependencies) {
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

  if (linked && sourceRepo) return { octokit: account.octokit, repo: { owner: sourceRepo.owner, repo: sourceRepo.repo } };

  let target: Repository = repo;
  if (sourceRepo && !sameRepository(sourceRepo, repo)) {
    const resolveNetwork = dependencies.resolveRepoNetwork ?? resolveRepoNetwork;
    const network = await resolveNetwork(account.octokit, directory, remote, { strictErrors: true });
    const member = changeRequestNetworkTarget(network, sourceRepo, sameRepository);
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

export async function readGitHubChangeRequestPatch(input: ChangeRequestPatchInput, dependencies: ChangeRequestPatchDependencies = {}) {
  const { octokit, repo: target } = await resolvePullRequestRepo(input, dependencies);
  // parseSuccessResponseBody: false hands back the raw body stream instead of
  // a buffered string, so the patch cap is judged while the body arrives: an
  // over-cap Content-Length is refused up front and the stream is cancelled
  // as soon as the read crosses the cap. An over-cap diff is never held whole.
  const response: { data: unknown; headers?: Record<string, string | number | undefined> } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: target.owner,
    repo: target.repo,
    pull_number: input.number,
    headers: { accept: 'application/vnd.github.v3.diff' },
    request: { parseSuccessResponseBody: false },
  });
  const patch = await readPatchBody(response);
  assert.match(patch, /^(?:diff --git |\s*$)/, 'GitHub returned an invalid pull request diff');
  return { patch, meta: { owner: target.owner, repo: target.repo, number: input.number } };
}

/** A whole pull request patch is far larger than one file: ten times the per-file cap, matching the local-diff cap in git/service.ts. */
const MAX_PATCH_BYTES = 50 * 1024 * 1024;

const patchTooLarge = () => Object.assign(new Error('This pull request diff is too large to show'), { statusCode: 413, code: 'patch-too-large' });

async function readPatchBody(response: { data: unknown; headers?: Record<string, string | number | undefined> }): Promise<string> {
  // A buffered body (a client that ignores parseSuccessResponseBody) is judged by its size.
  if (typeof response.data === 'string') {
    if (Buffer.byteLength(response.data) > MAX_PATCH_BYTES) throw patchTooLarge();
    return response.data;
  }
  if (!(response.data instanceof ReadableStream)) {
    assert.fail('GitHub returned an invalid pull request diff');
  }
  const read = await readBoundedResponseText({
    headers: new Headers(Object.entries(response.headers ?? {}).flatMap(([name, value]) => (value === undefined ? [] : [[name, String(value)]]))),
    body: response.data,
  }, MAX_PATCH_BYTES);
  if (read.tooLarge) throw patchTooLarge();
  return read.text;
}

const MAX_FULL_FILE_BYTES = 5 * 1024 * 1024;

function assertFileText(content: unknown): asserts content is string {
  assert.equal(typeof content, 'string', 'GitHub returned invalid file contents');
}

export async function readGitHubChangeRequestFile(input: ChangeRequestFileInput, dependencies: ChangeRequestPatchDependencies = {}) {
  const { path, previousPath, status, binary } = input;
  const { octokit, repo } = await resolvePullRequestRepo(input, dependencies);
  const pull = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: repo.owner, repo: repo.repo, pull_number: input.number,
  });
  const headSha: unknown = pull.data?.head?.sha;
  const baseSha: unknown = pull.data?.base?.sha;
  assert.match(String(headSha), /^[0-9a-f]{40}$/, 'GitHub returned an invalid pull request head');
  assert.match(String(baseSha), /^[0-9a-f]{40}$/, 'GitHub returned an invalid pull request base');
  const compare = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
    owner: repo.owner, repo: repo.repo, basehead: `${baseSha}...${headSha}`,
  });
  const mergeBaseSha: unknown = compare.data?.merge_base_commit?.sha;
  assert.match(String(mergeBaseSha), /^[0-9a-f]{40}$/, 'GitHub returned an invalid merge base');

  const readDocument = async (filePath: string, ref: GitHubEnvelope['data']) => {
    const entry = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner: repo.owner, repo: repo.repo, path: filePath, ref });
    const blob = await octokit.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', { owner: repo.owner, repo: repo.repo, file_sha: entry.data?.sha });
    assert.ok(blob.data?.encoding === 'base64', 'GitHub returned invalid file contents');
    return documentDataUrl(Buffer.from(blob.data.content, 'base64'));
  };

  const readFile = async (filePath: string, ref: GitHubEnvelope['data']) => {
    if (binary) return readDocument(filePath, ref);
    const response: { data: unknown } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: repo.owner, repo: repo.repo, path: filePath, ref,
      headers: { accept: 'application/vnd.github.raw+json' },
    });
    const content = response.data;
    assertFileText(content);
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

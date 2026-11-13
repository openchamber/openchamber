// Stacked pull requests: a chain of open PRs where each one's base is the
// head branch of the one below it.
//
// GitHub has native stacks (REST `/repos/{owner}/{repo}/stacks`, GA since
// 2026-10-06 on github.com). A stack GitHub knows wins; otherwise the chain is
// inferred from the open PRs' base and head branches, which also covers forks'
// absence of native support and GitHub Enterprise Server. Only heads in the
// repository itself count: a fork's branch named like the base is another
// branch.

import { z } from 'zod';
import { fetchPrSummaries } from './pr-summaries.js';
import { isGitHubRateLimitError } from './rate-limit.js';
import { isGraphqlRateLimitError } from './pr-summaries.js';

const STACKS_API_VERSION = '2026-03-10';
const OPEN_PULL_PAGES = 3;
const MAX_MEMBERS = 20;
const MAX_COMPARES = 10;
const MERGE_POLL_MS = 2_000;
const MERGE_POLL_LIMIT = 15;

const stacksHeaders = { 'X-GitHub-Api-Version': STACKS_API_VERSION };
const repositoryIdentitySchema = z.object({ full_name: z.string().regex(/^[^\s/:]+\/[^\s/:]+$/) }).loose();
const openPullIdentitySchema = z.object({
  number: z.number().int().positive(),
  head: z.object({ ref: z.string().min(1) }).loose(),
  base: z.object({ ref: z.string().min(1) }).loose(),
}).loose();

const isRateLimit = (error) => isGitHubRateLimitError(error) || isGraphqlRateLimitError(error);

const repositoryIdentity = (repository) => {
  const parsed = repositoryIdentitySchema.safeParse(repository);
  if (!parsed.success) throw new Error('GitHub returned an unknown repository identity');
  return parsed.data.full_name.toLowerCase();
};

const sameRepo = (pull, owner, repo) => {
  if (!pull) return false;
  return repositoryIdentity(pull.head?.repo) === `${owner}/${repo}`.toLowerCase();
};

// Repository names are case-insensitive; branch refs retain their exact case.
// Missing repository identity is a failed read, so it cannot hide membership.
const branchIdentity = (branch) => `${repositoryIdentity(branch.repo)}:${branch.ref}`;

const toOpenPull = (pull) => ({
  number: pull.number,
  title: String(pull.title ?? ''),
  url: String(pull.html_url ?? ''),
  state: 'open',
  draft: pull.draft === true,
  head: String(pull.head?.ref ?? ''),
  base: String(pull.base?.ref ?? ''),
  headSha: String(pull.head?.sha ?? ''),
});

async function listOpenPulls(octokit, owner, repo) {
  const pulls = [];
  let defaultBranch = null;
  for (let page = 1; page <= OPEN_PULL_PAGES; page += 1) {
    const response = await octokit.rest.pulls.list({ owner, repo, state: 'open', per_page: 100, page });
    if (!Array.isArray(response?.data)) throw new Error('GitHub returned an invalid pull request list');
    for (const pull of response.data) {
      const parsed = openPullIdentitySchema.safeParse(pull);
      if (!parsed.success) {
        throw new Error('GitHub returned an invalid pull request');
      }
      defaultBranch ??= parsed.data.base.repo?.default_branch ?? null;
      pulls.push(parsed.data);
    }
    if (response.data.length < 100) break;
    if (page === OPEN_PULL_PAGES) throw new Error('GitHub pull request list may be incomplete');
  }
  return { pulls, defaultBranch };
}

/**
 * The native stack holding `number`, `null` when GitHub reports none, or
 * `undefined` when the stack API could not answer (anything but a 404, which
 * means stacks are not available for this repository).
 */
export async function readNativeStack(octokit, owner, repo, number) {
  try {
    const response = await octokit.request('GET /repos/{owner}/{repo}/stacks', {
      owner, repo, pull_request: number, per_page: 10, headers: stacksHeaders,
    });
    const stacks = Array.isArray(response?.data) ? response.data : null;
    if (!stacks) return undefined;
    if (stacks.some((entry) => !Number.isSafeInteger(entry?.number) || entry.number < 1 || !Array.isArray(entry?.pull_requests)
      || entry.pull_requests.some((pull) => !Number.isSafeInteger(pull?.number) || pull.number < 1))) return undefined;
    const stack = stacks.find((entry) => entry?.open !== false && Array.isArray(entry?.pull_requests)
      && entry.pull_requests.some((pull) => pull?.number === number));
    return stack ?? null;
  } catch (error) {
    if (isRateLimit(error)) throw error;
    if (error?.status === 404) return null;
    return undefined;
  }
}

const toMergedParent = (pull) => ({ number: pull.number, head: String(pull.head?.ref ?? ''), headSha: String(pull.head?.sha ?? ''), base: pull.base?.ref ?? null });

// The merged PR whose head branch `base` still is: the bottom PR was not moved yet.
async function findMergedParent(octokit, owner, repo, base) {
  const response = await octokit.rest.pulls.list({ owner, repo, state: 'closed', head: `${owner}:${base}`, per_page: 5 });
  const merged = (Array.isArray(response?.data) ? response.data : [])
    .filter((pull) => pull?.merged_at && pull.head?.ref === base)
    .sort((left, right) => Date.parse(right.merged_at) - Date.parse(left.merged_at))[0];
  return merged ? toMergedParent(merged) : null;
}

// A PR already moved onto the trunk can still carry the commits of the PR it
// was stacked on, when that one was squashed or rebased in. Its head commit is
// then one of this PR's commits the trunk does not have.
async function findSquashedParent(octokit, owner, repo, member) {
  const closed = await octokit.rest.pulls.list({ owner, repo, state: 'closed', base: member.base, sort: 'updated', direction: 'desc', per_page: 10 });
  const merged = (Array.isArray(closed?.data) ? closed.data : []).filter((pull) => pull?.merged_at && pull.number !== member.number && pull.head?.sha);
  if (merged.length === 0) return null;
  const compare = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${member.base}...${member.head}`, per_page: 100 });
  const ahead = new Set((Array.isArray(compare?.data?.commits) ? compare.data.commits : []).map((commit) => commit?.sha));
  const parent = merged.find((pull) => ahead.has(pull.head.sha));
  return parent ? toMergedParent(parent) : null;
}

/** Bottom-to-top chain through `number` among open same-repository PRs, and the PRs branching off it. */
export function inferChain(pulls, owner, repo, number) {
  const open = pulls.filter((pull) => sameRepo(pull, owner, repo));
  const byHead = new Map(open.map((pull) => [branchIdentity(pull.head), pull]));
  const childrenByBase = new Map();
  for (const pull of open) {
    const base = branchIdentity(pull.base);
    const list = childrenByBase.get(base) ?? [];
    list.push(pull);
    childrenByBase.set(base, list);
  }
  for (const list of childrenByBase.values()) list.sort((left, right) => left.number - right.number);

  const start = pulls.find((pull) => pull.number === number);
  if (!start) return null;
  const chain = [start];
  const seen = new Set([start.number]);
  for (let current = start; chain.length < MAX_MEMBERS;) {
    const parent = byHead.get(branchIdentity(current.base));
    if (!parent || seen.has(parent.number)) break;
    chain.unshift(parent);
    seen.add(parent.number);
    current = parent;
  }
  for (let current = start; chain.length < MAX_MEMBERS;) {
    const child = (childrenByBase.get(branchIdentity(current.head)) ?? []).find((pull) => !seen.has(pull.number));
    if (!child) break;
    chain.push(child);
    seen.add(child.number);
    current = child;
  }
  if (chain.length === MAX_MEMBERS
    && ((byHead.has(branchIdentity(chain[0].base)) && !seen.has(byHead.get(branchIdentity(chain[0].base)).number))
      || (childrenByBase.get(branchIdentity(chain.at(-1).head)) ?? []).some((pull) => !seen.has(pull.number)))) {
    throw new Error('GitHub stack membership exceeds the read budget');
  }
  const branches = [];
  for (const member of chain) {
    for (const child of childrenByBase.get(branchIdentity(member.head)) ?? []) {
      if (!seen.has(child.number)) branches.push({ number: child.number, base: child.base.ref, title: String(child.title ?? '') });
    }
  }
  return { chain, branches };
}

async function readBehindBase(octokit, owner, repo, member) {
  try {
    const response = await octokit.rest.repos.compareCommitsWithBasehead({
      owner, repo, basehead: `${member.base}...${member.head}`, per_page: 1,
    });
    return Number.isInteger(response?.data?.behind_by) ? response.data.behind_by : null;
  } catch (error) {
    if (isRateLimit(error)) throw error;
    return null;
  }
}

/**
 * The stack `number` belongs to, or null when it is not stacked. Throws on a
 * failed read of the open PRs: an unknown stack is never reported as none.
 */
export async function resolvePullStack({ octokit, owner, repo, number }) {
  const { pulls, defaultBranch } = await listOpenPulls(octokit, owner, repo);
  const native = await readNativeStack(octokit, owner, repo, number);
  const openByNumber = new Map(pulls.map((pull) => [pull.number, pull]));

  let members;
  let branches = [];
  if (native) {
    if (native.pull_requests.length > MAX_MEMBERS) throw new Error('GitHub stack membership exceeds the read budget');
    members = native.pull_requests.map((entry, index, list) => {
      const open = openByNumber.get(entry.number);
      if (open) return toOpenPull(open);
      return {
        number: entry.number,
        title: '',
        url: `https://github.com/${owner}/${repo}/pull/${entry.number}`,
        state: entry.merged_at ? 'merged' : (entry.state === 'open' ? 'open' : 'closed'),
        draft: entry.draft === true,
        head: String(entry.head?.ref ?? ''),
        base: index === 0 ? String(native.base?.ref ?? '') : String(list[index - 1]?.head?.ref ?? ''),
        headSha: String(entry.head?.sha ?? ''),
      };
    });
    branches = inferChain(pulls, owner, repo, number)?.branches ?? [];
  } else {
    const inferred = inferChain(pulls, owner, repo, number);
    if (!inferred) {
      if (native === undefined) throw new Error('GitHub native stack membership is unavailable');
      return null;
    }
    members = inferred.chain.map(toOpenPull);
    branches = inferred.branches;
  }

  const result = members.map((member) => ({
    ...member,
    checks: null,
    mergeable: null,
    mergeableState: null,
    summary: 'unknown',
    behindBase: null,
    retargetTo: null,
    mergedParent: null,
  }));

  // The bottom PR sat on a PR that was merged. Either its base is still that
  // PR's head (move it onto what that PR merged into), or it was moved but
  // still carries that PR's commits (restack it onto the trunk with only its
  // own commits). A failed lookup leaves both unknown.
  const bottom = result.find((member) => member.state === 'open');
  const quiet = (error) => {
    if (isRateLimit(error)) throw error;
    return null;
  };
  if (bottom && bottom.base) {
    const parentOpen = pulls.some((pull) => sameRepo(pull, owner, repo) && pull.head.ref === bottom.base);
    if (bottom.base !== defaultBranch && !parentOpen) {
      const merged = await findMergedParent(octokit, owner, repo, bottom.base).catch(quiet);
      if (merged?.base) {
        bottom.retargetTo = merged.base;
        bottom.mergedParent = { number: merged.number, head: merged.head, headSha: merged.headSha };
      }
    } else if (bottom.base === defaultBranch && sameRepo(openByNumber.get(bottom.number), owner, repo)) {
      const squashed = await findSquashedParent(octokit, owner, repo, bottom).catch(quiet);
      if (squashed) bottom.mergedParent = { number: squashed.number, head: squashed.head, headSha: squashed.headSha };
    }
  }

  if (result.length < 2 && !result.some((member) => member.retargetTo || member.mergedParent)) {
    if (native === undefined) throw new Error('GitHub native stack membership is unavailable');
    return null;
  }

  const openMembers = result.filter((member) => member.state === 'open');
  try {
    const { summaries } = await fetchPrSummaries({
      octokit,
      refs: openMembers.map((member) => ({ owner, repo, number: member.number })),
    });
    for (const summary of summaries) {
      const member = result.find((entry) => entry.number === summary.number);
      if (!member) continue;
      member.checks = summary.checks;
      member.mergeable = summary.mergeable;
      member.mergeableState = summary.mergeableState;
      member.draft = summary.draft;
      member.title = member.title || summary.title;
      member.summary = 'ok';
    }
  } catch (error) {
    if (isRateLimit(error)) throw error;
  }

  for (const member of openMembers.slice(0, MAX_COMPARES)) {
    member.behindBase = await readBehindBase(octokit, owner, repo, member);
  }

  return {
    source: native ? 'native' : 'inferred',
    nativeNumber: native ? native.number : null,
    trunk: result[0].base,
    members: result,
    current: number,
    branches,
    nativeUnavailable: native === undefined,
  };
}

/**
 * Whether each PR sits in an inferred chain, from one read of the open PRs.
 * `true`/`false` only for open PRs; any other number is `null` (unknown), so a
 * caller never hides stack controls for a PR it could not judge. A failed read
 * throws.
 */
export async function resolveStackMembership({ octokit, owner, repo, numbers }) {
  const { pulls } = await listOpenPulls(octokit, owner, repo);
  const members = {};
  for (const number of numbers) {
    if (!pulls.some((pull) => pull.number === number)) { members[number] = null; continue; }
    try {
      members[number] = (inferChain(pulls, owner, repo, number)?.chain.length ?? 0) >= 2;
    } catch {
      members[number] = true;
    }
  }
  return members;
}

const STACK_PARENT_COMMIT_LIMIT = 1000;
const defaultBranchSchema = z.object({ default_branch: z.string().min(1) }).loose();

const toStackParent = (pull) => ({
  number: pull.number, head: pull.head.ref, title: String(pull.title ?? ''), url: String(pull.html_url ?? ''),
});

/**
 * The open PR a new branch sits on: the one whose head commit is the nearest
 * of the branch's own commits (`ownCommits`, nearest first). A tie is broken by
 * the branch the reflog says it was created from, otherwise it stays
 * ambiguous. With no ancestor PR, the reflog parent still counts when it has
 * an open PR (that PR got commits after the branch was created). A capped
 * commit list without a match is incomplete, never "none".
 */
export function selectStackParent({ pulls, owner, repo, branch, trunk, ownCommits, capped, createdFrom }) {
  const candidates = pulls.filter((pull) => sameRepo(pull, owner, repo) && pull.head.ref !== branch && pull.head.ref !== trunk);
  const position = new Map(ownCommits.map((sha, index) => [sha, index]));
  let nearest = [];
  let best = Infinity;
  for (const pull of candidates) {
    const at = position.get(String(pull.head?.sha ?? ''));
    if (at === undefined || at > best) continue;
    if (at < best) { best = at; nearest = []; }
    nearest.push(pull);
  }
  if (nearest.length === 1) return { status: 'found', via: 'ancestry', parent: toStackParent(nearest[0]) };
  if (nearest.length > 1) {
    const chosen = createdFrom ? nearest.find((pull) => pull.head.ref === createdFrom) : null;
    return chosen
      ? { status: 'found', via: 'ancestry', parent: toStackParent(chosen) }
      : { status: 'ambiguous', candidates: nearest.sort((left, right) => left.number - right.number).map(toStackParent) };
  }
  const fromReflog = createdFrom ? candidates.find((pull) => pull.head.ref === createdFrom) : null;
  if (fromReflog) return { status: 'found', via: 'created-from', parent: toStackParent(fromReflog) };
  return { status: capped ? 'incomplete' : 'none' };
}

/**
 * Detects the stack parent of a local branch for a PR into `owner/repo`.
 * `remote` is the configured remote of that repository; without it, or
 * without its trunk ref locally, the answer is `unavailable`. A failed read of
 * the open PRs throws: an unknown parent is never reported as none.
 */
export async function findStackParent({ octokit, owner, repo, branch, remote, listOwnCommits, readCreatedFrom }) {
  if (!remote) return { status: 'unavailable' };
  const { pulls, defaultBranch } = await listOpenPulls(octokit, owner, repo);
  if (!pulls.some((pull) => sameRepo(pull, owner, repo) && pull.head.ref !== branch)) return { status: 'none' };
  let trunk = defaultBranch;
  if (!trunk) {
    const metadata = defaultBranchSchema.safeParse((await octokit.rest.repos.get({ owner, repo }))?.data);
    if (!metadata.success) throw new Error('GitHub returned invalid repository metadata');
    trunk = metadata.data.default_branch;
  }
  const own = await listOwnCommits({ branch, remote, trunk, limit: STACK_PARENT_COMMIT_LIMIT });
  if (!own) return { status: 'unavailable' };
  const createdFrom = await readCreatedFrom({ branch, remote });
  return selectStackParent({ pulls, owner, repo, branch, trunk, ownCommits: own.commits, capped: own.capped, createdFrom });
}

const rejected = (message, status = 409) => Object.assign(new Error(message), { status, expected: true });

/**
 * Registers `number` (stacked on another open PR) as a native GitHub stack:
 * appends it to its parent's stack, or creates one from the inferred chain.
 * A repository without native stacks answers `registered: false`.
 */
export async function registerPullStack({ octokit, owner, repo, number }) {
  const { pulls } = await listOpenPulls(octokit, owner, repo);
  const inferred = inferChain(pulls, owner, repo, number);
  if (!inferred || inferred.chain.length < 2) return { registered: false, nativeNumber: null, reason: 'not-stacked' };
  const index = inferred.chain.findIndex((pull) => pull.number === number);
  const below = inferred.chain.slice(0, index + 1);
  try {
    const native = await readNativeStack(octokit, owner, repo, below[index - 1].number);
    if (native === undefined) return { registered: false, nativeNumber: null, reason: 'unavailable' };
    if (native) {
      const known = new Set(native.pull_requests.map((pull) => pull.number));
      if (known.has(number)) return { registered: true, nativeNumber: native.number };
      const add = below.filter((pull) => !known.has(pull.number)).map((pull) => pull.number);
      const response = await octokit.request('POST /repos/{owner}/{repo}/stacks/{stack_number}/add', {
        owner, repo, stack_number: native.number, pull_requests: add, headers: stacksHeaders,
      });
      return { registered: true, nativeNumber: response?.data?.number ?? native.number };
    }
    const response = await octokit.request('POST /repos/{owner}/{repo}/stacks', {
      owner, repo, pull_requests: below.map((pull) => pull.number), headers: stacksHeaders,
    });
    return { registered: true, nativeNumber: response?.data?.number ?? null };
  } catch (error) {
    if (isRateLimit(error)) throw error;
    if ([404, 409, 422].includes(error?.status)) {
      return { registered: false, nativeNumber: null, reason: String(error?.response?.data?.message ?? error.message ?? 'rejected') };
    }
    throw error;
  }
}

async function retargetPull({ octokit, owner, repo, number, base }) {
  await octokit.rest.pulls.update({ owner, repo, pull_number: number, base });
}

async function mergeAsync({ octokit, owner, repo, number, method, sha, sleep }) {
  let response;
  try {
    response = await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async', {
      owner, repo, pull_number: number, merge_method: method, sha, merge_action: 'default', headers: stacksHeaders,
    });
  } catch (error) {
    if (error?.status !== 409) throw error;
    response = error.response;
  }
  let result = response?.data;
  for (let attempt = 0; result?.status === 'pending' && attempt < MERGE_POLL_LIMIT; attempt += 1) {
    await sleep(MERGE_POLL_MS);
    const uuid = result?.details?.uuid;
    if (!uuid) break;
    result = (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/merge-async/{uuid}', {
      owner, repo, pull_number: number, uuid, headers: stacksHeaders,
    }))?.data;
  }
  if (result?.status === 'merged' || result?.status === 'enqueued') return result.status;
  if (result?.status === 'failed') throw rejected(String(result?.details?.message ?? 'GitHub could not merge the pull request'), 422);
  // Still pending after the wait: GitHub keeps going; the next read shows it.
  return 'pending';
}

/**
 * Merges the bottom open PR of its stack, never one above it. An inferred
 * stack's next PR is moved onto the trunk afterwards; GitHub does that itself
 * for native stacks.
 */
export async function mergeStackBottom({ octokit, owner, repo, number, method, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const stack = await resolvePullStack({ octokit, owner, repo, number });
  const open = stack?.members.filter((member) => member.state === 'open') ?? [];
  if (!stack || open[0]?.number !== number) throw rejected('Only the bottom pull request of a stack can be merged');
  const bottom = open[0];
  if (bottom.retargetTo) throw rejected('Move the pull request onto its new base first');
  let status;
  if (stack.source === 'native') {
    status = await mergeAsync({ octokit, owner, repo, number, method, sha: bottom.headSha, sleep });
  } else {
    await octokit.rest.pulls.merge({ owner, repo, pull_number: number, merge_method: method, sha: bottom.headSha });
    status = 'merged';
  }
  let retargeted = null;
  const next = open[1];
  if (status === 'merged' && stack.source === 'inferred' && next && next.base === bottom.head) {
    // GitHub retargets on its own when the merged head branch is deleted; a
    // 422 here then only says the base already moved.
    await retargetPull({ octokit, owner, repo, number: next.number, base: bottom.base }).then(
      () => { retargeted = next.number; },
      (error) => { if (error?.status !== 422) throw error; },
    );
  }
  return { merged: status === 'merged', status, retargeted };
}

import { stat } from 'node:fs/promises';
import { getRemotes, getStatus } from '../git/index.js';
import { resolveGitHubRepoFromDirectory } from './repo/index.js';
import { noteIfGitHubRateLimit } from './rate-limit.js';

const directoryExists = async (dir) => {
  if (!dir) return false;
  try {
    await stat(dir);
    return true;
  } catch {
    return false;
  }
};

const REPO_DEFAULT_BRANCH_TTL_MS = 5 * 60_000;
const defaultBranchCache = new Map();
const repoMetadataCache = new Map();

const normalizeText = (value) => typeof value === 'string' ? value.trim() : '';
const normalizeLower = (value) => normalizeText(value).toLowerCase();
const normalizeRepoKey = (owner, repo) => {
  const normalizedOwner = normalizeLower(owner);
  const normalizedRepo = normalizeLower(repo);
  if (!normalizedOwner || !normalizedRepo) {
    return '';
  }
  return `${normalizedOwner}/${normalizedRepo}`;
};
const parseTrackingRemoteName = (trackingBranch) => {
  const normalized = normalizeText(trackingBranch);
  if (!normalized) {
    return '';
  }
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0) {
    return '';
  }
  return normalized.slice(0, slashIndex).trim();
};

const parseTrackingBranchName = (trackingBranch) => {
  const normalized = normalizeText(trackingBranch);
  if (!normalized) {
    return '';
  }
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= normalized.length - 1) {
    return '';
  }
  return normalized.slice(slashIndex + 1).trim();
};

const pushUnique = (collection, value, keyFn = normalizeLower) => {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    return;
  }
  const nextKey = keyFn(normalizedValue);
  if (!nextKey) {
    return;
  }
  if (collection.some((item) => keyFn(item) === nextKey)) {
    return;
  }
  collection.push(normalizedValue);
};

const rankRemoteNames = (remoteNames, explicitRemoteName, trackingRemoteName) => {
  const ranked = [];
  pushUnique(ranked, explicitRemoteName);

  if (trackingRemoteName) {
    pushUnique(ranked, trackingRemoteName);
  }

  pushUnique(ranked, 'origin');
  pushUnique(ranked, 'upstream');
  remoteNames.forEach((name) => pushUnique(ranked, name));
  return ranked;
};

const getHeadOwner = (pr) => {
  const repoOwner = normalizeText(pr?.head?.repo?.owner?.login);
  if (repoOwner) {
    return repoOwner;
  }
  const userOwner = normalizeText(pr?.head?.user?.login);
  if (userOwner) {
    return userOwner;
  }
  const headLabel = normalizeText(pr?.head?.label);
  const separatorIndex = headLabel.indexOf(':');
  if (separatorIndex > 0) {
    return headLabel.slice(0, separatorIndex).trim();
  }
  return '';
};

const getHeadRepoKey = (pr, fallbackRepoName) => {
  const repoOwner = normalizeText(pr?.head?.repo?.owner?.login);
  const repoName = normalizeText(pr?.head?.repo?.name);
  if (repoOwner && repoName) {
    return normalizeRepoKey(repoOwner, repoName);
  }
  const headLabel = normalizeText(pr?.head?.label);
  const separatorIndex = headLabel.indexOf(':');
  if (separatorIndex > 0) {
    const labelOwner = headLabel.slice(0, separatorIndex).trim();
    if (labelOwner && fallbackRepoName) {
      return normalizeRepoKey(labelOwner, fallbackRepoName);
    }
  }
  return '';
};

const buildSourceMatcher = (sourceCandidates) => {
  const repoRank = new Map();
  const ownerRank = new Map();

  sourceCandidates.forEach((candidate, index) => {
    const repoKey = normalizeRepoKey(candidate.repo?.owner, candidate.repo?.repo);
    if (repoKey && !repoRank.has(repoKey)) {
      repoRank.set(repoKey, index);
    }
    const owner = normalizeLower(candidate.repo?.owner);
    if (owner && !ownerRank.has(owner)) {
      ownerRank.set(owner, index);
    }
  });

  const matches = (pr, fallbackRepoName) => {
    const repoKey = getHeadRepoKey(pr, fallbackRepoName);
    if (repoKey && repoRank.has(repoKey)) {
      return true;
    }
    const owner = normalizeLower(getHeadOwner(pr));
    return Boolean(owner) && ownerRank.has(owner);
  };

  const compare = (left, right, fallbackRepoName) => {
    const leftRepoRank = repoRank.get(getHeadRepoKey(left, fallbackRepoName));
    const rightRepoRank = repoRank.get(getHeadRepoKey(right, fallbackRepoName));
    const leftRepoScore = typeof leftRepoRank === 'number' ? leftRepoRank : Number.POSITIVE_INFINITY;
    const rightRepoScore = typeof rightRepoRank === 'number' ? rightRepoRank : Number.POSITIVE_INFINITY;
    if (leftRepoScore !== rightRepoScore) {
      return leftRepoScore - rightRepoScore;
    }

    const leftOwnerRank = ownerRank.get(normalizeLower(getHeadOwner(left)));
    const rightOwnerRank = ownerRank.get(normalizeLower(getHeadOwner(right)));
    const leftOwnerScore = typeof leftOwnerRank === 'number' ? leftOwnerRank : Number.POSITIVE_INFINITY;
    const rightOwnerScore = typeof rightOwnerRank === 'number' ? rightOwnerRank : Number.POSITIVE_INFINITY;
    if (leftOwnerScore !== rightOwnerScore) {
      return leftOwnerScore - rightOwnerScore;
    }

    return 0;
  };

  return { matches, compare };
};

const getRepoDefaultBranch = async (octokit, repo) => {
  const repoKey = normalizeRepoKey(repo?.owner, repo?.repo);
  if (!repoKey) {
    return null;
  }

  const cached = defaultBranchCache.get(repoKey);
  if (cached && Date.now() - cached.fetchedAt < REPO_DEFAULT_BRANCH_TTL_MS) {
    return cached.defaultBranch;
  }

  // Reuse the full repo metadata if it was already fetched (expandRepoNetwork
  // calls getRepoMetadata for every candidate before the default-branch loop).
  // This avoids a redundant repos.get per repo — fewer serial GitHub calls means
  // less exposure to secondary-rate-limiting that makes PR status slow.
  const metaCached = repoMetadataCache.get(repoKey);
  if (metaCached && Date.now() - metaCached.fetchedAt < REPO_DEFAULT_BRANCH_TTL_MS) {
    const defaultBranch = normalizeText(metaCached.data?.default_branch) || null;
    defaultBranchCache.set(repoKey, { defaultBranch, fetchedAt: Date.now() });
    return defaultBranch;
  }

  try {
    const response = await octokit.rest.repos.get({
      owner: repo.owner,
      repo: repo.repo,
    });
    const defaultBranch = normalizeText(response?.data?.default_branch) || null;
    defaultBranchCache.set(repoKey, {
      defaultBranch,
      fetchedAt: Date.now(),
    });
    return defaultBranch;
  } catch (error) {
    noteIfGitHubRateLimit(error);
    return null;
  }
};

const getRepoMetadata = async (octokit, repo) => {
  const repoKey = normalizeRepoKey(repo?.owner, repo?.repo);
  if (!repoKey) {
    return null;
  }

  const cached = repoMetadataCache.get(repoKey);
  if (cached && Date.now() - cached.fetchedAt < REPO_DEFAULT_BRANCH_TTL_MS) {
    return cached.data;
  }

  try {
    const response = await octokit.rest.repos.get({
      owner: repo.owner,
      repo: repo.repo,
    });
    const data = response?.data ?? null;
    repoMetadataCache.set(repoKey, {
      data,
      fetchedAt: Date.now(),
    });
    return data;
  } catch (error) {
    noteIfGitHubRateLimit(error);
    if (error?.status === 403 || error?.status === 404) {
      repoMetadataCache.set(repoKey, {
        data: null,
        fetchedAt: Date.now(),
      });
      return null;
    }
    throw error;
  }
};

const resolveRemoteCandidates = async (directory, rankedRemoteNames) => {
  // Resolve every ranked remote concurrently — they're independent git lookups.
  // Dedup afterwards in rank order so the result is identical to the previous
  // sequential pass, just without paying each lookup's latency back-to-back.
  const resolvedRemotes = await Promise.all(
    rankedRemoteNames.map((remoteName) =>
      resolveGitHubRepoFromDirectory(directory, remoteName)
        .then((resolved) => ({ remoteName, repo: resolved?.repo || null }))
        .catch(() => ({ remoteName, repo: null })),
    ),
  );

  const results = [];
  const seenRepoKeys = new Set();
  for (const { remoteName, repo } of resolvedRemotes) {
    const repoKey = normalizeRepoKey(repo?.owner, repo?.repo);
    if (!repo || !repoKey || seenRepoKeys.has(repoKey)) {
      continue;
    }
    seenRepoKeys.add(repoKey);
    results.push({ remoteName, repo });
  }

  return results;
};

const expandRepoNetwork = async (octokit, candidates) => {
  const expanded = [];
  const seenRepoKeys = new Set();

  const pushCandidate = (repo, remoteName, priority) => {
    const repoKey = normalizeRepoKey(repo?.owner, repo?.repo);
    if (!repoKey || seenRepoKeys.has(repoKey)) {
      return;
    }
    seenRepoKeys.add(repoKey);
    expanded.push({ repo, remoteName, priority });
  };

  // Fetch repo metadata for all candidates concurrently (independent GET
  // /repos calls), then fold them in candidate order so dedup/priority is
  // unchanged from the sequential version.
  const metadatas = await Promise.all(
    candidates.map((candidate) =>
      getRepoMetadata(octokit, candidate.repo).then((metadata) => ({ candidate, metadata })),
    ),
  );

  for (const { candidate, metadata } of metadatas) {
    if (!metadata) {
      continue;
    }

    pushCandidate(candidate.repo, candidate.remoteName, candidate.priority);

    const parent = metadata?.parent;
    if (parent?.owner?.login && parent?.name) {
      pushCandidate({
        owner: parent.owner.login,
        repo: parent.name,
        url: parent.html_url || `https://github.com/${parent.owner.login}/${parent.name}`,
      }, candidate.remoteName, candidate.priority + 0.1);
    }

    const source = metadata?.source;
    if (source?.owner?.login && source?.name) {
      pushCandidate({
        owner: source.owner.login,
        repo: source.name,
        url: source.html_url || `https://github.com/${source.owner.login}/${source.name}`,
      }, candidate.remoteName, candidate.priority + 0.2);
    }
  }

  return expanded.sort((left, right) => left.priority - right.priority);
};

const safeListPulls = async (octokit, options) => {
  try {
    const response = await octokit.rest.pulls.list(options);
    return Array.isArray(response?.data) ? response.data : [];
  } catch (error) {
    noteIfGitHubRateLimit(error);
    if (error?.status === 404 || error?.status === 403) {
      return [];
    }
    throw error;
  }
};

// Repo-level pull list, shared across every branch resolution. Ten worktree
// branches of one repo need ONE pulls.list per state per TTL window, not ten
// per-branch query fans. In-flight requests coalesce so concurrent branch
// resolutions share a single GitHub call.
const REPO_PULLS_CACHE_TTL_MS = 45_000;
const repoPullsCache = new Map();

// Remembered answer to "what is the newest closed/merged PR for this head?",
// so discovery polls do not re-ask GitHub every few minutes.
//
// A found record barely ever changes: it would take a second PR on the same
// head, and while that one is open the open-PR path wins and never reads this
// cache at all. "No history yet" is the volatile answer, since closing or
// merging a PR elsewhere flips it, so it expires far sooner. Either way, doing
// it from OpenChamber invalidates the entry immediately.
const HISTORICAL_PR_FOUND_TTL_MS = 6 * 60 * 60 * 1000;
const HISTORICAL_PR_ABSENT_TTL_MS = 10 * 60 * 1000;
const HISTORICAL_PR_CACHE_MAX_ENTRIES = 500;
const _historicalPrCache = new Map();

const isHistoricalPrCacheFresh = (entry) => {
  if (!entry) {
    return false;
  }
  const ttl = entry.pr ? HISTORICAL_PR_FOUND_TTL_MS : HISTORICAL_PR_ABSENT_TTL_MS;
  return Date.now() - entry.fetchedAt < ttl;
};

const rememberHistoricalPr = (key, pr) => {
  _historicalPrCache.delete(key);
  _historicalPrCache.set(key, { pr, fetchedAt: Date.now() });
  if (_historicalPrCache.size > HISTORICAL_PR_CACHE_MAX_ENTRIES) {
    const oldest = _historicalPrCache.keys().next().value;
    if (oldest !== undefined) {
      _historicalPrCache.delete(oldest);
    }
  }
};

export const invalidateRepoPullsCache = (owner, repo) => {
  const prefix = `${normalizeText(owner)}/${normalizeText(repo)}::`;
  for (const key of repoPullsCache.keys()) {
    if (key.startsWith(prefix)) {
      repoPullsCache.delete(key);
    }
  }
  // A just-created PR must also clear remembered search misses for this repo.
  const repoNameLower = normalizeText(repo).toLowerCase();
  for (const key of _searchMissCache.keys()) {
    const [repoPart] = key.split('::');
    if (repoPart && repoPart.split(',').includes(repoNameLower)) {
      _searchMissCache.delete(key);
    }
  }
  // A merge or close changes the branch's PR history, so drop it too.
  const historicalPrefix = `${normalizeRepoKey(owner, repo)}::`;
  for (const key of _historicalPrCache.keys()) {
    if (key.startsWith(historicalPrefix)) {
      _historicalPrCache.delete(key);
    }
  }
};

const getRepoPulls = (octokit, repo, state, { force = false } = {}) => {
  const key = `${normalizeText(repo.owner)}/${normalizeText(repo.repo)}::${state}`;
  const cached = repoPullsCache.get(key);
  if (cached?.promise) {
    return cached.promise;
  }
  if (!force && cached && Date.now() - cached.fetchedAt < REPO_PULLS_CACHE_TTL_MS) {
    return Promise.resolve(cached);
  }

  const promise = safeListPulls(octokit, {
    owner: repo.owner,
    repo: repo.repo,
    state,
    per_page: 100,
  }).then((prs) => {
    // `complete` means the first page held everything, so a miss is
    // authoritative: this repo has no PR in this state for any branch.
    const entry = { fetchedAt: Date.now(), prs, complete: prs.length < 100 };
    repoPullsCache.set(key, entry);
    return entry;
  }).catch((error) => {
    repoPullsCache.delete(key);
    throw error;
  });
  repoPullsCache.set(key, { promise });
  return promise;
};

const parseRepoFromApiUrl = (value) => {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  try {
    const url = new URL(normalized);
    const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
    if (parts.length < 2 || parts[0] !== 'repos') {
      return null;
    }
    const owner = parts[1];
    const repo = parts[2];
    if (!owner || !repo) {
      return null;
    }
    return { owner, repo };
  } catch {
    return null;
  }
};

// Track repos where the GitHub Search API returned 403 (token lacks scope for that org)
const _searchApiDisabledRepos = new Map();
const SEARCH_API_RETRY_MS = 5 * 60 * 1000; // retry after 5 minutes

// The Search API has its own tiny quota (30/min). A branch that has no PR
// would otherwise re-search on every poll; a miss is extremely unlikely to
// change within minutes, so remember it per repo+branch and back off.
const SEARCH_MISS_RETRY_MS = 10 * 60 * 1000;
const SEARCH_MISS_CACHE_MAX_ENTRIES = 500;
const _searchMissCache = new Map();

const rememberSearchMiss = (key) => {
  _searchMissCache.delete(key);
  _searchMissCache.set(key, Date.now());
  if (_searchMissCache.size > SEARCH_MISS_CACHE_MAX_ENTRIES) {
    const oldest = _searchMissCache.keys().next().value;
    if (oldest !== undefined) {
      _searchMissCache.delete(oldest);
    }
  }
};

const searchFallbackPr = async ({ octokit, branch, repoNames }) => {
  // Build a repo key to check/store 403 status per-repo
  const repoKey = [...repoNames].sort().join(',').toLowerCase();

  // Skip if this repo set returned 403 recently
  const disabledAt = _searchApiDisabledRepos.get(repoKey);
  if (disabledAt && Date.now() - disabledAt < SEARCH_API_RETRY_MS) {
    return null;
  }

  const missKey = `${repoKey}::${normalizeText(branch)}`;
  const missedAt = _searchMissCache.get(missKey);
  if (missedAt && Date.now() - missedAt < SEARCH_MISS_RETRY_MS) {
    return null;
  }

  const normalizedRepoNames = new Set(repoNames.map((name) => normalizeLower(name)).filter(Boolean));

  // The Search API has a tiny quota, so it is only spent on live branch status.
  // Closed/merged history is resolved by the cheaper per-head repo queries.
  let response;
  try {
    response = await octokit.rest.search.issuesAndPullRequests({
      q: `is:pr state:open head:${branch}`,
      per_page: 20,
    });
    // If we get here, search API works for this repo — clear the disabled flag
    _searchApiDisabledRepos.delete(repoKey);
  } catch (error) {
    noteIfGitHubRateLimit(error);
    if (error?.status === 403) {
      _searchApiDisabledRepos.set(repoKey, Date.now());
      return null;
    }
    if (error?.status === 404) {
      rememberSearchMiss(missKey);
      return null;
    }
    throw error;
  }

  const items = Array.isArray(response?.data?.items) ? response.data.items : [];
  for (const item of items) {
    const repo = parseRepoFromApiUrl(item?.repository_url);
    if (!repo) {
      continue;
    }
    if (normalizedRepoNames.size > 0 && !normalizedRepoNames.has(normalizeLower(repo.repo))) {
      continue;
    }
    try {
      const prResponse = await octokit.rest.pulls.get({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: item.number,
      });
      const pr = prResponse?.data;
      if (!pr || normalizeText(pr.head?.ref) !== branch) {
        continue;
      }
      return {
        repo: {
          owner: repo.owner,
          repo: repo.repo,
          url: `https://github.com/${repo.owner}/${repo.repo}`,
        },
        pr,
      };
    } catch (error) {
      if (error?.status === 403 || error?.status === 404) {
        continue;
      }
      throw error;
    }
  }

  rememberSearchMiss(missKey);
  return null;
};

const isTerminalPr = (pr) => Boolean(pr) && (pr.state === 'closed' || Boolean(pr.merged_at));

/**
 * Resolve the PRs a branch is associated with in one repo target.
 *
 * Returns both candidates because they answer different questions:
 * `open` is live branch status, `historical` is the last closed/merged PR for
 * the same head. The caller must prefer an open PR from ANY target over a
 * historical one — otherwise a merged fork PR hides an open upstream PR.
 *
 * `includeHistory` is off by default and must stay that way for secondary
 * targets. Live status is worth searching the whole fork network for; history
 * is not, and doing it per target multiplied the serial GitHub calls until the
 * route hit its resolve timeout and reported no status at all.
 */
const findBranchPrCandidates = async ({ octokit, target, branch, sourceCandidates, force = false, coverage = null, includeHistory = false }) => {
  const matcher = buildSourceMatcher(sourceCandidates);
  const sourceOwners = [];
  sourceCandidates.forEach((candidate) => pushUnique(sourceOwners, candidate.repo?.owner));

  const pickPreferred = (prs) => prs
    .filter((pr) => normalizeText(pr?.head?.ref) === branch)
    .filter((pr) => matcher.matches(pr, target.repo.repo))
    .sort((left, right) => matcher.compare(left, right, target.repo.repo))[0] ?? null;

  // The shared repo-level open list answers every branch of the repo within the
  // TTL. A miss in a complete list is authoritative: no open PR exists here.
  let openListWasComplete = false;
  try {
    const listEntry = await getRepoPulls(octokit, target.repo, 'open', { force });
    const fromList = pickPreferred(listEntry.prs);
    if (fromList) {
      return { open: fromList, historical: null };
    }
    openListWasComplete = listEntry.complete;
  } catch {
    // fall through to the precise per-head queries
  }

  if (!openListWasComplete && coverage) {
    coverage.authoritative = false;
  }

  // A complete open list already proved there is no open PR in this repo. With
  // no history to look up there is nothing left to ask GitHub.
  if (openListWasComplete && !includeHistory) {
    return { open: null, historical: null };
  }

  const historicalKey = `${normalizeRepoKey(target.repo?.owner, target.repo?.repo)}::${branch}`;
  if (includeHistory && !force && openListWasComplete) {
    const cached = _historicalPrCache.get(historicalKey);
    if (isHistoricalPrCacheFresh(cached)) {
      return { open: null, historical: cached.pr };
    }
  }

  // One query per source owner. With history enabled `state: 'all'` answers
  // both questions at once, so asking for history never costs an extra call.
  let historical = null;
  for (const owner of sourceOwners) {
    const directCandidates = await safeListPulls(octokit, {
      owner: target.repo.owner,
      repo: target.repo.repo,
      state: includeHistory ? 'all' : 'open',
      head: `${owner}:${branch}`,
      per_page: 100,
    });
    const openMatch = pickPreferred(directCandidates.filter((pr) => !isTerminalPr(pr)));
    if (openMatch) {
      return { open: openMatch, historical: null };
    }
    if (includeHistory && !historical) {
      // Among past PRs for the same head the newest one is the relevant record.
      historical = directCandidates
        .filter((pr) => normalizeText(pr?.head?.ref) === branch)
        .filter((pr) => matcher.matches(pr, target.repo.repo))
        .filter(isTerminalPr)
        .sort((left, right) => (right?.number ?? 0) - (left?.number ?? 0))[0] ?? null;
    }
  }

  if (includeHistory) {
    rememberHistoricalPr(historicalKey, historical);
  }
  return { open: null, historical };
};

// Exported for focused unit tests of open-versus-historical branch matching.
export { findBranchPrCandidates };

export async function resolveGitHubPrStatus({ octokit, directory, branch, remoteName, force = false }) {
  // A deleted worktree can still have a session in the sidebar that keeps
  // requesting its PR status. Bail before touching git or GitHub for a
  // directory that no longer exists — otherwise every poll spends a git call
  // (and the remote/repo resolution that follows) on a path that's gone.
  if (!(await directoryExists(directory))) {
    return { repo: null, pr: null, defaultBranch: null, resolvedRemoteName: null };
  }

  const normalizedBranch = normalizeText(branch);
  const normalizedRemoteName = normalizeText(remoteName) || 'origin';

  const [status, remotes] = await Promise.all([
    getStatus(directory).catch(() => null),
    getRemotes(directory).catch(() => []),
  ]);

  const trackingRemoteName = parseTrackingRemoteName(status?.tracking);
  const trackingBranchName = parseTrackingBranchName(status?.tracking);
  const branchCandidates = [];
  pushUnique(branchCandidates, normalizedBranch);
  pushUnique(branchCandidates, trackingBranchName);
  const rankedRemoteNames = rankRemoteNames(
    Array.isArray(remotes) ? remotes.map((remote) => remote?.name).filter(Boolean) : [],
    normalizedRemoteName,
    trackingRemoteName,
  );

  const resolvedRemoteTargets = await resolveRemoteCandidates(directory, rankedRemoteNames);
  const resolvedTargets = await expandRepoNetwork(
    octokit,
    resolvedRemoteTargets.map((target, index) => ({ ...target, priority: index })),
  );
  if (resolvedTargets.length === 0) {
    return {
      repo: null,
      pr: null,
      defaultBranch: null,
      resolvedRemoteName: null,
    };
  }

  // Only the repo this branch actually pushes to (the ranked-first remote)
  // and its fork network can be the SOURCE of the branch's PRs. Other
  // configured remotes — a maintainer's checkout often carries contributor
  // forks — are places to look for an open PR, but their `owner:branch`
  // heads are unrelated branches that merely share a name; treating them as
  // sources made a fork's closed `main` PR show up on the local main.
  const primaryRemoteName = resolvedTargets[0]?.remoteName ?? null;
  const sourceCandidates = resolvedTargets.filter(
    (target) => target.remoteName === primaryRemoteName,
  );
  // When every consulted repo list was complete, a no-PR result is
  // authoritative and the expensive Search API fallback is pointless.
  const coverage = { authoritative: true };

  let fallbackRepo = resolvedTargets[0].repo;
  let fallbackRemoteName = resolvedTargets[0].remoteName;
  let fallbackDefaultBranch = await getRepoDefaultBranch(octokit, fallbackRepo);

  // The first closed/merged PR found, in target priority order. It is only
  // returned once every target has been checked for an open PR, so an open
  // upstream PR always wins over a merged fork PR for the same head.
  let historicalMatch = null;

  for (const target of resolvedTargets) {
    const defaultBranch = await getRepoDefaultBranch(octokit, target.repo);
    if (!fallbackRepo) {
      fallbackRepo = target.repo;
      fallbackRemoteName = target.remoteName;
      fallbackDefaultBranch = defaultBranch;
    }

    const hasCrossRepoSource = sourceCandidates.some((candidate) => normalizeRepoKey(candidate.repo?.owner, candidate.repo?.repo) !== normalizeRepoKey(target.repo?.owner, target.repo?.repo));
    for (const candidateBranch of branchCandidates) {
      if (defaultBranch && defaultBranch === candidateBranch && !hasCrossRepoSource) {
        continue;
      }

      // History is only asked of the branch's own repo and its own name: the
      // ranked-first target is the remote this branch actually pushes to.
      // Searching the rest of the fork network for history would multiply
      // serial GitHub calls for no additional user-visible information.
      const isPrimaryAssociation = target === resolvedTargets[0] && candidateBranch === branchCandidates[0];

      const { open, historical } = await findBranchPrCandidates({
        octokit,
        target,
        branch: candidateBranch,
        sourceCandidates,
        force,
        coverage,
        includeHistory: isPrimaryAssociation,
      });
      if (open) {
        return {
          repo: target.repo,
          pr: open,
          defaultBranch,
          resolvedRemoteName: target.remoteName,
        };
      }
      if (historical && !historicalMatch) {
        historicalMatch = {
          repo: target.repo,
          pr: historical,
          defaultBranch,
          resolvedRemoteName: target.remoteName,
        };
      }
    }
  }

  for (const candidateBranch of branchCandidates) {
    if (coverage.authoritative) {
      break;
    }
    const fallbackSearch = await searchFallbackPr({
      octokit,
      branch: candidateBranch,
      repoNames: resolvedTargets.map((target) => target.repo.repo),
    });
    if (fallbackSearch) {
      return {
        repo: fallbackSearch.repo,
        pr: fallbackSearch.pr,
        defaultBranch: await getRepoDefaultBranch(octokit, fallbackSearch.repo),
        resolvedRemoteName: null,
      };
    }
  }

  if (historicalMatch) {
    return historicalMatch;
  }

  return {
    repo: fallbackRepo,
    pr: null,
    defaultBranch: fallbackDefaultBranch,
    resolvedRemoteName: fallbackRemoteName,
  };
}

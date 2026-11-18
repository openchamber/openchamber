import { stat } from 'node:fs/promises';
import { getRemotes, getTrackingBranch, isAncestorOfHead, isPatchEquivalentOfHead } from '../git/index.js';
import { resolveGitHubRepoFromDirectory } from './repo/index.js';
import { noteIfGitHubRateLimit } from './rate-limit.js';
import { getOctokitCacheIdentity } from './octokit.js';
import { hasProperty, isDiscoveryText, isCacheIdentity } from './contracts.js';
import type { Octokit, RestEndpointMethodTypes, DiscoveryPull as Pull, DiscoveryMetadata as RepoMetadata, DiscoveryRepository as Repository, RemoteCandidate, RankedCandidate, HistoricalEntry, PullList, PendingPullList, StatusInput, FoundPull, FindBranchPrInput } from './contracts.js';

const directoryExists = async (dir: string) => {
  if (!dir) return false;
  try {
    await stat(dir);
    return true;
  } catch {
    return false;
  }
};

const REPO_DEFAULT_BRANCH_TTL_MS = 5 * 60_000;
const defaultBranchCache = new Map<string, { defaultBranch: string | null; fetchedAt: number }>();
const repoMetadataCache = new Map<string, { data: RepoMetadata | null; fetchedAt: number }>();

const normalizeText = (value: string | null | undefined) => isDiscoveryText(value) ? value.trim() : '';
const normalizeLower = (value: string | null | undefined) => normalizeText(value).toLowerCase();
const normalizeRepoKey = (owner: string | undefined, repo: string | undefined) => {
  const normalizedOwner = normalizeLower(owner);
  const normalizedRepo = normalizeLower(repo);
  if (!normalizedOwner || !normalizedRepo) {
    return '';
  }
  return `${normalizedOwner}/${normalizedRepo}`;
};
const scopedCacheKey = (octokit: Octokit, key: string) => {
  const identity = getOctokitCacheIdentity(octokit);
  return identity && key ? `${key}::${identity}` : key;
};
const repoCacheKey = (repo: Repository | null | undefined, extra = '') => {
  const base = normalizeRepoKey(repo?.owner, repo?.repo);
  if (!base) {
    return '';
  }
  const host = normalizeLower(repo?.host) || 'github.com';
  const key = `${host}::${base}`;
  return extra ? `${key}::${extra}` : key;
};
const parseTrackingRemoteName = (trackingBranch: string | null) => {
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

const parseTrackingBranchName = (trackingBranch: string | null) => {
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

const pushUnique = (collection: string[], value: string | null | undefined, keyFn = normalizeLower) => {
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

const rankRemoteNames = (remoteNames: string[], explicitRemoteName: string, trackingRemoteName: string) => {
  const ranked: string[] = [];
  pushUnique(ranked, explicitRemoteName);

  if (trackingRemoteName) {
    pushUnique(ranked, trackingRemoteName);
  }

  pushUnique(ranked, 'origin');
  pushUnique(ranked, 'upstream');
  remoteNames.forEach((name) => pushUnique(ranked, name));
  return ranked;
};

const getHeadOwner = (pr: Pull) => {
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

const getHeadRepoKey = (pr: Pull, fallbackRepoName: string) => {
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

const buildSourceMatcher = (sourceCandidates: RemoteCandidate[]) => {
  const repoRank = new Map<string, number>();
  const ownerRank = new Map<string, number>();

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

  const matches = (pr: Pull, fallbackRepoName: string) => {
    const repoKey = getHeadRepoKey(pr, fallbackRepoName);
    if (repoKey && repoRank.has(repoKey)) {
      return true;
    }
    const owner = normalizeLower(getHeadOwner(pr));
    return Boolean(owner) && ownerRank.has(owner);
  };

  const compare = (left: Pull, right: Pull, fallbackRepoName: string) => {
    const leftRepoRank = repoRank.get(getHeadRepoKey(left, fallbackRepoName));
    const rightRepoRank = repoRank.get(getHeadRepoKey(right, fallbackRepoName));
    const leftRepoScore = leftRepoRank ?? Number.POSITIVE_INFINITY;
    const rightRepoScore = rightRepoRank ?? Number.POSITIVE_INFINITY;
    if (leftRepoScore !== rightRepoScore) {
      return leftRepoScore - rightRepoScore;
    }

    const leftOwnerRank = ownerRank.get(normalizeLower(getHeadOwner(left)));
    const rightOwnerRank = ownerRank.get(normalizeLower(getHeadOwner(right)));
    const leftOwnerScore = leftOwnerRank ?? Number.POSITIVE_INFINITY;
    const rightOwnerScore = rightOwnerRank ?? Number.POSITIVE_INFINITY;
    if (leftOwnerScore !== rightOwnerScore) {
      return leftOwnerScore - rightOwnerScore;
    }

    return 0;
  };

  return { matches, compare };
};

const getRepoDefaultBranch = async (octokit: Octokit, repo: Repository) => {
  const normalizedRepoKey = repoCacheKey(repo);
  const repoKey = scopedCacheKey(octokit, normalizedRepoKey);
  if (!normalizedRepoKey) {
    return null;
  }

  const cached = repoKey ? defaultBranchCache.get(repoKey) : null;
  if (cached && Date.now() - cached.fetchedAt < REPO_DEFAULT_BRANCH_TTL_MS) {
    return cached.defaultBranch;
  }

  const metaCached = repoKey ? repoMetadataCache.get(repoKey) : null;
  if (metaCached && Date.now() - metaCached.fetchedAt < REPO_DEFAULT_BRANCH_TTL_MS) {
    const defaultBranch = normalizeText(metaCached.data?.default_branch) || null;
    if (repoKey) defaultBranchCache.set(repoKey, { defaultBranch, fetchedAt: Date.now() });
    return defaultBranch;
  }

  try {
    const response = await octokit.rest.repos.get({
      owner: repo.owner,
      repo: repo.repo,
    });
    const defaultBranch = normalizeText(response?.data?.default_branch) || null;
    if (repoKey) {
      defaultBranchCache.set(repoKey, {
        defaultBranch,
        fetchedAt: Date.now(),
      });
    }
    return defaultBranch;
  } catch (error) {
    noteIfGitHubRateLimit(error);
    return null;
  }
};

const getRepoMetadata = async (octokit: Octokit, repo: Repository) => {
  const normalizedRepoKey = repoCacheKey(repo);
  const repoKey = scopedCacheKey(octokit, normalizedRepoKey);
  if (!normalizedRepoKey) {
    return null;
  }

  const cached = repoKey ? repoMetadataCache.get(repoKey) : null;
  if (cached && Date.now() - cached.fetchedAt < REPO_DEFAULT_BRANCH_TTL_MS) {
    return cached.data;
  }

  try {
    const response = await octokit.rest.repos.get({
      owner: repo.owner,
      repo: repo.repo,
    });
    const data = response?.data ?? null;
    if (repoKey) {
      repoMetadataCache.set(repoKey, {
        data,
        fetchedAt: Date.now(),
      });
    }
    return data;
  } catch (error) {
    noteIfGitHubRateLimit(error);
    if (hasProperty(error, 'status') && error.status === 404) {
      if (repoKey) {
        repoMetadataCache.set(repoKey, {
          data: null,
          fetchedAt: Date.now(),
        });
      }
      return null;
    }
    throw error;
  }
};

const resolveRemoteCandidates = async (directory: string, rankedRemoteNames: string[]) => {
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
    const repoKey = repoCacheKey(repo);
    if (!repo || !repoKey || seenRepoKeys.has(repoKey)) {
      continue;
    }
    seenRepoKeys.add(repoKey);
    results.push({ remoteName, repo });
  }

  return results;
};

const expandRepoNetwork = async (octokit: Octokit, candidates: RankedCandidate[]) => {
  const expanded: RankedCandidate[] = [];
  const seenRepoKeys = new Set();

  const pushCandidate = (repo: Repository, remoteName: string, priority: number) => {
    const repoKey = repoCacheKey(repo);
    if (!repoKey || seenRepoKeys.has(repoKey)) {
      return;
    }
    seenRepoKeys.add(repoKey);
    expanded.push({ repo, remoteName, priority });
  };

  const metadatas = await Promise.all(
    candidates.map((candidate) =>
      getRepoMetadata(octokit, candidate.repo)
        .then((metadata) => ({ candidate, metadata, refusal: undefined }))
        .catch((error) => {
          if (!(hasProperty(error, 'status') && error.status === 403)) throw error;
          return { candidate, metadata: null, refusal: error };
        }),
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
        host: candidate.repo?.host ?? null,
        url: parent.html_url || `https://${candidate.repo?.host || 'github.com'}/${parent.owner.login}/${parent.name}`,
      }, candidate.remoteName, candidate.priority + 0.1);
    }

    const source = metadata?.source;
    if (source?.owner?.login && source?.name) {
      pushCandidate({
        owner: source.owner.login,
        repo: source.name,
        host: candidate.repo?.host ?? null,
        url: source.html_url || `https://${candidate.repo?.host || 'github.com'}/${source.owner.login}/${source.name}`,
      }, candidate.remoteName, candidate.priority + 0.2);
    }
  }

  const refusal = metadatas.find((entry) => entry.refusal)?.refusal;
  if (expanded.length === 0 && refusal) {
    throw refusal;
  }

  return expanded.sort((left, right) => left.priority - right.priority);
};

const safeListPulls = async (octokit: Octokit, options: RestEndpointMethodTypes['pulls']['list']['parameters']): Promise<Pull[]> => {
  try {
    const response = await octokit.rest.pulls.list(options);
    return Array.isArray(response?.data) ? response.data : [];
  } catch (error) {
    noteIfGitHubRateLimit(error);
    if (hasProperty(error, 'status') && (error.status === 404 || error.status === 403)) {
      return [];
    }
    throw error;
  }
};

const REPO_PULLS_CACHE_TTL_MS = 45_000;
const repoPullsCache = new Map<string, PullList | PendingPullList>();

const HISTORICAL_PR_FOUND_TTL_MS = 6 * 60 * 60 * 1000;
const HISTORICAL_PR_ABSENT_TTL_MS = 10 * 60 * 1000;
const HISTORICAL_PR_CACHE_MAX_ENTRIES = 500;
const _historicalPrCache = new Map<string, HistoricalEntry>();
const pendingHistoricalPrWrites = new Map<object, string>();

const isHistoricalPrCacheFresh = (entry: HistoricalEntry | undefined): entry is HistoricalEntry => {
  if (!entry) {
    return false;
  }
  const ttl = entry.pr ? HISTORICAL_PR_FOUND_TTL_MS : HISTORICAL_PR_ABSENT_TTL_MS;
  return Date.now() - entry.fetchedAt < ttl;
};

const rememberHistoricalPr = (key: string, pr: Pull | null) => {
  _historicalPrCache.delete(key);
  _historicalPrCache.set(key, { pr, fetchedAt: Date.now() });
  if (_historicalPrCache.size > HISTORICAL_PR_CACHE_MAX_ENTRIES) {
    const oldest = _historicalPrCache.keys().next().value;
    if (oldest !== undefined) {
      _historicalPrCache.delete(oldest);
    }
  }
};

export const invalidateRepoPullsCache = (owner: string, repo: string, octokitOrCacheIdentity: Octokit | string | null = null) => {
  const requestedIdentity = isCacheIdentity(octokitOrCacheIdentity)
    ? octokitOrCacheIdentity
    : getOctokitCacheIdentity(octokitOrCacheIdentity);
  const matchesIdentity = (key: string) => !requestedIdentity || key.split('::').includes(requestedIdentity);
  const repoKey = normalizeRepoKey(owner, repo);
  for (const [key, entry] of repoPullsCache) {
    if (repoKey && key.split('::').includes(repoKey) && matchesIdentity(key)) {
      if (entry.token) entry.token.invalidated = true;
      repoPullsCache.delete(key);
    }
  }
  const repoNameLower = normalizeText(repo).toLowerCase();
  for (const key of _searchMissCache.keys()) {
    if (repoKey && key.split('::').some((part) => part.split(',').includes(repoNameLower)) && matchesIdentity(key)) {
      _searchMissCache.delete(key);
    }
  }
  for (const [token, key] of pendingSearchMissWrites) {
    if (repoKey && key.split('::').some((part) => part.split(',').includes(repoNameLower)) && matchesIdentity(key)) {
      pendingSearchMissWrites.delete(token);
    }
  }
  for (const key of _historicalPrCache.keys()) {
    if (key.split('::').includes(repoKey) && matchesIdentity(key)) {
      _historicalPrCache.delete(key);
    }
  }
  for (const [token, key] of pendingHistoricalPrWrites) {
    if (key.split('::').includes(repoKey) && matchesIdentity(key)) {
      pendingHistoricalPrWrites.delete(token);
    }
  }
};

const getRepoPulls = (octokit: Octokit, repo: Repository, state: 'open' | 'closed' | 'all', { force = false } = {}) => {
  const key = scopedCacheKey(octokit, repoCacheKey(repo, state));
  if (!key) {
    return safeListPulls(octokit, {
      owner: repo.owner,
      repo: repo.repo,
      state,
      per_page: 100,
    }).then((prs) => ({ fetchedAt: Date.now(), prs, complete: prs.length < 100 }));
  }
  const cached = repoPullsCache.get(key);
  if (cached?.promise) {
    return cached.promise;
  }
  if (!force && cached && Date.now() - cached.fetchedAt < REPO_PULLS_CACHE_TTL_MS) {
    return Promise.resolve(cached);
  }

  const token = { invalidated: false };
  const promise = safeListPulls(octokit, {
    owner: repo.owner,
    repo: repo.repo,
    state,
    per_page: 100,
  }).then((prs) => {
    const entry = { fetchedAt: Date.now(), prs, complete: prs.length < 100 };
    if (!token.invalidated && repoPullsCache.get(key)?.token === token) {
      repoPullsCache.set(key, entry);
    }
    return entry;
  }).catch((error) => {
    if (repoPullsCache.get(key)?.token === token) repoPullsCache.delete(key);
    throw error;
  });
  repoPullsCache.set(key, { promise, token });
  return promise;
};

const parseRepoFromApiUrl = (value: string | undefined) => {
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

const _searchApiDisabledRepos = new Map<string, number>();
const SEARCH_API_RETRY_MS = 5 * 60 * 1000;

const SEARCH_MISS_RETRY_MS = 10 * 60 * 1000;
const SEARCH_MISS_CACHE_MAX_ENTRIES = 500;
const _searchMissCache = new Map<string, number>();
const pendingSearchMissWrites = new Map<object, string>();

const rememberSearchMiss = (key: string) => {
  _searchMissCache.delete(key);
  _searchMissCache.set(key, Date.now());
  if (_searchMissCache.size > SEARCH_MISS_CACHE_MAX_ENTRIES) {
    const oldest = _searchMissCache.keys().next().value;
    if (oldest !== undefined) {
      _searchMissCache.delete(oldest);
    }
  }
};

const searchFallbackPr = async ({ octokit, branch, repoNames, host }: { octokit: Octokit; branch: string; repoNames: string[]; host: string | null | undefined }) => {
  const repoKey = scopedCacheKey(octokit, `${normalizeLower(host) || 'github.com'}::${[...repoNames].sort().join(',').toLowerCase()}`);

  const disabledAt = repoKey ? _searchApiDisabledRepos.get(repoKey) : null;
  if (disabledAt && Date.now() - disabledAt < SEARCH_API_RETRY_MS) {
    return null;
  }

  const missKey = repoKey ? `${repoKey}::${normalizeText(branch)}` : '';
  const missedAt = missKey ? _searchMissCache.get(missKey) : null;
  if (missedAt && Date.now() - missedAt < SEARCH_MISS_RETRY_MS) {
    return null;
  }

  const writeToken = missKey ? {} : null;
  if (writeToken) pendingSearchMissWrites.set(writeToken, missKey);

  try {
    const normalizedRepoNames = new Set(repoNames.map((name) => normalizeLower(name)).filter(Boolean));

    let response;
    try {
      response = await octokit.rest.search.issuesAndPullRequests({
        q: `is:pr state:open head:${branch}`,
        per_page: 20,
      });
      if (repoKey) _searchApiDisabledRepos.delete(repoKey);
    } catch (error) {
      noteIfGitHubRateLimit(error);
      if (hasProperty(error, 'status') && error.status === 403) {
        if (repoKey) _searchApiDisabledRepos.set(repoKey, Date.now());
        return null;
      }
      if (hasProperty(error, 'status') && error.status === 404) {
        if (missKey && writeToken && pendingSearchMissWrites.has(writeToken)) rememberSearchMiss(missKey);
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
            host: normalizeLower(host) || null,
            url: `https://${normalizeLower(host) || 'github.com'}/${repo.owner}/${repo.repo}`,
          },
          pr,
        };
      } catch (error) {
        if (hasProperty(error, 'status') && (error.status === 403 || error.status === 404)) {
          continue;
        }
        throw error;
      }
    }

    if (missKey && writeToken && pendingSearchMissWrites.has(writeToken)) rememberSearchMiss(missKey);
    return null;
  } finally {
    if (writeToken) pendingSearchMissWrites.delete(writeToken);
  }
};

const isTerminalPr = (pr: Pull) => Boolean(pr) && (pr.state === 'closed' || Boolean(pr.merged_at));

const isHistoricalPrOfCheckout = async (directory: string, pr: Pick<Pull, 'head'>, {
  isAncestor = isAncestorOfHead,
  isPatchEquivalent = isPatchEquivalentOfHead,
} = {}) => {
  const headSha = normalizeText(pr?.head?.sha);
  if (!headSha) {
    return false;
  }
  try {
    if (await isAncestor(directory, headSha)) {
      return true;
    }
  } catch {
    return false;
  }
  try {
    return await isPatchEquivalent(directory, headSha);
  } catch {
    return false;
  }
};

export { isHistoricalPrOfCheckout };

const findBranchPrCandidates = async ({ octokit, target, branch, sourceCandidates, force = false, coverage = null, includeHistory = false }: FindBranchPrInput) => {
  const matcher = buildSourceMatcher(sourceCandidates);
  const sourceOwners: string[] = [];
  sourceCandidates.forEach((candidate) => pushUnique(sourceOwners, candidate.repo?.owner));

  const pickPreferred = (prs: Pull[]) => prs
    .filter((pr) => normalizeText(pr?.head?.ref) === branch)
    .filter((pr) => matcher.matches(pr, target.repo.repo))
    .sort((left, right) => matcher.compare(left, right, target.repo.repo))[0] ?? null;

  let openListWasComplete = false;
  try {
    const listEntry = await getRepoPulls(octokit, target.repo, 'open', { force });
    const fromList = pickPreferred(listEntry.prs);
    if (fromList) {
      return { open: fromList, historical: null };
    }
    openListWasComplete = listEntry.complete;
  } catch { openListWasComplete = false; }

  if (!openListWasComplete && coverage) {
    coverage.authoritative = false;
  }

  if (openListWasComplete && !includeHistory) {
    return { open: null, historical: null };
  }

  const historicalKey = scopedCacheKey(octokit, repoCacheKey(target.repo, `${branch}::${sourceOwners.map(normalizeLower).filter(Boolean).join(',')}`));
  if (historicalKey && includeHistory && !force && openListWasComplete) {
    const cached = _historicalPrCache.get(historicalKey);
    if (isHistoricalPrCacheFresh(cached)) {
      return { open: null, historical: cached.pr };
    }
  }

  const historicalWriteToken = historicalKey && includeHistory ? {} : null;
  if (historicalWriteToken) pendingHistoricalPrWrites.set(historicalWriteToken, historicalKey);
  try {
    let historical: Pull | null = null;
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
        historical = directCandidates
          .filter((pr) => normalizeText(pr?.head?.ref) === branch)
          .filter((pr) => matcher.matches(pr, target.repo.repo))
          .filter(isTerminalPr)
          .sort((left, right) => (right?.number ?? 0) - (left?.number ?? 0))[0] ?? null;
      }
    }

    if (historicalWriteToken && pendingHistoricalPrWrites.has(historicalWriteToken)) {
      rememberHistoricalPr(historicalKey, historical);
    }
    return { open: null, historical };
  } finally {
    if (historicalWriteToken) pendingHistoricalPrWrites.delete(historicalWriteToken);
  }
};

export { findBranchPrCandidates };

export async function resolveGitHubPrStatus({ octokit, directory, branch, remoteName, sourceRemoteName = null, force = false, requestHost }: StatusInput) {
  if (!(await directoryExists(directory))) {
    return { repo: null, pr: null, defaultBranch: null, resolvedRemoteName: null };
  }

  const normalizedBranch = normalizeText(branch);
  const normalizedRemoteName = normalizeText(remoteName) || 'origin';

  const [tracking, remotes] = await Promise.all([
    getTrackingBranch(directory).catch(() => null),
    getRemotes(directory).catch(() => []),
  ]);

  const trackingRemoteName = parseTrackingRemoteName(tracking);
  const trackingBranchName = parseTrackingBranchName(tracking);
  const branchCandidates: string[] = [];
  pushUnique(branchCandidates, normalizedBranch);
  pushUnique(branchCandidates, trackingBranchName);
  const rankedRemoteNames = rankRemoteNames(
    Array.isArray(remotes) ? remotes.map((remote) => remote?.name).filter(Boolean) : [],
    normalizedRemoteName,
    trackingRemoteName,
  );

  const resolvedRemoteTargets = await resolveRemoteCandidates(directory, rankedRemoteNames);

  const requestHostKey = normalizeLower(requestHost) || 'github.com';
  const hostTargets = resolvedRemoteTargets.filter(
    (target) => (normalizeLower(target.repo?.host) || 'github.com') === requestHostKey,
  );

  const resolvedTargets = await expandRepoNetwork(
    octokit,
    hostTargets.map((target, index) => ({ ...target, priority: index })),
  );
  if (!resolvedTargets[0]) {
    return {
      repo: null,
      pr: null,
      defaultBranch: null,
      resolvedRemoteName: null,
    };
  }

  const primaryRemoteName = resolvedTargets[0]?.remoteName ?? null;
  const contributorSources = sourceRemoteName
    ? resolvedTargets.filter((target) => target.remoteName === sourceRemoteName)
    : [];
  const sourceCandidates = contributorSources.length > 0
    ? contributorSources
    : resolvedTargets.filter((target) => target.remoteName === primaryRemoteName);
  const coverage = { authoritative: true };

  let fallbackRepo = resolvedTargets[0].repo;
  let fallbackRemoteName = resolvedTargets[0].remoteName;
  let fallbackDefaultBranch = await getRepoDefaultBranch(octokit, fallbackRepo);

  let historicalMatch: FoundPull | null = null;

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

      const isPrimaryAssociation = (target === resolvedTargets[0] || sourceCandidates.includes(target)) && candidateBranch === branchCandidates[0] && candidateBranch !== defaultBranch;

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
      host: resolvedTargets[0]?.repo?.host,
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

  if (historicalMatch && await isHistoricalPrOfCheckout(directory, historicalMatch.pr)) {
    return historicalMatch;
  }

  return {
    repo: fallbackRepo,
    pr: null,
    defaultBranch: fallbackDefaultBranch,
    resolvedRemoteName: fallbackRemoteName,
  };
}

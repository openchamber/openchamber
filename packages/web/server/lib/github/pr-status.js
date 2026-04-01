import { getRemotes, getStatus } from '../git/index.js';
import { resolveGitHubRepoFromDirectory } from './repo/index.js';

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
  } catch {
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
  const results = [];
  const seenRepoKeys = new Set();

  for (const remoteName of rankedRemoteNames) {
    const resolved = await resolveGitHubRepoFromDirectory(directory, remoteName).catch(() => ({ repo: null }));
    const repo = resolved?.repo || null;
    const repoKey = normalizeRepoKey(repo?.owner, repo?.repo);
    if (!repo || !repoKey || seenRepoKeys.has(repoKey)) {
      continue;
    }
    seenRepoKeys.add(repoKey);
    results.push({
      remoteName,
      repo,
    });
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

  for (const candidate of candidates) {
    const metadata = await getRepoMetadata(octokit, candidate.repo);
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
    if (error?.status === 404 || error?.status === 403) {
      return [];
    }
    throw error;
  }
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

const searchFallbackPr = async ({ octokit, branch, repoNames }) => {
  // Build a repo key to check/store 403 status per-repo
  const repoKey = [...repoNames].sort().join(',').toLowerCase();

  // Skip if this repo set returned 403 recently
  const disabledAt = _searchApiDisabledRepos.get(repoKey);
  if (disabledAt && Date.now() - disabledAt < SEARCH_API_RETRY_MS) {
    return null;
  }

  const normalizedRepoNames = new Set(repoNames.map((name) => normalizeLower(name)).filter(Boolean));

  for (const state of ['open', 'closed']) {
    let response;
    try {
      response = await octokit.rest.search.issuesAndPullRequests({
        q: `is:pr state:${state} head:${branch}`,
        per_page: 20,
      });
      // If we get here, search API works for this repo — clear the disabled flag
      _searchApiDisabledRepos.delete(repoKey);
    } catch (error) {
      if (error?.status === 403) {
        _searchApiDisabledRepos.set(repoKey, Date.now());
        return null;
      }
      if (error?.status === 404) {
        continue;
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
  }

  return null;
};

const findFirstMatchingPr = async ({ octokit, target, branch, sourceCandidates }) => {
  const matcher = buildSourceMatcher(sourceCandidates);
  const sourceOwners = [];
  sourceCandidates.forEach((candidate) => pushUnique(sourceOwners, candidate.repo?.owner));

  const pickPreferred = (prs) => prs
    .filter((pr) => normalizeText(pr?.head?.ref) === branch)
    .filter((pr) => matcher.matches(pr, target.repo.repo))
    .sort((left, right) => matcher.compare(left, right, target.repo.repo))[0] ?? null;

  for (const state of ['open', 'closed']) {
    for (const owner of sourceOwners) {
      const directCandidates = await safeListPulls(octokit, {
        owner: target.repo.owner,
        repo: target.repo.repo,
        state,
        head: `${owner}:${branch}`,
        per_page: 100,
      });
      const direct = pickPreferred(directCandidates);
      if (direct) {
        return direct;
      }
    }

    const fallbackCandidates = await safeListPulls(octokit, {
      owner: target.repo.owner,
      repo: target.repo.repo,
      state,
      per_page: 100,
    });
    const fallback = pickPreferred(fallbackCandidates);
    if (fallback) {
      return fallback;
    }
  }

  return null;
};

export async function resolveGitHubPrStatus({ octokit, directory, branch, remoteName }) {
  const normalizedBranch = normalizeText(branch);
  const normalizedRemoteName = normalizeText(remoteName) || 'origin';

  const [status, remotes] = await Promise.all([
    getStatus(directory).catch(() => null),
    getRemotes(directory).catch(() => []),
  ]);

  const trackingRemoteName = parseTrackingRemoteName(status?.tracking);
  const rankedRemoteNames = rankRemoteNames(
    Array.isArray(remotes) ? remotes.map((remote) => remote?.name).filter(Boolean) : [],
    normalizedRemoteName,
    trackingRemoteName,
  );

  const resolvedRemoteTargets = await resolveRemoteCandidates(directory, rankedRemoteNames.slice(0, 3));
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

  const sourceCandidates = resolvedTargets.slice();

  let fallbackRepo = resolvedTargets[0].repo;
  let fallbackRemoteName = resolvedTargets[0].remoteName;
  let fallbackDefaultBranch = await getRepoDefaultBranch(octokit, fallbackRepo);

  for (const target of resolvedTargets) {
    const defaultBranch = await getRepoDefaultBranch(octokit, target.repo);
    if (!fallbackRepo) {
      fallbackRepo = target.repo;
      fallbackRemoteName = target.remoteName;
      fallbackDefaultBranch = defaultBranch;
    }
    if (defaultBranch && defaultBranch === normalizedBranch) {
      continue;
    }

    const pr = await findFirstMatchingPr({
      octokit,
      target,
      branch: normalizedBranch,
      sourceCandidates,
    });
    if (pr) {
      return {
        repo: target.repo,
        pr,
        defaultBranch,
        resolvedRemoteName: target.remoteName,
      };
    }
  }

  const fallbackSearch = await searchFallbackPr({
    octokit,
    branch: normalizedBranch,
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

  return {
    repo: fallbackRepo,
    pr: null,
    defaultBranch: fallbackDefaultBranch,
    resolvedRemoteName: fallbackRemoteName,
  };
}

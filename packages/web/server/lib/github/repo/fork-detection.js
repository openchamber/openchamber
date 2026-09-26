import { resolveGitHubRepoFromDirectory } from './index.js';

const REPO_METADATA_TTL_MS = 5 * 60_000;
const REPO_METADATA_CACHE_MAX_ENTRIES = 200;
const repoMetadataCache = new Map();

const setRepoMetadataCache = (repoKey, data) => {
  if (repoMetadataCache.size >= REPO_METADATA_CACHE_MAX_ENTRIES && !repoMetadataCache.has(repoKey)) {
    const oldest = repoMetadataCache.entries().next().value;
    if (oldest) {
      repoMetadataCache.delete(oldest[0]);
    }
  }
  repoMetadataCache.set(repoKey, { data, fetchedAt: Date.now() });
};

const normalizeRepoKey = (owner, repo) => {
  const o = typeof owner === 'string' ? owner.trim().toLowerCase() : '';
  const r = typeof repo === 'string' ? repo.trim().toLowerCase() : '';
  if (!o || !r) return '';
  return `${o}/${r}`;
};

const getRepoMetadata = async (octokit, repo, { signal = undefined } = {}) => {
  const repoKey = normalizeRepoKey(repo?.owner, repo?.repo);
  if (!repoKey) return null;

  if (signal?.aborted) {
    throw signal.reason || new Error('GitHub repository lookup was cancelled');
  }

  const cached = repoMetadataCache.get(repoKey);
  if (cached && Date.now() - cached.fetchedAt < REPO_METADATA_TTL_MS) {
    return cached.data;
  }

  try {
    const request = {
      owner: repo.owner,
      repo: repo.repo,
    };
    if (signal) request.signal = signal;
    const response = await octokit.rest.repos.get(request);
    const data = response?.data ?? null;
    setRepoMetadataCache(repoKey, data);
    return data;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error?.status === 403 || error?.status === 404) {
      setRepoMetadataCache(repoKey, null);
      return null;
    }
    throw error;
  }
};

/**
 * Resolve the repo network for a directory. If the origin repo is a fork,
 * includes the parent/source (upstream) repo in the result.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} directory
 * @param {string} [remoteName='origin']
 * @returns {Promise<Array<{ owner: string, repo: string, url: string, source: string }> | null>}
 *   Array of repos to query (origin first, then upstream), or null if not a fork.
 */
export async function resolveRepoNetwork(octokit, directory, remoteName = 'origin', { signal = undefined } = {}) {
  const { repo } = await resolveGitHubRepoFromDirectory(directory, remoteName, signal ? { signal } : {}).catch((error) => {
    if (signal?.aborted) throw error;
    return { repo: null };
  });
  if (!repo) return null;

  const metadata = await getRepoMetadata(octokit, repo, { signal });
  if (!metadata) return [{ ...repo, source: 'origin' }];

  const result = [{ ...repo, source: 'origin' }];
  const seenKeys = new Set([normalizeRepoKey(repo.owner, repo.repo)]);

  const parent = metadata?.parent;
  if (parent?.owner?.login && parent?.name) {
    const key = normalizeRepoKey(parent.owner.login, parent.name);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      result.push({
        owner: parent.owner.login,
        repo: parent.name,
        url: parent.html_url || `https://github.com/${parent.owner.login}/${parent.name}`,
        source: 'upstream',
      });
    }
  }

  const source = metadata?.source;
  if (source?.owner?.login && source?.name) {
    const key = normalizeRepoKey(source.owner.login, source.name);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      result.push({
        owner: source.owner.login,
        repo: source.name,
        url: source.html_url || `https://github.com/${source.owner.login}/${source.name}`,
        source: 'upstream',
      });
    }
  }

  // If no parent/source found, repo is not a fork
  if (result.length === 1) return null;

  return result;
}

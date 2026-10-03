import { resolveGitHubRepoFromDirectory } from './index.js';
import { getOctokitCacheIdentity } from '../octokit.js';

const REPO_METADATA_TTL_MS = 5 * 60_000;
const REPO_METADATA_CACHE_MAX_ENTRIES = 200;
const repoMetadataCache = new Map();

const isPlainObject = (value) => Object.prototype.toString.call(value) === '[object Object]';
const isProviderString = (value) => Object.prototype.toString.call(value) === '[object String]';

const isValidRelatedRepo = (value) => isPlainObject(value)
  && isProviderString(value.owner?.login)
  && value.owner.login.trim().length > 0
  && isProviderString(value.name)
  && value.name.trim().length > 0;

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

const getRepoMetadata = async (octokit, repo, options = {}) => {
  const identity = getOctokitCacheIdentity(octokit);
  const normalizedRepoKey = normalizeRepoKey(repo?.owner, repo?.repo);
  const repoKey = identity && normalizedRepoKey ? `${normalizedRepoKey}::${identity}` : '';
  if (!normalizedRepoKey) return null;

  const cached = repoKey ? repoMetadataCache.get(repoKey) : null;
  if (cached && Date.now() - cached.fetchedAt < REPO_METADATA_TTL_MS) {
    return cached.data;
  }

  try {
    const response = await octokit.rest.repos.get({
      owner: repo.owner,
      repo: repo.repo,
    });
    const data = response?.data ?? null;
    if (repoKey) setRepoMetadataCache(repoKey, data);
    return data;
  } catch (error) {
    if (error?.status === 403 || error?.status === 404) {
      if (options.strictErrors) throw error;
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
 * @param {{ strictErrors?: boolean }} [options]
 * @returns {Promise<Array<{ owner: string, repo: string, url: string, source: string }> | null>}
 *   Array of repos to query (origin first, then upstream), or null if not a fork.
 */
export async function resolveRepoNetwork(octokit, directory, remoteName = 'origin', options = {}) {
  const resolved = resolveGitHubRepoFromDirectory(directory, remoteName);
  const { repo } = options.strictErrors ? await resolved : await resolved.catch(() => ({ repo: null }));
  if (!repo) return null;

  const metadata = await getRepoMetadata(octokit, repo, options);
  if (options.strictErrors) {
    if (!isPlainObject(metadata) || (metadata.fork !== true && metadata.fork !== false)) {
      throw new Error('GitHub returned invalid repository metadata');
    }
    for (const field of ['parent', 'source']) {
      if (metadata[field] != null && !isValidRelatedRepo(metadata[field])) {
        throw new Error(`GitHub returned invalid repository ${field} metadata`);
      }
    }
    if (metadata.fork && !isValidRelatedRepo(metadata.parent) && !isValidRelatedRepo(metadata.source)) {
      throw new Error('GitHub returned invalid fork metadata');
    }
  }
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

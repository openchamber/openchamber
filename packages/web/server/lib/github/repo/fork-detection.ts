import { resolveGitHubRepoFromDirectory } from './index.js';
import { getOctokitCacheIdentity } from '../octokit.js';
import type { Octokit } from '@octokit/rest';
import type { GitHubRepository } from './index.js';

type RepoMetadata = Awaited<ReturnType<Octokit['rest']['repos']['get']>>['data'];

export interface RepoNetworkOptions {
  strictErrors?: boolean;
}

export interface NetworkRepository extends GitHubRepository {
  source: 'origin' | 'upstream';
}

const REPO_METADATA_TTL_MS = 5 * 60_000;
const REPO_METADATA_CACHE_MAX_ENTRIES = 200;
const repoMetadataCache = new Map<string, { data: RepoMetadata | null; fetchedAt: number }>();

const isPlainObject = <T>(value: T): value is NonNullable<T> & object => Object.prototype.toString.call(value) === '[object Object]';
const isProviderString = (value: string | undefined) => Object.prototype.toString.call(value) === '[object String]';
const isRepoKeyString = (value: unknown): value is string => typeof value === 'string';

const isValidRelatedRepo = (value: RepoMetadata['parent'] | RepoMetadata['source']) => isPlainObject(value)
  && isProviderString(value.owner?.login)
  && value.owner.login.trim().length > 0
  && isProviderString(value.name)
  && value.name.trim().length > 0;

const setRepoMetadataCache = (repoKey: string, data: RepoMetadata | null) => {
  if (repoMetadataCache.size >= REPO_METADATA_CACHE_MAX_ENTRIES && !repoMetadataCache.has(repoKey)) {
    const oldest = repoMetadataCache.entries().next().value;
    if (oldest) {
      repoMetadataCache.delete(oldest[0]);
    }
  }
  repoMetadataCache.set(repoKey, { data, fetchedAt: Date.now() });
};

const normalizeRepoKey = (owner: string, repo: string, host: string) => {
  const o = isRepoKeyString(owner) ? owner.trim().toLowerCase() : '';
  const r = isRepoKeyString(repo) ? repo.trim().toLowerCase() : '';
  if (!o || !r) return '';
  const h = String(host ?? '').trim().toLowerCase();
  return `${h || 'github.com'}::${o}/${r}`;
};

const hasStatus = (value: unknown): value is { status: unknown } => value !== null
  && (typeof value === 'object' || typeof value === 'function') && 'status' in value;

const getRepoMetadata = async (octokit: Octokit, repo: GitHubRepository, options: RepoNetworkOptions = {}) => {
  const identity = getOctokitCacheIdentity(octokit);
  const normalizedRepoKey = normalizeRepoKey(repo?.owner, repo?.repo, repo?.host);
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
    if (hasStatus(error) && (error.status === 403 || error.status === 404)) {
      if (options.strictErrors) throw error;
      return null;
    }
    throw error;
  }
};

export async function resolveRepoNetwork(octokit: Octokit, directory: string, remoteName = 'origin', options: RepoNetworkOptions = {}): Promise<NetworkRepository[] | null> {
  const resolved = resolveGitHubRepoFromDirectory(directory, remoteName);
  const { repo } = options.strictErrors ? await resolved : await resolved.catch(() => ({ repo: null }));
  if (!repo) return null;

  const metadata = await getRepoMetadata(octokit, repo, options);
  if (options.strictErrors) {
    if (!isPlainObject(metadata) || (metadata.fork !== true && metadata.fork !== false)) {
      throw new Error('GitHub returned invalid repository metadata');
    }
    const relatedFields: ('parent' | 'source')[] = ['parent', 'source'];
    for (const field of relatedFields) {
      if (metadata[field] != null && !isValidRelatedRepo(metadata[field])) {
        throw new Error(`GitHub returned invalid repository ${field} metadata`);
      }
    }
    if (metadata.fork && !isValidRelatedRepo(metadata.parent) && !isValidRelatedRepo(metadata.source)) {
      throw new Error('GitHub returned invalid fork metadata');
    }
  }
  if (!metadata) return [{ ...repo, source: 'origin' }];

  const result: NetworkRepository[] = [{ ...repo, source: 'origin' }];
  const seenKeys = new Set([normalizeRepoKey(repo.owner, repo.repo, repo.host)]);

  const parent = metadata?.parent;
  if (parent?.owner?.login && parent?.name) {
    const key = normalizeRepoKey(parent.owner.login, parent.name, repo.host);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      result.push({
        owner: parent.owner.login,
        repo: parent.name,
        host: repo.host,
        url: parent.html_url || `https://${repo.host || 'github.com'}/${parent.owner.login}/${parent.name}`,
        source: 'upstream',
      });
    }
  }

  const source = metadata?.source;
  if (source?.owner?.login && source?.name) {
    const key = normalizeRepoKey(source.owner.login, source.name, repo.host);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      result.push({
        owner: source.owner.login,
        repo: source.name,
        host: repo.host,
        url: source.html_url || `https://${repo.host || 'github.com'}/${source.owner.login}/${source.name}`,
        source: 'upstream',
      });
    }
  }

  if (result.length === 1) return null;

  return result;
}

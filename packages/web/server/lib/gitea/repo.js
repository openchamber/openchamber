import { getRemotes, getStatus } from '../git/index.js';
import { isString } from '../shared/guards.js';
import { normalizeGiteaInstance } from './instance.js';

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** `owner/name` of a path, or null: Gitea repositories are exactly two segments deep. */
function repositoryPath(value) {
  const segments = value.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (segments.length !== 2 || segments.some((segment) => segment === '.' || segment === '..' || !SEGMENT.test(segment))) return null;
  return { owner: segments[0], name: segments[1] };
}

const matchScpRemote = (value) => (value.includes('://') ? null : value.match(/^(?:[^@\s]+@)?([^:/\s]+):(?!\/)(.+)$/));

/**
 * The repository a remote URL names on one known instance, or null. HTTPS
 * remotes match the instance's exact authority (host and port); HTTP only
 * when the instance itself is a loopback HTTP origin. SSH remotes match its
 * hostname: an instance whose SSH host differs from its web host
 * (`SSH_DOMAIN`) is not recognized over SSH.
 */
export function parseGiteaRemoteUrl(raw, instance) {
  if (!isString(raw) || !raw.trim()) return null;
  const origin = normalizeGiteaInstance(instance);
  const originUrl = new URL(origin);
  const value = raw.trim();
  const build = (path) => (path ? { ...path, repoPath: `${path.owner}/${path.name}`, url: `${origin}/${path.owner}/${path.name}` } : null);

  const scpMatch = matchScpRemote(value);
  if (scpMatch) return scpMatch[1].toLowerCase() === originUrl.hostname.toLowerCase() ? build(repositoryPath(scpMatch[2])) : null;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopbackHttp = url.protocol === 'http:' && originUrl.protocol === 'http:';
  if (!loopbackHttp && !['https:', 'ssh:', 'git+ssh:'].includes(url.protocol)) return null;
  const web = url.protocol === 'http:' || url.protocol === 'https:';
  const hostMatches = web
    ? url.host.toLowerCase() === originUrl.host.toLowerCase()
    : url.hostname.toLowerCase() === originUrl.hostname.toLowerCase();
  if (!hostMatches || (web && (url.username || url.password)) || url.search || url.hash) return null;
  return build(repositoryPath(decodeURIComponent(url.pathname)));
}

const trackingRemoteName = (tracking) => {
  if (!isString(tracking)) return '';
  const separator = tracking.indexOf('/');
  return separator > 0 ? tracking.slice(0, separator) : '';
};

/**
 * The repositories a working directory's remotes name on the instance. With
 * an explicit remote (every bound read names the binding's primary remote)
 * only that remote counts; otherwise remotes are ranked: tracking, origin,
 * upstream, then the rest.
 */
export async function resolveGiteaReposFromDirectory(directory, instance, explicitRemote, dependencies = {}) {
  const loadRemotes = dependencies.getRemotes ?? getRemotes;
  const loadStatus = dependencies.getStatus ?? getStatus;
  const parseRemote = (remote) => parseGiteaRemoteUrl(remote.pushUrl || remote.fetchUrl, instance)
    ?? parseGiteaRemoteUrl(remote.fetchUrl, instance);
  const remotes = await loadRemotes(directory);
  if (explicitRemote) {
    const remote = remotes.find((candidate) => candidate?.name === explicitRemote);
    const parsed = remote ? parseRemote(remote) : null;
    return { repos: parsed ? [{ ...parsed, remoteName: explicitRemote }] : [] };
  }
  const status = await loadStatus(directory, { mode: 'light' });
  const ranked = [];
  for (const name of [trackingRemoteName(status?.tracking), 'origin', 'upstream', ...remotes.map((remote) => remote?.name)]) {
    if (isString(name) && name && !ranked.includes(name)) ranked.push(name);
  }
  const repos = [];
  for (const name of ranked) {
    const remote = remotes.find((candidate) => candidate?.name === name);
    const parsed = remote ? parseRemote(remote) : null;
    if (!parsed || repos.some((known) => known.repoPath.toLowerCase() === parsed.repoPath.toLowerCase())) continue;
    repos.push({ ...parsed, remoteName: name });
  }
  return { repos };
}

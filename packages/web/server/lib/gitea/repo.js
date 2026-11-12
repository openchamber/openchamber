import { getRemotes, getStatus } from '../git/index.js';
import { sshHostReaches, sshUserOf } from '../git/ssh-host-alias.js';
import { isString } from '../shared/guards.js';
import { sshHostMatches } from '../source-control/ssh-url.js';
import { normalizeGiteaInstance } from './instance.js';

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const SSH_PROTOCOLS = new Set(['ssh:', 'git+ssh:']);

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
 * when the instance itself is a loopback HTTP origin.
 *
 * An SSH remote matches when its host is the instance hostname, when its host
 * and port are the instance's separate SSH address `sshUrl`, or when the raw
 * remote value is one `sshHosts` holds. Gitea sets `SSH_DOMAIN` apart from the
 * web address, often on another host or port. `sshHosts` carries only the
 * remotes whose host the server user's SSH configuration resolves to the
 * instance, so an alias such as `forgejo:` for `git.example.com` counts there
 * and a `HostKeyAlias` or a shared resolved address never does.
 */
export function parseGiteaRemoteUrl(raw, instance, { sshHosts = null, sshUrl = null } = {}) {
  if (!isString(raw) || !raw.trim()) return null;
  const origin = normalizeGiteaInstance(instance);
  const originUrl = new URL(origin);
  const hostname = originUrl.hostname.toLowerCase();
  const value = raw.trim();
  const build = (path) => (path ? { ...path, repoPath: `${path.owner}/${path.name}`, url: `${origin}/${path.owner}/${path.name}` } : null);
  const matchesInstanceSshHost = (host, port) => host === hostname
    || sshHostMatches(sshUrl, host, port)
    || sshHosts?.has(value) === true;

  const scpMatch = matchScpRemote(value);
  // A `git@host:owner/repo.git` remote names no port, so SSH reaches it on 22.
  if (scpMatch) return matchesInstanceSshHost(scpMatch[1].toLowerCase(), 22) ? build(repositoryPath(scpMatch[2])) : null;

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
    : matchesInstanceSshHost(url.hostname.toLowerCase(), Number(url.port || 22));
  if (!hostMatches || (web && (url.username || url.password)) || url.search || url.hash) return null;
  return build(repositoryPath(decodeURIComponent(url.pathname)));
}

/** The host an SSH remote names, or null for any other URL. */
const sshHostOf = (value) => {
  if (!isString(value) || !value.trim()) return null;
  const scp = matchScpRemote(value.trim());
  if (scp) return scp[1].toLowerCase();
  try {
    const url = new URL(value.trim());
    return SSH_PROTOCOLS.has(url.protocol) ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

async function sshHostsReaching(remotes, hostname, reaches) {
  const hosts = new Map();
  for (const remote of remotes) {
    for (const value of [remote?.pushUrl, remote?.fetchUrl]) {
      const host = sshHostOf(value);
      if (host && host !== hostname) hosts.set(value.trim(), { host, user: sshUserOf(value.trim()) });
    }
  }
  const reaching = new Set();
  await Promise.all([...hosts].map(async ([value, { host, user }]) => {
    if (await reaches(host, hostname, user)) reaching.add(value);
  }));
  return reaching;
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
  const reaches = dependencies.sshHostReaches ?? sshHostReaches;
  const allRemotes = await loadRemotes(directory);
  // An explicit remote is the only one that can count, so it is also the only
  // one whose SSH host is looked up.
  const remotes = explicitRemote ? allRemotes.filter((remote) => remote?.name === explicitRemote) : allRemotes;
  const sshHosts = await sshHostsReaching(remotes, new URL(normalizeGiteaInstance(instance)).hostname.toLowerCase(), reaches);
  const options = { sshHosts, sshUrl: dependencies.sshUrl ?? null };
  const parseRemote = (remote) => parseGiteaRemoteUrl(remote.pushUrl || remote.fetchUrl, instance, options)
    ?? parseGiteaRemoteUrl(remote.fetchUrl, instance, options);
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

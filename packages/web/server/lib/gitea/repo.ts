import { getRemotes, getStatus } from '../git/index.js';
import { sshHostReaches, sshRemoteUrlsReaching } from '../git/ssh-host-alias.js';
import { isString as isStringValue } from '../shared/guards.js';
import { sshHostMatches } from '../source-control/ssh-url.js';
import { normalizeGiteaInstance } from './instance.js';

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

interface RepositoryPath {
  owner: string;
  name: string;
}

export interface GiteaRepository extends RepositoryPath {
  repoPath: string;
  url: string;
}

export interface ResolvedGiteaRepository extends GiteaRepository {
  remoteName: string;
}

export interface GiteaRemote {
  name: string;
  fetchUrl: string;
  pushUrl?: string;
}

export interface GiteaRemoteOptions {
  sshHosts?: ReadonlySet<string> | null;
  sshUrl?: string | null;
}

export interface GiteaRepoDependencies {
  getRemotes?: (directory: string) => Promise<GiteaRemote[]>;
  getStatus?: (directory: string, options: { mode: 'light' }) => Promise<{ tracking?: string | null } | null>;
  sshHostReaches?: (host: string, hostname: string, user: string | null) => Promise<boolean>;
  sshUrl?: string | null;
}

const isString = (value: string | null | undefined): value is string => isStringValue(value);

function repositoryPath(value: string) {
  const segments = value.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (segments.length !== 2 || segments.some((segment) => segment === '.' || segment === '..' || !SEGMENT.test(segment))) return null;
  const [owner, name] = segments;
  if (owner === undefined || name === undefined) return null;
  return { owner, name };
}

const matchScpRemote = (value: string) => (value.includes('://') ? null : value.match(/^(?:[^@\s]+@)?([^:/\s]+):(?!\/)(.+)$/));

export function parseGiteaRemoteUrl(raw: string | null | undefined, instance: string, { sshHosts = null, sshUrl = null }: GiteaRemoteOptions = {}): GiteaRepository | null {
  if (!isString(raw) || !raw.trim()) return null;
  const origin = normalizeGiteaInstance(instance);
  const originUrl = new URL(origin);
  const hostname = originUrl.hostname.toLowerCase();
  const value = raw.trim();
  const build = (path: RepositoryPath | null) => (path ? { ...path, repoPath: `${path.owner}/${path.name}`, url: `${origin}/${path.owner}/${path.name}` } : null);
  const matchesInstanceSshHost = (host: string, port: number) => host === hostname
    || sshHostMatches(sshUrl, host, port)
    || sshHosts?.has(value) === true;

  const scpMatch = matchScpRemote(value);
  if (scpMatch && scpMatch[1] !== undefined && scpMatch[2] !== undefined) return matchesInstanceSshHost(scpMatch[1].toLowerCase(), 22) ? build(repositoryPath(scpMatch[2])) : null;

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

const trackingRemoteName = (tracking: string | null | undefined) => {
  if (!isString(tracking)) return '';
  const separator = tracking.indexOf('/');
  return separator > 0 ? tracking.slice(0, separator) : '';
};

export async function resolveGiteaReposFromDirectory(directory: string, instance: string, explicitRemote?: string | null, dependencies: GiteaRepoDependencies = {}) {
  const loadRemotes = dependencies.getRemotes ?? getRemotes;
  const loadStatus = dependencies.getStatus ?? getStatus;
  const reaches = dependencies.sshHostReaches ?? sshHostReaches;
  const allRemotes = await loadRemotes(directory);
  const remotes = explicitRemote ? allRemotes.filter((remote) => remote?.name === explicitRemote) : allRemotes;
  const sshHosts = await sshRemoteUrlsReaching(remotes.flatMap((remote) => [remote?.pushUrl, remote?.fetchUrl]),
    new URL(normalizeGiteaInstance(instance)).hostname.toLowerCase(), reaches);
  const options = { sshHosts, sshUrl: dependencies.sshUrl ?? null };
  const parseRemote = (remote: GiteaRemote) => parseGiteaRemoteUrl(remote.pushUrl || remote.fetchUrl, instance, options)
    ?? parseGiteaRemoteUrl(remote.fetchUrl, instance, options);
  if (explicitRemote) {
    const remote = remotes.find((candidate) => candidate?.name === explicitRemote);
    const parsed = remote ? parseRemote(remote) : null;
    return { repos: parsed ? [{ ...parsed, remoteName: explicitRemote }] : [] };
  }
  const status = await loadStatus(directory, { mode: 'light' });
  const ranked: string[] = [];
  for (const name of [trackingRemoteName(status?.tracking), 'origin', 'upstream', ...remotes.map((remote) => remote?.name)]) {
    if (isString(name) && name && !ranked.includes(name)) ranked.push(name);
  }
  const repos: ResolvedGiteaRepository[] = [];
  for (const name of ranked) {
    const remote = remotes.find((candidate) => candidate?.name === name);
    const parsed = remote ? parseRemote(remote) : null;
    if (!parsed || repos.some((known) => known.repoPath.toLowerCase() === parsed.repoPath.toLowerCase())) continue;
    repos.push({ ...parsed, remoteName: name });
  }
  return { repos };
}

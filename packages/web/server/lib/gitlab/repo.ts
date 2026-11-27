import { getRemotes, getStatus } from '../git/index.js';
import { sshHostReaches, sshRemoteUrlsReaching } from '../git/ssh-host-alias.js';
import { normalizeGitLabInstance } from './instance.js';

export interface GitLabRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitLabProjectRemote {
  projectPath: string;
  url: string;
  remoteName: string | undefined;
}

export interface GitLabDirectoryProjects {
  branch: string;
  tracking: string;
  projects: GitLabProjectRemote[];
}

export interface GitLabProjectDependencies {
  getRemotes?: (directory: string) => Promise<GitLabRemote[]>;
  getStatus?: (directory: string, options: { mode: 'light' }) => Promise<{
    current?: string | null;
    tracking?: string | null;
  } | null>;
  exactRemote?: boolean;
  sshHostReaches?: (host: string, hostname: string, user: string | null) => Promise<boolean>;
}

const isRemoteString = (value: unknown): value is string => typeof value === 'string';

function normalizeProjectPath(value: string) {
  const path = value.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2 || segments.some((segment) => segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

const matchScpRemote = (value: string) => {
  const match = value.includes('://') ? null : value.match(/^(?:[^@\s]+@)?([^:/\s]+):(?!\/)(.+)$/);
  if (!match) return null;
  const [, host, path] = match;
  if (host === undefined || path === undefined) throw new Error('Invalid SSH remote match');
  return { host, path };
};

export function parseGitLabRemoteUrl(raw: string | null | undefined, instance: string, sshHosts: ReadonlySet<string> | null = null) {
  if (!isRemoteString(raw) || !raw.trim()) return null;
  const origin = normalizeGitLabInstance(instance);
  const originUrl = new URL(origin);
  const expectedHost = originUrl.host.toLowerCase();
  const expectedHostname = originUrl.hostname.toLowerCase();
  const value = raw.trim();
  const reachesInstance = sshHosts?.has(value) === true;

  const scpMatch = matchScpRemote(value);
  if (scpMatch) {
    if (scpMatch.host.toLowerCase() !== expectedHostname && !reachesInstance) return null;
    const projectPath = normalizeProjectPath(scpMatch.path);
    return projectPath ? { projectPath, url: `${origin}/${projectPath}` } : null;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const allowsLoopbackHttp = url.protocol === 'http:' && originUrl.protocol === 'http:';
  if (!allowsLoopbackHttp && !['https:', 'ssh:', 'git+ssh:'].includes(url.protocol)) return null;
  const isWebRemote = url.protocol === 'http:' || url.protocol === 'https:';
  const hostMatches = isWebRemote
    ? url.host.toLowerCase() === expectedHost
    : url.hostname.toLowerCase() === expectedHostname || reachesInstance;
  if (!hostMatches || (isWebRemote && (url.username || url.password))) return null;
  if (url.search || url.hash) return null;
  const projectPath = normalizeProjectPath(url.pathname);
  return projectPath ? { projectPath, url: `${origin}/${projectPath}` } : null;
}

export function parseGitLabSshProjectPath(raw: string) {
  const value = raw.trim();
  if (!value) return null;
  const scpMatch = matchScpRemote(value);
  if (scpMatch) return normalizeProjectPath(scpMatch.path);
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!['ssh:', 'git+ssh:'].includes(url.protocol) || !url.hostname || url.search || url.hash) return null;
  return normalizeProjectPath(url.pathname);
}

function trackingRemoteName(tracking: string | null | undefined) {
  if (!isRemoteString(tracking)) return '';
  const separator = tracking.indexOf('/');
  return separator > 0 ? tracking.slice(0, separator) : '';
}

export function rankGitLabRemotes(
  remotes: ReadonlyArray<{ name: string }>,
  explicitRemote?: string,
  tracking?: string | null,
) {
  const ranked: string[] = [];
  const add = (name: string | undefined) => {
    if (!isRemoteString(name) || !name.trim() || ranked.includes(name.trim())) return;
    ranked.push(name.trim());
  };
  add(explicitRemote);
  add(trackingRemoteName(tracking));
  add('origin');
  add('upstream');
  for (const remote of remotes) add(remote?.name);
  return ranked;
}

export async function resolveGitLabProjectsFromDirectory(
  directory: string,
  instance: string,
  explicitRemote?: string,
  dependencies: GitLabProjectDependencies = {},
): Promise<GitLabDirectoryProjects> {
  const loadRemotes = dependencies.getRemotes ?? getRemotes;
  const loadStatus = dependencies.getStatus ?? getStatus;
  const hostname = new URL(normalizeGitLabInstance(instance)).hostname.toLowerCase();
  const parseRemote = async (candidates: GitLabRemote[]) => {
    const sshHosts = await sshRemoteUrlsReaching(candidates.flatMap((remote) => [remote.pushUrl, remote.fetchUrl]),
      hostname, dependencies.sshHostReaches ?? sshHostReaches);
    return (remote: GitLabRemote) => parseGitLabRemoteUrl(remote.pushUrl || remote.fetchUrl, instance, sshHosts)
      ?? parseGitLabRemoteUrl(remote.fetchUrl, instance, sshHosts);
  };
  if (dependencies.exactRemote) {
    const remotes = await loadRemotes(directory);
    const remote = remotes.find((candidate) => candidate?.name === explicitRemote);
    const parsed = remote ? (await parseRemote([remote]))(remote) : null;
    return {
      branch: '',
      tracking: '',
      projects: parsed ? [{ ...parsed, remoteName: explicitRemote }] : [],
    };
  }
  const [remotes, status] = await Promise.all([
    loadRemotes(directory),
    loadStatus(directory, { mode: 'light' }),
  ]);
  const rankedNames = rankGitLabRemotes(remotes, explicitRemote, status?.tracking);
  const byName = new Map(remotes.map((remote) => [remote.name, remote]));
  const parse = await parseRemote(remotes);
  const projects: GitLabProjectRemote[] = [];
  for (const remoteName of rankedNames) {
    const remote = byName.get(remoteName);
    if (!remote) continue;
    const parsed = parse(remote);
    if (!parsed || projects.some((item) => item.projectPath.toLowerCase() === parsed.projectPath.toLowerCase())) continue;
    projects.push({ ...parsed, remoteName });
  }
  return { branch: status?.current || '', tracking: status?.tracking || '', projects };
}

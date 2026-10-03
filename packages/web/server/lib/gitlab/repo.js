import { getRemotes, getStatus } from '../git/index.js';
import { normalizeGitLabInstance } from './instance.js';

function normalizeProjectPath(value) {
  const path = value.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2 || segments.some((segment) => segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

export function parseGitLabRemoteUrl(raw, instance) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const origin = normalizeGitLabInstance(instance);
  const originUrl = new URL(origin);
  const expectedHost = originUrl.host.toLowerCase();
  const expectedHostname = originUrl.hostname.toLowerCase();
  const value = raw.trim();

  const scpMatch = value.includes('://') ? null : value.match(/^(?:[^@\s]+@)?([^:/\s]+):(?!\/)(.+)$/);
  if (scpMatch) {
    if (scpMatch[1].toLowerCase() !== expectedHostname) return null;
    const projectPath = normalizeProjectPath(scpMatch[2]);
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
    : url.hostname.toLowerCase() === expectedHostname;
  if (!hostMatches || (isWebRemote && (url.username || url.password))) return null;
  if (url.search || url.hash) return null;
  const projectPath = normalizeProjectPath(url.pathname);
  return projectPath ? { projectPath, url: `${origin}/${projectPath}` } : null;
}

function trackingRemoteName(tracking) {
  if (typeof tracking !== 'string') return '';
  const separator = tracking.indexOf('/');
  return separator > 0 ? tracking.slice(0, separator) : '';
}

export function rankGitLabRemotes(remotes, explicitRemote, tracking) {
  const ranked = [];
  const add = (name) => {
    if (typeof name !== 'string' || !name.trim() || ranked.includes(name.trim())) return;
    ranked.push(name.trim());
  };
  add(explicitRemote);
  add(trackingRemoteName(tracking));
  add('origin');
  add('upstream');
  for (const remote of remotes) add(remote?.name);
  return ranked;
}

export async function resolveGitLabProjectsFromDirectory(directory, instance, explicitRemote, dependencies = {}) {
  const loadRemotes = dependencies.getRemotes ?? getRemotes;
  const loadStatus = dependencies.getStatus ?? getStatus;
  if (dependencies.exactRemote) {
    const remotes = await loadRemotes(directory);
    const remote = remotes.find((candidate) => candidate?.name === explicitRemote);
    const parsed = remote
      ? parseGitLabRemoteUrl(remote.pushUrl || remote.fetchUrl, instance)
        ?? parseGitLabRemoteUrl(remote.fetchUrl, instance)
      : null;
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
  const projects = [];
  for (const remoteName of rankedNames) {
    const remote = byName.get(remoteName);
    if (!remote) continue;
    const parsed = parseGitLabRemoteUrl(remote.pushUrl || remote.fetchUrl, instance)
      ?? parseGitLabRemoteUrl(remote.fetchUrl, instance);
    if (!parsed || projects.some((item) => item.projectPath.toLowerCase() === parsed.projectPath.toLowerCase())) continue;
    projects.push({ ...parsed, remoteName });
  }
  return { branch: status?.current || '', tracking: status?.tracking || '', projects };
}

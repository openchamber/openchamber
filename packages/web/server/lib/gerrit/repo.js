import { getRemotes, getStatus } from '../git/index.js';
import { isString } from '../shared/guards.js';
import { splitProjectPath } from '../source-control/project-path.js';
import { normalizeGerritInstance } from './instance.js';

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

function gerritProjectOfPath(value) {
  const segments = value.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..' || !SEGMENT.test(segment))) return null;
  const project = segments.join('/');
  return { ...splitProjectPath(project), project };
}

const matchScpRemote = (value) => (value.includes('://') ? null : value.match(/^(?:[^@\s]+@)?([^:/\s]+):(?!\/)(.+)$/));

export function parseGerritRemoteUrl(raw, instance) {
  if (!isString(raw) || !raw.trim()) return null;
  const origin = normalizeGerritInstance(instance);
  const originUrl = new URL(origin);
  const value = raw.trim();
  const build = (parsed) => (parsed ? { ...parsed, repoPath: parsed.project, url: `${origin}/admin/repos/${parsed.project}` } : null);

  const scpMatch = matchScpRemote(value);
  if (scpMatch) return scpMatch[1].toLowerCase() === originUrl.hostname.toLowerCase() ? build(gerritProjectOfPath(scpMatch[2])) : null;

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
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (web) path = path.replace(/^\/a\//, '/');
  return build(gerritProjectOfPath(path));
}

const trackingRemoteName = (tracking) => {
  if (!isString(tracking)) return '';
  const separator = tracking.indexOf('/');
  return separator > 0 ? tracking.slice(0, separator) : '';
};

export async function resolveGerritProjectsFromDirectory(directory, instance, explicitRemote, dependencies = {}) {
  const loadRemotes = dependencies.getRemotes ?? getRemotes;
  const loadStatus = dependencies.getStatus ?? getStatus;
  const parseRemote = (remote) => parseGerritRemoteUrl(remote.pushUrl || remote.fetchUrl, instance)
    ?? parseGerritRemoteUrl(remote.fetchUrl, instance);
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
    if (!parsed || repos.some((known) => known.project === parsed.project)) continue;
    repos.push({ ...parsed, remoteName: name });
  }
  return { repos };
}

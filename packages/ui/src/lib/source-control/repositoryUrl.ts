import type { GitRemote, SourceControlIdentity, SourceControlProvider } from '@/lib/api/types';
import { getSourceControlBaseUrl, resolveSourceControlIdentity } from './identity';

type RepositoryLink = { provider: SourceControlProvider; url: string };

const repositoryLink = (endpoint: string, identities: readonly SourceControlIdentity[]): RepositoryLink | null => {
  const value = endpoint.trim();
  const identity = resolveSourceControlIdentity({ name: '', fetchUrl: value, pushUrl: value }, [...identities]);
  if (!identity) return null;

  let path: string;
  const scp = /^(?:[^@/:\s]+@)?[^/:\s]+:([^\s]+)$/.exec(value);
  if (scp && !value.includes('://')) {
    path = scp[1];
  } else {
    try {
      const remote = new URL(value);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(remote.protocol)) return null;
      path = remote.pathname;
    } catch {
      return null;
    }
  }

  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  const base = new URL(getSourceControlBaseUrl(identity));
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) return null;
  const prefix = base.pathname.replace(/^\/+|\/+$/g, '');
  if (prefix && path.startsWith(`${prefix}/`)) path = path.slice(prefix.length + 1);
  const segments = path.split('/');
  if (segments.length < 2 || (identity.provider === 'github' && segments.length !== 2)) return null;
  if (segments.some((segment) => !/^[a-zA-Z0-9_.-]+$/.test(segment) || ['.', '..', '-'].includes(segment))) return null;

  base.pathname = `/${prefix ? `${prefix}/` : ''}${path}`;
  base.search = '';
  base.hash = '';
  return { provider: identity.provider, url: base.toString() };
};

/** Origin first, then the first recognized remote. Fetch identifies the checkout before push. */
export const repositoryLinkFromRemotes = (
  remotes: readonly GitRemote[],
  identities: readonly SourceControlIdentity[],
): RepositoryLink | null => {
  const origin = remotes.find((remote) => remote.name === 'origin');
  const ordered = origin ? [origin, ...remotes.filter((remote) => remote !== origin)] : remotes;
  for (const remote of ordered) {
    const link = repositoryLink(remote.fetchUrl, identities) ?? repositoryLink(remote.pushUrl, identities);
    if (link) return link;
  }
  return null;
};

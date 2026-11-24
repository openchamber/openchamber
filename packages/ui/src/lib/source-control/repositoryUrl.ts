import type { SourceControlIdentity, SourceControlProvider } from '@/lib/api/types';
import { getSourceControlBaseUrl, resolveSourceControlIdentity, type AliasedGitRemote } from './identity';
import { unknownProviderDescriptor, type SourceControlProviderDescriptor } from './providers/descriptor';

type RepositoryLink = { provider: SourceControlProvider; url: string };

const repositoryLink = (
  remote: AliasedGitRemote,
  endpoint: string,
  identities: readonly SourceControlIdentity[],
  descriptors: readonly SourceControlProviderDescriptor[],
): RepositoryLink | null => {
  const value = endpoint.trim();
  const identity = resolveSourceControlIdentity({ ...remote, fetchUrl: value, pushUrl: value }, identities);
  if (!identity) return null;

  let path: string;
  const scp = /^(?:[^@/:\s]+@)?[^/:\s]+:([^\s]+)$/.exec(value);
  if (scp && !value.includes('://')) {
    path = scp[1];
  } else {
    try {
      const url = new URL(value);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
      path = url.pathname;
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
  const descriptor = descriptors.find((entry) => entry.id === identity.provider) ?? unknownProviderDescriptor(identity.provider);
  const fewest = descriptor.repository.pathStyle === 'path' ? 1 : 2;
  if (segments.length < fewest || (!descriptor.repository.nestedNamespaces && segments.length !== 2)) return null;
  if (segments.some((segment) => !/^[a-zA-Z0-9_.-]+$/.test(segment) || ['.', '..', '-'].includes(segment))) return null;

  base.pathname = `/${prefix ? `${prefix}/` : ''}${path}`;
  base.search = '';
  base.hash = '';
  return { provider: identity.provider, url: base.toString() };
};

export const repositoryLinkFromRemotes = (
  remotes: readonly AliasedGitRemote[],
  identities: readonly SourceControlIdentity[],
  descriptors: readonly SourceControlProviderDescriptor[],
): RepositoryLink | null => {
  const origin = remotes.find((remote) => remote.name === 'origin');
  const ordered = origin ? [origin, ...remotes.filter((remote) => remote !== origin)] : remotes;
  for (const remote of ordered) {
    const link = repositoryLink(remote, remote.fetchUrl, identities, descriptors) ?? repositoryLink(remote, remote.pushUrl, identities, descriptors);
    if (link) return link;
  }
  return null;
};

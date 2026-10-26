import type { GitRemote, SourceControlIdentity, SourceControlProvider } from '@/lib/api/types';
import { getSourceControlBaseUrl, resolveSourceControlIdentity } from './identity';
import { unknownProviderDescriptor, type SourceControlProviderDescriptor } from './providers/descriptor';

type RepositoryLink = { provider: SourceControlProvider; url: string };

const repositoryLink = (
  endpoint: string,
  identities: readonly SourceControlIdentity[],
  descriptors: readonly SourceControlProviderDescriptor[],
): RepositoryLink | null => {
  const value = endpoint.trim();
  const identity = resolveSourceControlIdentity({ name: '', fetchUrl: value, pushUrl: value }, identities);
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
  // A provider that nests namespaces (GitLab subgroups) names a project by its whole path; others by owner/name.
  // A path-style provider's project may also be top level, one segment.
  const descriptor = descriptors.find((entry) => entry.id === identity.provider) ?? unknownProviderDescriptor(identity.provider);
  const fewest = descriptor.repository.pathStyle === 'path' ? 1 : 2;
  if (segments.length < fewest || (!descriptor.repository.nestedNamespaces && segments.length !== 2)) return null;
  if (segments.some((segment) => !/^[a-zA-Z0-9_.-]+$/.test(segment) || ['.', '..', '-'].includes(segment))) return null;

  base.pathname = `/${prefix ? `${prefix}/` : ''}${path}`;
  base.search = '';
  base.hash = '';
  return { provider: identity.provider, url: base.toString() };
};

/**
 * Origin first, then the first recognized remote. Fetch identifies the
 * checkout before push. `identities` include each provider's default instance
 * (`defaultSourceControlIdentities`); `descriptors` are the registry's.
 */
export const repositoryLinkFromRemotes = (
  remotes: readonly GitRemote[],
  identities: readonly SourceControlIdentity[],
  descriptors: readonly SourceControlProviderDescriptor[],
): RepositoryLink | null => {
  const origin = remotes.find((remote) => remote.name === 'origin');
  const ordered = origin ? [origin, ...remotes.filter((remote) => remote !== origin)] : remotes;
  for (const remote of ordered) {
    const link = repositoryLink(remote.fetchUrl, identities, descriptors) ?? repositoryLink(remote.pushUrl, identities, descriptors);
    if (link) return link;
  }
  return null;
};

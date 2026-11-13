import type { RepositorySelector, SourceControlBindingRead, SourceControlIdentity } from '@/lib/api/types';

import { defaultSourceControlIdentities, getSourceControlBaseUrl } from './identity';
import { splitProjectPath } from './projectPath';
import type { SourceControlProviderDescriptor } from './providers/descriptor';
import { repositoryLinkFromRemotes } from './repositoryUrl';

/**
 * The repository a folder's items are read from, for a read that names a
 * project rather than a context. A bound repository names its project itself;
 * a fork clone is read from its upstream, as its binding says. A repository
 * nobody bound names itself through its remotes.
 */
export const projectOfBinding = (
    read: SourceControlBindingRead | null,
    provider: string | null,
    instance: string | null,
    identities: readonly SourceControlIdentity[],
    descriptors: readonly SourceControlProviderDescriptor[],
): RepositorySelector | null => {
    const configured = read?.binding?.providers
        .find((entry) => entry.repository && (provider === null || entry.provider === provider) && (instance === null || entry.instance === instance))
        ?.repository;
    // A binding names its repository `{ owner, name }`; a read names it `{ owner, repo }`.
    if (configured) return { owner: configured.owner, repo: configured.name };
    if (!read) return null;
    const link = repositoryLinkFromRemotes(
        read.repository.remotes.map((remote) => ({ name: remote.name, fetchUrl: remote.fetch.displayUrl, pushUrl: remote.push.displayUrl })),
        [...identities, ...defaultSourceControlIdentities(descriptors)],
        descriptors,
    );
    if (!link || (provider !== null && link.provider !== provider) || instance === null) return null;
    try {
        const base = new URL(getSourceControlBaseUrl({ instance }));
        const prefix = base.pathname.replace(/^\/+|\/+$/g, '');
        let path = new URL(link.url).pathname.replace(/^\/+|\/+$/g, '');
        if (prefix && path.startsWith(`${prefix}/`)) path = path.slice(prefix.length + 1);
        return splitProjectPath(path);
    } catch {
        return null;
    }
};

import * as React from 'react';

import { trackerOfSource, trackerReferenceSource } from '@/components/references/referencePickerItems';
import { defaultSourceControlIdentities } from '@/lib/source-control/identity';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitRemote, SourceControlIdentity } from '@/lib/api/types';
import { normalizePath } from '@/lib/pathNormalization';
import { discoversNestedRepos } from '@/lib/nestedRepositories';
import { useRepositoryBindings } from '@/lib/source-control/repository-binding';
import { repositoryLinkFromRemotes } from '@/lib/source-control/repositoryUrl';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import { useSourceControlProviders } from '@/lib/source-control/providers/registry';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { useGitStore, useIsGitRepo, useNestedRepos, type NestedRepoDiscovery } from '@/stores/useGitStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import type { SourceBoardTab } from '@/stores/useSourceBoardStore';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { normalizeContextPanelDirectoryKey } from '@/stores/useUIStore';

import { repositoryUrlOfItemLink } from './openTrackerItem';

const NO_FOLDERS: string[] = [];

export type BoardRepository = {
    status: 'pending' | 'failed' | 'ready';
    directory: string | null;
    repositories: readonly string[];
    all: boolean;
    allAvailable: boolean;
    choosable: boolean;
};

export type RepositoryChoice = {
    path: string | null;
    all: boolean | undefined;
};

export function resolveBoardRepository(
    root: string | null,
    rootIsGitRepo: boolean | null,
    nestedRepos: NestedRepoDiscovery | undefined,
    choice: RepositoryChoice,
    acrossAvailable: boolean,
): BoardRepository {
    if (!root) return { status: 'ready', directory: null, repositories: [], all: false, allAvailable: false, choosable: false };
    const atRoot = (status: BoardRepository['status']): BoardRepository => ({ status, directory: root, repositories: [], all: false, allAvailable: false, choosable: false });
    if (rootIsGitRepo === true) {
        const repositories = Array.isArray(nestedRepos) ? [root, ...nestedRepos] : [root];
        const directory = choice.path && repositories.includes(choice.path) ? choice.path : root;
        return { status: 'ready', directory, repositories, all: false, allAvailable: false, choosable: repositories.length > 1 };
    }
    if (rootIsGitRepo === null || nestedRepos === undefined) return atRoot('pending');
    if (nestedRepos === null) return atRoot('failed');
    if (nestedRepos === 'unsupported') return atRoot('ready');
    const first = nestedRepos[0];
    if (first === undefined) return atRoot('ready');
    if (acrossAvailable && (choice.all ?? choice.path === null)) {
        return { status: 'ready', directory: root, repositories: nestedRepos, all: true, allAvailable: true, choosable: true };
    }
    const directory = choice.path && nestedRepos.includes(choice.path) ? choice.path : first;
    return { status: 'ready', directory, repositories: nestedRepos, all: false, allAvailable: acrossAvailable, choosable: true };
}

export const choiceForFocus = (choice: RepositoryChoice, focusPending: boolean): RepositoryChoice => (
    focusPending ? { ...choice, all: true } : choice
);

export const shouldRememberAll = (resolution: BoardRepository, storedAll: boolean | undefined, focusPending: boolean): boolean => (
    focusPending && resolution.all && storedAll !== true
);

export function resolveBoardTab(options: {
    chosen: SourceBoardTab;
    hasRepository: boolean;
    repositoryStatus: BoardRepository['status'];
    trackers: {
        connected: readonly string[];
        pending: boolean;
    };
}): SourceBoardTab | null {
    const { chosen, hasRepository, repositoryStatus, trackers } = options;
    const chosenTracker = trackerOfSource(chosen);
    if (chosenTracker && trackers.connected.includes(chosenTracker)) return chosen;
    if (chosenTracker && trackers.pending) return null;
    if (hasRepository) return 'repository';
    if (repositoryStatus === 'pending' || trackers.pending) return null;
    const first = trackers.connected[0];
    return first === undefined ? null : trackerReferenceSource(first);
}

export const repositoryLabel = (repository: string, root: string): string => {
    if (repository === root) return root.split('/').filter(Boolean).pop() ?? root;
    const prefix = `${root}/`;
    return repository.startsWith(prefix) ? repository.slice(prefix.length) : repository;
};

export type PullLinkTarget = {
    panelDirectory: string;
    targetDirectory: string | null;
    requestDirectory: string;
    mobileDirectory: string;
    mobileRequestDirectory: string;
    mobileRepository: string | null;
};

export function resolvePullLinkTarget(options: {
    projectPath: string;
    repository: string | null;
    currentDirectory: string | null;
    owned: boolean;
}): PullLinkTarget {
    const { projectPath, repository, owned } = options;
    const currentDirectory = options.currentDirectory ? normalizePath(options.currentDirectory) ?? options.currentDirectory : null;
    const ownedDirectory = owned ? currentDirectory : null;
    const projectRoot = normalizePath(projectPath) ?? projectPath;
    const nested = repository ? normalizePath(repository) ?? repository : null;
    const readsNested = nested !== null && nested !== projectRoot && nested !== ownedDirectory;
    const panelDirectory = options.currentDirectory ?? projectPath;
    const target = readsNested
        ? nested
        : ownedDirectory || !currentDirectory ? null : projectRoot;
    const targetDirectory = target ? normalizeContextPanelDirectoryKey(target) : null;
    const showsOtherRepository = nested !== null && nested !== projectRoot && ownedDirectory !== null
        && ownedDirectory !== projectRoot && ownedDirectory !== nested;
    const mobileDirectory = owned && options.currentDirectory && !showsOtherRepository ? options.currentDirectory : projectPath;
    const mobileRequestDirectory = normalizePath(mobileDirectory) ?? mobileDirectory;
    return {
        panelDirectory,
        targetDirectory,
        requestDirectory: targetDirectory ?? panelDirectory,
        mobileDirectory,
        mobileRequestDirectory,
        mobileRepository: nested !== null && nested !== projectRoot && nested !== mobileRequestDirectory ? nested : null,
    };
}

function useFolderRepositories(root: string | null) {
    const { git } = useRuntimeAPIs();
    const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
    const searchesNested = root !== null && discoversNestedRepos(root, homeDirectory);
    const rootIsGitRepo = useIsGitRepo(root);
    const nestedRepos = useNestedRepos(root);
    const ensureStatus = useGitStore((state) => state.ensureStatus);
    const ensureNestedRepos = useGitStore((state) => state.ensureNestedRepos);

    React.useEffect(() => {
        if (root && rootIsGitRepo === null) void ensureStatus(root, git);
    }, [ensureStatus, git, root, rootIsGitRepo]);
    React.useEffect(() => {
        if (root && searchesNested && rootIsGitRepo !== null) void ensureNestedRepos(root);
    }, [ensureNestedRepos, root, rootIsGitRepo, searchesNested]);

    const retry = React.useCallback(() => {
        if (root && searchesNested) void ensureNestedRepos(root, { force: true });
    }, [ensureNestedRepos, root, searchesNested]);
    return { rootIsGitRepo, nestedRepos: searchesNested ? nestedRepos : NO_FOLDERS, retry };
}

export function useBoardRepository(root: string | null, choice: RepositoryChoice): BoardRepository & { retry: () => void; discoveryFailed: boolean; discoveryPending: boolean } {
    const { sourceControl } = useRuntimeAPIs();
    const acrossAvailable = Boolean(sourceControl.referencesAcross);
    const { rootIsGitRepo, nestedRepos, retry } = useFolderRepositories(root);
    const resolution = React.useMemo(
        () => resolveBoardRepository(root, rootIsGitRepo, nestedRepos, { path: choice.path, all: choice.all }, acrossAvailable),
        [acrossAvailable, choice.all, choice.path, nestedRepos, root, rootIsGitRepo],
    );
    return { ...resolution, retry, discoveryFailed: nestedRepos === null, discoveryPending: nestedRepos === undefined };
}

export type FolderRemotes = { directory: string; remotes: readonly GitRemote[] | null };

export function folderOfRepository(
    repositoryUrl: string,
    folders: readonly FolderRemotes[],
    identities: readonly SourceControlIdentity[],
    descriptors: readonly SourceControlProviderDescriptor[],
): string | 'none' | null {
    const names = (remote: GitRemote) => repositoryLinkFromRemotes([remote], identities, descriptors)?.url.replace(/\/+$/, '').toLowerCase() === repositoryUrl;
    const byOrigin = folders.find((folder) => folder.remotes?.some((remote) => remote.name === 'origin' && names(remote)));
    if (byOrigin) return byOrigin.directory;
    if (folders.some((folder) => folder.remotes === null)) return null;
    return folders.find((folder) => folder.remotes?.some(names))?.directory ?? 'none';
}

export type LinkRepository = {
    status: 'pending' | 'failed' | 'ready';
    directory: string;
    owned: boolean;
    retry: () => void;
};

export function useLinkRepository(root: string, url: string, options: { enabled?: boolean } = {}): LinkRepository {
    const { enabled = true } = options;
    const { sourceControl } = useRuntimeAPIs();
    const { rootIsGitRepo, nestedRepos, retry } = useFolderRepositories(root);
    const discovered = Array.isArray(nestedRepos) ? nestedRepos : NO_FOLDERS;
    const candidates = React.useMemo(
        () => (!enabled ? NO_FOLDERS : rootIsGitRepo === true ? [root, ...discovered] : discovered),
        [discovered, enabled, root, rootIsGitRepo],
    );
    const bindings = useRepositoryBindings(candidates, sourceControl);
    const knownIdentities = useSourceControlAuthStore((state) => state.identities);
    const descriptors = useSourceControlProviders();
    const urls = useRepositoryUrlMatcher();
    const repositoryUrl = repositoryUrlOfItemLink(url, urls);
    const match = React.useMemo(() => {
        if (!enabled || !repositoryUrl || candidates.length === 0) return 'none';
        const folders = candidates.map((directory, index): FolderRemotes => {
            const binding = bindings[index];
            if (binding?.read) {
                return {
                    directory,
                    remotes: binding.read.repository.remotes.map((remote) => ({ name: remote.name, fetchUrl: remote.fetch.displayUrl, pushUrl: remote.push.displayUrl })),
                };
            }
            return { directory, remotes: binding?.status === 'error' ? [] : null };
        });
        return folderOfRepository(repositoryUrl, folders, [...knownIdentities, ...defaultSourceControlIdentities(descriptors)], descriptors);
    }, [bindings, candidates, descriptors, enabled, knownIdentities, repositoryUrl]);

    if (!enabled) return { status: 'ready', directory: root, owned: false, retry };
    if (rootIsGitRepo === null) return { status: 'pending', directory: root, owned: false, retry };
    if (match !== null && match !== 'none') return { status: 'ready', directory: match, owned: true, retry };
    if (nestedRepos === undefined) return { status: 'pending', directory: root, owned: false, retry };
    if (nestedRepos === null) return { status: 'failed', directory: root, owned: false, retry };
    if (match === null) return { status: 'pending', directory: root, owned: false, retry };
    return { status: 'ready', directory: root, owned: false, retry };
}

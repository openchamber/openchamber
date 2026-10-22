import * as React from 'react';

import { trackerOfSource, trackerReferenceSource } from '@/components/references/referencePickerItems';
import { defaultSourceControlIdentities } from '@/lib/source-control/identity';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitRemote, SourceControlIdentity } from '@/lib/api/types';
import { normalizePath } from '@/lib/pathNormalization';
import { useRepositoryBindings } from '@/lib/source-control/repository-binding';
import { repositoryLinkFromRemotes } from '@/lib/source-control/repositoryUrl';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import { useSourceControlProviders } from '@/lib/source-control/providers/registry';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { useGitStore, useIsGitRepo, useNestedRepos, type NestedRepoDiscovery } from '@/stores/useGitStore';
import type { SourceBoardTab } from '@/stores/useSourceBoardStore';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { normalizeContextPanelDirectoryKey } from '@/stores/useUIStore';

import { repositoryUrlOfItemLink } from './openTrackerItem';

const NO_FOLDERS: readonly string[] = [];

/**
 * The folder the board reads a project's repository from.
 *
 * A project whose root is a repository is read there. A root that is not one
 * but holds repositories is read in one of them, or in all of them together
 * (`all`, where the runtime can search across repositories): `directory` is
 * then the root, and each item brings the repository folder it belongs to.
 * `pending` and `failed` keep the root as `directory`, so a project that is a
 * repository never waits on the discovery, and neither state is taken for
 * "no repositories".
 */
export type BoardRepository = {
    status: 'pending' | 'failed' | 'ready';
    directory: string | null;
    /** The repositories under a root that is not one itself; empty otherwise. */
    repositories: readonly string[];
    /** The board lists all of `repositories` together. */
    all: boolean;
};

/** What the board remembers for a project's repository: a single one, and whether it lists them all. */
export type RepositoryChoice = {
    path: string | null;
    /** Undefined until chosen; then all repositories unless a single one was remembered. */
    all: boolean | undefined;
};

export function resolveBoardRepository(
    root: string | null,
    rootIsGitRepo: boolean | null,
    nestedRepos: NestedRepoDiscovery | undefined,
    choice: RepositoryChoice,
    /** The runtime can list across repositories (VS Code cannot). */
    acrossAvailable: boolean,
): BoardRepository {
    if (!root) return { status: 'ready', directory: null, repositories: [], all: false };
    const atRoot = (status: BoardRepository['status']): BoardRepository => ({ status, directory: root, repositories: [], all: false });
    if (rootIsGitRepo === true) return atRoot('ready');
    if (rootIsGitRepo === null || nestedRepos === undefined) return atRoot('pending');
    if (nestedRepos === null) return atRoot('failed');
    // A runtime without discovery cannot look any further than the root.
    if (nestedRepos === 'unsupported') return atRoot('ready');
    const first = nestedRepos[0];
    if (first === undefined) return atRoot('ready');
    if (acrossAvailable && (choice.all ?? choice.path === null)) {
        return { status: 'ready', directory: root, repositories: nestedRepos, all: true };
    }
    const directory = choice.path && nestedRepos.includes(choice.path) ? choice.path : first;
    return { status: 'ready', directory, repositories: nestedRepos, all: false };
}

/**
 * A link to an issue or PR is looked up across the folder's repositories: a
 * repository focus pending for the project reads as choosing "all", so the
 * lookup never runs first against a single repository that may not hold the
 * item. Where the root is a repository, or the runtime cannot list across
 * repositories, `resolveBoardRepository` ignores it as it ignores any "all".
 */
export const choiceForFocus = (choice: RepositoryChoice, focusPending: boolean): RepositoryChoice => (
    focusPending ? { ...choice, all: true } : choice
);

/** The focus made the board list all repositories: remember that, as if the user had picked it. */
export const shouldRememberAll = (resolution: BoardRepository, storedAll: boolean | undefined, focusPending: boolean): boolean => (
    focusPending && resolution.all && storedAll !== true
);

/**
 * The tab the board shows, or null for its loading or no-source screen, both
 * of which keep the project pickers. A chosen tracker tab stays while that
 * tracker is connected. Otherwise the repository tab when the project has
 * one. Without one the board waits until the folder says whether it holds a
 * repository and until the trackers' statuses arrive, then turns to the first
 * connected tracker, or to the no-source note when none is: a tracker nobody
 * signed in to lists nothing. A chosen tracker whose status is still out is
 * waited for too, so the board does not flash the repository tab first.
 */
export function resolveBoardTab(options: {
    chosen: SourceBoardTab;
    hasRepository: boolean;
    repositoryStatus: BoardRepository['status'];
    trackers: {
        /** Ids of the trackers with a tab: served and signed in. */
        connected: readonly string[];
        /** A served tracker's status has not arrived yet. */
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

/** A repository's path below the project's root, as the pickers name it. */
export const repositoryLabel = (repository: string, root: string): string => {
    const prefix = `${root}/`;
    return repository.startsWith(prefix) ? repository.slice(prefix.length) : repository;
};

/** Where Changes and Walkthrough for a PR open, on desktop and on the phone. */
export type PullLinkTarget = {
    /** The panel the tab opens in: the folder the app shows, else the project's root, where a draft opens first. */
    panelDirectory: string;
    /** The folder the tab reads the PR through; null for the panel's own. */
    targetDirectory: string | null;
    /** The key the diff and walkthrough views take the request under: the folder they read. */
    requestDirectory: string;
    /** The phone: the folder the app shows for it, a draft of the project's root when it is not the project's. */
    mobileDirectory: string;
    /** The phone's Changes looks requests up by the normalized folder the app shows. */
    mobileRequestDirectory: string;
    /** The repository the phone's Changes shows the PR in, in place of the Git selection; null for the folder itself. */
    mobileRepository: string | null;
};

/**
 * A PR is read through the project's own folder: the folder the app shows when
 * it belongs to the project, else the project's root, read as another
 * project's. A PR of a repository under a root that is not one is read through
 * that repository, so the views never resolve it through the root's Git
 * selection and the selection stays where it was; a session already in the
 * repository reads it as its own.
 */
export function resolvePullLinkTarget(options: {
    projectPath: string;
    /** The folder the PR was listed from; differs from `projectPath` for a repository under a root that is not one. */
    repository: string | null;
    currentDirectory: string | null;
    /** `currentDirectory` belongs to the project. */
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
    // The phone reads the PR through the folder it shows, so a session in a
    // sibling repository under the root opens the project's root instead.
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

/** Probes a project's root and, when it is not a repository, finds the repositories under it, read only. */
function useFolderRepositories(root: string | null) {
    const { git } = useRuntimeAPIs();
    const rootIsGitRepo = useIsGitRepo(root);
    const nestedRepos = useNestedRepos(root);
    const ensureStatus = useGitStore((state) => state.ensureStatus);
    const ensureNestedRepos = useGitStore((state) => state.ensureNestedRepos);

    React.useEffect(() => {
        if (root && rootIsGitRepo === null) void ensureStatus(root, git);
    }, [ensureStatus, git, root, rootIsGitRepo]);
    React.useEffect(() => {
        if (root && rootIsGitRepo === false) void ensureNestedRepos(root);
    }, [ensureNestedRepos, root, rootIsGitRepo]);

    const retry = React.useCallback(() => {
        if (root) void ensureNestedRepos(root, { force: true });
    }, [ensureNestedRepos, root]);
    return { rootIsGitRepo, nestedRepos, retry };
}

/**
 * Probes the root and discovers the repositories under it, reading the Git
 * screen's discovery without touching its repository selection: the board's
 * choice is its own.
 */
export function useBoardRepository(root: string | null, choice: RepositoryChoice): BoardRepository & { retry: () => void } {
    const { sourceControl } = useRuntimeAPIs();
    const acrossAvailable = Boolean(sourceControl.referencesAcross);
    const { rootIsGitRepo, nestedRepos, retry } = useFolderRepositories(root);
    const resolution = React.useMemo(
        () => resolveBoardRepository(root, rootIsGitRepo, nestedRepos, { path: choice.path, all: choice.all }, acrossAvailable),
        [acrossAvailable, choice.all, choice.path, nestedRepos, root, rootIsGitRepo],
    );
    return { ...resolution, retry };
}

/** A folder's remotes once its binding is read; null while it is, empty when the read failed. */
export type FolderRemotes = { directory: string; remotes: readonly GitRemote[] | null };

/**
 * Of the folders, the one whose remote is the repository `repositoryUrl` names
 * (`https://host/owner/name`, lowercase): one whose origin is, else one with
 * any remote that is, such as a fork's upstream. Null while a folder that may
 * still answer is being read; `'none'` when no folder's remote is it.
 */
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

/** The folder a link to an issue or PR is read through: `pending` while that is not known yet, `failed` when the search for repositories failed. */
export type LinkRepository = { status: 'pending' | 'failed' | 'ready'; directory: string; retry: () => void };

/**
 * The folder the Tracker reads a link through. A root that is a repository is
 * read where it is, as before. A root that is not one but holds repositories
 * is read through the one whose remote is the link's repository, so a link to
 * any of them opens in the Tracker; with none, the root is read and answers
 * that it cannot show the link. The Git selection is never touched.
 */
export function useLinkRepository(root: string, url: string): LinkRepository {
    const { sourceControl } = useRuntimeAPIs();
    const { rootIsGitRepo, nestedRepos, retry } = useFolderRepositories(root);
    const candidates = rootIsGitRepo === false && Array.isArray(nestedRepos) ? nestedRepos : NO_FOLDERS;
    const bindings = useRepositoryBindings(candidates, sourceControl);
    const knownIdentities = useSourceControlAuthStore((state) => state.identities);
    const descriptors = useSourceControlProviders();
    const urls = useRepositoryUrlMatcher();
    const repositoryUrl = repositoryUrlOfItemLink(url, urls);
    const match = React.useMemo(() => {
        if (!repositoryUrl || candidates.length === 0) return 'none';
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
    }, [bindings, candidates, descriptors, knownIdentities, repositoryUrl]);

    if (rootIsGitRepo === null || (rootIsGitRepo === false && nestedRepos === undefined)) return { status: 'pending', directory: root, retry };
    if (rootIsGitRepo === false && nestedRepos === null) return { status: 'failed', directory: root, retry };
    if (match === null) return { status: 'pending', directory: root, retry };
    return { status: 'ready', directory: match === 'none' ? root : match, retry };
}

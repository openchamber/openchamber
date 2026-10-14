import * as React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { normalizePath } from '@/lib/pathNormalization';
import { useGitStore, useIsGitRepo, useNestedRepos, type NestedRepoDiscovery } from '@/stores/useGitStore';

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

/** A repository's path below the project's root, as the pickers name it. */
export const repositoryLabel = (repository: string, root: string): string => {
    const prefix = `${root}/`;
    return repository.startsWith(prefix) ? repository.slice(prefix.length) : repository;
};

/** Where Changes and Walkthrough for a PR open, and what they must do first. */
export type PullLinkTarget = {
    /** The folder the app shows; a new draft of the project opens there unless it is already the current one. */
    appDirectory: string;
    /** The folder the diff and walkthrough views read their request under: the repository they resolve. */
    requestDirectory: string;
    /**
     * The key the phone's Changes reads a request under: the normalized folder
     * the app shows, not the repository (it resolves the repository from the
     * Git selection itself).
     */
    mobileRequestDirectory: string;
    /** The root whose Git selection must move to `requestDirectory` first; null when it already resolves there. */
    selectNestedIn: string | null;
};

/**
 * A project that is a repository opens where the app is when that folder is
 * the project's, else at the project's root. A PR of a repository under a root
 * that is not one is shown by the views through that root's Git selection, so
 * the request is keyed by the repository and the selection moves to it; a
 * session already in the repository shows it as it is.
 */
export function resolvePullLinkTarget(options: {
    projectPath: string;
    /** The folder the board reads; differs from `projectPath` for a repository under a root that is not one. */
    repository: string | null;
    /** The folder the app shows, when it belongs to the project. */
    ownedCurrentDirectory: string | null;
}): PullLinkTarget {
    const { projectPath, repository, ownedCurrentDirectory } = options;
    const target = (appDirectory: string, requestDirectory: string, selectNestedIn: string | null): PullLinkTarget => ({
        appDirectory,
        requestDirectory,
        mobileRequestDirectory: normalizePath(appDirectory) ?? appDirectory,
        selectNestedIn,
    });
    if (!repository || repository === projectPath) {
        const directory = ownedCurrentDirectory ?? projectPath;
        return target(directory, directory, null);
    }
    if (ownedCurrentDirectory === repository) return target(repository, repository, null);
    return target(projectPath, repository, projectPath);
}

/**
 * Probes the root and discovers the repositories under it, reading the Git
 * screen's discovery without touching its repository selection: the board's
 * choice is its own.
 */
export function useBoardRepository(root: string | null, choice: RepositoryChoice): BoardRepository & { retry: () => void } {
    const { git, sourceControl } = useRuntimeAPIs();
    const acrossAvailable = Boolean(sourceControl.githubReferencesAcross);
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
    const resolution = React.useMemo(
        () => resolveBoardRepository(root, rootIsGitRepo, nestedRepos, { path: choice.path, all: choice.all }, acrossAvailable),
        [acrossAvailable, choice.all, choice.path, nestedRepos, root, rootIsGitRepo],
    );
    return { ...resolution, retry };
}

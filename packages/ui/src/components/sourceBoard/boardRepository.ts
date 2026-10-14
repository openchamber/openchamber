import * as React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useGitStore, useIsGitRepo, useNestedRepos, type NestedRepoDiscovery } from '@/stores/useGitStore';

/**
 * The folder the board reads a project's repository from.
 *
 * A project whose root is a repository is read there. A root that is not one
 * but holds repositories is read in one of them. `pending` and `failed` keep
 * the root as `directory`, so a project that is a repository never waits on
 * the discovery, and neither state is taken for "no repositories".
 */
export type BoardRepository = {
    status: 'pending' | 'failed' | 'ready';
    directory: string | null;
    /** The repositories under a root that is not one itself; empty otherwise. */
    repositories: readonly string[];
};

export function resolveBoardRepository(
    root: string | null,
    rootIsGitRepo: boolean | null,
    nestedRepos: NestedRepoDiscovery | undefined,
    remembered: string | null,
): BoardRepository {
    if (!root) return { status: 'ready', directory: null, repositories: [] };
    const atRoot = (status: BoardRepository['status']): BoardRepository => ({ status, directory: root, repositories: [] });
    if (rootIsGitRepo === true) return atRoot('ready');
    if (rootIsGitRepo === null || nestedRepos === undefined) return atRoot('pending');
    if (nestedRepos === null) return atRoot('failed');
    // A runtime without discovery cannot look any further than the root.
    if (nestedRepos === 'unsupported') return atRoot('ready');
    const first = nestedRepos[0];
    if (first === undefined) return atRoot('ready');
    const directory = remembered && nestedRepos.includes(remembered) ? remembered : first;
    return { status: 'ready', directory, repositories: nestedRepos };
}

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
    if (!repository || repository === projectPath) {
        const directory = ownedCurrentDirectory ?? projectPath;
        return { appDirectory: directory, requestDirectory: directory, selectNestedIn: null };
    }
    if (ownedCurrentDirectory === repository) {
        return { appDirectory: repository, requestDirectory: repository, selectNestedIn: null };
    }
    return { appDirectory: projectPath, requestDirectory: repository, selectNestedIn: projectPath };
}

/**
 * Probes the root and discovers the repositories under it, reading the Git
 * screen's discovery without touching its repository selection: the board's
 * choice is its own.
 */
export function useBoardRepository(root: string | null, remembered: string | null): BoardRepository & { retry: () => void } {
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
    const resolution = React.useMemo(
        () => resolveBoardRepository(root, rootIsGitRepo, nestedRepos, remembered),
        [nestedRepos, remembered, root, rootIsGitRepo],
    );
    return { ...resolution, retry };
}

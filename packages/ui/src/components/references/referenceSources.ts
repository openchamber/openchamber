/**
 * Where the picker's lists and previews come from, one cache per kind of
 * answer. Cache keys carry the runtime, the account and the project, so a
 * different account or host never sees another one's list.
 *
 * Repository items are read with the project's read context: the account its
 * binding names, or the current account of the host for a repository nobody
 * bound, the same one the Git view reads with. A GitLab project lists through
 * the same rows and preview as a GitHub one (`gitlabReferences.ts`).
 */

import * as React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type {
    SourceControlBindingRead,
    GitHubPullStatus,
    GitHubReference,
    GitHubReferenceDetail,
    RepositoryReferenceFilter,
    GitHubReferenceKind,
    LinearAPI,
    LinearIssue,
    LinearIssueSummary,
    SourceControlIdentity,
    SourceControlProvider,
    SourceControlReadContext,
} from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { GITHUB_SOURCE_CONTROL_IDENTITY, resolveSourceControlIdentity } from '@/lib/source-control/identity';
import { getSourceControlAuthKey, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { useRepositoryBinding, useRepositoryBindings } from '@/lib/source-control/repository-binding';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { normalizeProjectPath, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import {
    rememberedRepositoryProvider,
    rememberRepositoryProvider,
    subscribeRepositoryProviderMemory,
} from '@/lib/source-control/repositoryProviderMemory';


import { fetchGitLabReferenceDetail, fetchGitLabReferencePage } from './gitlabReferences';
import {
    NO_ACROSS_CONTEXTS,
    fetchAcrossPage,
    ensurePullStatuses,
    groupPullsByDirectory,
    needsPullStatus,
    partitionAcrossContexts,
    pullStatusKey,
    type AcrossContexts,
    type AcrossReference,
    type PullStatusGroup,
    type ReadContextState,
} from './acrossRepositories';
import { createListCache, createValueCache, useCachedList, useCachedValue, useReferenceRevalidation, type CachedValue, type ListPage } from './referenceCache';
import type { LinearReferenceFilter } from './referencePickerItems';

const githubLists = createListCache<GitHubReference>();
const githubAcrossLists = createListCache<AcrossReference>();
const linearLists = createListCache<LinearIssueSummary>();
const linearDetails = createValueCache<LinearIssue>();
const githubDetails = createValueCache<GitHubReferenceDetail>();

export type ReferenceSourceStatus = 'ready' | 'disconnected' | 'unsupported';

/** The hosts every remote is recognised on, whether or not an account there is connected. */
export const BUILT_IN_SOURCE_CONTROL_IDENTITIES: readonly SourceControlIdentity[] = [
    GITHUB_SOURCE_CONTROL_IDENTITY,
    { provider: 'gitlab', instance: 'https://gitlab.com' },
];

/**
 * The project's binding and every host it lives on: the providers it is bound
 * to and the hosts its remotes point at, whether or not an account there works.
 */
function repositoryHostsOf(read: SourceControlBindingRead | null, knownIdentities: readonly SourceControlIdentity[]): SourceControlIdentity[] {
    if (!read) return [];
    const found = new Map<string, SourceControlIdentity>();
    const add = (identity: SourceControlIdentity) => found.set(getSourceControlAuthKey(identity), identity);
    for (const provider of read.binding?.providers ?? []) add({ provider: provider.provider, instance: provider.instance });
    const identities = [...knownIdentities, ...BUILT_IN_SOURCE_CONTROL_IDENTITIES];
    for (const remote of read.repository.remotes) {
        const identity = resolveSourceControlIdentity(
            { name: remote.name, fetchUrl: remote.fetch.displayUrl, pushUrl: remote.push.displayUrl },
            identities,
        );
        if (identity) add(identity);
    }
    return [...found.values()];
}

function useRepositoryHosts(directory: string | null) {
    const { sourceControl } = useRuntimeAPIs();
    const binding = useRepositoryBinding(directory, sourceControl, Boolean(directory));
    const knownIdentities = useSourceControlAuthStore((state) => state.identities);
    const hosts = React.useMemo(() => repositoryHostsOf(binding.read, knownIdentities), [binding.read, knownIdentities]);
    return { binding, hosts };
}

/** The context a folder is read with once its binding and accounts are known: GitHub's, else GitLab's. */
function pickReadContext(
    binding: { contexts: readonly SourceControlReadContext[]; status: 'idle' | 'loading' | 'ready' | 'stale' | 'error' },
    hostPending: boolean,
): ReadContextState {
    const context = binding.contexts.find((candidate) => candidate.provider === 'github')
        ?? binding.contexts.find((candidate) => candidate.provider === 'gitlab')
        ?? null;
    if (context) return context;
    if (binding.status === 'error') return 'missing';
    return binding.status === 'ready' && !hostPending ? 'missing' : null;
}

const NO_DIRECTORIES: readonly string[] = [];

/**
 * The read contexts of several folders at once, for a list across the
 * repositories under a project folder. `ready` once every folder's context is
 * known; the GitHub ones are what a search is sent, the rest are left out.
 */
function useGitHubReadContexts(directories: readonly string[]): AcrossContexts {
    const { sourceControl } = useRuntimeAPIs();
    const bindings = useRepositoryBindings(directories, sourceControl);
    const knownIdentities = useSourceControlAuthStore((state) => state.identities);
    const authEntries = useSourceControlAuthStore((state) => state.entries);
    return React.useMemo(() => {
        if (directories.length === 0) return NO_ACROSS_CONTEXTS;
        return partitionAcrossContexts(directories.map((directory, index) => {
            const binding = bindings[index];
            if (!binding) return { directory, state: null };
            const hostPending = repositoryHostsOf(binding.read, knownIdentities)
                .some((host) => !authEntries[getSourceControlAuthKey(host)]?.hasChecked);
            return { directory, state: pickReadContext(binding, hostPending) };
        }));
    }, [authEntries, bindings, directories, knownIdentities]);
}

/**
 * The host whose account reads the project: its read context's, else the host
 * its remotes point at, GitHub first. Known even while no account there works,
 * so a surface can name GitLab and ask for that account instead of GitHub's.
 * Null while the binding loads or when the project lives on neither.
 */
export function useRepositoryHost(directory: string | null): SourceControlIdentity | null {
    const { binding, hosts } = useRepositoryHosts(directory);
    const context = binding.contexts[0] ?? null;
    const provider = context?.provider ?? null;
    const instance = context?.instance ?? null;
    return React.useMemo(() => {
        if (provider && instance) return { provider, instance };
        return hosts.find((host) => host.provider === 'github') ?? hosts.find((host) => host.provider === 'gitlab') ?? null;
    }, [hosts, instance, provider]);
}

/**
 * Where a project's issues and change requests live: its host's provider, or
 * `none` once its remotes are read and none is on a supported host. While
 * they load, the provider remembered for the project answers, so a switcher
 * does not change shape on every visit. Null without a project.
 */
export function useRepositoryHostProvider(directory: string | null): SourceControlProvider | 'none' | null {
    const { binding, hosts } = useRepositoryHosts(directory);
    const provider = useRepositoryReferenceProvider(directory);
    if (!directory) return null;
    if (binding.contexts.length > 0 || hosts.length > 0) return provider;
    return binding.read ? 'none' : provider;
}

/**
 * The read context a project's issues and change requests come from, once its
 * binding has been read: GitHub's when the project has one, else GitLab's.
 * Null while the binding or an account on one of its hosts is still loading,
 * and `missing` when no account can read it: no remote on a supported host, or
 * none of its hosts has a working account.
 */
export function useGitHubReadContext(directory: string | null): SourceControlReadContext | 'missing' | null {
    const { binding, hosts } = useRepositoryHosts(directory);
    const hostPending = useSourceControlAuthStore((state) => hosts
        .some((host) => !state.entries[getSourceControlAuthKey(host)]?.hasChecked));
    return pickReadContext(binding, hostPending);
}

/**
 * The host a project's items come from.
 *
 * Read contexts name it once the binding and the accounts have both loaded,
 * but either can still be loading, and a binding nobody watches goes stale
 * with no contexts. The project's remotes say where it lives in all of those
 * moments, so they answer meanwhile; GitHub only when nothing says otherwise.
 * GitHub wins over GitLab when a project has both, as the read context does.
 */
export function useRepositoryReferenceProvider(directory: string | null): SourceControlProvider {
    const { binding, hosts } = useRepositoryHosts(directory);
    // A worktree shares its project's host, so the answer is kept per project.
    const projects = useProjectsStore((state) => state.projects);
    const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
    const projectPath = React.useMemo(() => {
        if (!directory) return null;
        const project = resolveProjectForSessionDirectory(projects, worktreesByProject, directory);
        return normalizeProjectPath(project?.path ?? directory);
    }, [directory, projects, worktreesByProject]);
    const runtimeKey = getRuntimeKey();
    const remembered = React.useSyncExternalStore(
        subscribeRepositoryProviderMemory,
        () => rememberedRepositoryProvider(runtimeKey, projectPath),
    );
    // What the project itself says, or null while nothing has loaded that could.
    const known = React.useMemo((): SourceControlProvider | null => {
        const providers = new Set<SourceControlProvider>(binding.contexts.map((context) => context.provider));
        if (!providers.size) for (const host of hosts) providers.add(host.provider);
        if (providers.has('github')) return 'github';
        return providers.has('gitlab') ? 'gitlab' : null;
    }, [binding.contexts, hosts]);
    React.useEffect(() => {
        if (known) rememberRepositoryProvider(runtimeKey, projectPath, known);
    }, [known, projectPath, runtimeKey]);
    return known ?? remembered ?? 'github';
}

/**
 * Whether the project's issues and change requests can be listed. A project
 * that lives on GitHub or GitLab but no account there can read it is
 * disconnected, and so is a project with no remote at all while no account is
 * connected anywhere.
 */
export function useGitHubSourceStatus(directory: string | null): ReferenceSourceStatus {
    const { runtime } = useRuntimeAPIs();
    const context = useGitHubReadContext(directory);
    const { hosts } = useRepositoryHosts(directory);
    const anyConnected = useSourceControlAuthStore((state) => Object.values(state.entries)
        .some((entry) => entry.status?.connected === true));
    const githubChecked = useSourceControlAuthStore((state) => Boolean(
        state.entries[getSourceControlAuthKey(GITHUB_SOURCE_CONTROL_IDENTITY)]?.hasChecked,
    ));
    if (runtime.isVSCode) return 'unsupported';
    if (context !== 'missing') return 'ready';
    return hosts.length > 0 || (githubChecked && !anyConnected) ? 'disconnected' : 'ready';
}

export function useLinearSourceStatus(): ReferenceSourceStatus {
    const { linear } = useRuntimeAPIs();
    const checked = useLinearAuthStore((state) => state.hasChecked);
    const connected = useLinearAuthStore((state) => state.status?.connected === true);
    if (!linear) return 'unsupported';
    return checked && !connected ? 'disconnected' : 'ready';
}

/**
 * Everything about a read context that changes what it answers: provider,
 * host, account, the bound repository and remote, and the binding revision.
 * Rebinding the directory moves to a new key, so an answer still in flight for
 * the old binding fills only the old key and never the new list.
 */
const readContextCacheKey = (context: SourceControlReadContext): unknown[] => [
    context.provider,
    context.instance,
    context.accountId,
    context.directory,
    context.repositoryId,
    context.primaryRemote,
    context.bindingRevision,
];

export function useGitHubReferenceList(options: {
    enabled: boolean;
    directory: string | null;
    kind: GitHubReferenceKind;
    filter: RepositoryReferenceFilter;
    query: string;
}) {
    const { sourceControl } = useRuntimeAPIs();
    const { enabled, directory, kind, filter, query } = options;
    const { state, people } = filter;
    const context = useGitHubReadContext(enabled ? directory : null);
    const text = query.trim();
    const scope = context && context !== 'missing' ? readContextCacheKey(context) : 'missing';
    const key = enabled && directory && context
        ? JSON.stringify([getRuntimeKey(), scope, directory, kind, filter.state, filter.people, text])
        : null;
    const fetchPage = React.useCallback(async (cursor: string | null): Promise<ListPage<GitHubReference>> => {
        if (!context || context === 'missing') return { kind: 'unavailable', reason: 'no-repo' };
        if (context.provider === 'gitlab') return fetchGitLabReferencePage(sourceControl, context, kind, { state, people }, text, cursor);
        const result = await sourceControl.githubReferences(context, { kind, state, people, query: text, cursor });
        if (!result.connected) return { kind: 'unavailable', reason: 'disconnected' };
        if (!result.repo) return { kind: 'unavailable', reason: 'no-repo' };
        return { kind: 'page', items: result.items, cursor: result.cursor, hasMore: result.hasMore };
    }, [context, kind, people, sourceControl, state, text]);
    return useCachedList(githubLists, key, fetchPage);
}

const NO_ACROSS_ITEMS: AcrossReference[] = [];

/**
 * Issues or PRs of every GitHub repository under a project folder, one request
 * per page (`githubReferencesAcross`). Waits until every folder's context is
 * known, and its key carries the set of contexts asked, so a change in it
 * lists again. Folders on GitLab or without a context are not asked; those the
 * answer skipped come back as `skipped`. `contexts` is what the list was built from.
 */
export function useGitHubAcrossReferenceList(options: {
    enabled: boolean;
    directories: readonly string[];
    kind: GitHubReferenceKind;
    filter: RepositoryReferenceFilter;
    query: string;
}) {
    const { sourceControl } = useRuntimeAPIs();
    const { enabled, directories, kind, filter, query } = options;
    const { state, people } = filter;
    const contexts = useGitHubReadContexts(enabled ? directories : NO_DIRECTORIES);
    const text = query.trim();
    const key = enabled && contexts.ready
        ? JSON.stringify([getRuntimeKey(), contexts.github.map(({ directory, context }) => [directory, readContextCacheKey(context)]), kind, state, people, text])
        : null;
    const fetchPage = React.useCallback(async (cursor: string | null): Promise<ListPage<AcrossReference>> => {
        // Absent where the runtime cannot (VS Code); the board never offers the search there.
        const search = sourceControl.githubReferencesAcross?.bind(sourceControl);
        return fetchAcrossPage(search, contexts.github, { kind, state, people, query: text, cursor });
    }, [contexts.github, kind, people, sourceControl, state, text]);
    const list = useCachedList(githubAcrossLists, key, fetchPage);
    return { ...list, items: list.items.length === 0 ? NO_ACROSS_ITEMS : list.items, contexts };
}

export function useLinearReferenceList(options: {
    enabled: boolean;
    filter: LinearReferenceFilter;
    query: string;
    /** One team's issues; every team's when absent. */
    teamId?: string | null;
}) {
    const { linear } = useRuntimeAPIs();
    const workspace = useLinearAuthStore((state) => state.status?.organization?.id ?? '');
    const { enabled, filter, query } = options;
    const teamId = options.teamId ?? null;
    const text = query.trim();
    const { status, people, priority } = filter;
    const key = enabled && linear ? JSON.stringify([getRuntimeKey(), workspace, status, people, priority, text, teamId]) : null;
    const fetchPage = React.useCallback(async (cursor: string | null): Promise<ListPage<LinearIssueSummary>> => {
        if (!linear) return { kind: 'unavailable', reason: 'disconnected' };
        const result = await linear.issuesList({
            query: text || undefined,
            cursor: cursor ?? undefined,
            status,
            assignee: people,
            priority,
            teamId: teamId ?? undefined,
        });
        if (result.connected === false) return { kind: 'unavailable', reason: 'disconnected' };
        return { kind: 'page', items: result.issues ?? [], cursor: result.cursor ?? null, hasMore: Boolean(result.hasMore) };
    }, [linear, people, priority, status, teamId, text]);
    return useCachedList(linearLists, key, fetchPage);
}

/**
 * Comments of the previewed issue or PR, and a PR's size and review. A cached
 * answer shows at once; GitHub is asked only once `settled` says the
 * highlight stopped on the item.
 */
export function useGitHubReferenceDetail(directory: string | null, reference: GitHubReference | null, settled: boolean) {
    const { sourceControl } = useRuntimeAPIs();
    const context = useGitHubReadContext(reference ? directory : null);
    const owner = reference?.sourceRepo.owner ?? '';
    const repo = reference?.sourceRepo.repo ?? '';
    const number = reference?.number ?? 0;
    // GitLab numbers issues and merge requests separately: #1 and !1 differ.
    const kind = reference?.kind ?? 'issue';
    const key = directory && reference && context && context !== 'missing'
        ? JSON.stringify([getRuntimeKey(), readContextCacheKey(context), directory, kind, owner, repo, number])
        : null;
    const fetch = React.useCallback(async (): Promise<GitHubReferenceDetail> => {
        if (!context || context === 'missing' || !reference) throw new Error('GitHub is not available here');
        if (context.provider === 'gitlab') return fetchGitLabReferenceDetail(sourceControl, context, reference);
        const result = await sourceControl.githubReferenceDetail(context, { owner, repo, number });
        if (!result.connected) throw new Error('GitHub is not connected');
        if (!result.detail) throw new Error('Not found');
        return result.detail;
    }, [context, number, owner, reference, repo, sourceControl]);
    const detail = useCachedValue(githubDetails, key, fetch, settled);
    // After a write (a comment, a review) the feed shows it without waiting for
    // staleness. Settles once it is read again; a failure shows in the preview.
    const refresh = React.useCallback(
        () => (key ? githubDetails.ensure(key, fetch, { force: true }).then(() => undefined, () => undefined) : Promise.resolve()),
        [fetch, key],
    );
    return { detail, refresh };
}

// A key per PR and head commit: a push asks again, a page loaded later
// reuses what the earlier pages already answered.
const githubPullStatuses = createValueCache<GitHubPullStatus | null>(200);
// A third of a listed page per request, asked together: GitHub answers a
// page's checks in one query only after ~10 s, at the edge of the request's
// timeout, so the first rows (and the preview) waited for the slowest PR.
const PULL_STATUS_BATCH = 10;
const IDLE: CachedValue<GitHubPullStatus | null> = { status: 'idle' };

/** Forgets every PR's checks and mergeability, so the lists showing them ask again: the board's refresh. */
export const forgetGitHubPullStatuses = (): void => githubPullStatuses.clear();

const pullStatusScope = (group: PullStatusGroup): string => (
    JSON.stringify([getRuntimeKey(), readContextCacheKey(group.context), group.directory])
);

/**
 * Checks and mergeability of the open PRs of each group, asked after the list
 * in batches of a page, so they colour like the sidebar. A group is a folder
 * and the GitHub context its PRs are read through; groups are asked
 * independently. The reader answers `idle` for anything outside them.
 */
function usePullStatusGroups(groups: readonly PullStatusGroup[]) {
    const { sourceControl } = useRuntimeAPIs();
    const keys = React.useMemo(
        () => groups.flatMap((group) => group.pulls.map((pull) => pullStatusKey(pullStatusScope(group), pull))),
        [groups],
    );

    // Through the store, not an effect: React reads the version again once it
    // has subscribed, so an answer that lands between a render and its
    // subscription (a list shown from the cache while its statuses are on the
    // way) still shows instead of leaving the row and preview loading.
    const subscribe = React.useCallback((listener: () => void) => {
        const stops = keys.map((key) => githubPullStatuses.subscribe(key, listener));
        return () => stops.forEach((stop) => stop());
    }, [keys]);
    const version = React.useSyncExternalStore(subscribe, githubPullStatuses.version, githubPullStatuses.version);
    const revalidation = useReferenceRevalidation();

    // Runs again on every change and revalidation too, so statuses forgotten
    // by a refresh or gone old are asked again; fresh and pending ones are
    // skipped by `ensureMany`.
    React.useEffect(() => {
        ensurePullStatuses(
            githubPullStatuses,
            groups,
            pullStatusScope,
            (context, pulls) => sourceControl.githubPullStatuses(
                context,
                pulls.map((pull) => ({ owner: pull.sourceRepo.owner, repo: pull.sourceRepo.repo, number: pull.number })),
            ),
            PULL_STATUS_BATCH,
        );
    }, [groups, revalidation, sourceControl, version]);

    return (reference: GitHubReference, directory: string | null): CachedValue<GitHubPullStatus | null> => {
        const group = groups.find((candidate) => candidate.directory === directory);
        if (!group || !needsPullStatus(reference)) return IDLE;
        return githubPullStatuses.read(pullStatusKey(pullStatusScope(group), reference)) ?? IDLE;
    };
}

/**
 * Checks and mergeability of the open PRs a list shows. GitHub only: a GitLab
 * project's items, issues and closed PRs ask nothing and answer `idle`. A ready
 * null is a PR GitHub could not resolve.
 */
export function useGitHubPullStatuses(directory: string | null, references: readonly GitHubReference[]) {
    const context = useGitHubReadContext(directory);
    const github = context && context !== 'missing' && context.provider === 'github' ? context : null;
    const groups = React.useMemo(
        () => (github && directory ? groupPullsByDirectory(references.map((reference) => ({ reference, directory })), partitionAcrossContexts([{ directory, state: github }])) : []),
        [directory, github, references],
    );
    const statusOf = usePullStatusGroups(groups);
    return (reference: GitHubReference): CachedValue<GitHubPullStatus | null> => statusOf(reference, directory);
}

/** The same for a list across repositories: each PR is asked through the context of the folder it came from. */
export function useGitHubPullStatusesAcross(contexts: AcrossContexts, items: readonly AcrossReference[]) {
    const groups = React.useMemo(
        () => groupPullsByDirectory(items.map((item) => ({ reference: item, directory: item.directory })), contexts),
        [contexts, items],
    );
    return usePullStatusGroups(groups);
}

const linearDetailKey = (workspace: string, issueId: string) => JSON.stringify([getRuntimeKey(), workspace, issueId]);

const fetchLinearIssue = async (linear: LinearAPI, issueId: string): Promise<LinearIssue> => {
    const result = await linear.issueGet(issueId);
    if (result.connected === false) throw new Error('Linear is not connected');
    if (!result.issue) throw new Error('Issue not found');
    return result.issue;
};

/**
 * A Linear issue with its description and comments, from the same cache the
 * preview fills: attaching an issue that was previewed asks Linear nothing.
 */
export function readLinearIssueDetail(linear: LinearAPI, issueId: string): Promise<LinearIssue> {
    const workspace = useLinearAuthStore.getState().status?.organization?.id ?? '';
    return linearDetails.ensure(linearDetailKey(workspace, issueId), () => fetchLinearIssue(linear, issueId));
}

/** The previewed Linear issue's description and comments; asked once `settled`, like GitHub's. */
export function useLinearIssueDetail(issueId: string | null, settled: boolean) {
    const { linear } = useRuntimeAPIs();
    const workspace = useLinearAuthStore((state) => state.status?.organization?.id ?? '');
    const key = issueId && linear ? linearDetailKey(workspace, issueId) : null;
    const fetch = React.useCallback(async () => {
        if (!linear || !issueId) throw new Error('Linear is not available here');
        return fetchLinearIssue(linear, issueId);
    }, [issueId, linear]);
    const detail = useCachedValue(linearDetails, key, fetch, settled);
    // After a change of state, read again without waiting for staleness.
    const refresh = React.useCallback(
        () => (key ? linearDetails.ensure(key, fetch, { force: true }).then(() => undefined, () => undefined) : Promise.resolve()),
        [fetch, key],
    );
    return { detail, refresh };
}

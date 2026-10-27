/**
 * Where the picker's lists and previews come from, one cache per kind of
 * answer. Cache keys carry the runtime, the account and the project, so a
 * different account or host never sees another one's list.
 *
 * Repository items are read with the project's read context: the account its
 * binding names, or the current account of the host for a repository nobody
 * bound, the same one the Git view reads with. What the provider can do
 * decides how: its own reference search and detail where its descriptor says
 * so (`features.referenceSearch`, `features.referenceDetail`), else the
 * neutral list reads (`listBackedReferences.ts`), through the same rows and
 * preview.
 */

import * as React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type {
    SourceControlBindingRead,
    RepositoryItemRef,
    ChangeRequestListStatus,
    RepositoryReference,
    RepositoryReferenceDetail,
    RepositoryReferenceFilter,
    RepositoryReferenceKind,
    TrackerAPI,
    TrackerItem,
    TrackerItemSummary,
    SourceControlIdentity,
    SourceControlProvider,
    SourceControlReadContext,
} from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { defaultSourceControlIdentities, resolveSourceControlIdentity } from '@/lib/source-control/identity';
import { unknownProviderDescriptor, type SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import { useSourceControlProvider, useSourceControlProviderRegistry, useSourceControlProviders } from '@/lib/source-control/providers/registry';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { getSourceControlAuthKey, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { useRepositoryBinding, useRepositoryBindings } from '@/lib/source-control/repository-binding';
import { currentTrackerAccountId, useTrackerAuthStore } from '@/stores/useTrackerAuthStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { normalizeProjectPath, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useSpaceProjectDirectory } from '@/lib/spaces/spaces-store';
import {
    rememberedRepositoryProvider,
    rememberRepositoryProvider,
    subscribeRepositoryProviderMemory,
} from '@/lib/source-control/repositoryProviderMemory';

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
import { fetchListBackedReferenceDetail, fetchListBackedReferencePage } from './listBackedReferences';
import { isNewerThanRead, useLivePullStatuses, useLiveReferences, useLiveTrackerItems, type LivePullStatus } from './liveReferences';
import { createListCache, createValueCache, useCachedList, useCachedValue, useReferenceRevalidation, type CachedValue, type ListPage, type PageRead, type ReadStamp } from './referenceCache';
import type { TrackerReferenceFilter } from './referencePickerItems';
import { joinProjectPath } from '@/lib/source-control/projectPath';

const repositoryLists = createListCache<RepositoryReference>();
const repositoryAcrossLists = createListCache<AcrossReference>();
const trackerLists = createListCache<TrackerItemSummary>();
const trackerDetails = createValueCache<TrackerItem>();
const repositoryDetails = createValueCache<RepositoryReferenceDetail>();

export type ReferenceSourceStatus = 'ready' | 'disconnected' | 'unsupported';

/** A provider's place in the registry; one it does not hold comes after all it does. */
const orderOf = (descriptors: readonly SourceControlProviderDescriptor[], provider: string): number => (
    (descriptors.find((descriptor) => descriptor.id === provider) ?? unknownProviderDescriptor(provider)).order
);

/** The entry whose provider comes first by registry `order`; the earlier entry on a tie. */
function firstByOrder<T extends { provider: string }>(entries: readonly T[], descriptors: readonly SourceControlProviderDescriptor[]): T | null {
    let first: T | null = null;
    for (const entry of entries) {
        if (!first || orderOf(descriptors, entry.provider) < orderOf(descriptors, first.provider)) first = entry;
    }
    return first;
}

/**
 * Whether the registry holds no list yet on a first visit to this runtime:
 * nothing remembered, and the first request still out or failed and being
 * retried. What a provider can do is unknown then, so nothing is read with a
 * guess.
 */
const useProvidersPending = (): boolean => useSourceControlProviderRegistry((state) => !state.holdsList);

/**
 * The project's binding and every host it lives on: the providers it is bound
 * to and the hosts its remotes point at, whether or not an account there works.
 */
function repositoryHostsOf(
    read: SourceControlBindingRead | null,
    knownIdentities: readonly SourceControlIdentity[],
    defaultIdentities: readonly SourceControlIdentity[],
): SourceControlIdentity[] {
    if (!read) return [];
    const found = new Map<string, SourceControlIdentity>();
    const add = (identity: SourceControlIdentity) => found.set(getSourceControlAuthKey(identity), identity);
    for (const provider of read.binding?.providers ?? []) add({ provider: provider.provider, instance: provider.instance });
    const identities = [...knownIdentities, ...defaultIdentities];
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
    const descriptors = useSourceControlProviders();
    const defaultIdentities = React.useMemo(() => defaultSourceControlIdentities(descriptors), [descriptors]);
    const hosts = React.useMemo(
        () => repositoryHostsOf(binding.read, knownIdentities, defaultIdentities),
        [binding.read, defaultIdentities, knownIdentities],
    );
    return { binding, hosts, descriptors, defaultIdentities };
}

/**
 * The context a folder is read with once its binding and accounts are known:
 * the one whose provider comes first by registry `order`.
 */
function pickReadContext(
    binding: { contexts: readonly SourceControlReadContext[]; status: 'idle' | 'loading' | 'ready' | 'stale' | 'error' },
    hostPending: boolean,
    descriptors: readonly SourceControlProviderDescriptor[],
): ReadContextState {
    const context = firstByOrder(binding.contexts, descriptors);
    if (context) return context;
    if (binding.status === 'error') return 'missing';
    return binding.status === 'ready' && !hostPending ? 'missing' : null;
}

const NO_DIRECTORIES: readonly string[] = [];

/**
 * The read contexts of several folders at once, for a list across the
 * repositories under a project folder. `ready` once every folder's context is
 * known; the folders of the provider asked are what a search is sent, the
 * rest are left out (`partitionAcrossContexts`).
 */
function useRepositoryReadContexts(directories: readonly string[]): AcrossContexts {
    const { sourceControl } = useRuntimeAPIs();
    const bindings = useRepositoryBindings(directories, sourceControl);
    const knownIdentities = useSourceControlAuthStore((state) => state.identities);
    const authEntries = useSourceControlAuthStore((state) => state.entries);
    const descriptors = useSourceControlProviders();
    const providersPending = useProvidersPending();
    return React.useMemo(() => {
        if (directories.length === 0) return NO_ACROSS_CONTEXTS;
        const defaultIdentities = defaultSourceControlIdentities(descriptors);
        return partitionAcrossContexts(directories.map((directory, index) => {
            const binding = bindings[index];
            if (!binding || providersPending) return { directory, state: null };
            const hostPending = repositoryHostsOf(binding.read, knownIdentities, defaultIdentities)
                .some((host) => !authEntries[getSourceControlAuthKey(host)]?.hasChecked);
            return { directory, state: pickReadContext(binding, hostPending, descriptors) };
        }), descriptors);
    }, [authEntries, bindings, descriptors, directories, knownIdentities, providersPending]);
}

/**
 * The host whose account reads the project: its read context's, else the host
 * its remotes point at, the first by registry `order`. Known even while no
 * account there works, so a surface can name that provider and ask for its
 * account. Null while the binding loads or when the project lives on no
 * known host.
 */
export function useRepositoryHost(directory: string | null): SourceControlIdentity | null {
    const { binding, hosts, descriptors } = useRepositoryHosts(directory);
    const context = firstByOrder(binding.contexts, descriptors);
    const provider = context?.provider ?? null;
    const instance = context?.instance ?? null;
    return React.useMemo(() => {
        if (provider && instance) return { provider, instance };
        return firstByOrder(hosts, descriptors);
    }, [descriptors, hosts, instance, provider]);
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
 * binding has been read: the one whose provider comes first by registry
 * `order`. Null while the binding, an account on one of its hosts, or the
 * provider list on a first visit is still loading, and `missing` when no
 * account can read it: no remote on a known host, or none of its hosts has a
 * working account.
 */
export function useRepositoryReadContext(directory: string | null): SourceControlReadContext | 'missing' | null {
    const { binding, hosts, descriptors } = useRepositoryHosts(directory);
    const hostPending = useSourceControlAuthStore((state) => hosts
        .some((host) => !state.entries[getSourceControlAuthKey(host)]?.hasChecked));
    const providersPending = useProvidersPending();
    if (providersPending) return null;
    return pickReadContext(binding, hostPending, descriptors);
}

/**
 * The host a project's items come from.
 *
 * Read contexts name it once the binding and the accounts have both loaded,
 * but either can still be loading, and a binding nobody watches goes stale
 * with no contexts. The project's remotes say where it lives in all of those
 * moments, so they answer meanwhile. Of several providers the first by
 * registry `order` wins, as the read context does.
 */
export function useRepositoryReferenceProvider(directory: string | null): SourceControlProvider | null {
    const { binding, hosts, descriptors } = useRepositoryHosts(directory);
    // A worktree shares its project's host, so the answer is kept per project.
    const projects = useProjectsStore((state) => state.projects);
    const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
    const spaceProjectDirectory = useSpaceProjectDirectory(directory);
    const projectPath = React.useMemo(() => {
        if (!directory) return null;
        const project = resolveProjectForSessionDirectory(projects, worktreesByProject, directory, spaceProjectDirectory);
        return normalizeProjectPath(project?.path ?? directory);
    }, [directory, projects, spaceProjectDirectory, worktreesByProject]);
    const runtimeKey = getRuntimeKey();
    const remembered = React.useSyncExternalStore(
        subscribeRepositoryProviderMemory,
        () => rememberedRepositoryProvider(runtimeKey, projectPath),
    );
    // What the project itself says, or null while nothing has loaded that could.
    const known = React.useMemo((): SourceControlProvider | null => (
        firstByOrder(binding.contexts.length > 0 ? binding.contexts : hosts, descriptors)?.provider ?? null
    ), [binding.contexts, descriptors, hosts]);
    React.useEffect(() => {
        if (known) rememberRepositoryProvider(runtimeKey, projectPath, known);
    }, [known, projectPath, runtimeKey]);
    // Nothing known or remembered: the first served provider, or none on a runtime that serves none.
    return known ?? remembered ?? descriptors[0]?.id ?? null;
}

/**
 * Whether the project's issues and change requests can be listed. A project
 * that lives on a known host but no account there can read it is
 * disconnected, and so is a project with no remote at all while no account is
 * connected anywhere (once a default instance's account is checked).
 */
export function useRepositorySourceStatus(directory: string | null): ReferenceSourceStatus {
    const { runtime } = useRuntimeAPIs();
    const context = useRepositoryReadContext(directory);
    const { hosts, defaultIdentities } = useRepositoryHosts(directory);
    const anyConnected = useSourceControlAuthStore((state) => Object.values(state.entries)
        .some((entry) => entry.status?.connected === true));
    const defaultChecked = useSourceControlAuthStore((state) => defaultIdentities
        .some((identity) => state.entries[getSourceControlAuthKey(identity)]?.hasChecked));
    if (runtime.isVSCode) return 'unsupported';
    if (context !== 'missing') return 'ready';
    return hosts.length > 0 || (defaultChecked && !anyConnected) ? 'disconnected' : 'ready';
}

/** The account a tracker's lists and details are read with; '' while unknown. */
const useTrackerAccount = (provider: string | null): string => useTrackerAuthStore((state) => (
    provider ? currentTrackerAccountId(state.entries[provider]) : ''
));

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

export function useRepositoryReferenceList(options: {
    enabled: boolean;
    directory: string | null;
    kind: RepositoryReferenceKind;
    filter: RepositoryReferenceFilter;
    query: string;
}) {
    const { sourceControl } = useRuntimeAPIs();
    const { enabled, directory, kind, filter, query } = options;
    const { state, people } = filter;
    const context = useRepositoryReadContext(enabled ? directory : null);
    const readable = context && context !== 'missing' ? context : null;
    const descriptor = useSourceControlProvider(readable?.provider);
    const urls = useRepositoryUrlMatcher();
    const text = query.trim();
    const scope = readable ? readContextCacheKey(readable) : 'missing';
    const key = enabled && directory && context
        ? JSON.stringify([getRuntimeKey(), scope, directory, kind, filter.state, filter.people, text])
        : null;
    const fetchPage = React.useCallback(async (cursor: string | null): Promise<ListPage<RepositoryReference>> => {
        if (!readable) return { kind: 'unavailable', reason: 'no-repo' };
        if (!descriptor.features.referenceSearch) {
            return fetchListBackedReferencePage(sourceControl, readable, { descriptor, urls }, kind, { state, people }, text, cursor);
        }
        const result = await sourceControl.references(readable, { kind, state, people, query: text, cursor });
        if (!result.connected) return { kind: 'unavailable', reason: 'disconnected' };
        if (!result.repo) return { kind: 'unavailable', reason: 'no-repo' };
        return { kind: 'page', items: result.items, cursor: result.cursor, hasMore: result.hasMore };
    }, [descriptor, kind, people, readable, sourceControl, state, text, urls]);
    const list = useCachedList(repositoryLists, key, fetchPage);
    const contextOf = React.useCallback(() => readable, [readable]);
    const live = useLiveReferences(list.items, contextOf, list.pageReads);
    return { ...list, items: live.items, followed: live.followed };
}

const NO_ACROSS_ITEMS: AcrossReference[] = [];

/**
 * Issues or PRs of every repository under a project folder on the provider
 * asked (`partitionAcrossContexts`), one request per page
 * (`referencesAcross`). Waits until every folder's context is known, and its
 * key carries the set of contexts asked, so a change in it lists again.
 * Folders on another provider or without a context are not asked; those the
 * answer skipped come back as `skipped`. `contexts` is what the list was built from.
 */
export function useRepositoryAcrossReferenceList(options: {
    enabled: boolean;
    directories: readonly string[];
    kind: RepositoryReferenceKind;
    filter: RepositoryReferenceFilter;
    query: string;
}) {
    const { sourceControl } = useRuntimeAPIs();
    const { enabled, directories, kind, filter, query } = options;
    const { state, people } = filter;
    const contexts = useRepositoryReadContexts(enabled ? directories : NO_DIRECTORIES);
    const text = query.trim();
    const key = enabled && contexts.ready
        ? JSON.stringify([getRuntimeKey(), contexts.asked.map(({ directory, context }) => [directory, readContextCacheKey(context)]), kind, state, people, text])
        : null;
    const fetchPage = React.useCallback(async (cursor: string | null): Promise<ListPage<AcrossReference>> => {
        // Absent where the runtime cannot (VS Code); the board never offers the search there.
        const search = sourceControl.referencesAcross?.bind(sourceControl);
        return fetchAcrossPage(search, contexts.asked, { kind, state, people, query: text, cursor });
    }, [contexts.asked, kind, people, sourceControl, state, text]);
    const list = useCachedList(repositoryAcrossLists, key, fetchPage);
    const contextOf = React.useCallback(
        (item: AcrossReference) => contexts.asked.find((entry) => entry.directory === item.directory)?.context ?? null,
        [contexts.asked],
    );
    const live = useLiveReferences(list.items, contextOf, list.pageReads);
    return { ...list, items: live.items.length === 0 ? NO_ACROSS_ITEMS : live.items, followed: live.followed, contexts };
}

/**
 * The provider a list across the repositories under a folder asks, the one
 * `useRepositoryAcrossReferenceList` reads; null while the folders' contexts
 * load, or without folders.
 */
export function useRepositoryAcrossProvider(directories: readonly string[] | null): SourceControlProvider | null {
    return useRepositoryReadContexts(directories ?? NO_DIRECTORIES).provider;
}

/** One tracker's work items; the key carries the tracker and its account, so another account never sees this list. */
export function useTrackerReferenceList(options: {
    enabled: boolean;
    provider: string | null;
    filter: TrackerReferenceFilter;
    query: string;
    /** One container's items (a Linear team); every container's when absent. */
    containerId?: string | null;
}) {
    const { trackers } = useRuntimeAPIs();
    const { enabled, provider, filter, query } = options;
    const account = useTrackerAccount(provider);
    const containerId = options.containerId ?? null;
    const text = query.trim();
    const { state, people, priority } = filter;
    const key = enabled && trackers && provider
        ? JSON.stringify([getRuntimeKey(), provider, account, state, people, priority, text, containerId])
        : null;
    const fetchPage = React.useCallback(async (cursor: string | null): Promise<ListPage<TrackerItemSummary>> => {
        if (!trackers || !provider) return { kind: 'unavailable', reason: 'disconnected' };
        const result = await trackers.list(provider, {
            query: text || undefined,
            cursor: cursor ?? undefined,
            state,
            // A filter left at its default is not sent, so a tracker without it still lists.
            people: people === 'any' ? undefined : people,
            priority: priority === 'all' ? undefined : priority,
            containerId,
        });
        if (result.connected === false) return { kind: 'unavailable', reason: 'disconnected' };
        return { kind: 'page', items: result.items, cursor: result.cursor, hasMore: result.hasMore };
    }, [containerId, people, priority, provider, state, text, trackers]);
    const list = useCachedList(trackerLists, key, fetchPage);
    const live = useLiveTrackerItems(list.items, list.pageReads);
    return { ...list, items: live.items, followed: live.followed };
}

/**
 * Comments of the previewed issue, PR or discussion, and a PR's size and review. A cached
 * answer shows at once; the host is asked only once `settled` says the
 * highlight stopped on the item.
 *
 * `revision` (a commit of the change, where the provider has
 * `features.revisions`) reads that revision's files beside the latest:
 * `detail` is then the revision's, `latest` stays the latest one, which names
 * the revisions to pick from and carries the votes.
 */
export function useRepositoryReferenceDetail(directory: string | null, reference: RepositoryReference | null, settled: boolean, revision: string | null = null) {
    const { sourceControl } = useRuntimeAPIs();
    const context = useRepositoryReadContext(reference ? directory : null);
    const readable = context && context !== 'missing' ? context : null;
    const features = useSourceControlProvider(readable?.provider).features;
    const detailed = features.referenceDetail;
    const owner = reference?.sourceRepo.owner ?? '';
    const repo = reference?.sourceRepo.repo ?? '';
    const number = reference?.number ?? 0;
    // Where issues and change requests are numbered apart, #1 and !1 differ.
    const kind = reference?.kind ?? 'issue';
    const key = directory && reference && readable
        ? JSON.stringify([getRuntimeKey(), readContextCacheKey(readable), directory, kind, owner, repo, number])
        : null;
    const fetch = React.useCallback(async (): Promise<RepositoryReferenceDetail> => {
        if (!readable || !reference) throw new Error('The repository is not available here');
        if (!detailed) return fetchListBackedReferenceDetail(sourceControl, readable, reference);
        const result = await sourceControl.referenceDetail(readable, kind === 'discussion' ? { owner, repo, number, kind } : { owner, repo, number });
        if (!result.connected) throw new Error(`${readable.provider} is not connected`);
        if (!result.detail) throw new Error('Not found');
        return result.detail;
    }, [detailed, kind, number, owner, readable, reference, repo, sourceControl]);
    const latest = useCachedValue(repositoryDetails, key, fetch, settled);
    // An older revision is its own answer; the latest one keeps its key, so it is shared as before.
    const pickedRevision = features.revisions && kind === 'pull' && !detailed ? revision : null;
    const revisionKey = key && pickedRevision ? JSON.stringify([key, pickedRevision]) : null;
    const fetchRevision = React.useCallback(async (): Promise<RepositoryReferenceDetail> => {
        if (!readable || !reference || !pickedRevision) throw new Error('The repository is not available here');
        return fetchListBackedReferenceDetail(sourceControl, readable, reference, pickedRevision);
    }, [pickedRevision, readable, reference, sourceControl]);
    const revisionDetail = useCachedValue(repositoryDetails, revisionKey, fetchRevision, settled);
    // After a write (a comment, a review) the feed shows it without waiting for
    // staleness. Settles once it is read again; a failure shows in the preview.
    const refresh = React.useCallback(
        () => (key ? Promise.all([
            repositoryDetails.ensure(key, fetch, { force: true }),
            ...(revisionKey ? [repositoryDetails.ensure(revisionKey, fetchRevision, { force: true })] : []),
        ]).then(() => undefined, () => undefined) : Promise.resolve()),
        [fetch, fetchRevision, key, revisionKey],
    );
    return { detail: revisionKey ? revisionDetail : latest, latest, refresh };
}

// A key per PR and head commit: a push asks again, a page loaded later
// reuses what the earlier pages already answered.
const repositoryPullStatuses = createValueCache<ChangeRequestListStatus | null>(200);
// A third of a listed page per request, asked together: GitHub answers a
// page's checks in one query only after ~10 s, at the edge of the request's
// timeout, so the first rows (and the preview) waited for the slowest PR.
const PULL_STATUS_BATCH = 10;
const IDLE: CachedValue<ChangeRequestListStatus | null> = { status: 'idle' };

/** Forgets every PR's checks and mergeability, so the lists showing them ask again: the board's list refresh. */
export const forgetRepositoryPullStatuses = (): void => repositoryPullStatuses.clear();

/** Forgets one PR's checks and mergeability, at any head commit: the preview's refresh. */
export const forgetRepositoryPullStatus = (pull: RepositoryItemRef): void => {
    const marker = `|${joinProjectPath(pull.owner, pull.repo)}#${pull.number}@`.toLowerCase();
    repositoryPullStatuses.forget((key) => key.toLowerCase().includes(marker));
};

const pullStatusScope = (group: PullStatusGroup): string => (
    JSON.stringify([getRuntimeKey(), readContextCacheKey(group.context), group.directory])
);

/**
 * Checks and mergeability of the open PRs of each group, asked after the list
 * in batches of a page, so they colour like the sidebar. A group is a folder
 * and the context its PRs are read through; groups are asked
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
        const stops = keys.map((key) => repositoryPullStatuses.subscribe(key, listener));
        return () => stops.forEach((stop) => stop());
    }, [keys]);
    const version = React.useSyncExternalStore(subscribe, repositoryPullStatuses.version, repositoryPullStatuses.version);
    const revalidation = useReferenceRevalidation();

    // Runs again on every change and revalidation too, so statuses forgotten
    // by a refresh or gone old are asked again; fresh and pending ones are
    // skipped by `ensureMany`.
    React.useEffect(() => {
        ensurePullStatuses(
            repositoryPullStatuses,
            groups,
            pullStatusScope,
            (context, pulls) => sourceControl.changeRequestListStatuses(
                context,
                pulls.map((pull) => ({ owner: pull.sourceRepo.owner, repo: pull.sourceRepo.repo, number: pull.number })),
            ),
            PULL_STATUS_BATCH,
        );
    }, [groups, revalidation, sourceControl, version]);

    return (reference: RepositoryReference, directory: string | null): AskedPullStatus => {
        const group = groups.find((candidate) => candidate.directory === directory);
        if (!group || !needsPullStatus(reference)) return { value: IDLE, read: null };
        const key = pullStatusKey(pullStatusScope(group), reference);
        return { value: repositoryPullStatuses.read(key) ?? IDLE, read: repositoryPullStatuses.readOf(key) };
    };
}

/** A PR's status as asked for its list, and when it was read (null before an answer). */
type AskedPullStatus = { value: CachedValue<ChangeRequestListStatus | null>; read: ReadStamp | null };

/**
 * A PR's status as asked for its list, or the followed one when that was
 * answered later (`liveReferences.ts`): checks that finish while the list
 * stays on screen recolour its row.
 */
const newerStatus = (asked: AskedPullStatus, live: LivePullStatus | null): CachedValue<ChangeRequestListStatus | null> => {
    if (!live || (asked.read && !isNewerThanRead(live.fetchedAt, asked.read))) return asked.value;
    return { status: 'ready', value: live.status };
};

/**
 * Checks and mergeability of the open PRs a list shows. A provider with list
 * statuses (`features.listStatuses`) is asked for them with the list; the
 * others' come from the followed change requests' pipelines. Issues and closed
 * PRs answer `idle`. A ready null is a PR the host could not resolve.
 */
export function useRepositoryPullStatuses(directory: string | null, references: readonly RepositoryReference[]) {
    const context = useRepositoryReadContext(directory);
    const readable = context && context !== 'missing' ? context : null;
    const listed = useSourceControlProvider(readable?.provider).features.listStatuses;
    const asked = listed ? readable : null;
    const groups = React.useMemo(
        () => (asked && directory ? groupPullsByDirectory(references.map((reference) => ({ reference, directory })), [{ directory, context: asked }]) : []),
        [asked, directory, references],
    );
    const askedOf = usePullStatusGroups(groups);
    const pulls = React.useMemo(() => references.map((reference) => ({ reference, context: readable })), [readable, references]);
    const liveOf = useLivePullStatuses(pulls);
    return (reference: RepositoryReference): CachedValue<ChangeRequestListStatus | null> => (
        newerStatus(askedOf(reference, directory), liveOf(reference, readable))
    );
}

/** The same for a list across repositories: each PR is asked through the context of the folder it came from. */
export function useRepositoryPullStatusesAcross(contexts: AcrossContexts, items: readonly AcrossReference[]) {
    const listed = useSourceControlProvider(contexts.provider).features.listStatuses;
    const groups = React.useMemo(
        () => (listed ? groupPullsByDirectory(items.map((item) => ({ reference: item, directory: item.directory })), contexts.asked) : []),
        [contexts.asked, items, listed],
    );
    const askedOf = usePullStatusGroups(groups);
    const contextOf = React.useCallback(
        (directory: string | null) => contexts.asked.find((entry) => entry.directory === directory)?.context ?? null,
        [contexts.asked],
    );
    const pulls = React.useMemo(() => items.map((item) => ({ reference: item, context: contextOf(item.directory) })), [contextOf, items]);
    const liveOf = useLivePullStatuses(pulls);
    return (reference: RepositoryReference, directory: string | null): CachedValue<ChangeRequestListStatus | null> => (
        newerStatus(askedOf(reference, directory), liveOf(reference, contextOf(directory)))
    );
}

const trackerDetailKey = (provider: string, account: string, itemId: string) => JSON.stringify([getRuntimeKey(), provider, account, itemId]);

const fetchTrackerItem = async (trackers: TrackerAPI, provider: string, itemId: string): Promise<TrackerItem> => {
    const result = await trackers.get(provider, itemId);
    if (result.connected === false) throw new Error(`${provider} is not connected`);
    if (!result.item) throw new Error('Item not found');
    return result.item;
};

/**
 * A tracker item with its description and comments, from the same cache the
 * preview fills: attaching an item that was previewed asks the tracker nothing.
 */
export function readTrackerItemDetail(trackers: TrackerAPI, provider: string, itemId: string): Promise<TrackerItem> {
    const account = currentTrackerAccountId(useTrackerAuthStore.getState().entries[provider]);
    return trackerDetails.ensure(trackerDetailKey(provider, account, itemId), () => fetchTrackerItem(trackers, provider, itemId));
}

/** The previewed tracker item's description and comments; asked once `settled`, like a repository item's. */
export function useTrackerItemDetail(item: { provider: string; id: string } | null, settled: boolean) {
    const { trackers } = useRuntimeAPIs();
    const provider = item?.provider ?? null;
    const itemId = item?.id ?? null;
    const account = useTrackerAccount(provider);
    const key = provider && itemId && trackers ? trackerDetailKey(provider, account, itemId) : null;
    const fetch = React.useCallback(async () => {
        if (!trackers || !provider || !itemId) throw new Error('Trackers are not available here');
        return fetchTrackerItem(trackers, provider, itemId);
    }, [itemId, provider, trackers]);
    const cached = useCachedValue(trackerDetails, key, fetch, settled);
    // The item's state as the server follows it, once that is newer than the read.
    const items = React.useMemo(() => (cached.status === 'ready' ? [cached.value] : []), [cached]);
    const read = key ? trackerDetails.readOf(key) : null;
    const readAt = read?.at ?? 0;
    const readForced = read?.forced ?? false;
    const reads = React.useMemo<PageRead[]>(
        () => (readAt ? [{ start: 0, read: { at: readAt, forced: readForced } }] : []),
        [readAt, readForced],
    );
    const live = useLiveTrackerItems(items, reads);
    const liveItem = live.items[0];
    const detail = React.useMemo<CachedValue<TrackerItem>>(
        () => (cached.status === 'ready' && liveItem && liveItem !== cached.value ? { status: 'ready', value: liveItem } : cached),
        [cached, liveItem],
    );
    // After a change of state, read again without waiting for staleness.
    const refresh = React.useCallback(
        () => (key ? trackerDetails.ensure(key, fetch, { force: true }).then(() => undefined, () => undefined) : Promise.resolve()),
        [fetch, key],
    );
    return { detail, refresh, followed: live.followed };
}

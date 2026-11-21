
import * as React from 'react';

import { useMinuteTickerNow } from '@/hooks/useDurationTicker';
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
import { reconcileLabelWrites, useLabelWrites } from './labelWrites';
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

const orderOf = (descriptors: readonly SourceControlProviderDescriptor[], provider: string): number => (
    (descriptors.find((descriptor) => descriptor.id === provider) ?? unknownProviderDescriptor(provider)).order
);

function firstByOrder<T extends { provider: string }>(entries: readonly T[], descriptors: readonly SourceControlProviderDescriptor[]): T | null {
    let first: T | null = null;
    for (const entry of entries) {
        if (!first || orderOf(descriptors, entry.provider) < orderOf(descriptors, first.provider)) first = entry;
    }
    return first;
}

const useProvidersPending = (): boolean => useSourceControlProviderRegistry((state) => !state.holdsList);

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

export function useRepositoryHostProvider(directory: string | null): SourceControlProvider | 'none' | null {
    const { binding, hosts } = useRepositoryHosts(directory);
    const provider = useRepositoryReferenceProvider(directory);
    if (!directory) return null;
    if (binding.contexts.length > 0 || hosts.length > 0) return provider;
    return binding.read ? 'none' : provider;
}

export function useRepositoryReadContext(directory: string | null): SourceControlReadContext | 'missing' | null {
    const { binding, hosts, descriptors } = useRepositoryHosts(directory);
    const hostPending = useSourceControlAuthStore((state) => hosts
        .some((host) => !state.entries[getSourceControlAuthKey(host)]?.hasChecked));
    const providersPending = useProvidersPending();
    if (providersPending) return null;
    return pickReadContext(binding, hostPending, descriptors);
}

export function useRepositoryReferenceProvider(directory: string | null): SourceControlProvider | null {
    const { binding, hosts, descriptors } = useRepositoryHosts(directory);
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
    const known = React.useMemo((): SourceControlProvider | null => (
        firstByOrder(binding.contexts.length > 0 ? binding.contexts : hosts, descriptors)?.provider ?? null
    ), [binding.contexts, descriptors, hosts]);
    React.useEffect(() => {
        if (known) rememberRepositoryProvider(runtimeKey, projectPath, known);
    }, [known, projectPath, runtimeKey]);
    return known ?? remembered ?? descriptors[0]?.id ?? null;
}

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

const useTrackerAccount = (provider: string | null): string => useTrackerAuthStore((state) => (
    provider ? currentTrackerAccountId(state.entries[provider]) : ''
));

const readContextCacheKey = (context: SourceControlReadContext): unknown[] => [
    context.provider,
    context.instance,
    context.accountId,
    context.directory,
    context.repositoryId,
    context.primaryRemote,
    context.bindingRevision,
    context.linked === true,
];

const useReferenceReadContext = (context: SourceControlReadContext | 'missing' | null, linked: boolean): SourceControlReadContext | null => (
    React.useMemo(() => {
        if (!context || context === 'missing') return null;
        return linked ? { ...context, linked: true } : context;
    }, [context, linked])
);

export function useRepositoryReferenceList(options: {
    enabled: boolean;
    directory: string | null;
    kind: RepositoryReferenceKind;
    filter: RepositoryReferenceFilter;
    query: string;
    linked?: boolean;
}) {
    const { sourceControl } = useRuntimeAPIs();
    const { enabled, directory, kind, filter, query, linked = false } = options;
    const { state, people, labels } = filter;
    const context = useRepositoryReadContext(enabled ? directory : null);
    const readable = useReferenceReadContext(context, linked);
    const descriptor = useSourceControlProvider(readable?.provider);
    const urls = useRepositoryUrlMatcher();
    const text = query.trim();
    const scope = readable ? readContextCacheKey(readable) : 'missing';
    const key = enabled && directory && context
        ? JSON.stringify([getRuntimeKey(), scope, directory, kind, filter.state, filter.people, labels, text])
        : null;
    const fetchPage = React.useCallback(async (cursor: string | null): Promise<ListPage<RepositoryReference>> => {
        if (!readable) return { kind: 'unavailable', reason: 'no-repo' };
        const named = (page: ListPage<RepositoryReference>): ListPage<RepositoryReference> => (
            linked && page.kind === 'page' ? { ...page, items: page.items.map((item) => ({ ...item, linked: true })) } : page
        );
        if (!descriptor.features.referenceSearch) {
            return named(await fetchListBackedReferencePage(sourceControl, readable, { descriptor, urls }, kind, { state, people, labels }, text, cursor));
        }
        const result = await sourceControl.references(readable, { kind, state, people, labels, query: text, cursor });
        if (!result.connected) return { kind: 'unavailable', reason: 'disconnected' };
        if (!result.repo) return { kind: 'unavailable', reason: 'no-repo' };
        return named({ kind: 'page', items: result.items, cursor: result.cursor, hasMore: result.hasMore });
    }, [descriptor, kind, labels, linked, people, readable, sourceControl, state, text, urls]);
    const list = useCachedList(repositoryLists, key, fetchPage);
    const contextOf = React.useCallback(() => readable, [readable]);
    const live = useLiveReferences(list.items, contextOf, list.pageReads);
    const items = useWrittenLabels(live.items, key, labels, keepReference);
    return { ...list, key, items, followed: live.followed };
}

const keepReference = (reference: RepositoryReference): RepositoryReference => reference;
const restoreNothing = (): null => null;

function useWrittenLabels<T extends RepositoryReference>(
    items: T[],
    listKey: string | null,
    filterLabels: readonly string[],
    restore: (reference: RepositoryReference) => T | null,
): T[] {
    const written = useLabelWrites();
    const now = useMinuteTickerNow(written.size > 0);
    return React.useMemo(
        () => reconcileLabelWrites(items, written, { listKey, filterLabels, now, restore }),
        [filterLabels, items, listKey, now, restore, written],
    );
}

const NO_ACROSS_ITEMS: AcrossReference[] = [];
const NO_LABELS: readonly string[] = [];

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
        const search = sourceControl.referencesAcross?.bind(sourceControl);
        return fetchAcrossPage(search, contexts.asked, { kind, state, people, query: text, cursor });
    }, [contexts.asked, kind, people, sourceControl, state, text]);
    const list = useCachedList(repositoryAcrossLists, key, fetchPage);
    const contextOf = React.useCallback(
        (item: AcrossReference) => contexts.asked.find((entry) => entry.directory === item.directory)?.context ?? null,
        [contexts.asked],
    );
    const live = useLiveReferences(list.items, contextOf, list.pageReads);
    const items = useWrittenLabels(live.items, null, NO_LABELS, restoreNothing);
    return { ...list, items: items.length === 0 ? NO_ACROSS_ITEMS : items, followed: live.followed, contexts };
}

export function useRepositoryAcrossProvider(directories: readonly string[] | null): SourceControlProvider | null {
    return useRepositoryReadContexts(directories ?? NO_DIRECTORIES).provider;
}

export function useTrackerReferenceList(options: {
    enabled: boolean;
    provider: string | null;
    filter: TrackerReferenceFilter;
    query: string;
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

export function useRepositoryReferenceDetail(
    directory: string | null,
    reference: RepositoryReference | null,
    settled: boolean,
    revision: string | null = null,
    crossReferences = false,
) {
    const { sourceControl } = useRuntimeAPIs();
    const context = useRepositoryReadContext(reference ? directory : null);
    const readable = useReferenceReadContext(context, reference?.linked === true);
    const features = useSourceControlProvider(readable?.provider).features;
    const detailed = features.referenceDetail;
    const owner = reference?.sourceRepo.owner ?? '';
    const repo = reference?.sourceRepo.repo ?? '';
    const number = reference?.number ?? 0;
    const kind = reference?.kind ?? 'issue';
    const key = directory && reference && readable
        ? JSON.stringify([getRuntimeKey(), readContextCacheKey(readable), directory, kind, owner, repo, number, crossReferences])
        : null;
    const fetch = React.useCallback(async (): Promise<RepositoryReferenceDetail> => {
        if (!readable || !reference) throw new Error('The repository is not available here');
        if (!detailed) return fetchListBackedReferenceDetail(sourceControl, readable, reference, { crossReferences });
        const result = await sourceControl.referenceDetail(
            readable,
            kind === 'discussion' ? { owner, repo, number, kind } : { owner, repo, number },
            { includeReferences: crossReferences && kind !== 'discussion' },
        );
        if (!result.connected) throw new Error(`${readable.provider} is not connected`);
        if (!result.detail) throw new Error('Not found');
        if (crossReferences || !result.detail.references) return result.detail;
        const { references: _unasked, ...detail } = result.detail;
        return detail;
    }, [crossReferences, detailed, kind, number, owner, readable, reference, repo, sourceControl]);
    const latest = useCachedValue(repositoryDetails, key, fetch, settled);
    const pickedRevision = features.revisions && kind === 'pull' && !detailed ? revision : null;
    const revisionKey = key && pickedRevision ? JSON.stringify([key, pickedRevision]) : null;
    const fetchRevision = React.useCallback(async (): Promise<RepositoryReferenceDetail> => {
        if (!readable || !reference || !pickedRevision) throw new Error('The repository is not available here');
        return fetchListBackedReferenceDetail(sourceControl, readable, reference, { revision: pickedRevision, crossReferences });
    }, [crossReferences, pickedRevision, readable, reference, sourceControl]);
    const revisionDetail = useCachedValue(repositoryDetails, revisionKey, fetchRevision, settled);
    const refresh = React.useCallback(
        () => (key ? Promise.all([
            repositoryDetails.ensure(key, fetch, { force: true }),
            ...(revisionKey ? [repositoryDetails.ensure(revisionKey, fetchRevision, { force: true })] : []),
        ]).then(() => undefined, () => undefined) : Promise.resolve()),
        [fetch, fetchRevision, key, revisionKey],
    );
    return { detail: revisionKey ? revisionDetail : latest, latest, refresh };
}

const repositoryPullStatuses = createValueCache<ChangeRequestListStatus | null>(200);
const PULL_STATUS_BATCH = 10;
const IDLE: CachedValue<ChangeRequestListStatus | null> = { status: 'idle' };

export const forgetRepositoryPullStatuses = (): void => repositoryPullStatuses.clear();

export const forgetRepositoryPullStatus = (pull: RepositoryItemRef): void => {
    const marker = `|${joinProjectPath(pull.owner, pull.repo)}#${pull.number}@`.toLowerCase();
    repositoryPullStatuses.forget((key) => key.toLowerCase().includes(marker));
};

const pullStatusScope = (group: PullStatusGroup): string => (
    JSON.stringify([getRuntimeKey(), readContextCacheKey(group.context), group.directory])
);

function usePullStatusGroups(groups: readonly PullStatusGroup[]) {
    const { sourceControl } = useRuntimeAPIs();
    const keys = React.useMemo(
        () => groups.flatMap((group) => group.pulls.map((pull) => pullStatusKey(pullStatusScope(group), pull))),
        [groups],
    );

    const subscribe = React.useCallback((listener: () => void) => {
        const stops = keys.map((key) => repositoryPullStatuses.subscribe(key, listener));
        return () => stops.forEach((stop) => stop());
    }, [keys]);
    const version = React.useSyncExternalStore(subscribe, repositoryPullStatuses.version, repositoryPullStatuses.version);
    const revalidation = useReferenceRevalidation();

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

type AskedPullStatus = { value: CachedValue<ChangeRequestListStatus | null>; read: ReadStamp | null };

const newerStatus = (asked: AskedPullStatus, live: LivePullStatus | null): CachedValue<ChangeRequestListStatus | null> => {
    if (!live || (asked.read && !isNewerThanRead(live.fetchedAt, asked.read))) return asked.value;
    return { status: 'ready', value: live.status };
};

export function useRepositoryPullStatuses(directory: string | null, references: readonly RepositoryReference[]) {
    const context = useRepositoryReadContext(directory);
    const readable = useReferenceReadContext(context, references.some((reference) => reference.linked));
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

export function readTrackerItemDetail(trackers: TrackerAPI, provider: string, itemId: string): Promise<TrackerItem> {
    const account = currentTrackerAccountId(useTrackerAuthStore.getState().entries[provider]);
    return trackerDetails.ensure(trackerDetailKey(provider, account, itemId), () => fetchTrackerItem(trackers, provider, itemId));
}

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
    const refresh = React.useCallback(
        () => (key ? trackerDetails.ensure(key, fetch, { force: true }).then(() => undefined, () => undefined) : Promise.resolve()),
        [fetch, key],
    );
    return { detail, refresh, followed: live.followed };
}

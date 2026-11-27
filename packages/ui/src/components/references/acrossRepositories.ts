
import type {
    RepositoryChangeRequestReference,
    RepositoryReferenceQuery,
    RepositoryReferencesAcrossResult,
    ChangeRequestListStatus,
    ChangeRequestListStatusesResult,
    RepositoryReference,
    RepositoryReferencesAcrossSkip,
    SourceControlReadContext,
} from '@/lib/api/types';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';

import type { ListPage, ListSkip, ValueCache } from './referenceCache';
import type { ReferencePickerItem } from './referencePickerItems';
import { joinProjectPath } from '@/lib/source-control/projectPath';

export type AcrossReference = RepositoryReference & { directory: string };

export type ReadContextState = SourceControlReadContext | 'missing' | null;

export type AcrossExclusion =
    | { directory: string; reason: 'missing' | RepositoryReferencesAcrossSkip }
    | { directory: string; reason: 'unsupportedProvider'; provider: string };
export type AcrossExclusionReason = AcrossExclusion['reason'];

export type AcrossContexts = {
    ready: boolean;
    provider: string | null;
    asked: Array<{ directory: string; context: SourceControlReadContext }>;
    excluded: AcrossExclusion[];
};

export const NO_ACROSS_CONTEXTS: AcrossContexts = { ready: true, provider: null, asked: [], excluded: [] };

export function partitionAcrossContexts(
    folders: ReadonlyArray<{ directory: string; state: ReadContextState }>,
    descriptors: readonly SourceControlProviderDescriptor[],
): AcrossContexts {
    const present = new Set<string>(folders.flatMap(({ state }) => (state && state !== 'missing' ? [state.provider] : [])));
    const provider = descriptors.find((descriptor) => descriptor.features.referencesAcross && present.has(descriptor.id))?.id ?? null;
    const asked: AcrossContexts['asked'] = [];
    const excluded: AcrossExclusion[] = [];
    let ready = true;
    for (const { directory, state } of folders) {
        if (state === null) ready = false;
        else if (state === 'missing') excluded.push({ directory, reason: 'missing' });
        else if (state.provider === provider) asked.push({ directory, context: state });
        else excluded.push({ directory, reason: 'unsupportedProvider', provider: state.provider });
    }
    return { ready, provider, asked, excluded };
}

export function linkReadContext(
    folders: AcrossContexts['asked'],
    repositoryFolder: string | null,
    host: { provider: string; instance: string },
): SourceControlReadContext | null {
    const onHost = folders.filter(({ context }) => context.provider === host.provider && context.instance === host.instance);
    return (onHost.find(({ directory }) => directory === repositoryFolder) ?? onHost[0])?.context ?? null;
}

export function leftOutFolders(contexts: AcrossContexts, skipped: readonly ListSkip[]): AcrossExclusion[] {
    return [...contexts.excluded, ...skipped];
}

export function skippedOf(repositories: RepositoryReferencesAcrossResult['repositories']): ListSkip[] {
    return repositories.flatMap((entry) => (entry.status === 'included' ? [] : [{ directory: entry.directory, reason: entry.status }]));
}

export function itemDirectory(item: ReferencePickerItem | null, fallback: string | null): string | null {
    return item?.source === 'repository' ? item.directory ?? fallback : fallback;
}

export const needsPullStatus = (reference: RepositoryReference): reference is RepositoryChangeRequestReference => (
    reference.kind === 'pull' && reference.state === 'open'
);

export type PullStatusGroup = {
    directory: string;
    context: SourceControlReadContext;
    pulls: RepositoryChangeRequestReference[];
};

export function groupPullsByDirectory(
    items: ReadonlyArray<{ reference: RepositoryReference; directory: string }>,
    folders: AcrossContexts['asked'],
): PullStatusGroup[] {
    const groups = new Map<string, PullStatusGroup>();
    for (const { directory, context } of folders) groups.set(directory, { directory, context, pulls: [] });
    for (const { reference, directory } of items) {
        if (needsPullStatus(reference)) groups.get(directory)?.pulls.push(reference);
    }
    return [...groups.values()].filter((group) => group.pulls.length > 0);
}

export const pullStatusKey = (scope: string, pull: RepositoryChangeRequestReference): string => (
    `${scope}|${joinProjectPath(pull.sourceRepo.owner, pull.sourceRepo.repo)}#${pull.number}@${pull.headSha}`
);

const samePull = (status: ChangeRequestListStatus, pull: RepositoryChangeRequestReference) => (
    status.number === pull.number
    && status.owner.toLowerCase() === pull.sourceRepo.owner.toLowerCase()
    && status.repo.toLowerCase() === pull.sourceRepo.repo.toLowerCase()
);

export function ensurePullStatuses(
    cache: ValueCache<ChangeRequestListStatus | null>,
    groups: readonly PullStatusGroup[],
    scopeOf: (group: PullStatusGroup) => string,
    ask: (context: SourceControlReadContext, pulls: RepositoryChangeRequestReference[]) => Promise<ChangeRequestListStatusesResult>,
    batchSize: number,
): void {
    for (const group of groups) {
        const scope = scopeOf(group);
        const byKey = new Map(group.pulls.map((pull) => [pullStatusKey(scope, pull), pull]));
        cache.ensureMany([...byKey.keys()], async (batch) => {
            const asked = batch.flatMap((key) => byKey.get(key) ?? []);
            const result = await ask(group.context, asked);
            if (!result.connected) throw new Error(`${group.context.provider} is not connected`);
            const answers = new Map<string, ChangeRequestListStatus | null>(batch.map((key) => [key, null]));
            for (const pull of asked) {
                answers.set(pullStatusKey(scope, pull), result.statuses.find((status) => samePull(status, pull)) ?? null);
            }
            return answers;
        }, batchSize);
    }
}

export async function fetchAcrossPage(
    search: ((contexts: SourceControlReadContext[], options: RepositoryReferenceQuery) => Promise<RepositoryReferencesAcrossResult>) | undefined,
    asked: AcrossContexts['asked'],
    options: RepositoryReferenceQuery,
): Promise<ListPage<AcrossReference>> {
    if (!search || asked.length === 0) return { kind: 'unavailable', reason: 'no-repo' };
    const { labels: _labels, ...query } = options;
    const result = await search(asked.map(({ context }) => context), query);
    if (!result.repositories.some((entry) => entry.status === 'included')) {
        if (options.cursor || result.repositories.some((entry) => entry.status === 'error' || entry.status === 'invalid-context')) {
            throw new Error('None of these repositories could be read');
        }
        return { kind: 'unavailable', reason: result.repositories.some((entry) => entry.status === 'disconnected') ? 'disconnected' : 'no-repo' };
    }
    return { kind: 'page', items: result.items, cursor: result.cursor, hasMore: result.hasMore, skipped: skippedOf(result.repositories) };
}

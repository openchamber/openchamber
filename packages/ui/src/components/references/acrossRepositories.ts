/**
 * Listing issues and PRs across the repositories under a project folder: which
 * folders can be asked, which are left out and why, and how an item finds the
 * folder (and so the read context) it belongs to. Pure; the hooks in
 * `referenceSources.ts` feed it.
 */

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

/** An item of a list across repositories: the folder whose read context it belongs to comes with it. */
export type AcrossReference = RepositoryReference & { directory: string };

/** A folder's read context: known, absent (`missing`: no account can read it), or still loading. */
export type ReadContextState = SourceControlReadContext | 'missing' | null;

/**
 * Why a folder is not in the list. `unsupportedProvider` and `missing` are
 * known before asking; the rest come with an answer.
 */
export type AcrossExclusion =
    | { directory: string; reason: 'missing' | RepositoryReferencesAcrossSkip }
    /** On a provider other than the one asked, which this list does not search. */
    | { directory: string; reason: 'unsupportedProvider'; provider: string };
export type AcrossExclusionReason = AcrossExclusion['reason'];

export type AcrossContexts = {
    /** Every folder's context is known; asking earlier would list a part and then the whole. */
    ready: boolean;
    /** The provider the search is sent to; null when no folder is on one that can search across repositories. */
    provider: string | null;
    /** The folders to ask, all on `provider`, in folder order. */
    asked: Array<{ directory: string; context: SourceControlReadContext }>;
    /** Folders that are not asked: on another provider, or with no context that can read them. */
    excluded: AcrossExclusion[];
};

export const NO_ACROSS_CONTEXTS: AcrossContexts = { ready: true, provider: null, asked: [], excluded: [] };

/**
 * Which folders a search across repositories asks. One request goes to one
 * provider, so it asks the folders of the lowest-`order` provider among them
 * that can search across repositories (`features.referencesAcross`); folders
 * on any other provider are left out and named. `descriptors` are in registry
 * order.
 */
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

/** The folders left out of a list: those never asked, then those the answer skipped. */
export function leftOutFolders(contexts: AcrossContexts, skipped: readonly ListSkip[]): AcrossExclusion[] {
    return [...contexts.excluded, ...skipped];
}

/** What a page of the search says about its folders, reduced to the ones it left out. */
export function skippedOf(repositories: RepositoryReferencesAcrossResult['repositories']): ListSkip[] {
    return repositories.flatMap((entry) => (entry.status === 'included' ? [] : [{ directory: entry.directory, reason: entry.status }]));
}

/** The folder an item came from: its own in a list across repositories, else the list's. */
export function itemDirectory(item: ReferencePickerItem | null, fallback: string | null): string | null {
    return item?.source === 'repository' ? item.directory ?? fallback : fallback;
}

/** An open PR, draft or not: its preview shows checks, and a ready one is coloured by them. */
export const needsPullStatus = (reference: RepositoryReference): reference is RepositoryChangeRequestReference => (
    reference.kind === 'pull' && reference.state === 'open'
);

/** One folder's open PRs and the context their checks are asked through. */
export type PullStatusGroup = {
    directory: string;
    context: SourceControlReadContext;
    pulls: RepositoryChangeRequestReference[];
};

/** Listed open PRs grouped by the folder they came from; a folder not among `folders` asks nothing. */
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

/** A key per PR and head commit within its group's scope: a push asks again, a later page reuses earlier answers. */
export const pullStatusKey = (scope: string, pull: RepositoryChangeRequestReference): string => (
    `${scope}|${pull.sourceRepo.owner}/${pull.sourceRepo.repo}#${pull.number}@${pull.headSha}`
);

const samePull = (status: ChangeRequestListStatus, pull: RepositoryChangeRequestReference) => (
    status.number === pull.number
    && status.owner.toLowerCase() === pull.sourceRepo.owner.toLowerCase()
    && status.repo.toLowerCase() === pull.sourceRepo.repo.toLowerCase()
);

/**
 * Asks each group's PR statuses through its own context, in batches. Groups are
 * asked independently: one that fails stores its error under its own keys and
 * leaves the others' answers alone.
 */
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

/**
 * One page of the search across repositories, sent the contexts of the asked
 * folders. Without any, or where the runtime cannot search across repositories,
 * there is nothing to list. When no folder was read, the list fails if one
 * of them failed, and otherwise reads as disconnected or as having no
 * repository, never as an empty list.
 */
export async function fetchAcrossPage(
    search: ((contexts: SourceControlReadContext[], options: RepositoryReferenceQuery) => Promise<RepositoryReferencesAcrossResult>) | undefined,
    asked: AcrossContexts['asked'],
    options: RepositoryReferenceQuery,
): Promise<ListPage<AcrossReference>> {
    if (!search || asked.length === 0) return { kind: 'unavailable', reason: 'no-repo' };
    const result = await search(asked.map(({ context }) => context), options);
    // Nothing read: a failure is never shown as an empty list, only an answer
    // that there is nothing to read.
    if (!result.repositories.some((entry) => entry.status === 'included')) {
        // A later page that reads nothing ends nothing: the list shown stays, with the error and a retry.
        if (options.cursor || result.repositories.some((entry) => entry.status === 'error' || entry.status === 'invalid-context')) {
            throw new Error('None of these repositories could be read');
        }
        return { kind: 'unavailable', reason: result.repositories.some((entry) => entry.status === 'disconnected') ? 'disconnected' : 'no-repo' };
    }
    return { kind: 'page', items: result.items, cursor: result.cursor, hasMore: result.hasMore, skipped: skippedOf(result.repositories) };
}

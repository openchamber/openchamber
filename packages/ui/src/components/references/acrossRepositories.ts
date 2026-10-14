/**
 * Listing issues and PRs across the repositories under a project folder: which
 * folders can be asked, which are left out and why, and how an item finds the
 * folder (and so the read context) it belongs to. Pure; the hooks in
 * `referenceSources.ts` feed it.
 */

import type {
    GitHubPullReference,
    GitHubReferencesOptions,
    GitHubReferencesAcrossResult,
    GitHubPullStatus,
    GitHubPullStatusesResult,
    GitHubReference,
    GitHubReferencesAcrossSkip,
    SourceControlReadContext,
} from '@/lib/api/types';

import type { ListPage, ListSkip, ValueCache } from './referenceCache';
import type { ReferencePickerItem } from './referencePickerItems';

/** An item of a list across repositories: the folder whose read context it belongs to comes with it. */
export type AcrossReference = GitHubReference & { directory: string };

/** A folder's read context: known, absent (`missing`: no account can read it), or still loading. */
export type ReadContextState = SourceControlReadContext | 'missing' | null;

/** Why a folder is not in the list. `gitlab` and `missing` are known before asking; the rest come with an answer. */
export type AcrossExclusionReason = 'gitlab' | 'missing' | GitHubReferencesAcrossSkip;
export type AcrossExclusion = { directory: string; reason: AcrossExclusionReason };

export type AcrossContexts = {
    /** Every folder's context is known; asking earlier would list a part and then the whole. */
    ready: boolean;
    /** The GitHub folders to ask, in folder order. */
    github: Array<{ directory: string; context: SourceControlReadContext }>;
    /** Folders that are not asked: on GitLab, or with no context that can read them. */
    excluded: AcrossExclusion[];
};

export const NO_ACROSS_CONTEXTS: AcrossContexts = { ready: true, github: [], excluded: [] };

export function partitionAcrossContexts(folders: ReadonlyArray<{ directory: string; state: ReadContextState }>): AcrossContexts {
    const github: AcrossContexts['github'] = [];
    const excluded: AcrossExclusion[] = [];
    let ready = true;
    for (const { directory, state } of folders) {
        if (state === null) ready = false;
        else if (state === 'missing') excluded.push({ directory, reason: 'missing' });
        else if (state.provider === 'github') github.push({ directory, context: state });
        else excluded.push({ directory, reason: 'gitlab' });
    }
    return { ready, github, excluded };
}

/** The folders left out of a list: those never asked, then those the answer skipped. */
export function leftOutFolders(contexts: AcrossContexts, skipped: readonly ListSkip[]): AcrossExclusion[] {
    return [...contexts.excluded, ...skipped];
}

/** What a page of the search says about its folders, reduced to the ones it left out. */
export function skippedOf(repositories: GitHubReferencesAcrossResult['repositories']): ListSkip[] {
    return repositories.flatMap((entry) => (entry.status === 'included' ? [] : [{ directory: entry.directory, reason: entry.status }]));
}

/** The folder an item came from: its own in a list across repositories, else the list's. */
export function itemDirectory(item: ReferencePickerItem | null, fallback: string | null): string | null {
    return item?.source === 'github' ? item.directory ?? fallback : fallback;
}

/** An open PR, draft or not: its preview shows checks, and a ready one is coloured by them. */
export const needsPullStatus = (reference: GitHubReference): reference is GitHubPullReference => (
    reference.kind === 'pull' && reference.state === 'open'
);

/** One folder's open PRs and the context their checks are asked through. */
export type PullStatusGroup = {
    directory: string;
    context: SourceControlReadContext;
    pulls: GitHubPullReference[];
};

/** Listed open PRs grouped by the folder they came from; a folder without a GitHub context asks nothing. */
export function groupPullsByDirectory(
    items: ReadonlyArray<{ reference: GitHubReference; directory: string }>,
    contexts: AcrossContexts,
): PullStatusGroup[] {
    const groups = new Map<string, PullStatusGroup>();
    for (const { directory, context } of contexts.github) groups.set(directory, { directory, context, pulls: [] });
    for (const { reference, directory } of items) {
        if (needsPullStatus(reference)) groups.get(directory)?.pulls.push(reference);
    }
    return [...groups.values()].filter((group) => group.pulls.length > 0);
}

/** A key per PR and head commit within its group's scope: a push asks again, a later page reuses earlier answers. */
export const pullStatusKey = (scope: string, pull: GitHubPullReference): string => (
    `${scope}|${pull.sourceRepo.owner}/${pull.sourceRepo.repo}#${pull.number}@${pull.headSha}`
);

const samePull = (status: GitHubPullStatus, pull: GitHubPullReference) => (
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
    cache: ValueCache<GitHubPullStatus | null>,
    groups: readonly PullStatusGroup[],
    scopeOf: (group: PullStatusGroup) => string,
    ask: (context: SourceControlReadContext, pulls: GitHubPullReference[]) => Promise<GitHubPullStatusesResult>,
    batchSize: number,
): void {
    for (const group of groups) {
        const scope = scopeOf(group);
        const byKey = new Map(group.pulls.map((pull) => [pullStatusKey(scope, pull), pull]));
        cache.ensureMany([...byKey.keys()], async (batch) => {
            const asked = batch.flatMap((key) => byKey.get(key) ?? []);
            const result = await ask(group.context, asked);
            if (!result.connected) throw new Error('GitHub is not connected');
            const answers = new Map<string, GitHubPullStatus | null>(batch.map((key) => [key, null]));
            for (const pull of asked) {
                answers.set(pullStatusKey(scope, pull), result.statuses.find((status) => samePull(status, pull)) ?? null);
            }
            return answers;
        }, batchSize);
    }
}

/**
 * One page of the search across repositories, sent the contexts of the GitHub
 * folders. Without any, or where the runtime cannot search across repositories,
 * there is nothing to list; when every folder answers that no account is
 * connected, the list reads as disconnected rather than empty.
 */
export async function fetchAcrossPage(
    search: ((contexts: SourceControlReadContext[], options: GitHubReferencesOptions) => Promise<GitHubReferencesAcrossResult>) | undefined,
    github: AcrossContexts['github'],
    options: GitHubReferencesOptions,
): Promise<ListPage<AcrossReference>> {
    if (!search || github.length === 0) return { kind: 'unavailable', reason: 'no-repo' };
    const result = await search(github.map(({ context }) => context), options);
    if (result.repositories.length > 0 && result.repositories.every((entry) => entry.status === 'disconnected')) {
        return { kind: 'unavailable', reason: 'disconnected' };
    }
    return { kind: 'page', items: result.items, cursor: result.cursor, hasMore: result.hasMore, skipped: skippedOf(result.repositories) };
}

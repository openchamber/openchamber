import type { SourceControlReferenceLink, ReviewCommentExcerpt } from '@/lib/api/types';


export type ReferenceCommentItem = {
    kind: 'comment';
    key: string;
    author: string | null;
    avatarUrl: string | null;
    body: string;
    createdAt: string | null;
    context: string | null;
    location: string | null;
    excerpt?: ReviewCommentExcerpt;
    id?: string;
    canUpdate?: boolean;
    canDelete?: boolean;
    thread?: ReferenceCommentThread;
    answer?: { chosen: boolean; canChange: boolean };
};

export type ReferenceCommentThread = {
    id: string;
    resolved: boolean;
    outdated?: boolean;
    canResolve: boolean;
    canReply: boolean;
    replies: ReferenceCommentItem[];
};

export type ReferenceCommitItem = {
    sha: string;
    headline: string;
    author: string | null;
    avatarUrl: string | null;
    committedAt: string | null;
    url: string | null;
};

export type ReferenceCommitGroup = {
    kind: 'commits';
    key: string;
    commits: ReferenceCommitItem[];
};

export type ReferenceTimelineEntry = ReferenceCommentItem | ReferenceCommitGroup | ReferenceReferenceItem;

export type ReferenceReferenceItem = {
    kind: 'reference';
    key: string;
    reference: SourceControlReferenceLink;
};

const entryTime = (entry: ReferenceTimelineEntry): number => Date.parse(
    (entry.kind === 'comment'
        ? entry.createdAt
        : entry.kind === 'reference' ? entry.reference.createdAt : entry.commits[0]?.committedAt) ?? '',
) || 0;

export const buildReferenceTimeline = (
    comments: ReferenceCommentItem[],
    commits: ReferenceCommitItem[],
    references: SourceControlReferenceLink[] = [],
): ReferenceTimelineEntry[] => {
    const singles: ReferenceTimelineEntry[] = [
        ...comments,
        ...commits.map((commit): ReferenceCommitGroup => ({ kind: 'commits', key: `commit:${commit.sha}`, commits: [commit] })),
        ...references.map((reference, index): ReferenceReferenceItem => ({ kind: 'reference', key: `reference:${reference.url}#${index}`, reference })),
    ];
    const ordered = singles.map((entry, index) => ({ entry, index }))
        .sort((left, right) => entryTime(left.entry) - entryTime(right.entry) || left.index - right.index)
        .map(({ entry }) => entry);
    const entries: ReferenceTimelineEntry[] = [];
    for (const entry of ordered) {
        const previous = entries.at(-1);
        if (entry.kind === 'commits' && previous?.kind === 'commits') {
            entries[entries.length - 1] = { ...previous, commits: [...previous.commits, ...entry.commits] };
            continue;
        }
        entries.push(entry);
    }
    return entries;
};

export const newestFirstTimeline = (entries: readonly ReferenceTimelineEntry[]): ReferenceTimelineEntry[] => {
    const runs: ReferenceTimelineEntry[][] = [];
    for (const entry of entries) {
        const current = runs.at(-1);
        if (current && entryTime(current[0]) === entryTime(entry)) current.push(entry);
        else runs.push([entry]);
    }
    return runs.reverse().flat().map((entry) => (entry.kind === 'commits' ? { ...entry, commits: [...entry.commits].reverse() } : entry));
};

const commentTime = (item: ReferenceCommentItem): number | null => {
    if (!item.createdAt) return null;
    const parsed = Date.parse(item.createdAt);
    return Number.isNaN(parsed) ? null : parsed;
};

export const sortCommentsByTime = (
    comments: readonly ReferenceCommentItem[],
    newestFirst = false,
): ReferenceCommentItem[] => {
    const dated: Array<{ comment: ReferenceCommentItem; time: number }> = [];
    const undated: ReferenceCommentItem[] = [];
    for (const comment of comments) {
        const time = commentTime(comment);
        if (time === null) undated.push(comment);
        else dated.push({ comment, time });
    }
    dated.sort((left, right) => (left.time - right.time) * (newestFirst ? -1 : 1));
    return [...dated.map(({ comment }) => comment), ...undated];
};

export type ReferenceActivityFilter = 'all' | 'comments' | 'unresolved' | 'resolved';

interface ReferenceActivityCounts {
    all: number;
    comments: number;
    unresolved: number;
    resolved: number;
}

export const filterReferenceTimeline = (
    entries: readonly ReferenceTimelineEntry[],
    filter: ReferenceActivityFilter,
): ReferenceTimelineEntry[] => {
    if (filter === 'all') return [...entries];
    if (filter === 'comments') return entries.filter((entry) => entry.kind === 'comment');
    if (filter === 'unresolved') {
        return entries.filter((entry) => entry.kind === 'comment' && entry.thread !== undefined && !entry.thread.resolved);
    }
    return entries.filter((entry) => entry.kind === 'comment' && entry.thread?.resolved === true);
};

export const countReferenceTimeline = (entries: readonly ReferenceTimelineEntry[]): ReferenceActivityCounts => {
    let comments = 0;
    let unresolved = 0;
    let resolved = 0;
    for (const entry of entries) {
        if (entry.kind !== 'comment') continue;
        comments += 1;
        if (entry.thread) {
            if (entry.thread.resolved) resolved += 1;
            else unresolved += 1;
        }
    }
    return { all: entries.length, comments, unresolved, resolved };
};

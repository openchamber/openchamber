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

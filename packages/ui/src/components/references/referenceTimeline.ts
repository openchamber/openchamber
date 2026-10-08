/** The preview's thread: comments and, for a PR, its commits, in the order they happened. */

/** One comment in the preview's thread, from GitHub, GitLab or Linear. */
export type ReferenceCommentItem = {
    kind: 'comment';
    key: string;
    author: string | null;
    avatarUrl: string | null;
    body: string;
    createdAt: string | null;
    /** What the comment is attached to: a review verdict, or `path:line`. */
    context: string | null;
    /** The `path:line` a review comment sits on, for what it is attached to in chat. */
    location: string | null;
};

export type ReferenceCommitItem = {
    sha: string;
    headline: string;
    /** Who made it: the host account, or the name git recorded. */
    author: string | null;
    avatarUrl: string | null;
    committedAt: string | null;
    url: string | null;
};

/** Commits that landed one after another, between two comments. */
export type ReferenceCommitGroup = {
    kind: 'commits';
    key: string;
    commits: ReferenceCommitItem[];
};

export type ReferenceTimelineEntry = ReferenceCommentItem | ReferenceCommitGroup;

const entryTime = (entry: ReferenceTimelineEntry): number => Date.parse(
    (entry.kind === 'comment' ? entry.createdAt : entry.commits[0]?.committedAt) ?? '',
) || 0;

/**
 * Comments and commits in the order they happened, so a review reads next to
 * the commits it answered. Commits in a row become one group.
 */
export const buildReferenceTimeline = (comments: ReferenceCommentItem[], commits: ReferenceCommitItem[]): ReferenceTimelineEntry[] => {
    const singles: ReferenceTimelineEntry[] = [
        ...comments,
        ...commits.map((commit): ReferenceCommitGroup => ({ kind: 'commits', key: `commit:${commit.sha}`, commits: [commit] })),
    ];
    // Stable: equal times keep comments before commits, as listed above.
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

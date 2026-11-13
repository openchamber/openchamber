import * as React from 'react';

import { useI18n } from '@/lib/i18n';
import type { ReviewPerson } from '@/lib/source-control/types';

import { ReviewAvatar } from './ReviewCards';
import { useChangeRequestReviewContext } from './useChangeRequestReview';

const MAX_AVATARS = 3;

/**
 * Who has something open on a file of a change request's diff, in its header
 * and its tree row: the authors of unresolved threads and of the viewer's own
 * draft. Nothing outside a review, or on a file with nothing open.
 */
export const ReviewFileMark: React.FC<{ path: string }> = ({ path }) => {
    const { t } = useI18n();
    const review = useChangeRequestReviewContext();
    const threads = (review?.state?.threads ?? []).filter((thread) => thread.path === path && !thread.resolved);
    const drafts = (review?.state?.draft?.comments ?? []).filter((comment) => comment.path === path);
    const count = threads.length + drafts.length;
    if (count === 0) return null;

    const people = new Map<string, ReviewPerson | null>();
    for (const { author } of drafts) people.set(author?.login ?? '', author);
    for (const { comments } of threads) people.set(comments[0]?.author?.login ?? '', comments[0]?.author ?? null);
    const label = t(count === 1 ? 'review.fileMark.one' : 'review.fileMark.other', { count });

    return (
        <span className="flex shrink-0 items-center -space-x-1 rtl:space-x-reverse" role="img" aria-label={label} title={label}>
            {[...people.entries()].slice(0, MAX_AVATARS).map(([login, person]) => <ReviewAvatar key={login} person={person} />)}
        </span>
    );
};

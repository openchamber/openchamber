import type { RepositoryReferenceReview } from '@/lib/api/types';

export type ReviewDismissMode = 'others' | 'own';

export const dismissibleReviews = (
    reviews: readonly RepositoryReferenceReview[],
    mode: ReviewDismissMode | null,
    viewerLogin: string | null,
): RepositoryReferenceReview[] => {
    if (mode === null || viewerLogin === null) return [];
    if (mode === 'own') {
        return reviews.filter((review) => review.state === 'approved' && review.author?.login === viewerLogin);
    }
    return reviews.filter((review) => (
        (review.state === 'approved' || review.state === 'changes_requested')
        && review.author !== null
        && review.author.login !== viewerLogin
    ));
};

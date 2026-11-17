import React from 'react';
import { useReviewFlowStart } from '@/components/session/useReviewFlowStart';
import { useDiffViewSetup } from './useDiffViewSetup';


type useDiffViewReviewProps = Pick<ReturnType<typeof useDiffViewSetup>, 'setReviewDialogOpen' | 'currentSessionId' | 'rootDirectory'>;

export function useDiffViewReview({ setReviewDialogOpen, currentSessionId, rootDirectory }: useDiffViewReviewProps) {
    const closeReviewDialog = React.useCallback(() => setReviewDialogOpen(false), [setReviewDialogOpen]);
    const { submitting: reviewFlowSubmitting, start: handleStartReviewFlow } = useReviewFlowStart(currentSessionId, rootDirectory, closeReviewDialog);

    return { reviewFlowSubmitting, handleStartReviewFlow };
}

import type { useComposerSessionScope } from './useComposerSessionScope';
import { useReviewFlowStart } from '@/components/session/useReviewFlowStart';

type Dependencies = {
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'currentSessionId' | 'currentDirectory' | 'closeReviewDialog'>;
};

export function useComposerReviewFlow({
    sessionScope,
}: Dependencies) {
    const { currentSessionId, currentDirectory, closeReviewDialog } = sessionScope;

    const { submitting: reviewFlowSubmitting, start: handleStartReviewFlow } = useReviewFlowStart(currentSessionId, currentDirectory, closeReviewDialog);
    return { reviewFlowSubmitting, handleStartReviewFlow };
}

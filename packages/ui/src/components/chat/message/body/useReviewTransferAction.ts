import React from 'react';
import { useI18n } from '@/lib/i18n';
import {
    type ReviewTransferDirection,
    sendImplementationResponseToReviewer,
    sendReviewFeedbackToOriginal,
} from '@/lib/reviewFlow';

export const useReviewTransferAction = ({
    sessionId,
    effectiveDirectory,
    assistantPlanText,
    effectiveReviewTransferDirection,
}: {
    sessionId: string | undefined;
    effectiveDirectory: string | null | undefined;
    assistantPlanText: string;
    effectiveReviewTransferDirection: ReviewTransferDirection | null;
}) => {
    const { t } = useI18n();
    return React.useMemo(() => {
        const transferText = assistantPlanText.trim();
        if (!sessionId || !effectiveDirectory || !transferText || !effectiveReviewTransferDirection) return undefined;
        if (effectiveReviewTransferDirection === 'review-to-original') {
            return {
                ariaLabel: t('chat.messageBody.actions.sendReviewFeedback'),
                tooltip: t('chat.messageBody.actions.sendReviewFeedback'),
                onClick: async () => {
                    try {
                        await sendReviewFeedbackToOriginal(sessionId, effectiveDirectory, transferText);
                    } catch (error) {
                        console.error('[review-flow] failed to send review feedback', error);
                    }
                },
            };
        }
        return {
            ariaLabel: t('chat.messageBody.actions.sendImplementationResponse'),
            tooltip: t('chat.messageBody.actions.sendImplementationResponse'),
            onClick: async () => {
                try {
                    await sendImplementationResponseToReviewer(sessionId, effectiveDirectory, transferText);
                } catch (error) {
                    console.error('[review-flow] failed to send implementation response', error);
                }
            },
        };
    }, [assistantPlanText, effectiveDirectory, effectiveReviewTransferDirection, sessionId, t]);
};

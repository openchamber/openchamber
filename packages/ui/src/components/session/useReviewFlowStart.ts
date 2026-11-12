import React from 'react';

import { toast } from '@/components/ui';
import type { ReviewFlowExecution } from '@/components/session/ReviewFlowDialog';
import { useI18n } from '@/lib/i18n';
import { startReviewFlow } from '@/lib/reviewFlow';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * What the review dialog's Start button runs, shared by every place that
 * offers the review: it starts the flow for `sessionId` in the session's own
 * directory (else `fallbackDirectory`) and calls `onStarted` once it is under way.
 */
export function useReviewFlowStart(
  sessionId: string | null | undefined,
  fallbackDirectory: string | null | undefined,
  onStarted: () => void,
) {
  const { t } = useI18n();
  const [submitting, setSubmitting] = React.useState(false);

  const start = React.useCallback(async (execution: ReviewFlowExecution) => {
    if (!sessionId) return;
    const directory = useSessionUIStore.getState().getDirectoryForSession(sessionId) || fallbackDirectory || '';
    if (!directory) {
      toast.error(t('diffView.reviewDialog.toast.noSessionDirectory'));
      return;
    }

    setSubmitting(true);
    try {
      await startReviewFlow({
        originalSessionID: sessionId,
        directory,
        providerID: execution.providerID,
        modelID: execution.modelID,
        agent: execution.agent || undefined,
        variant: execution.variant || undefined,
        generateHandoff: execution.generateHandoff,
        returnAfterHandoffRequest: execution.generateHandoff,
        autoReview: execution.autoReview,
      });
      onStarted();
    } catch (error) {
      console.error('[review-flow] failed to start review flow', error);
      toast.error(error instanceof Error ? error.message : t('diffView.reviewDialog.toast.startFailed'));
    } finally {
      setSubmitting(false);
    }
  }, [fallbackDirectory, onStarted, sessionId, t]);

  return { submitting, start };
}

export type PendingScrollFailureDecision = 'wait-hidden' | 'retry-visible' | 'resolve-failed';

export const DEFAULT_VISIBLE_PENDING_SCROLL_RETRY_LIMIT = 30;

export const decidePendingScrollFailure = ({
    targetIndex,
    turnStart,
    visibleFailureCount,
    visibleRetryLimit = DEFAULT_VISIBLE_PENDING_SCROLL_RETRY_LIMIT,
}: {
    targetIndex: number | undefined;
    turnStart: number;
    visibleFailureCount: number;
    visibleRetryLimit?: number;
}): PendingScrollFailureDecision => {
    if (typeof targetIndex !== 'number') {
        return 'resolve-failed';
    }

    if (targetIndex < turnStart) {
        return 'wait-hidden';
    }

    if (visibleFailureCount < visibleRetryLimit) {
        return 'retry-visible';
    }

    return 'resolve-failed';
};

export const shouldReportScrollAttemptComplete = ({
    elementScrolled,
    virtualIndexScrollRequested,
}: {
    elementScrolled: boolean;
    virtualIndexScrollRequested: boolean;
}): boolean => {
    if (elementScrolled) {
        return true;
    }

    if (virtualIndexScrollRequested) {
        return false;
    }

    return false;
};

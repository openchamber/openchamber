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

// NOTE (Greptile review PR#1434 P2): The previous implementation had two branches
// for the !elementScrolled case — both returned false. The virtualIndexScrollRequested
// parameter had no effect on the return value. Collapsed to the minimal correct
// expression. The parameter is kept in the signature so call sites remain readable
// (it documents intent: "we requested a virtual scroll but that alone isn't enough
// to call the attempt complete").
export const shouldReportScrollAttemptComplete = ({
    elementScrolled,
}: {
    elementScrolled: boolean;
    // virtualIndexScrollRequested is kept in the type signature so call sites remain
    // readable and self-documenting: passing it documents the *intent* (a virtual
    // scroll was requested), even though the outcome is the same either way.
    virtualIndexScrollRequested: boolean;
}): boolean => elementScrolled;

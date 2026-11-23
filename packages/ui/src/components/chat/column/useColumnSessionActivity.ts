import React from 'react';
import { getLastConversationRecord, isIncompleteAssistantTurn } from '@/lib/opencode/model';
import type { Message, Part, SessionStatus } from '@/lib/opencode/model';
import {
    useSessionStatus,
    useSessionStatusSnapshotReady,
    useScopedBlockingPermissions,
    useScopedBlockingForms,
} from '@/sync/sync-context';
import type { useSync } from '@/sync/use-sync';
import { hasActiveFormToolInCurrentTurn, recoverPendingFormWithRetry } from '@/sync/form-recovery';
import type { RetryOverlay } from '../timeline/types';

const IDLE_SESSION_STATUS = { type: 'idle' as const };
const DEFAULT_RETRY_MESSAGE = 'Quota limit reached. Retrying automatically.';

export const useColumnSessionActivity = ({
    active,
    currentSessionId,
    effectiveSessionDirectory,
    sessionMessages,
    sync,
}: {
    active: boolean;
    currentSessionId: string | null;
    effectiveSessionDirectory: string | undefined;
    sessionMessages: Array<{ info: Message; parts: Part[] }>;
    sync: ReturnType<typeof useSync>;
}) => {
    const sessionStatusForCurrent = useSessionStatus(currentSessionId ?? '', effectiveSessionDirectory) ?? IDLE_SESSION_STATUS;
    const statusSnapshotReady = useSessionStatusSnapshotReady(effectiveSessionDirectory, currentSessionId ?? '');

    const sessionPermissions = useScopedBlockingPermissions(currentSessionId, effectiveSessionDirectory);
    const sessionForms = useScopedBlockingForms(currentSessionId, effectiveSessionDirectory);

    const hasUnreconciledFormTool = React.useMemo(
        () => !sessionForms.some((form) => form.sessionID === currentSessionId)
            && hasActiveFormToolInCurrentTurn(sessionMessages),
        [currentSessionId, sessionMessages, sessionForms],
    );

    React.useEffect(() => {
        if (!active || !currentSessionId || !effectiveSessionDirectory || !hasUnreconciledFormTool) return;
        let cancelled = false;

        void recoverPendingFormWithRetry(
            () => sync.recoverPendingQuestions(currentSessionId, effectiveSessionDirectory),
            { isCancelled: () => cancelled },
        );

        return () => {
            cancelled = true;
        };
    }, [active, currentSessionId, effectiveSessionDirectory, hasUnreconciledFormTool, sync]);

    const sessionIsWorking = React.useMemo(() => {
        if (!currentSessionId || sessionPermissions.length > 0 || sessionForms.length > 0) {
            return false;
        }

        const statusType = sessionStatusForCurrent.type ?? 'idle';
        if (statusType === 'busy' || statusType === 'retry') {
            return true;
        }

        if (sessionStatusForCurrent === IDLE_SESSION_STATUS && statusSnapshotReady) {
            return false;
        }

        return isIncompleteAssistantTurn(getLastConversationRecord(sessionMessages)?.info);
    }, [currentSessionId, sessionMessages, sessionPermissions.length, sessionForms.length, sessionStatusForCurrent, statusSnapshotReady]);

    return { sessionStatusForCurrent, sessionPermissions, sessionIsWorking };
};

export const useRetryOverlay = (
    currentSessionId: string | null,
    sessionStatusForCurrent: SessionStatus,
    lastIdleAt: number | null,
): RetryOverlay | null => {
    const activeRetryStatus = React.useMemo<RetryOverlay | null>(() => {
        if (!currentSessionId || (sessionStatusForCurrent.type !== 'retry' && sessionStatusForCurrent.type !== 'busy')) {
            return null;
        }

        if (sessionStatusForCurrent.type === 'busy') {
            return { sessionId: currentSessionId, lastIdleAt };
        }

        const rawMessage = sessionStatusForCurrent.message.trim();
        const confirmedAt = 'confirmedAt' in sessionStatusForCurrent
            && typeof sessionStatusForCurrent.confirmedAt === 'number'
            ? sessionStatusForCurrent.confirmedAt
            : undefined;
        return {
            sessionId: currentSessionId,
            lastIdleAt,
            notice: {
                message: rawMessage || DEFAULT_RETRY_MESSAGE,
                confirmedAt,
            },
        };
    }, [currentSessionId, lastIdleAt, sessionStatusForCurrent]);
    const [retryFallbackTimestamp, setRetryFallbackTimestamp] = React.useState<number>(0);
    const retryFallbackSessionRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        const notice = activeRetryStatus?.notice;
        if (!activeRetryStatus || !notice || typeof notice.confirmedAt === 'number') {
            retryFallbackSessionRef.current = null;
            setRetryFallbackTimestamp(0);
            return;
        }

        if (retryFallbackSessionRef.current !== activeRetryStatus.sessionId) {
            retryFallbackSessionRef.current = activeRetryStatus.sessionId;
            setRetryFallbackTimestamp(Date.now());
        }
    }, [activeRetryStatus]);

    return React.useMemo(() => {
        if (!activeRetryStatus?.notice) {
            return activeRetryStatus;
        }

        return {
            ...activeRetryStatus,
            notice: {
                ...activeRetryStatus.notice,
                fallbackTimestamp: retryFallbackTimestamp,
            },
        };
    }, [activeRetryStatus, retryFallbackTimestamp]);
};

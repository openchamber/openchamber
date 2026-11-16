import React from 'react';
import { getLastConversationRecord, isIncompleteAssistantTurn } from '@/lib/opencode/model';
import type { Message, Part } from '@/lib/opencode/model';
import {
    useSessionStatus,
    useSessionStatusSnapshotReady,
    useScopedBlockingPermissions,
    useScopedBlockingForms,
} from '@/sync/sync-context';
import type { useSync } from '@/sync/use-sync';
import { hasActiveFormToolInCurrentTurn, recoverPendingFormWithRetry } from '@/sync/form-recovery';

const IDLE_SESSION_STATUS = { type: 'idle' as const };
const DEFAULT_RETRY_MESSAGE = 'Quota limit reached. Retrying automatically.';

/** Whether the shown session is working, what blocks it, and the retry notice. */
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
    // Session status from sync system
    const sessionStatusForCurrent = useSessionStatus(currentSessionId ?? '', effectiveSessionDirectory) ?? IDLE_SESSION_STATUS;
    const statusSnapshotReady = useSessionStatusSnapshotReady(effectiveSessionDirectory, currentSessionId ?? '');

    // Scoped blocking requests — only subscribe to permissions/forms for
    // the current session + descendant subagent sessions, not all sessions in
    // the directory.
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

        // No status once the directory's snapshot has landed is idle, as in
        // `useSessionActivity`: a turn OpenCode was stopped under stays incomplete.
        if (sessionStatusForCurrent === IDLE_SESSION_STATUS && statusSnapshotReady) {
            return false;
        }

        // The last record can be a synthetic/skill/shell/switch message; the
        // turn is still running only per the last conversation message.
        return isIncompleteAssistantTurn(getLastConversationRecord(sessionMessages)?.info);
    }, [currentSessionId, sessionMessages, sessionPermissions.length, sessionForms.length, sessionStatusForCurrent, statusSnapshotReady]);

    return { sessionStatusForCurrent, sessionPermissions, sessionIsWorking };
};

/** The retry notice of a session in `retry` status, with a fallback clock for a status that carries none. */
export const useRetryOverlay = (
    currentSessionId: string | null,
    sessionStatusForCurrent: { type: string },
) => {
    const activeRetryStatus = React.useMemo(() => {
        if (!currentSessionId || sessionStatusForCurrent.type !== 'retry') {
            return null;
        }

        const rawMessage = typeof (sessionStatusForCurrent as { message?: string }).message === 'string'
            ? (((sessionStatusForCurrent as { message?: string }).message) ?? '').trim()
            : '';

        return {
            sessionId: currentSessionId,
            message: rawMessage || DEFAULT_RETRY_MESSAGE,
            confirmedAt: (sessionStatusForCurrent as { confirmedAt?: number }).confirmedAt,
        };
    }, [currentSessionId, sessionStatusForCurrent]);
    const [retryFallbackTimestamp, setRetryFallbackTimestamp] = React.useState<number>(0);
    const retryFallbackSessionRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!activeRetryStatus || typeof activeRetryStatus.confirmedAt === 'number') {
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
        if (!activeRetryStatus) {
            return null;
        }

        return {
            ...activeRetryStatus,
            fallbackTimestamp: retryFallbackTimestamp,
        };
    }, [activeRetryStatus, retryFallbackTimestamp]);
};

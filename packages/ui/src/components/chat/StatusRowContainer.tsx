import React from 'react';

import { useCurrentSessionActivity } from '@/hooks/useSessionActivity';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionPermissions, useSessionStatus } from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { StatusRow } from './StatusRow';

const DEFAULT_WORKING_STATUS = 'working';

/**
 * Coarse status wrapper.
 * Avoids subscribing to live assistant parts so the row doesn't rerender on every text delta.
 */
export const StatusRowContainer: React.FC = React.memo(() => {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const abortRecord = useSessionUIStore(
        React.useCallback((state) => {
            if (!currentSessionId) {
                return null;
            }
            return state.sessionAbortFlags?.get(currentSessionId) ?? null;
        }, [currentSessionId]),
    );
    const permissions = useSessionPermissions(currentSessionId ?? '');
    const sessionStatus = useSessionStatus(currentSessionId ?? '');
    const { phase, isWorking } = useCurrentSessionActivity();
    const currentAgentName = useConfigStore((state) => state.currentAgentName);

    const wasAborted = Boolean(abortRecord && !abortRecord.acknowledged);
    const isWaitingForPermission = permissions.length > 0;
    const isRetry = sessionStatus?.type === 'retry';

    const statusText = React.useMemo(() => {
        if (isWaitingForPermission) {
            return 'waiting for permission';
        }
        if (isRetry) {
            return 'retrying';
        }
        if (!isWorking) {
            return null;
        }
        if (phase === 'busy') {
            return 'composing';
        }
        return DEFAULT_WORKING_STATUS;
    }, [isRetry, isWaitingForPermission, isWorking, phase]);

    const retryInfo = React.useMemo(() => {
        if (!isRetry) {
            return null;
        }
        return {
            attempt: (sessionStatus as { attempt?: number } | undefined)?.attempt,
            next: (sessionStatus as { next?: number } | undefined)?.next,
        };
    }, [isRetry, sessionStatus]);

    return (
        <StatusRow
            isWorking={isWorking}
            statusText={statusText}
            isGenericStatus={true}
            isWaitingForPermission={isWaitingForPermission}
            wasAborted={wasAborted}
            abortActive={wasAborted}
            retryInfo={retryInfo}
            showAssistantStatus
            showTodos={false}
            agentName={currentAgentName}
        />
    );
});

StatusRowContainer.displayName = 'StatusRowContainer';

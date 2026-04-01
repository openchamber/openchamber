import React from 'react';
import { useAssistantStatus } from '@/hooks/useAssistantStatus';
import { useConfigStore } from '@/stores/useConfigStore';
import { StatusRow } from './StatusRow';

/**
 * Self-contained wrapper — subscribes to assistant status internally
 * so MessageList doesn't re-render on every streaming part delta.
 */
export const StatusRowContainer: React.FC = React.memo(() => {
    const { working } = useAssistantStatus();
    const currentAgentName = useConfigStore((state) => state.currentAgentName);

    return (
        <StatusRow
            isWorking={working.isWorking}
            statusText={working.statusText}
            isGenericStatus={working.isGenericStatus}
            isWaitingForPermission={working.isWaitingForPermission}
            wasAborted={working.wasAborted}
            abortActive={working.abortActive}
            retryInfo={working.retryInfo}
            showAssistantStatus
            showTodos={false}
            agentName={currentAgentName}
        />
    );
});

StatusRowContainer.displayName = 'StatusRowContainer';

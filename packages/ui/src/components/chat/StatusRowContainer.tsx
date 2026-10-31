import React from 'react';

import { useAssistantStatus } from '@/hooks/useAssistantStatus';
import { useBackgroundSessionWork } from '@/hooks/useBackgroundSessionWork';
import { useKeybind } from '@/hooks/useKeybind';
import { useConfigStore } from '@/stores/useConfigStore';
import { useCommandsStore } from '@/stores/useCommandsStore';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { opencodeClient, RETRY_NOW_COMMAND } from '@/lib/opencode/client';
import { useChatSessionSelection } from './chatColumnSession';
import { StatusRow } from './StatusRow';

/**
 * Status row wrapper.
 * Uses the dedicated assistant status hook so the row keeps accurate live activity
 * labels while still limiting subscriptions to the active assistant message.
 */
export const StatusRowContainer: React.FC = React.memo(() => {
    const { activeModel, working } = useAssistantStatus();
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const providers = useConfigStore((state) => state.providers);
    const backgroundWork = useBackgroundSessionWork();
    const { sessionId, directory } = useChatSessionSelection();
    // The managed plugin registers this command only while the setting is on.
    const canRetryNow = useCommandsStore((state) => state.commands.some(
        (command) => command.name === RETRY_NOW_COMMAND && command.fromOpenCode === true,
    ));

    const retryNow = React.useCallback(() => {
        if (!sessionId) return;
        void opencodeClient.retryNow({ id: sessionId, directory }).catch(() => undefined);
    }, [directory, sessionId]);

    // The shortcut lives with the status that knows whether anything can go
    // to the background; otherwise it yields the key.
    useKeybind('background_session_work', () => {
        if (!working.canBackground) return false;
        backgroundWork();
    });

    const modelDisplayName = React.useMemo(() => {
        if (!activeModel) {
            return null;
        }
        const provider = providers.length > 0
            ? providers.find((candidate) => candidate.id === activeModel.providerId)
            : undefined;
        return getProviderModelDisplayName(provider, activeModel.modelId) || null;
    }, [activeModel, providers]);

    return (
        <StatusRow
            isWorking={working.isWorking}
            statusText={working.statusText}
            isGenericStatus={working.isGenericStatus}
            isWaitingForPermission={working.isWaitingForPermission}
            abortActive={working.abortActive}
            retryInfo={working.retryInfo}
            agentName={currentAgentName}
            modelName={modelDisplayName}
            providerId={activeModel?.providerId ?? null}
            onBackground={working.canBackground ? backgroundWork : undefined}
            onRetryNow={working.retryInfo && canRetryNow ? retryNow : undefined}
        />
    );
});

StatusRowContainer.displayName = 'StatusRowContainer';

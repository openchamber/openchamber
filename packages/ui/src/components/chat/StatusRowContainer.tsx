import React from 'react';

import { useAssistantStatus } from '@/hooks/useAssistantStatus';
import { useBackgroundSessionWork } from '@/hooks/useBackgroundSessionWork';
import { useKeybind } from '@/hooks/useKeybind';
import { useConfigStore } from '@/stores/useConfigStore';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { StatusRow } from './StatusRow';

export const StatusRowContainer: React.FC = React.memo(() => {
    const { activeModel, working } = useAssistantStatus();
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const providers = useConfigStore((state) => state.providers);
    const backgroundWork = useBackgroundSessionWork();

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
            status={working.status}
            isGenericStatus={working.isGenericStatus}
            isWaitingForPermission={working.isWaitingForPermission}
            abortActive={working.abortActive}
            retryInfo={working.retryInfo}
            agentName={currentAgentName}
            modelName={modelDisplayName}
            providerId={activeModel?.providerId ?? null}
            onBackground={working.canBackground ? backgroundWork : undefined}
        />
    );
});

StatusRowContainer.displayName = 'StatusRowContainer';

import type { Agent } from '@/lib/opencode/model';
import { selectCatalogLoadedForDirectory, selectConfigAgentsForDirectory, selectIsModelMissingFromCatalog, useConfigStore } from '@/stores/useConfigStore';
import { useChatSessionSelection } from './chatColumnSession';

export const isAgentMissingFromCatalog = (
    catalog: { agentsLoaded: boolean; agents: readonly Pick<Agent, 'name'>[] },
    agentName: string | null | undefined,
): boolean => Boolean(agentName)
    && catalog.agentsLoaded
    && !catalog.agents.some((agent) => agent.name === agentName);

export const isAgentMissingForDirectory = (
    state: Parameters<typeof selectCatalogLoadedForDirectory>[0] & Parameters<typeof selectConfigAgentsForDirectory>[0],
    directory: string | undefined,
    agentName: string | null | undefined,
): boolean => isAgentMissingFromCatalog({
    agentsLoaded: selectCatalogLoadedForDirectory(state, 'agents', directory),
    agents: selectConfigAgentsForDirectory(state, directory),
}, agentName);

export const useAgentMissingFromCatalog = (agentName: string | null | undefined): boolean => {
    const directory = useChatSessionSelection().directory ?? undefined;
    return useConfigStore((state) => isAgentMissingForDirectory(state, directory, agentName));
};

export const useModelMissingFromCatalog = (
    directory: string | undefined,
    providerId: string | null | undefined,
    modelId: string | null | undefined,
): boolean => useConfigStore((state) => selectIsModelMissingFromCatalog(state, directory, providerId ?? '', modelId ?? ''));

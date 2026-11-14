import type { Agent } from '@/lib/opencode/model';
import { selectCatalogLoadedForDirectory, selectConfigAgentsForDirectory, selectIsModelMissingFromCatalog, useConfigStore } from '@/stores/useConfigStore';
import { useChatSessionSelection } from './chatColumnSession';

/**
 * Whether the composer's agent is missing from the folder's loaded agent
 * catalog, the state in which a send stops with an error. A catalog still
 * loading proves nothing, so it never marks the agent.
 */
export const isAgentMissingFromCatalog = (
    catalog: { agentsLoaded: boolean; agents: readonly Pick<Agent, 'name'>[] },
    agentName: string | null | undefined,
): boolean => Boolean(agentName)
    && catalog.agentsLoaded
    && !catalog.agents.some((agent) => agent.name === agentName);

/**
 * The check against the catalog of `directory`, the folder the composer's
 * session lives in: a chat pinned beside the main one can belong to another
 * folder. Without one (a draft) it is the active catalog.
 */
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

/**
 * Whether the composer's model is gone from the live catalog it is picked
 * from, which is how a removed provider shows: a send with it stops with an
 * error. `directory` is that catalog's folder: the column's own for a
 * controlled picker, none (the active catalog) for the main chat, which reads
 * the active selection even while the column still shows the previous session.
 */
export const useModelMissingFromCatalog = (
    directory: string | undefined,
    providerId: string | null | undefined,
    modelId: string | null | undefined,
): boolean => useConfigStore((state) => selectIsModelMissingFromCatalog(state, directory, providerId ?? '', modelId ?? ''));

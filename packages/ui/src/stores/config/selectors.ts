import { type ProviderWithModelList, type ConfigStore, type ProviderModel, type ConfigSlice } from './types';
import { toConfigDirectoryKey } from './directories';
import { type Agent, findCatalogModel } from '@/lib/opencode/model';
import { isMissingFromCatalog, isStaleAutoSelection as resolveStaleAutoSelection } from './selectionResolution';
import { hasLiveCatalog } from './directorySnapshots';
import { useConfigStore } from '../useConfigStore';
import { resolveModelMetadata } from './metadata';
import { filterVisibleAgents } from '../useAgentsStore';

export const isStaleAutoSelection = (providerId?: string | null, modelId?: string | null): boolean =>
    resolveStaleAutoSelection(useConfigStore.getState().settingsDefaultsLoaded, providerId, modelId);

export const selectProvidersForDirectory = (
    state: Pick<ConfigStore, "providers" | "directoryScoped" | "activeDirectoryKey">,
    directory?: string | null,
): ProviderWithModelList[] => {
    if (directory == null) return state.providers;
    const directoryKey = toConfigDirectoryKey(directory);
    if (directoryKey === state.activeDirectoryKey) {
        return state.providers;
    }
    return state.directoryScoped[directoryKey]?.providers ?? EMPTY_PROVIDERS;
};

export const EMPTY_PROVIDERS: ProviderWithModelList[] = [];
const EMPTY_AGENTS: Agent[] = [];

export const selectIsModelMissingFromCatalog = (
    state: Pick<ConfigStore, "providers" | "directoryScoped" | "activeDirectoryKey">,
    directory: string | null | undefined,
    providerId: string,
    modelId: string,
): boolean => {
    if (!providerId || !modelId) return false;
    const directoryKey = directory == null ? state.activeDirectoryKey : toConfigDirectoryKey(directory);
    return isMissingFromCatalog(
        selectProvidersForDirectory(state, directory),
        hasLiveCatalog(state, directoryKey),
        providerId,
        modelId,
    );
};

export const selectSettingsOnlyProvidersForDirectory = (
    state: Pick<ConfigStore, "settingsOnlyProviders" | "activeDirectoryKey">,
    directory?: string | null,
): ProviderWithModelList[] => {
    const directoryKey = directory == null ? state.activeDirectoryKey : toConfigDirectoryKey(directory);
    return state.settingsOnlyProviders[directoryKey] ?? EMPTY_PROVIDERS;
};

export const selectConfigAgentsForDirectory = (
    state: Pick<ConfigStore, 'agents' | 'directoryScoped' | 'activeDirectoryKey'>,
    directory?: string | null,
): Agent[] => {
    if (directory === undefined) return state.agents;
    const key = toConfigDirectoryKey(directory);
    return key === state.activeDirectoryKey ? state.agents : state.directoryScoped[key]?.agents ?? EMPTY_AGENTS;
};

export const selectKnownCatalogModel = (
    state: Pick<ConfigStore, 'providers' | 'directoryScoped'>,
    providerId: string,
    modelId: string,
): ProviderModel | undefined => {
    if (!providerId || !modelId) return undefined;
    const fromProviders = (providers: ProviderWithModelList[]) =>
        findCatalogModel(providers.find((provider) => provider.id === providerId)?.models, modelId);
    const active = fromProviders(state.providers);
    if (active) return active;
    for (const snapshot of Object.values(state.directoryScoped)) {
        const known = fromProviders(snapshot.providers);
        if (known) return known;
    }
    return undefined;
};

export const selectKnownAgent = (
    state: Pick<ConfigStore, 'agents' | 'directoryScoped'>,
    name: string,
): Agent | undefined => {
    if (!name) return undefined;
    const active = state.agents.find((agent) => agent.name === name);
    if (active) return active;
    for (const snapshot of Object.values(state.directoryScoped)) {
        const known = snapshot.agents.find((agent) => agent.name === name);
        if (known) return known;
    }
    return undefined;
};

export const selectCatalogLoadedForDirectory = (
    state: Pick<ConfigStore, 'agentsLoaded' | 'providersLoaded' | 'directoryScoped' | 'activeDirectoryKey'>,
    resource: 'models' | 'agents',
    directory?: string | null,
): boolean => {
    const field = resource === 'models' ? 'providersLoaded' : 'agentsLoaded';
    if (directory === undefined) return state[field];
    const key = toConfigDirectoryKey(directory);
    return key === state.activeDirectoryKey ? state[field] : state.directoryScoped[key]?.[field] === true;
};

export const createConfigGetters: ConfigSlice<
    | 'getCurrentProvider'
    | 'getCurrentModel'
    | 'getCurrentAgent'
    | 'getModelMetadata'
    | 'getVisibleAgents'
> = (set, get) => ({
    getCurrentProvider: () => {
        const { providers, currentProviderId } = get();
        return providers.find((p) => p.id === currentProviderId);
    },

    getCurrentModel: () => {
        const provider = get().getCurrentProvider();
        const { currentModelId } = get();
        if (!provider) {
            return undefined;
        }
        return findCatalogModel(provider.models, currentModelId);
    },

    getCurrentAgent: () => {
        const { agents, currentAgentName } = get();
        if (!currentAgentName) return undefined;
        return agents.find((a) => a.name === currentAgentName);
    },
    getModelMetadata: (providerId: string, modelId: string) => {
        const { modelsMetadata, providers } = get();
        return resolveModelMetadata(modelsMetadata, providers, providerId, modelId);
    },
    getVisibleAgents: () => {
        const { agents } = get();
        return filterVisibleAgents(agents);
    },
});

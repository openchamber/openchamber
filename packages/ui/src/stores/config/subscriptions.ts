import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { configRuntime, captureConfigRuntimeContext, isConfigRuntimeContextCurrent } from './runtime';
import { invalidateOpenChamberDefaultsCache } from './defaults';
import {
    _providersLoadedAt,
    _agentsLoadedAt,
    _providersStaleAt,
    _agentsStaleAt,
    _agentsLoadErrors,
    _inFlightProviders,
    _inFlightAgents,
    _agentsLoadGeneration,
} from './catalogLifecycle';
import { resetConfigInitialization } from './connection';
import { resetModelsMetadataRequest } from './metadata';
import { useConfigStore } from '../useConfigStore';
import { type ModelMetadata } from '@/types';
import { hydrateConfigCatalogFromCache } from './catalogHydration';
import { fromDirectoryKey, toDirectoryKey, isChatDraftOpen, toConfigDirectoryKey } from './directories';
import { subscribeToConfigChanges, scopeMatches } from '@/lib/configSync';
import { opencodeClient } from '@/lib/opencode/client';
import { subscribeToSyncConfigChanges } from '@/sync/sync-refs';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { markStartupTrace } from '@/lib/startupTrace';
import { useRoutingStore } from '@/stores/useRoutingStore';
import { useUIStore } from '@/stores/useUIStore';

const PROVIDER_CONFIG_REFRESH_CONCURRENCY = 4;

export const subscribeConfigRuntimeChanges = (): void => {
    subscribeRuntimeEndpointChanged((detail) => {
        configRuntime.generation += 1;
        invalidateOpenChamberDefaultsCache();
        _providersLoadedAt.clear();
        _agentsLoadedAt.clear();
        _providersStaleAt.clear();
        _agentsStaleAt.clear();
        _agentsLoadErrors.clear();
        _inFlightProviders.clear();
        _inFlightAgents.clear();
        _agentsLoadGeneration.clear();
        resetConfigInitialization();
        resetModelsMetadataRequest();
        if (detail.runtimeKey === detail.previousRuntimeKey) return;
        configRuntime.instanceGeneration += 1;
        useConfigStore.setState({
            configRuntimeKey: detail.runtimeKey,
            modelsMetadata: new Map<string, ModelMetadata>(),
            directoryScoped: {},
            projectConfigErrors: {},
            lastInitFailure: null,
            settingsOnlyProviders: {},
            providers: [],
            agents: [],
            providersLoaded: false,
            agentsLoaded: false,
            currentProviderId: '',
            currentModelId: '',
            currentAgentName: undefined,
            currentVariant: undefined,
            currentVariantSelection: { override: undefined, inherited: undefined },
            selectedProviderId: '',
            agentModelSelections: {},
            defaultProviders: {},
            opencodeDefaultAgent: undefined,
            opencodeDefaultModel: undefined,
            settingsDefaultModel: undefined,
            settingsDefaultVariant: undefined,
            settingsDefaultAgent: undefined,
            settingsDefaultsLoaded: false,
            settingsZenModel: undefined,
            selectionSource: 'auto',
            agentSelectionSource: 'auto',
            isInitialized: false,
            isConnected: false,
        });
    });
};

export const subscribeConfigStoreChanges = (): void => {
    if (typeof window !== "undefined") {
        window.__zustand_config_store__ = useConfigStore;
    }

    if (typeof window !== "undefined") {
        const hydrateActiveCatalog = () => void hydrateConfigCatalogFromCache(useConfigStore.getState().activeDirectoryKey);
        if (useConfigStore.persist.hasHydrated()) hydrateActiveCatalog();
        else useConfigStore.persist.onFinishHydration(hydrateActiveCatalog);
    }
    const refreshKnownProviderDirectories = async (source: string): Promise<void> => {
        const runtimeContext = captureConfigRuntimeContext();
        const state = useConfigStore.getState();
        const directoryKeys = Array.from(new Set([
            state.activeDirectoryKey,
            ...Object.keys(state.directoryScoped),
        ])).filter((key) => key.length > 0);

        state.invalidateProviderCache();

        let nextIndex = 0;
        const workerCount = Math.min(PROVIDER_CONFIG_REFRESH_CONCURRENCY, directoryKeys.length);
        const workers = Array.from({ length: workerCount }, async () => {
            while (nextIndex < directoryKeys.length) {
                if (!isConfigRuntimeContextCurrent(runtimeContext)) return;
                const directoryKey = directoryKeys[nextIndex];
                nextIndex += 1;
                await useConfigStore.getState().loadProviders({
                    directory: fromDirectoryKey(directoryKey),
                    source,
                    fresh: true,
                });
            }
        });

        await Promise.all(workers);
};

let unsubscribeConfigStoreChanges: (() => void) | null = null;

if (!unsubscribeConfigStoreChanges) {
    unsubscribeConfigStoreChanges = subscribeToConfigChanges(async (event) => {
            const tasks: Promise<void>[] = [];

        opencodeClient.clearConfigCache();

        if (scopeMatches(event, "agents")) {
            const { loadAgents } = useConfigStore.getState();
            tasks.push(loadAgents({ source: 'configChange:agents' }).then(() => {}));
        }

        if (scopeMatches(event, "providers")) {
            tasks.push(refreshKnownProviderDirectories('configChange:providers'));
        }

        if (tasks.length > 0) {
            await Promise.all(tasks);
        }
    });
}

let unsubscribeConfigStoreDirectoryChanges: (() => void) | null = null;

let unsubscribeConfigStoreSyncConfigChanges: (() => void) | null = null;

if (!unsubscribeConfigStoreSyncConfigChanges) {
    unsubscribeConfigStoreSyncConfigChanges = subscribeToSyncConfigChanges((directory, config) => {
        useConfigStore.getState().applyOpenCodeConfigDefaults(directory, 'syncConfig', config);
    });
}

if (typeof window !== "undefined" && !unsubscribeConfigStoreDirectoryChanges) {
    unsubscribeConfigStoreDirectoryChanges = useDirectoryStore.subscribe((state, prevState) => {
        const nextKey = toDirectoryKey(state.currentDirectory);
        const prevKey = toDirectoryKey(prevState.currentDirectory);
        if (nextKey === prevKey) {
            return;
        }

        markStartupTrace('directoryStore:changed', { previous: prevKey, next: nextKey });
        if (isChatDraftOpen()) return;
        void hydrateConfigCatalogFromCache(toConfigDirectoryKey(state.currentDirectory));
        void useConfigStore.getState().activateDirectory(state.currentDirectory);
    });
}

let unsubscribeConfigStoreRoutingChanges: (() => void) | null = null;

if (typeof window !== "undefined" && !unsubscribeConfigStoreRoutingChanges) {
    const drop = () => useConfigStore.getState().dropStaleAutoSelection();
    const unsubscribeRouting = useRoutingStore.subscribe(drop);
    const unsubscribeUi = useUIStore.subscribe((state, prevState) => {
        if (state.routingFeatureAvailable !== prevState.routingFeatureAvailable) drop();
    });
    const unsubscribeSelf = useConfigStore.subscribe((state, prevState) => {
        if (state.settingsDefaultsLoaded && !prevState.settingsDefaultsLoaded) drop();
    });
    unsubscribeConfigStoreRoutingChanges = () => {
        unsubscribeRouting();
        unsubscribeUi();
        unsubscribeSelf();
    };
}
};

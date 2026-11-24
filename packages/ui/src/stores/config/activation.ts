import { type ConfigSlice } from './types';
import { captureConfigRuntimeContext, isConfigRuntimeContextCurrent } from './runtime';
import { normalizeConfigPath as resolveConfigDirectory, toDirectoryKey, fromDirectoryKey } from './directories';
import { markStartupTrace } from '@/lib/startupTrace';
import { isConfigFresh, _providersLoadedAt, _agentsLoadedAt } from './catalogLifecycle';

export const createDirectoryActivation: ConfigSlice<'activateDirectory'> = (set, get) => ({
    activateDirectory: async (directory, options) => {
        const runtimeContext = captureConfigRuntimeContext();
        const configDirectory = resolveConfigDirectory(directory);
        if (!configDirectory) {
            markStartupTrace('activateDirectory:skippedUnknownDirectory', { directory });
            return;
        }
        const directoryKey = toDirectoryKey(configDirectory);
        let snapshotHadProviders = false;
        let snapshotHadAgents = false;

        set((state) => {
            const snapshot = state.directoryScoped[directoryKey];
            const carryManualModel = options?.preserveManualModel && state.activeDirectoryKey !== directoryKey
                && state.selectionSource === 'manual' && Boolean(state.currentProviderId && state.currentModelId);
            const manualModel = carryManualModel ? {
                currentProviderId: state.currentProviderId,
                currentModelId: state.currentModelId,
                currentVariant: state.currentVariant,
                currentVariantSelection: state.currentVariantSelection,
                selectionSource: 'manual' as const,
            } : null;
            const carriedOverride = !manualModel && options?.preserveManualModel
                && state.activeDirectoryKey !== directoryKey
                ? state.currentVariantSelection.override
                : undefined;
            const carriedVariant = carriedOverride === undefined ? null : {
                currentVariant: carriedOverride ?? undefined,
                currentVariantSelection: {
                    override: carriedOverride,
                    inherited: snapshot?.currentVariantSelection?.inherited !== undefined
                        ? snapshot.currentVariantSelection.inherited
                        : snapshot?.currentVariant,
                },
            };
            const carried = manualModel ?? carriedVariant;
            if (snapshot) {
                snapshotHadProviders = snapshot.providers.length > 0;
                snapshotHadAgents = snapshot.agents.length > 0;
                return {
                    activeDirectoryKey: directoryKey,
                    directoryScoped: carried ? {
                        ...state.directoryScoped,
                        [directoryKey]: { ...snapshot, ...carried },
                    } : state.directoryScoped,
                    providers: snapshot.providers,
                    agents: snapshot.agents,
                    providersLoaded: snapshot.providersLoaded ?? snapshot.providers.length > 0,
                    agentsLoaded: snapshot.agentsLoaded ?? snapshot.agents.length > 0,
                    currentProviderId: manualModel?.currentProviderId ?? snapshot.currentProviderId,
                    currentModelId: manualModel?.currentModelId ?? snapshot.currentModelId,
                    currentVariant: carried ? carried.currentVariant : snapshot.currentVariant,
                    currentVariantSelection: carried?.currentVariantSelection ?? snapshot.currentVariantSelection ?? { override: undefined, inherited: snapshot.currentVariant },
                    currentAgentName: snapshot.currentAgentName,
                    selectedProviderId: snapshot.selectedProviderId,
                    agentModelSelections: snapshot.agentModelSelections,
                    defaultProviders: snapshot.defaultProviders,
                    opencodeDefaultAgent: snapshot.opencodeDefaultAgent,
                    opencodeDefaultModel: snapshot.opencodeDefaultModel,
                    selectionSource: manualModel?.selectionSource ?? snapshot.selectionSource ?? "auto",
                    agentSelectionSource: snapshot.agentSelectionSource ?? "auto",
                };
            }

            return {
                activeDirectoryKey: directoryKey,
                directoryScoped: carried ? {
                    ...state.directoryScoped,
                    [directoryKey]: {
                        providers: [], agents: [], agentModelSelections: {}, defaultProviders: {},
                        selectedProviderId: '', currentAgentName: undefined,
                        currentProviderId: '', currentModelId: '', ...carried,
                    },
                } : state.directoryScoped,
                providers: [],
                agents: [],
                providersLoaded: false,
                agentsLoaded: false,
                currentProviderId: manualModel?.currentProviderId ?? "",
                currentModelId: manualModel?.currentModelId ?? "",
                currentVariant: carried?.currentVariant,
                currentVariantSelection: carried?.currentVariantSelection ?? { override: undefined, inherited: undefined },
                currentAgentName: undefined,
                selectedProviderId: "",
                agentModelSelections: {},
                defaultProviders: {},
                opencodeDefaultAgent: undefined,
                opencodeDefaultModel: undefined,
                selectionSource: manualModel?.selectionSource ?? "auto",
                agentSelectionSource: "auto",
            };
        });

        if (!get().isConnected) {
            return;
        }

        const requiredLoads: Promise<void | boolean>[] = [];
        if (snapshotHadProviders) {
            if (isConfigFresh(_providersLoadedAt, directoryKey)) {
                markStartupTrace('activateDirectory:providersFresh', { directoryKey });
            } else {
                markStartupTrace('activateDirectory:refreshProvidersBackground', { directoryKey });
                void get().loadProviders({ directory: fromDirectoryKey(directoryKey), source: 'activateDirectory:refresh' });
            }
        } else {
            requiredLoads.push(get().loadProviders({ directory: fromDirectoryKey(directoryKey), source: 'activateDirectory' }));
        }

        if (!isConfigRuntimeContextCurrent(runtimeContext)) return;
        if (snapshotHadAgents) {
            if (isConfigFresh(_agentsLoadedAt, directoryKey)) {
                markStartupTrace('activateDirectory:agentsFresh', { directoryKey });
            } else {
                markStartupTrace('activateDirectory:refreshAgentsBackground', { directoryKey });
                void get().loadAgents({ directory: fromDirectoryKey(directoryKey), source: 'activateDirectory:refresh' });
            }
        } else {
            requiredLoads.push(get().loadAgents({ directory: fromDirectoryKey(directoryKey), source: 'activateDirectory' }));
        }
        await Promise.all(requiredLoads);
    },
});

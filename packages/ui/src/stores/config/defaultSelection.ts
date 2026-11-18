import { type ConfigSlice, type DirectoryScopedConfig, type ConfigStore } from './types';
import {
    isStaleAutoSelection,
    resolveProviderModelSelection,
    inheritedDefaultsFor,
    readFallbackModelPrefs,
    resolveDefaultAgentModelSelection,
    normalizeOptionalString,
    resolveSelectionWithManualGuard,
    variantAfterResolve,
} from './selectionResolution';
import {
    fromDirectoryKey,
    normalizeConfigPath as resolveConfigDirectory,
    toDirectoryKey,
    toConfigDirectoryKey,
} from './directories';
import { getProjectDefaultsForConfigDirectory, readProjectDefaults } from './projectDefaults';
import { hasLiveCatalog, createEmptyDirectoryScopedConfig } from './directorySnapshots';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { notifyAutoUnavailable } from '@/lib/routing/autoUnavailableNotice';
import { captureConfigRuntimeContext, isConfigRuntimeContextCurrent } from './runtime';
import { getSyncConfig } from '@/sync/sync-refs';
import { opencodeClient } from '@/lib/opencode/client';
import { configModelIdentifier } from '@/lib/opencode/projection';
import { markStartupTrace } from '@/lib/startupTrace';

export const createDefaultSelection: ConfigSlice<
    | 'dropStaleAutoSelection'
    | 'applyDefaultModelAgentSelection'
    | 'resolveDirectoryDefaultSelection'
    | 'applyOpenCodeConfigDefaults'
> = (set, get) => ({
    dropStaleAutoSelection: () => {
        const current = get();
        if (!isStaleAutoSelection(current.settingsDefaultsLoaded, current.currentProviderId, current.currentModelId)) return;
        const projectDefaults = getProjectDefaultsForConfigDirectory(fromDirectoryKey(current.activeDirectoryKey));
        const resolved = resolveProviderModelSelection({
            providers: current.providers,
            catalogLoaded: hasLiveCatalog(current, current.activeDirectoryKey),
            configuredDefaults: [
                { model: projectDefaults.projectDefaultModel, variant: projectDefaults.projectDefaultVariant },
                { model: current.settingsDefaultModel, variant: current.settingsDefaultVariant },
            ],
            inheritedDefaults: inheritedDefaultsFor(current.agents, current.currentAgentName, current.opencodeDefaultModel),
            allowFallback: true,
            fallbackPrefs: readFallbackModelPrefs(get().settingsDefaultsLoaded),
        });
        if (!resolved) return;
        set((state) => {
            const directoryKey = state.activeDirectoryKey;
            const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                providers: state.providers,
                agents: state.agents,
                currentProviderId: state.currentProviderId,
                currentModelId: state.currentModelId,
                currentVariant: state.currentVariant,
                currentAgentName: state.currentAgentName,
                selectedProviderId: state.selectedProviderId,
                agentModelSelections: state.agentModelSelections,
                defaultProviders: state.defaultProviders,
            };
            const nextSnapshot: DirectoryScopedConfig = {
                ...baseSnapshot,
                currentProviderId: resolved.providerId,
                currentModelId: resolved.modelId,
                currentVariant: resolved.variant ?? undefined,
                currentVariantSelection: { override: undefined, inherited: resolved.variant },
                selectionSource: "auto",
            };
            return {
                currentProviderId: resolved.providerId,
                currentModelId: resolved.modelId,
                currentVariant: resolved.variant ?? undefined,
                currentVariantSelection: { override: undefined, inherited: resolved.variant },
                selectionSource: "auto",
                directoryScoped: { ...state.directoryScoped, [directoryKey]: nextSnapshot },
            };
        });
        const sessionId = useSessionUIStore.getState().currentSessionId;
        if (sessionId) {
            const selection = useSelectionStore.getState();
            selection.saveSessionModelSelection(sessionId, resolved.providerId, resolved.modelId);
            if (current.currentAgentName) selection.saveAgentModelForSession(sessionId, current.currentAgentName, resolved.providerId, resolved.modelId);
        }
        notifyAutoUnavailable();
    },

    applyDefaultModelAgentSelection: (options) => {
        const projectDefaults = options ?? getProjectDefaultsForConfigDirectory(fromDirectoryKey(get().activeDirectoryKey));
        const {
            agents,
            providers,
            settingsDefaultModel,
            settingsDefaultVariant,
            settingsDefaultAgent,
            opencodeDefaultAgent,
            opencodeDefaultModel,
        } = get();

        const {
            agentName: resolvedAgentName,
            providerId: resolvedProviderId,
            modelId: resolvedModelId,
            variant: resolvedVariant,
        } = resolveDefaultAgentModelSelection({
            agents,
            providers,
            catalogLoaded: hasLiveCatalog(get(), get().activeDirectoryKey),
            ...projectDefaults,
            settingsDefaultAgent,
            settingsDefaultModel,
            settingsDefaultVariant,
            opencodeDefaultAgent,
            opencodeDefaultModel,
            allowFallback: get().settingsDefaultsLoaded,
            fallbackPrefs: readFallbackModelPrefs(get().settingsDefaultsLoaded),
        });

        set((state) => {
            const directoryKey = state.activeDirectoryKey;
            const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                providers: state.providers,
                agents: state.agents,
                currentProviderId: state.currentProviderId,
                currentModelId: state.currentModelId,
                currentVariant: state.currentVariant,
                currentAgentName: state.currentAgentName,
                selectedProviderId: state.selectedProviderId,
                agentModelSelections: state.agentModelSelections,
                defaultProviders: state.defaultProviders,
            };

            const nextSnapshot: DirectoryScopedConfig = {
                ...baseSnapshot,
                currentAgentName: resolvedAgentName,
                currentProviderId: resolvedProviderId ?? '',
                currentModelId: resolvedModelId ?? '',
                currentVariant: resolvedVariant ?? undefined,
                currentVariantSelection: { override: undefined, inherited: resolvedVariant },
                selectionSource: "auto",
                agentSelectionSource: "auto",
            };

            const nextState: Partial<ConfigStore> = {
                currentAgentName: resolvedAgentName,
                currentProviderId: nextSnapshot.currentProviderId,
                currentModelId: nextSnapshot.currentModelId,
                currentVariant: resolvedVariant ?? undefined,
                currentVariantSelection: { override: undefined, inherited: resolvedVariant },
                selectionSource: "auto",
                agentSelectionSource: "auto",
                directoryScoped: {
                    ...state.directoryScoped,
                    [directoryKey]: nextSnapshot,
                },
            };

            return nextState;
        });
    },

    resolveDirectoryDefaultSelection: async (directory) => {
        const runtimeContext = captureConfigRuntimeContext();
        const configDirectory = resolveConfigDirectory(directory);
        if (!configDirectory) return null;
        const directoryKey = toDirectoryKey(configDirectory);
        const source = 'resolveDirectoryDefaultSelection';
        const [, , config] = await Promise.all([
            get().loadProviders({ directory: configDirectory, source }).catch(() => undefined),
            get().loadAgents({ directory: configDirectory, source }).catch(() => false),
            getSyncConfig(configDirectory) ?? opencodeClient.getConfig(configDirectory).catch(() => undefined),
        ]);
        if (!isConfigRuntimeContextCurrent(runtimeContext)) return null;

        const state = get();
        const snapshot = state.directoryScoped[directoryKey];
        const isActive = state.activeDirectoryKey === directoryKey;
        const resolved = resolveDefaultAgentModelSelection({
            agents: isActive ? state.agents : (snapshot?.agents ?? []),
            providers: isActive ? state.providers : (snapshot?.providers ?? []),
            catalogLoaded: hasLiveCatalog(state, directoryKey),
            ...readProjectDefaults(configDirectory),
            settingsDefaultAgent: state.settingsDefaultAgent,
            settingsDefaultModel: state.settingsDefaultModel,
            settingsDefaultVariant: state.settingsDefaultVariant,
            opencodeDefaultAgent: config ? normalizeOptionalString(config.default_agent) : snapshot?.opencodeDefaultAgent,
            opencodeDefaultModel: config ? configModelIdentifier(config.model) : snapshot?.opencodeDefaultModel,
            allowFallback: state.settingsDefaultsLoaded,
            fallbackPrefs: readFallbackModelPrefs(get().settingsDefaultsLoaded),
        });
        if (!resolved.providerId || !resolved.modelId) return null;
        return {
            agentName: resolved.agentName,
            providerId: resolved.providerId,
            modelId: resolved.modelId,
            variant: resolved.variant,
        };
    },

    applyOpenCodeConfigDefaults: (directory, source = "syncConfig", config) => {
        const eventDirectory = directory ?? fromDirectoryKey(get().activeDirectoryKey);
        const directoryKey = toConfigDirectoryKey(eventDirectory);
        const configDirectory = fromDirectoryKey(directoryKey);
        const syncedConfig = config
            ?? getSyncConfig(eventDirectory ?? undefined)
            ?? getSyncConfig(configDirectory ?? undefined);
        if (!syncedConfig) {
            return;
        }

        const opencodeDefaultAgent = normalizeOptionalString(syncedConfig.default_agent);
        const opencodeDefaultModel = configModelIdentifier(syncedConfig.model);
        const projectDefaults = getProjectDefaultsForConfigDirectory(configDirectory);

        set((state) => {
            const snapshot = state.directoryScoped[directoryKey];
            const isActive = state.activeDirectoryKey === directoryKey;
            const providers = isActive ? state.providers : (snapshot?.providers ?? []);
            const agents = isActive ? state.agents : (snapshot?.agents ?? []);
            const baseSnapshot: DirectoryScopedConfig = snapshot ?? createEmptyDirectoryScopedConfig(providers, agents);
            const defaultsChanged = baseSnapshot.opencodeDefaultAgent !== opencodeDefaultAgent
                || baseSnapshot.opencodeDefaultModel !== opencodeDefaultModel
                || (isActive && (
                    state.opencodeDefaultAgent !== opencodeDefaultAgent
                    || state.opencodeDefaultModel !== opencodeDefaultModel
                ));
            const defaultsSnapshot: DirectoryScopedConfig = {
                ...baseSnapshot,
                providers,
                agents,
                opencodeDefaultAgent,
                opencodeDefaultModel,
            };
            const nextState: Partial<ConfigStore> = {
                directoryScoped: {
                    ...state.directoryScoped,
                    [directoryKey]: defaultsSnapshot,
                },
            };

            if (isActive) {
                nextState.opencodeDefaultAgent = opencodeDefaultAgent;
                nextState.opencodeDefaultModel = opencodeDefaultModel;
            }

            const selectionSource = isActive ? state.selectionSource : (snapshot?.selectionSource ?? "auto");
            const agentSelectionSource = isActive ? state.agentSelectionSource : (snapshot?.agentSelectionSource ?? "auto");

            if (providers.length === 0 || agents.length === 0) {
                if (!defaultsChanged) {
                    return state;
                }
                return nextState;
            }

            const resolved = resolveDefaultAgentModelSelection({
                agents,
                providers,
                catalogLoaded: hasLiveCatalog(state, directoryKey),
                projectDefaultAgent: projectDefaults.projectDefaultAgent,
                projectDefaultModel: projectDefaults.projectDefaultModel,
                projectDefaultVariant: projectDefaults.projectDefaultVariant,
                settingsDefaultAgent: state.settingsDefaultAgent,
                settingsDefaultModel: state.settingsDefaultModel,
                settingsDefaultVariant: state.settingsDefaultVariant,
                opencodeDefaultAgent,
                opencodeDefaultModel,
                allowFallback: state.settingsDefaultsLoaded,
                fallbackPrefs: readFallbackModelPrefs(get().settingsDefaultsLoaded),
            });

            if (!resolved.agentName) {
                if (!defaultsChanged) {
                    return state;
                }
                return nextState;
            }

            const currentAgentName = isActive ? state.currentAgentName : baseSnapshot.currentAgentName;
            const currentProviderId = isActive ? state.currentProviderId : baseSnapshot.currentProviderId;
            const currentModelId = isActive ? state.currentModelId : baseSnapshot.currentModelId;
            const currentVariant = isActive ? state.currentVariant : baseSnapshot.currentVariant;
            const nextSelection = resolveSelectionWithManualGuard({
                currentAgentName,
                currentProviderId,
                currentModelId,
                currentVariant,
                selectionSource,
                agentSelectionSource,
                resolvedAgentName: resolved.agentName,
                resolvedProviderId: resolved.providerId,
                resolvedModelId: resolved.modelId,
                resolvedVariant: resolved.variant,
            });

            const heldVariantSelection = isActive ? state.currentVariantSelection : baseSnapshot.currentVariantSelection;
            const nextVariant = variantAfterResolve(heldVariantSelection, nextSelection.variant);
            const nextSnapshot: DirectoryScopedConfig = {
                ...defaultsSnapshot,
                providers,
                agents,
                currentAgentName: nextSelection.agentName,
                currentVariantSelection: nextSelection.selectionSource === 'manual'
                    || heldVariantSelection?.override !== undefined
                    ? heldVariantSelection
                    : { override: undefined, inherited: nextSelection.variant },
                ...(nextSelection.providerId && nextSelection.modelId
                    ? {
                        currentProviderId: nextSelection.providerId,
                        currentModelId: nextSelection.modelId,
                        currentVariant: nextVariant,
                    }
                    : {}),
                selectionSource: nextSelection.selectionSource,
            };

            const selectionChanged = baseSnapshot.currentAgentName !== nextSnapshot.currentAgentName
                || baseSnapshot.currentProviderId !== nextSnapshot.currentProviderId
                || baseSnapshot.currentModelId !== nextSnapshot.currentModelId
                || baseSnapshot.currentVariant !== nextSnapshot.currentVariant
                || baseSnapshot.selectedProviderId !== nextSnapshot.selectedProviderId
                || (baseSnapshot.selectionSource ?? "auto") !== nextSnapshot.selectionSource
                || (isActive && (
                    state.currentAgentName !== nextSelection.agentName
                    || state.selectionSource !== nextSelection.selectionSource
                    || (nextSelection.providerId !== undefined && nextSelection.modelId !== undefined && (
                        state.currentProviderId !== nextSelection.providerId
                        || state.currentModelId !== nextSelection.modelId
                        || state.currentVariant !== nextVariant
                    ))
                ));

            if (!defaultsChanged && !selectionChanged) {
                return state;
            }

            nextState.directoryScoped = {
                ...state.directoryScoped,
                [directoryKey]: nextSnapshot,
            };

            if (isActive) {
                nextState.currentAgentName = nextSelection.agentName;
                nextState.selectionSource = nextSelection.selectionSource;
                if (nextSelection.providerId && nextSelection.modelId) {
                    nextState.currentProviderId = nextSelection.providerId;
                    nextState.currentModelId = nextSelection.modelId;
                    nextState.currentVariant = nextVariant;
                    nextState.currentVariantSelection = nextSnapshot.currentVariantSelection ?? { override: undefined, inherited: nextSelection.variant };
                }
            }

            markStartupTrace('loadAgents:opencodeConfigDefaultsApplied', { directoryKey, eventDirectory, source });
            return nextState;
        });
    },
});

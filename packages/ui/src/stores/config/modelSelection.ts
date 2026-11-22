import { type ConfigSlice, type DirectoryScopedConfig } from './types';
import { AUTO_PROVIDER_ID, AUTO_MODEL_ID } from '@/lib/routing/autoModel';
import { findProviderModel, hasProviderModel, modelHasVariant, resolveConfiguredDefaultVariant } from './selectionResolution';
import { readLockedVariant } from '@/lib/modelEffortLock';
import { useUIStore } from '@/stores/useUIStore';
import { isUnchangedSelection, variantResetForModelChange, resolveVariantFromSelection } from './selectionResolution';
import { modelVariantNames, nextThinkingVariant } from '@/lib/modelVariants';
import { normalizeConfigPath, fromDirectoryKey } from './directories';
import { readScopeDefaults, getProjectDefaultsForConfigDirectory } from './projectDefaults';
import { rememberEffort } from '@/lib/modelEfforts';

export const createModelSelection: ConfigSlice<
    | 'setProvider'
    | 'setModel'
    | 'setCurrentVariant'
    | 'setCurrentVariantOverride'
    | 'getCurrentModelVariants'
    | 'getDefaultVariantForModel'
    | 'getLockedVariantForModel'
    | 'cycleCurrentVariant'
    | 'setSelectedProvider'
    | 'saveAgentModelSelection'
    | 'getAgentModelSelection'
> = (set, get) => ({
    setProvider: (providerId: string) => {
        const { providers } = get();
        const provider = providers.find((p) => p.id === providerId);
        const isAuto = providerId === AUTO_PROVIDER_ID && hasProviderModel(providers, AUTO_PROVIDER_ID, AUTO_MODEL_ID);
 
        if (!provider && !isAuto) {
            return;
        }
 
        const firstModel = provider?.models[0];
        const newModelId = isAuto ? AUTO_MODEL_ID : (firstModel?.modelID || "");

        if (isUnchangedSelection(get(), { currentProviderId: providerId, currentModelId: newModelId, selectionSource: "manual" })) {
            return;
        }

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

            const variantReset = variantResetForModelChange(state, providerId, newModelId);
            const nextSnapshot: DirectoryScopedConfig = {
                ...baseSnapshot,
                ...variantReset,
                currentProviderId: providerId,
                currentModelId: newModelId,
                selectionSource: "manual",
            };

            return {
                ...variantReset,
                currentProviderId: providerId,
                currentModelId: newModelId,
                selectionSource: "manual",
                directoryScoped: {
                    ...state.directoryScoped,
                    [directoryKey]: nextSnapshot,
                },
            };
        });
    },

    setModel: (modelId: string) => {
        if (isUnchangedSelection(get(), { currentModelId: modelId, selectionSource: "manual" })) {
            return;
        }

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
 
            const variantReset = variantResetForModelChange(state, state.currentProviderId, modelId);
            const nextSnapshot: DirectoryScopedConfig = {
                ...baseSnapshot,
                ...variantReset,
                currentModelId: modelId,
                selectionSource: "manual",
            };
 
            return {
                ...variantReset,
                currentModelId: modelId,
                selectionSource: "manual",
                directoryScoped: {
                    ...state.directoryScoped,
                    [directoryKey]: nextSnapshot,
                },
            };
        });
    },

    setCurrentVariant: (variant: string | undefined) => {
        get().setCurrentVariantOverride(undefined, variant);
    },

    setCurrentVariantOverride: (requestedOverride, requestedInherited) => {
        // A locked model runs at its locked effort whatever is picked or cycled to.
        const current = get();
        const locked = current.currentProviderId && current.currentModelId
            ? current.getLockedVariantForModel(current.currentProviderId, current.currentModelId)
            : undefined;
        const override = locked === undefined ? requestedOverride : undefined;
        const inherited = locked ?? requestedInherited;
        set((state) => {
            const currentVariant = resolveVariantFromSelection({ override, inherited });
            if (
                state.currentVariant === currentVariant
                && state.currentVariantSelection.override === override
                && state.currentVariantSelection.inherited === inherited
            ) {
                return state;
            }

            const directoryKey = state.activeDirectoryKey;
            const baseSnapshot = state.directoryScoped[directoryKey] ?? {
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

            return {
                currentVariant,
                currentVariantSelection: { override, inherited },
                directoryScoped: {
                    ...state.directoryScoped,
                    [directoryKey]: {
                        ...baseSnapshot,
                        currentVariant,
                        currentVariantSelection: { override, inherited },
                    },
                },
            };
        });
    },

    getCurrentModelVariants: () => {
        return modelVariantNames(get().getCurrentModel());
    },

    getDefaultVariantForModel: (providerId: string, modelId: string, directory?: string | null) => {
        const state = get();
        const configDirectory = directory ? normalizeConfigPath(directory) : null;
        const configured = resolveConfiguredDefaultVariant({
            ...(configDirectory
                ? readScopeDefaults(configDirectory)
                : getProjectDefaultsForConfigDirectory(fromDirectoryKey(state.activeDirectoryKey))),
            settingsDefaultModel: state.settingsDefaultModel,
            settingsDefaultVariant: state.settingsDefaultVariant,
        }, providerId, modelId);
        const personal = useUIStore.getState().modelDefaultVariants[`${providerId}/${modelId}`];
        return get().getLockedVariantForModel(providerId, modelId) ?? configured ?? personal;
    },

    getLockedVariantForModel: (providerId: string, modelId: string) => {
        const locked = readLockedVariant(providerId, modelId);
        const model = findProviderModel(get().providers, providerId, modelId);
        // A lock on an effort the model no longer offers would fail every request; it is left out.
        return locked !== undefined && (!model || modelHasVariant(model, locked)) ? locked : undefined;
    },

    cycleCurrentVariant: () => {
        const variantKeys = get().getCurrentModelVariants();
        if (variantKeys.length === 0) {
            return undefined;
        }
        const { currentProviderId, currentModelId } = get();
        const locked = currentProviderId && currentModelId ? get().getLockedVariantForModel(currentProviderId, currentModelId) : undefined;
        if (locked !== undefined) return locked;

        const state = get();
        const currentOverride = state.currentVariantSelection.override;
        const inheritedVariant = state.currentVariantSelection.inherited !== undefined
            ? state.currentVariantSelection.inherited
            : state.currentVariant;
        const currentVariant = currentOverride === undefined
            ? state.currentVariant
            : currentOverride;
        const nextOverride = nextThinkingVariant(variantKeys, currentVariant);

        get().setCurrentVariantOverride(nextOverride, inheritedVariant);
        rememberEffort(state.currentProviderId, state.currentModelId, nextOverride ?? null);
        return nextOverride ?? undefined;
    },
 
    setSelectedProvider: (providerId: string) => {
        set((state) => {
            const directoryKey = state.activeDirectoryKey;
            const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                providers: state.providers,
                agents: state.agents,
                currentProviderId: state.currentProviderId,
                currentModelId: state.currentModelId,
                currentAgentName: state.currentAgentName,
                selectedProviderId: state.selectedProviderId,
                agentModelSelections: state.agentModelSelections,
                defaultProviders: state.defaultProviders,
            };

            const nextSnapshot: DirectoryScopedConfig = {
                ...baseSnapshot,
                selectedProviderId: providerId,
                selectionSource: "manual",
            };

            return {
                selectedProviderId: providerId,
                selectionSource: "manual",
                directoryScoped: {
                    ...state.directoryScoped,
                    [directoryKey]: nextSnapshot,
                },
            };
        });
    },

    saveAgentModelSelection: (agentName: string, providerId: string, modelId: string) => {
        set((state) => {
            const directoryKey = state.activeDirectoryKey;
            const nextSelections = {
                ...state.agentModelSelections,
                [agentName]: { providerId, modelId },
            };

            const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                providers: state.providers,
                agents: state.agents,
                currentProviderId: state.currentProviderId,
                currentModelId: state.currentModelId,
                currentAgentName: state.currentAgentName,
                selectedProviderId: state.selectedProviderId,
                agentModelSelections: state.agentModelSelections,
                defaultProviders: state.defaultProviders,
            };

            const nextSnapshot: DirectoryScopedConfig = {
                ...baseSnapshot,
                agentModelSelections: nextSelections,
                selectionSource: "manual",
            };

            return {
                agentModelSelections: nextSelections,
                selectionSource: "manual",
                directoryScoped: {
                    ...state.directoryScoped,
                    [directoryKey]: nextSnapshot,
                },
            };
        });
    },

    getAgentModelSelection: (agentName: string) => {
        const { agentModelSelections } = get();
        return agentModelSelections[agentName] || null;
    },
});

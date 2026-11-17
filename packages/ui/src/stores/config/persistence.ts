import { type ProviderWithModelList, type ConfigStore, type DirectoryScopedConfig } from './types';
import { createDeferredSafeJSONStorage } from '../utils/safeStorage';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isRecord } from '@/lib/utils';
import type { PersistOptions } from 'zustand/middleware';

const ADD_PROVIDER_SENTINEL = "__add_provider__";

const sanitizePersistedSelectedProviderId = (providerId: string | undefined): string => (
    providerId === ADD_PROVIDER_SENTINEL ? "" : (providerId ?? "")
);

const hasCompatibleCachedVariants = (providers: ProviderWithModelList[] | undefined): boolean => (
    Array.isArray(providers) && providers.every((provider) => (
        isRecord(provider)
        && Array.isArray(provider.models)
        && provider.models.every((model) => (
            isRecord(model)
            && Array.isArray(model.variants)
            && model.variants.every(isRecord)
        ))
    ))
);

const hydrateActiveDirectorySnapshot = <T extends Partial<ConfigStore>>(merged: T): T => {
    const directoryScoped = merged.directoryScoped;
    const activeKey = merged.activeDirectoryKey;
    if (!directoryScoped || !activeKey) return merged;
    const snapshot = directoryScoped[activeKey];
    if (!snapshot) return merged;

    const next: Partial<ConfigStore> = { ...merged };
    if ((!merged.providers || merged.providers.length === 0) && snapshot.providers?.length) {
        next.providers = snapshot.providers;
    }
    if ((!merged.agents || merged.agents.length === 0) && snapshot.agents?.length) {
        next.agents = snapshot.agents;
    }
    if (!merged.defaultProviders || Object.keys(merged.defaultProviders).length === 0) {
        if (snapshot.defaultProviders && Object.keys(snapshot.defaultProviders).length > 0) {
            next.defaultProviders = snapshot.defaultProviders;
        }
    }
    if (snapshot.opencodeDefaultAgent !== undefined) {
        next.opencodeDefaultAgent = snapshot.opencodeDefaultAgent;
    }
    if (snapshot.opencodeDefaultModel !== undefined) {
        next.opencodeDefaultModel = snapshot.opencodeDefaultModel;
    }
    if (snapshot.selectionSource) {
        next.selectionSource = snapshot.selectionSource;
    }
    if (snapshot.agentSelectionSource) {
        next.agentSelectionSource = snapshot.agentSelectionSource;
    }
    return next as T;
};

const toPersistedDirectorySnapshot = (snapshot: DirectoryScopedConfig) => {
    const { providers: _providers, agents: _agents, providersLoaded: _providersLoaded, agentsLoaded: _agentsLoaded, ...selection } = snapshot;
    void _providers;
    void _agents;
    void _providersLoaded;
    void _agentsLoaded;
    return {
        ...selection,
        selectedProviderId: sanitizePersistedSelectedProviderId(snapshot.selectedProviderId),
    };
};

const partializeConfig = (state: ConfigStore) => ({
    configRuntimeKey: state.configRuntimeKey,
    activeDirectoryKey: state.activeDirectoryKey,
    directoryScoped: Object.fromEntries(
        Object.entries(state.directoryScoped).map(([directoryKey, snapshot]) => [
            directoryKey,
            toPersistedDirectorySnapshot(snapshot),
        ]),
    ),
    currentProviderId: state.currentProviderId,
    currentModelId: state.currentModelId,
    currentVariant: state.currentVariant,
    currentVariantSelection: state.currentVariantSelection,
    currentAgentName: state.currentAgentName,
    selectedProviderId: sanitizePersistedSelectedProviderId(state.selectedProviderId),
    agentModelSelections: state.agentModelSelections,
    defaultProviders: state.defaultProviders,
    settingsDefaultModel: state.settingsDefaultModel,
    settingsDefaultVariant: state.settingsDefaultVariant,
    settingsDefaultAgent: state.settingsDefaultAgent,
    settingsAutoCreateWorktree: state.settingsAutoCreateWorktree,
    settingsGitmojiEnabled: state.settingsGitmojiEnabled,
    settingsDefaultFileViewerPreview: state.settingsDefaultFileViewerPreview,
    settingsZenModel: state.settingsZenModel,
    settingsMessageStreamTransport: state.settingsMessageStreamTransport,
    dictationEnabled: state.dictationEnabled,
    dictationAutoSend: state.dictationAutoSend,
    speechRate: state.speechRate,
    speechPitch: state.speechPitch,
    speechVolume: state.speechVolume,
});

export const configPersistence = {
    name: "config-store",
    storage: createDeferredSafeJSONStorage(),
    version: 1,
    // SAFETY: a version-0 blob is the same shape plus catalogs, and
    // merge() is the one place that validates any persisted state.
    migrate: (persistedState) => persistedState as ConfigStore,
    merge: (persistedState, currentState) => {
        // SAFETY: Zustand's storage boundary supplies an unknown
        // partial store. Only an explicitly matching runtime may hydrate it.
        const persisted = persistedState as Partial<ConfigStore> | undefined;
        if (!persisted || persisted.configRuntimeKey !== getRuntimeKey()) return currentState;

        const storedScopes = isRecord(persisted.directoryScoped) && !Array.isArray(persisted.directoryScoped)
            ? persisted.directoryScoped
            : currentState.directoryScoped;
        const directoryScoped = { ...storedScopes };
        for (const [directory, snapshot] of Object.entries(directoryScoped)) {
            if (!isRecord(snapshot)) {
                delete directoryScoped[directory];
            } else if (snapshot.providers === undefined) {
                directoryScoped[directory] = { ...snapshot, providers: [], agents: snapshot.agents ?? [] };
            } else if (!hasCompatibleCachedVariants(snapshot.providers)) {
                directoryScoped[directory] = {
                    ...snapshot, providers: [], providersLoaded: false, defaultProviders: {},
                    agents: snapshot.agents ?? [],
                };
            }
        }

        const merged = { ...currentState, ...persisted, directoryScoped };
        if (persisted.providers !== undefined && !hasCompatibleCachedVariants(persisted.providers)) {
            merged.providers = currentState.providers;
            merged.providersLoaded = currentState.providersLoaded;
            merged.defaultProviders = currentState.defaultProviders;
        }
        return hydrateActiveDirectorySnapshot(merged);
    },
    partialize: partializeConfig,
} satisfies PersistOptions<ConfigStore, ReturnType<typeof partializeConfig>>;

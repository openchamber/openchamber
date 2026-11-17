import { type ConfigSlice, type DirectoryScopedConfig, type ConfigStore } from './types';
import { captureConfigRuntimeContext, isConfigRuntimeContextCurrent } from './runtime';
import { fromDirectoryKey, normalizeConfigPath as resolveConfigDirectory, toDirectoryKey } from './directories';
import { getProjectDefaultsForConfigDirectory } from './projectDefaults';
import { markStartupTrace, measureStartupTrace } from '@/lib/startupTrace';
import { opencodeClient } from '@/lib/opencode/client';
import {
    catalogLifecycle,
    markCatalogLoaded,
    _agentsLoadedAt,
    _agentsStaleAt,
    persistLoadedCatalog,
} from './catalogLifecycle';
import { getConfigLoadKey, _inFlightAgents, _agentsLoadGeneration } from './catalogRequests';
import { clearProjectConfigError, _agentsLoadErrors } from './projectErrors';
import { getSyncConfig } from '@/sync/sync-refs';
import {
    normalizeOptionalString,
    resolveGitGenerationModelSelection,
    resolveDefaultAgentModelSelection,
    readFallbackModelPrefs,
    resolveSelectionWithManualGuard,
    variantAfterResolve,
} from './selectionResolution';
import { configModelIdentifier } from '@/lib/opencode/projection';
import { updateDesktopSettings } from '@/lib/persistence';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { hasLiveCatalog } from './directorySnapshots';
import { readProjectConfigError, isSameProjectConfigError } from '@/lib/opencode/configError';
import { isLocationNotFoundError } from '@/lib/opencode/location-errors';

export const createAgentCatalog: ConfigSlice<'loadAgents'> = (set, get) => ({
    loadAgents: async (options) => {
        const runtimeContext = captureConfigRuntimeContext();
        const requestedDirectory = options?.directory ?? fromDirectoryKey(get().activeDirectoryKey);
        const configDirectory = resolveConfigDirectory(requestedDirectory);
        if (!configDirectory) {
            markStartupTrace('loadAgents:skippedUnknownDirectory', { requestedDirectory, source: options?.source ?? 'unknown' });
            return false;
        }
        const effectiveDirectory = configDirectory ?? opencodeClient.getDirectory() ?? null;
        const directoryKey = toDirectoryKey(configDirectory);
        const inFlightKey = getConfigLoadKey(runtimeContext, directoryKey);
        const source = options?.source ?? 'unknown';
        const entryCatalogEpoch = catalogLifecycle.loadEpoch;
        markStartupTrace('loadAgents:called', { directoryKey, source, requestedDirectory, effectiveDirectory });

        let existing = _inFlightAgents.get(inFlightKey);
        if (existing && options?.fresh) {
            await existing.catch(() => false);
            existing = _inFlightAgents.get(inFlightKey);
        }
        if (existing) {
            markStartupTrace('loadAgents:deduped', { directoryKey, source, requestedDirectory, effectiveDirectory });
            const joinedGeneration = _agentsLoadGeneration.get(inFlightKey) ?? 0;
            const loaded = await existing;
            if (!isConfigRuntimeContextCurrent(runtimeContext)) return false;
            if (catalogLifecycle.loadEpoch !== entryCatalogEpoch
                || (_agentsLoadGeneration.get(inFlightKey) ?? 0) !== joinedGeneration) {
                return get().loadAgents({ directory: configDirectory, source });
            }
            return loaded;
        }

        const catalogEpoch = catalogLifecycle.loadEpoch;
        const loadGeneration = _agentsLoadGeneration.get(inFlightKey) ?? 0;
        const isCurrentAgentLoad = () => (
            isConfigRuntimeContextCurrent(runtimeContext)
            && catalogLifecycle.loadEpoch === catalogEpoch
            && (_agentsLoadGeneration.get(inFlightKey) ?? 0) === loadGeneration
        );
        const promise = (async (): Promise<boolean> => {
        if (!isCurrentAgentLoad()) return false;
        const loadRevision = catalogLifecycle.revision;
        const loaderStarted = typeof performance !== 'undefined' ? performance.now() : Date.now();
        markStartupTrace('loadAgents:start', { directoryKey, source, requestedDirectory, effectiveDirectory });
        const existingSnapshot = get().directoryScoped[directoryKey];
        const previousAgents = existingSnapshot?.agents ?? (get().activeDirectoryKey === directoryKey ? get().agents : []);
        let lastError: unknown = null;

        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const configDirectoryPath = fromDirectoryKey(directoryKey);
                const initialSyncedOpencodeConfig = getSyncConfig(requestedDirectory ?? undefined)
                    ?? getSyncConfig(configDirectoryPath ?? undefined);
                if (initialSyncedOpencodeConfig) {
                    markStartupTrace('loadAgents:syncConfigHit', { directoryKey, source });
                }
                const [agents, defaultsLoaded] = await Promise.all([
                    measureStartupTrace(
                        'loadAgents:api',
                        () => opencodeClient.listAgents(configDirectoryPath),
                        { directoryKey, source, requestedDirectory, effectiveDirectory, attempt: attempt + 1 },
                    ),
                    get().loadSessionDefaults(),
                ]);

                if (!isCurrentAgentLoad()) return false;
                if (!defaultsLoaded && !get().settingsDefaultsLoaded) {
                    throw new Error('Session defaults are not available yet');
                }
                const safeAgents = Array.isArray(agents) ? agents : [];
                const latestSyncedOpencodeConfig = getSyncConfig(requestedDirectory ?? undefined)
                    ?? getSyncConfig(configDirectoryPath ?? undefined);
                const hasLatestSyncedOpencodeConfig = latestSyncedOpencodeConfig !== undefined;
                const latestSyncedOpencodeDefaultAgent = hasLatestSyncedOpencodeConfig
                    ? normalizeOptionalString(latestSyncedOpencodeConfig.default_agent)
                    : undefined;
                const latestSyncedOpencodeDefaultModel = hasLatestSyncedOpencodeConfig
                    ? configModelIdentifier(latestSyncedOpencodeConfig.model)
                    : undefined;

                const providers = get().activeDirectoryKey === directoryKey
                    ? get().providers
                    : (get().directoryScoped[directoryKey]?.providers ?? []);

                const defaultZenModel = normalizeOptionalString(get().settingsZenModel);
                const resolvedGitSelection = resolveGitGenerationModelSelection({
                    providers,
                    settingsZenModel: defaultZenModel,
                });
                const resolvedZenModel = resolvedGitSelection?.modelId || defaultZenModel;

                if (!isCurrentAgentLoad()) return false;
                set((state) => {
                    if (!isCurrentAgentLoad()) return state;
                    const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                        providers,
                        agents: previousAgents,
                        currentProviderId: "",
                        currentModelId: "",
                        currentAgentName: undefined,
                        selectedProviderId: "",
                        agentModelSelections: {},
                        defaultProviders: {},
                    };
                    const opencodeDefaultAgent = hasLatestSyncedOpencodeConfig
                        ? latestSyncedOpencodeDefaultAgent
                        : baseSnapshot.opencodeDefaultAgent ?? (state.activeDirectoryKey === directoryKey ? state.opencodeDefaultAgent : undefined);
                    const opencodeDefaultModel = hasLatestSyncedOpencodeConfig
                        ? latestSyncedOpencodeDefaultModel
                        : baseSnapshot.opencodeDefaultModel ?? (state.activeDirectoryKey === directoryKey ? state.opencodeDefaultModel : undefined);

                    const nextSnapshot: DirectoryScopedConfig = {
                        ...baseSnapshot,
                        providers,
                        agents: safeAgents,
                        opencodeDefaultAgent,
                        opencodeDefaultModel,
                    };

                    const nextState: Partial<ConfigStore> = {
                        settingsZenModel: resolvedZenModel,
                        directoryScoped: {
                            ...state.directoryScoped,
                            [directoryKey]: nextSnapshot,
                        },
                    };

                    if (state.activeDirectoryKey === directoryKey) {
                        nextState.agents = safeAgents;
                        nextState.opencodeDefaultAgent = opencodeDefaultAgent;
                        nextState.opencodeDefaultModel = opencodeDefaultModel;
                    }

                    return nextState;
                });

                const latestConfigState = get();
                const latestSnapshot = latestConfigState.directoryScoped[directoryKey];
                const opencodeDefaultAgent = latestSnapshot?.opencodeDefaultAgent
                    ?? (latestConfigState.activeDirectoryKey === directoryKey ? latestConfigState.opencodeDefaultAgent : undefined);
                const opencodeDefaultModel = latestSnapshot?.opencodeDefaultModel
                    ?? (latestConfigState.activeDirectoryKey === directoryKey ? latestConfigState.opencodeDefaultModel : undefined);

                const shouldPersistResolvedZenModel =
                    !!resolvedZenModel &&
                    resolvedZenModel !== defaultZenModel;

                if (shouldPersistResolvedZenModel && resolvedZenModel) {
                    updateDesktopSettings({
                        zenModel: resolvedZenModel,
                    }).catch(() => {
                    });
                }

                if (safeAgents.length === 0) {
                    if (
                        get().activeDirectoryKey === directoryKey
                        && !useSessionUIStore.getState().currentSessionId
                        && get().selectionSource === 'auto'
                        && get().agentSelectionSource === 'auto'
                        && get().currentVariantSelection.override === undefined
                    ) {
                        get().applyDefaultModelAgentSelection(getProjectDefaultsForConfigDirectory(fromDirectoryKey(directoryKey)));
                    }
                    if (!isCurrentAgentLoad()) return false;
                    set((state) => {
                        if (!isCurrentAgentLoad()) return state;
                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers,
                            agents: [],
                currentProviderId: "",
                currentModelId: "",
                currentVariant: undefined,
                currentAgentName: undefined,
                            selectedProviderId: "",
                            agentModelSelections: {},
                            defaultProviders: {},
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            providers,
                            agents: [],
                            currentAgentName: undefined,
                            agentsLoaded: true,
                        };

                        const nextState: Partial<ConfigStore> = {
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };

                        if (state.activeDirectoryKey === directoryKey) {
                            nextState.currentAgentName = undefined;
                            nextState.agentsLoaded = true;
                        }

                        return nextState;
                    });

                    const loaderEnded = typeof performance !== 'undefined' ? performance.now() : Date.now();
                    markStartupTrace('loadAgents:end', {
                        directoryKey,
                        source,
                        requestedDirectory,
                        effectiveDirectory,
                        durationMs: Math.round(loaderEnded - loaderStarted),
                        agents: safeAgents.length,
                    });
                    markCatalogLoaded(_agentsLoadedAt, _agentsStaleAt, directoryKey, loadRevision);
                    persistLoadedCatalog(runtimeContext, directoryKey, { agents: safeAgents }, _agentsStaleAt, loadRevision);
                    clearProjectConfigError(directoryKey);
                    return true;
                }

                const resolvedDefault = resolveDefaultAgentModelSelection({
                    agents: safeAgents,
                    providers,
                    catalogLoaded: hasLiveCatalog(get(), directoryKey),
                    ...getProjectDefaultsForConfigDirectory(configDirectoryPath),
                    settingsDefaultAgent: get().settingsDefaultAgent,
                    settingsDefaultModel: get().settingsDefaultModel,
                    settingsDefaultVariant: get().settingsDefaultVariant,
                    opencodeDefaultAgent,
                    opencodeDefaultModel,
                    allowFallback: get().settingsDefaultsLoaded,
                    fallbackPrefs: readFallbackModelPrefs(get().settingsDefaultsLoaded),
                });
                const resolvedAgentName = resolvedDefault.agentName ?? safeAgents[0].name;
                const resolvedProviderId = resolvedDefault.providerId;
                const resolvedModelId = resolvedDefault.modelId;
                const resolvedVariant = resolvedDefault.variant;

                if (!isCurrentAgentLoad()) return false;
                set((state) => {
                    if (!isCurrentAgentLoad()) return state;
                    const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                        providers,
                        agents: safeAgents,
                        currentProviderId: "",
                        currentModelId: "",
                        currentAgentName: undefined,
                        selectedProviderId: "",
                        agentModelSelections: {},
                        defaultProviders: {},
                    };
                    const isActive = state.activeDirectoryKey === directoryKey;
                    const currentAgentName = isActive ? state.currentAgentName : baseSnapshot.currentAgentName;
                    const currentProviderId = isActive ? state.currentProviderId : baseSnapshot.currentProviderId;
                    const currentModelId = isActive ? state.currentModelId : baseSnapshot.currentModelId;
                    const currentVariant = isActive ? state.currentVariant : baseSnapshot.currentVariant;
                    const selectionSource = isActive ? state.selectionSource : (baseSnapshot.selectionSource ?? "auto");
                    const agentSelectionSource = isActive ? state.agentSelectionSource : (baseSnapshot.agentSelectionSource ?? "auto");
                    const nextSelection = resolveSelectionWithManualGuard({
                        currentAgentName,
                        currentProviderId,
                        currentModelId,
                        currentVariant,
                        selectionSource,
                        agentSelectionSource,
                        resolvedAgentName,
                        resolvedProviderId,
                        resolvedModelId,
                        resolvedVariant,
                    });

                    const heldVariantSelection = isActive ? state.currentVariantSelection : baseSnapshot.currentVariantSelection;
                    const nextVariant = variantAfterResolve(heldVariantSelection, nextSelection.variant);
                    const nextSnapshot: DirectoryScopedConfig = {
                        ...baseSnapshot,
                        providers,
                        agents: safeAgents,
                        currentAgentName: nextSelection.agentName,
                        agentsLoaded: true,
                        currentProviderId: nextSelection.providerId ?? baseSnapshot.currentProviderId,
                        currentModelId: nextSelection.modelId ?? baseSnapshot.currentModelId,
                        currentVariant: nextVariant,
                        currentVariantSelection: nextSelection.selectionSource === 'manual'
                            || heldVariantSelection?.override !== undefined
                            ? heldVariantSelection
                            : { override: undefined, inherited: nextSelection.variant },
                        opencodeDefaultAgent,
                        opencodeDefaultModel,
                        selectionSource: nextSelection.selectionSource,
                    };

                    const nextState: Partial<ConfigStore> = {
                        directoryScoped: {
                            ...state.directoryScoped,
                            [directoryKey]: nextSnapshot,
                        },
                    };

                    if (isActive) {
                        nextState.agentsLoaded = true;
                        nextState.currentAgentName = nextSelection.agentName;
                        nextState.opencodeDefaultAgent = opencodeDefaultAgent;
                        nextState.opencodeDefaultModel = opencodeDefaultModel;
                        if (nextSelection.providerId && nextSelection.modelId) {
                            nextState.currentProviderId = nextSelection.providerId;
                            nextState.currentModelId = nextSelection.modelId;
                            nextState.currentVariant = nextVariant;
                            nextState.currentVariantSelection = nextSnapshot.currentVariantSelection ?? { override: undefined, inherited: nextSelection.variant };
                        }
                        nextState.selectionSource = nextSelection.selectionSource;
                    }

                    return nextState;
                });

                const loaderEnded = typeof performance !== 'undefined' ? performance.now() : Date.now();
                markStartupTrace('loadAgents:end', {
                    directoryKey,
                    source,
                    requestedDirectory,
                    effectiveDirectory,
                    durationMs: Math.round(loaderEnded - loaderStarted),
                    agents: safeAgents.length,
                });
                markCatalogLoaded(_agentsLoadedAt, _agentsStaleAt, directoryKey, loadRevision);
                persistLoadedCatalog(runtimeContext, directoryKey, { agents: safeAgents }, _agentsStaleAt, loadRevision);
                _agentsLoadErrors.delete(directoryKey);
                clearProjectConfigError(directoryKey);
                return true;
            } catch (error) {
                lastError = error;
                markStartupTrace('loadAgents:attemptError', {
                    directoryKey,
                    source,
                    requestedDirectory,
                    effectiveDirectory,
                    attempt: attempt + 1,
                    error: error instanceof Error ? error.message : String(error),
                });
                if (readProjectConfigError(error) || (error instanceof Error && isLocationNotFoundError(error))) break;
                const waitMs = 200 * (attempt + 1);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
                if (!isCurrentAgentLoad()) return false;
            }
        }

        if (!isCurrentAgentLoad()) return false;
        console.error("Failed to load agents:", lastError);
        _agentsLoadErrors.set(directoryKey, lastError instanceof Error ? lastError : new Error(String(lastError ?? '')));
        const configError = readProjectConfigError(lastError);
        if (configError && !isSameProjectConfigError(get().projectConfigErrors[directoryKey], configError)) {
            set((state) => ({ projectConfigErrors: { ...state.projectConfigErrors, [directoryKey]: configError } }));
        }
        markStartupTrace('loadAgents:error', {
            directoryKey,
            source,
            requestedDirectory,
            effectiveDirectory,
            error: lastError instanceof Error ? lastError.message : String(lastError),
        });

        if (!isCurrentAgentLoad()) return false;
        set((state) => {
            if (!isCurrentAgentLoad()) return state;
            const providers = state.activeDirectoryKey === directoryKey
                ? state.providers
                : (state.directoryScoped[directoryKey]?.providers ?? []);

            const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                providers,
                agents: [],
                currentProviderId: "",
                currentModelId: "",
                currentAgentName: undefined,
                selectedProviderId: "",
                agentModelSelections: {},
                defaultProviders: {},
            };

            const nextSnapshot: DirectoryScopedConfig = {
                ...baseSnapshot,
                providers,
                agents: previousAgents,
            };

            const nextState: Partial<ConfigStore> = {
                directoryScoped: {
                    ...state.directoryScoped,
                    [directoryKey]: nextSnapshot,
                },
            };

            if (state.activeDirectoryKey === directoryKey) {
                nextState.agents = previousAgents;
            }

            return nextState;
        });

        return false;
        })();

        _inFlightAgents.set(inFlightKey, promise);
        let loaded: boolean;
        try {
            loaded = await promise;
        } finally {
            if (_inFlightAgents.get(inFlightKey) === promise) {
                _inFlightAgents.delete(inFlightKey);
            }
        }
        if (isConfigRuntimeContextCurrent(runtimeContext)
            && (_agentsLoadGeneration.get(inFlightKey) ?? 0) !== loadGeneration) {
            return get().loadAgents({ directory: configDirectory, source });
        }
        return loaded;
    },
});

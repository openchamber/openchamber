import { type ConfigSlice, type ConfigStore, type DirectoryScopedConfig, type ProviderModel, type ProviderWithModelList } from './types';
import { toDirectoryKey, fromDirectoryKey, normalizeConfigPath as resolveConfigDirectory } from './directories';
import { getProjectDefaultsForConfigDirectory } from './projectDefaults';
import { captureConfigRuntimeContext, isConfigRuntimeContextCurrent } from './runtime';
import { markStartupTrace, measureStartupTrace } from '@/lib/startupTrace';
import { opencodeClient } from '@/lib/opencode/client';
import {
    catalogLifecycle,
    markCatalogLoaded,
    _providersLoadedAt,
    _providersStaleAt,
    persistLoadedCatalog,
} from './catalogLifecycle';
import { getConfigLoadKey, _inFlightProviders } from './catalogRequests';
import { useConfigStore } from '../useConfigStore';
import { ensureModelsMetadataFetch } from './metadata';
import { EMPTY_PROVIDERS } from './selectors';
import { resolveProviderModelSelection, inheritedDefaultsFor, readFallbackModelPrefs, parseModelString, modelHasVariant, variantAfterResolve } from './selectionResolution';
import { findCatalogModel } from '@/lib/opencode/model';

const PROVIDERS_RETRY_SOURCE = "loadProviders:retryAfterFailure";
const PROVIDERS_RETRY_DELAY_MS = 3000;
const PROVIDER_CONFIG_REFRESH_CONCURRENCY = 4;

const isSameProviderCatalog = (previous: ProviderWithModelList[], next: ProviderWithModelList[]): boolean => {
    if (previous === next) return true;
    if (previous.length !== next.length) return false;
    return JSON.stringify(previous) === JSON.stringify(next);
};

const isSameDefaults = (previous: { [key: string]: string }, next: { [key: string]: string }): boolean => {
    const previousKeys = Object.keys(previous);
    const nextKeys = Object.keys(next);
    if (previousKeys.length !== nextKeys.length) return false;
    return previousKeys.every((key) => previous[key] === next[key]);
};

export const refreshKnownProviderDirectories = async (source: string): Promise<void> => {
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

export const createProviderCatalog: ConfigSlice<'invalidateProviderCache' | 'loadProviders'> = (set, get) => ({
    invalidateProviderCache: (directory) => {
        const targetDirectoryKey = directory === undefined ? null : toDirectoryKey(directory);

        set((state) => {
            const nextState: Partial<ConfigStore> = {};
            let scopedChanged = false;
            const nextDirectoryScoped: Record<string, DirectoryScopedConfig> = {
                ...state.directoryScoped,
            };

            const clearSnapshot = (snapshot: DirectoryScopedConfig): DirectoryScopedConfig => {
                if (!snapshot.providersLoaded && snapshot.providers.length === 0 && Object.keys(snapshot.defaultProviders).length === 0) {
                    return snapshot;
                }

                scopedChanged = true;
                return {
                    ...snapshot,
                    providers: [],
                    providersLoaded: false,
                    defaultProviders: {},
                };
            };

            if (targetDirectoryKey) {
                const snapshot = state.directoryScoped[targetDirectoryKey];
                if (snapshot) {
                    nextDirectoryScoped[targetDirectoryKey] = clearSnapshot(snapshot);
                }
            } else {
                for (const [directoryKey, snapshot] of Object.entries(state.directoryScoped)) {
                    nextDirectoryScoped[directoryKey] = clearSnapshot(snapshot);
                }
            }

            if (scopedChanged) {
                nextState.directoryScoped = nextDirectoryScoped;
            }

            if (targetDirectoryKey === null) {
                if (Object.keys(state.settingsOnlyProviders).length > 0) nextState.settingsOnlyProviders = {};
            } else if (state.settingsOnlyProviders[targetDirectoryKey]) {
                const { [targetDirectoryKey]: _cleared, ...settingsOnlyProviders } = state.settingsOnlyProviders;
                void _cleared;
                nextState.settingsOnlyProviders = settingsOnlyProviders;
            }

            if (targetDirectoryKey === null || targetDirectoryKey === state.activeDirectoryKey) {
                nextState.providersLoaded = false;
                if (state.providers.length > 0) {
                    nextState.providers = [];
                }
                if (Object.keys(state.defaultProviders).length > 0) {
                    nextState.defaultProviders = {};
                }
            }

            return Object.keys(nextState).length > 0 ? nextState : state;
        });
    },

    loadProviders: async (options) => {
        const runtimeContext = captureConfigRuntimeContext();
        const requestedDirectory = options?.directory ?? fromDirectoryKey(get().activeDirectoryKey);
        const configDirectory = resolveConfigDirectory(requestedDirectory);
        if (!configDirectory) {
            markStartupTrace('loadProviders:skippedUnknownDirectory', { requestedDirectory, source: options?.source ?? 'unknown' });
            return;
        }
        const effectiveDirectory = configDirectory ?? opencodeClient.getDirectory() ?? null;
        const directoryKey = toDirectoryKey(configDirectory);
        const inFlightKey = getConfigLoadKey(runtimeContext, directoryKey);
        const source = options?.source ?? 'unknown';
        markStartupTrace('loadProviders:called', { directoryKey, source, requestedDirectory, effectiveDirectory });

        let existing = _inFlightProviders.get(inFlightKey);
        if (existing && options?.fresh) {
            await existing.catch(() => undefined);
            existing = _inFlightProviders.get(inFlightKey);
        }
        if (existing) {
            markStartupTrace('loadProviders:deduped', { directoryKey, source, requestedDirectory, effectiveDirectory });
            return existing;
        }

        const catalogEpoch = catalogLifecycle.loadEpoch;
        const isCurrentProviderLoad = () => (
            isConfigRuntimeContextCurrent(runtimeContext)
            && catalogLifecycle.loadEpoch === catalogEpoch
        );

        const promise: Promise<void> = (async () => {
        if (!isCurrentProviderLoad()) return;
        const loadRevision = catalogLifecycle.revision;
        const loaderStarted = typeof performance !== 'undefined' ? performance.now() : Date.now();
        markStartupTrace('loadProviders:start', { directoryKey, source, requestedDirectory, effectiveDirectory });
        const existingSnapshot = get().directoryScoped[directoryKey];
        const previousProviders = existingSnapshot?.providers ?? (get().activeDirectoryKey === directoryKey ? get().providers : []);
        const previousDefaults = existingSnapshot?.defaultProviders ?? (get().activeDirectoryKey === directoryKey ? get().defaultProviders : {});
        let lastError: unknown = null;

        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                ensureModelsMetadataFetch(
                    () => get().modelsMetadata,
                    (metadata) => {
                        if (isConfigRuntimeContextCurrent(runtimeContext)) {
                            set({ modelsMetadata: metadata });
                        }
                    },
                );
                const apiResult = await measureStartupTrace(
                    'loadProviders:api',
                    () => opencodeClient.getProvidersForConfig(fromDirectoryKey(directoryKey), { fresh: options?.fresh }),
                    { directoryKey, source, requestedDirectory, effectiveDirectory, attempt: attempt + 1 },
                );
                if (!isCurrentProviderLoad()) return;
                const providers = Array.isArray(apiResult?.providers) ? apiResult.providers : [];
                const catalogModels = Array.isArray(apiResult?.models) ? apiResult.models : [];
                const defaults: { [key: string]: string } = apiResult?.default
                    ? { [apiResult.default.providerID]: apiResult.default.id }
                    : {};

                const modelsByProvider = new Map<string, ProviderModel[]>();
                const imageModelsByProvider = new Map<string, ProviderModel[]>();
                for (const model of catalogModels) {
                    if (!model.enabled) continue;
                    const byProvider = model.type === "image" ? imageModelsByProvider : modelsByProvider;
                    const bucket = byProvider.get(model.providerID);
                    if (bucket) bucket.push(model);
                    else byProvider.set(model.providerID, [model]);
                }
                const processedProviders: ProviderWithModelList[] = providers
                    .filter((provider) => provider.activation !== "disabled" && modelsByProvider.has(provider.id))
                    .map((provider) => ({
                        ...provider,
                        models: modelsByProvider.get(provider.id) ?? [],
                    }));
                const settingsOnlyProviders: ProviderWithModelList[] = providers
                    .filter((provider) => provider.activation !== "disabled"
                        && !modelsByProvider.has(provider.id))
                    .map((provider) => ({
                        ...provider,
                        models: imageModelsByProvider.get(provider.id) ?? [],
                    }));

                if (!isCurrentProviderLoad()) return;
                set((state) => {
                    const previous = state.settingsOnlyProviders[directoryKey] ?? EMPTY_PROVIDERS;
                    return isSameProviderCatalog(previous, settingsOnlyProviders)
                        ? state
                        : { settingsOnlyProviders: { ...state.settingsOnlyProviders, [directoryKey]: settingsOnlyProviders } };
                });
                const nextProviders = isSameProviderCatalog(previousProviders, processedProviders)
                    ? previousProviders
                    : processedProviders;
                const nextDefaults = isSameDefaults(previousDefaults, defaults) ? previousDefaults : defaults;
                set((state) => {
                    if (!isCurrentProviderLoad()) return state;
                    const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                        providers: [],
                        agents: [],
                        currentProviderId: "",
                        currentModelId: "",
                        currentAgentName: undefined,
                        selectedProviderId: "",
                        agentModelSelections: {},
                        defaultProviders: {},
                    };

                    const currentProviderId = state.activeDirectoryKey === directoryKey
                        ? state.currentProviderId
                        : baseSnapshot.currentProviderId;
                    const currentModelId = state.activeDirectoryKey === directoryKey
                        ? state.currentModelId
                        : baseSnapshot.currentModelId;
                    const currentVariant = state.activeDirectoryKey === directoryKey
                        ? state.currentVariant
                        : baseSnapshot.currentVariant;
                    const projectDefaults = getProjectDefaultsForConfigDirectory(fromDirectoryKey(directoryKey));
                    const isActive = state.activeDirectoryKey === directoryKey;
                    const resolvedModel = resolveProviderModelSelection({
                        providers: nextProviders,
                        catalogLoaded: true,
                        currentProviderId,
                        currentModelId,
                        currentVariant,
                        preserveCurrent: (isActive ? state.selectionSource : baseSnapshot.selectionSource) === 'manual',
                        configuredDefaults: [
                            { model: projectDefaults.projectDefaultModel, variant: projectDefaults.projectDefaultVariant },
                            { model: state.settingsDefaultModel, variant: state.settingsDefaultVariant },
                        ],
                        inheritedDefaults: inheritedDefaultsFor(
                            isActive ? state.agents : baseSnapshot.agents,
                            isActive ? state.currentAgentName : baseSnapshot.currentAgentName,
                            isActive ? state.opencodeDefaultModel : baseSnapshot.opencodeDefaultModel,
                        ),
                        allowFallback: state.settingsDefaultsLoaded,
                        fallbackPrefs: readFallbackModelPrefs(get().settingsDefaultsLoaded),
                    });
                    const currentSelectedProviderId = state.activeDirectoryKey === directoryKey
                        ? state.selectedProviderId
                        : baseSnapshot.selectedProviderId;
                    const selectedProviderId = currentSelectedProviderId
                        ? currentSelectedProviderId
                        : (resolvedModel?.providerId ?? nextProviders[0]?.id ?? "");

                    const heldVariantSelection = state.activeDirectoryKey === directoryKey
                        ? state.currentVariantSelection
                        : baseSnapshot.currentVariantSelection;
                    const pickedVariant = heldVariantSelection?.override;
                    const nextSnapshot: DirectoryScopedConfig = {
                        ...baseSnapshot,
                        providers: nextProviders,
                        providersLoaded: true,
                        defaultProviders: nextDefaults,
                        currentProviderId: resolvedModel?.providerId ?? "",
                        currentModelId: resolvedModel?.modelId ?? "",
                        currentVariant: variantAfterResolve(heldVariantSelection, resolvedModel?.variant),
                        currentVariantSelection: (state.activeDirectoryKey === directoryKey ? state.selectionSource : baseSnapshot.selectionSource) === 'manual'
                            || pickedVariant !== undefined
                            ? heldVariantSelection
                            : { override: undefined, inherited: resolvedModel?.variant },
                        selectedProviderId,
                    };

                    if (
                        baseSnapshot.providers === nextSnapshot.providers
                        && baseSnapshot.providersLoaded === true
                        && baseSnapshot.defaultProviders === nextSnapshot.defaultProviders
                        && baseSnapshot.currentProviderId === nextSnapshot.currentProviderId
                        && baseSnapshot.currentModelId === nextSnapshot.currentModelId
                        && baseSnapshot.currentVariant === nextSnapshot.currentVariant
                        && baseSnapshot.selectedProviderId === nextSnapshot.selectedProviderId
                        && (state.activeDirectoryKey !== directoryKey || (
                            state.providers === nextSnapshot.providers
                            && state.providersLoaded
                            && state.defaultProviders === nextSnapshot.defaultProviders
                            && state.currentProviderId === nextSnapshot.currentProviderId
                            && state.currentModelId === nextSnapshot.currentModelId
                            && state.currentVariant === nextSnapshot.currentVariant
                            && state.selectedProviderId === nextSnapshot.selectedProviderId
                        ))
                    ) {
                        return state;
                    }

                    const nextState: Partial<ConfigStore> = {
                        directoryScoped: {
                            ...state.directoryScoped,
                            [directoryKey]: nextSnapshot,
                        },
                    };

                    if (state.activeDirectoryKey === directoryKey) {
                        nextState.providers = nextProviders;
                        nextState.providersLoaded = true;
                        nextState.defaultProviders = nextDefaults;
                        nextState.currentProviderId = nextSnapshot.currentProviderId;
                        nextState.currentModelId = nextSnapshot.currentModelId;
                        nextState.currentVariant = nextSnapshot.currentVariant;
                        nextState.currentVariantSelection = nextSnapshot.currentVariantSelection ?? { override: undefined, inherited: nextSnapshot.currentVariant };
                        nextState.selectedProviderId = selectedProviderId;
                    }

                    return nextState;
                });

                if (!isCurrentProviderLoad()) return;
                const loaderEnded = typeof performance !== 'undefined' ? performance.now() : Date.now();
                markStartupTrace('loadProviders:end', {
                    directoryKey,
                    source,
                    requestedDirectory,
                    effectiveDirectory,
                    durationMs: Math.round(loaderEnded - loaderStarted),
                    providers: processedProviders.length,
                    models: processedProviders.reduce((count, provider) => count + provider.models.length, 0),
                });
                markCatalogLoaded(_providersLoadedAt, _providersStaleAt, directoryKey, loadRevision);
                if (nextProviders !== previousProviders || nextDefaults !== previousDefaults) {
                    persistLoadedCatalog(runtimeContext, directoryKey, { providers: nextProviders, defaultProviders: nextDefaults }, _providersStaleAt, loadRevision);
                }
                return;
            } catch (error) {
                lastError = error;
                markStartupTrace('loadProviders:attemptError', {
                    directoryKey,
                    source,
                    requestedDirectory,
                    effectiveDirectory,
                    attempt: attempt + 1,
                    error: error instanceof Error ? error.message : String(error),
                });
                const waitMs = 200 * (attempt + 1);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
                if (!isCurrentProviderLoad()) return;
            }
        }

        if (!isCurrentProviderLoad()) return;
        console.error("Failed to load providers:", lastError);
        markStartupTrace('loadProviders:error', {
            directoryKey,
            source,
            requestedDirectory,
            effectiveDirectory,
            error: lastError instanceof Error ? lastError.message : String(lastError),
        });

        if (!isCurrentProviderLoad()) return;
        set((state) => {
            if (!isCurrentProviderLoad()) return state;
            const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                providers: [],
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
                providers: previousProviders,
                defaultProviders: previousDefaults,
            };

            const nextState: Partial<ConfigStore> = {
                directoryScoped: {
                    ...state.directoryScoped,
                    [directoryKey]: nextSnapshot,
                },
            };

            if (state.activeDirectoryKey === directoryKey) {
                nextState.providers = previousProviders;
                nextState.defaultProviders = previousDefaults;

                if (!state.currentProviderId && !state.currentModelId && state.settingsDefaultModel) {
                    const parsed = parseModelString(state.settingsDefaultModel);
                    if (parsed) {
                        const settingsProvider = previousProviders.find((p) => p.id === parsed.providerId);
                        const model = findCatalogModel(settingsProvider?.models, parsed.modelId);
                        if (model) {
                            const currentVariant = modelHasVariant(model, state.settingsDefaultVariant)
                                ? state.settingsDefaultVariant
                                : undefined;

                            nextState.currentProviderId = parsed.providerId;
                            nextState.currentModelId = parsed.modelId;
                            nextState.currentVariant = currentVariant;

                            nextSnapshot.currentProviderId = parsed.providerId;
                            nextSnapshot.currentModelId = parsed.modelId;
                            nextSnapshot.currentVariant = currentVariant;

                            if (!state.selectedProviderId) {
                                nextState.selectedProviderId = parsed.providerId;
                                nextSnapshot.selectedProviderId = parsed.providerId;
                            }
                        }
                    }
                }
            }

            return nextState;
        });

        if (source !== PROVIDERS_RETRY_SOURCE && !get().directoryScoped[directoryKey]?.providersLoaded) {
            setTimeout(() => {
                if (!isCurrentProviderLoad()) return;
                const state = get();
                if (state.activeDirectoryKey !== directoryKey || state.directoryScoped[directoryKey]?.providersLoaded) return;
                void state.loadProviders({ directory: fromDirectoryKey(directoryKey), source: PROVIDERS_RETRY_SOURCE });
            }, PROVIDERS_RETRY_DELAY_MS);
        }
        })().finally(() => {
            if (_inFlightProviders.get(inFlightKey) === promise) _inFlightProviders.delete(inFlightKey);
        });

        _inFlightProviders.set(inFlightKey, promise);
        return promise;
    },
});

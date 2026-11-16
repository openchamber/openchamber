import { create } from "zustand";
import { listModelVariantIds, modelVariantNames, nextThinkingVariant } from "@/lib/modelVariants";
import { AUTO_MODEL_ID, AUTO_PROVIDER_ID, isAutoModel } from '@/lib/routing/autoModel';
import { selectAutoReady, useRoutingStore } from '@/stores/useRoutingStore';
import { notifyAutoUnavailable } from '@/lib/routing/autoUnavailableNotice';
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { findCatalogModel, type Provider, type Model, type Agent, type Config } from "@/lib/opencode/model";
import type { DesktopSettings } from "@/lib/desktop";
import type { CatalogKind } from "@/lib/opencode/events";
import { OpencodeApiError, opencodeClient, type OpencodeHealthProbe } from "@/lib/opencode/client";
import { isOpenCodeTrustPending } from "@/lib/opencodeTrust";
import { isLocationNotFoundError } from "@/lib/opencode/location-errors";
import { isSameProjectConfigError, readProjectConfigError, type ProjectConfigError } from "@/lib/opencode/configError";
import { scopeMatches, subscribeToConfigChanges } from "@/lib/configSync";
import type { ModelMetadata } from "@/types";
import { createDeferredSafeJSONStorage, getSafeStorage } from "./utils/safeStorage";
import { filterVisibleAgents, isAgentHidden } from "./useAgentsStore";
import { isPrimaryMode } from "@/components/chat/mobileControlsUtils";
import { useSessionUIStore } from "@/sync/session-ui-store";
import { useSelectionStore } from "@/sync/selection-store";
import { useUIStore } from "@/stores/useUIStore";
import { loadDesktopSettings, updateDesktopSettings } from "@/lib/persistence";
import { useDirectoryStore } from "@/stores/useDirectoryStore";
import { useProjectsStore } from "@/stores/useProjectsStore";
import { resolveProjectForSessionDirectory } from "@/lib/projectResolution";
import { isSpaceDirectory } from "@/lib/spaces/space-route";
import { resolveChatsRootDirectory } from "@/lib/chatDirectories";
import { streamDebugEnabled } from "@/stores/utils/streamDebug";
import { parseModelIdentifier, parseModelSelection } from "@/lib/modelIdentifier";
import { readRememberedEffort, rememberEffort, resolveEffortChoice, type EffortChoice } from "@/lib/modelEfforts";
import type { ModelRef } from "@/lib/settings/parsers";
import { configModelIdentifier } from "@/lib/opencode/projection";
import { runtimeFetch } from "@/lib/runtime-fetch";
import { EMPTY_VOICE_API_KEYS, fetchVoiceApiKeys, migrateLegacyVoiceApiKeys, updateVoiceApiKeys, type VoiceApiKeyKind, type VoiceApiKeyState } from "@/lib/voiceKeysApi";
import { markStartupTrace, measureStartupTrace } from "@/lib/startupTrace";
import { normalizePath } from "@/lib/pathNormalization";
import { getSyncConfig, subscribeToSyncConfigChanges } from "@/sync/sync-refs";
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from "@/lib/runtime-switch";
import { readCachedCatalog, writeCachedCatalogWhenSettled, type CachedCatalog } from "./configCatalogCache";

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const MODELS_DEV_PROXY_URL = "/api/openchamber/models-metadata";

const FALLBACK_PROVIDER_ID = "opencode";
const FALLBACK_MODEL_ID = "big-pickle";
const ADD_PROVIDER_SENTINEL = "__add_provider__";
const GIT_UTILITY_PROVIDER_ID = "zen";
const GIT_UTILITY_PREFERRED_MODEL_ID = "big-pickle";
const PROVIDER_CONFIG_REFRESH_CONCURRENCY = 4;

const PROVIDERS_RETRY_SOURCE = "loadProviders:retryAfterFailure";
const PROVIDERS_RETRY_DELAY_MS = 3000;

interface OpenChamberDefaults {
    defaultModel?: string;
    defaultVariant?: string;
    defaultAgent?: string;
    autoCreateWorktree?: boolean;
    gitmojiEnabled?: boolean;
    defaultFileViewerPreview?: boolean;
    zenModel?: string;
    messageStreamTransport?: 'auto' | 'ws' | 'sse';
    dictationEnabled?: boolean;
    dictationAutoSend?: boolean;
    sttProvider?: 'local' | 'openai-compatible';
    sttServerUrl?: string;
    sttEndpointPath?: string;
    sttModel?: string;
    sttLocalModel?: string;
    sttLanguage?: string;
    sttCorrectTranscript?: boolean;
}

const OPENCHAMBER_DEFAULTS_FRESH_MS = 15_000;
type ConfigRuntimeContext = { runtimeKey: string; generation: number };

let configRuntimeGeneration = 0;
let configInstanceGeneration = 0;

const captureConfigRuntimeContext = (): ConfigRuntimeContext => ({
    runtimeKey: getRuntimeKey(),
    generation: configRuntimeGeneration,
});

const isConfigRuntimeContextCurrent = (context: ConfigRuntimeContext): boolean => (
    context.generation === configRuntimeGeneration && context.runtimeKey === getRuntimeKey()
);

const isSameConfigRuntimeContext = (left: ConfigRuntimeContext, right: ConfigRuntimeContext): boolean => (
    left.runtimeKey === right.runtimeKey && left.generation === right.generation
);

let openChamberDefaultsCache: {
    at: number;
    context: ConfigRuntimeContext;
    request: Promise<OpenChamberDefaults | null>;
} | null = null;
let openChamberDefaultsUserRevision = 0;

const invalidateOpenChamberDefaultsCache = (): void => {
    openChamberDefaultsCache = null;
};

const recordOpenChamberDefaultsChange = (): void => {
    openChamberDefaultsUserRevision += 1;
    invalidateOpenChamberDefaultsCache();
};

const fetchOpenChamberDefaults = (context: ConfigRuntimeContext): Promise<OpenChamberDefaults | null> => {
    const now = Date.now();
    if (
        openChamberDefaultsCache
        && isSameConfigRuntimeContext(openChamberDefaultsCache.context, context)
        && now - openChamberDefaultsCache.at < OPENCHAMBER_DEFAULTS_FRESH_MS
    ) {
        return openChamberDefaultsCache.request;
    }
    const request = requestOpenChamberDefaults(context);
    const cacheEntry = { at: now, context, request };
    openChamberDefaultsCache = cacheEntry;
    void request.then((result) => {
        if (result === null && openChamberDefaultsCache === cacheEntry) {
            openChamberDefaultsCache = null;
        }
    }).catch(() => {
        if (openChamberDefaultsCache === cacheEntry) openChamberDefaultsCache = null;
    });
    return request;
};

const toOpenChamberDefaults = (data: DesktopSettings): OpenChamberDefaults => {
    const defaultModel = data.defaultModel?.trim() ?? '';
    const defaultVariant = data.defaultVariant?.trim() ?? '';
    const defaultAgent = data.defaultAgent?.trim() ?? '';
    const zenModel = data.zenModel ?? '';

    return {
        defaultModel: defaultModel.length > 0 ? defaultModel : undefined,
        defaultVariant: defaultVariant.length > 0 ? defaultVariant : undefined,
        defaultAgent: defaultAgent.length > 0 ? defaultAgent : undefined,
        autoCreateWorktree: data.autoCreateWorktree,
        gitmojiEnabled: data.gitmojiEnabled,
        defaultFileViewerPreview: data.defaultFileViewerPreview,
        zenModel: zenModel.length > 0 ? zenModel : undefined,
        messageStreamTransport: data.messageStreamTransport,
        dictationEnabled: data.dictationEnabled,
        dictationAutoSend: data.dictationAutoSend,
        sttProvider: data.sttProvider,
        sttServerUrl: data.sttServerUrl,
        sttEndpointPath: data.sttEndpointPath,
        sttModel: data.sttModel,
        sttLocalModel: data.sttLocalModel,
        sttLanguage: data.sttLanguage,
        sttCorrectTranscript: data.sttCorrectTranscript,
    };
};

const requestOpenChamberDefaults = async (context: ConfigRuntimeContext): Promise<OpenChamberDefaults | null> => {
    markStartupTrace('config.defaults:start');
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const finish = (source: string, result: OpenChamberDefaults | null) => {
        const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
        markStartupTrace('config.defaults:end', {
            source,
            durationMs: Math.round(ended - started),
            hasDefaultModel: Boolean(result?.defaultModel),
            hasDefaultAgent: Boolean(result?.defaultAgent),
        });
        return result;
    };
    try {
        const data = await loadDesktopSettings();
        if (!isConfigRuntimeContextCurrent(context)) {
            return finish('stale', null);
        }
        if (!data) {
            return finish('settings-unavailable', null);
        }

        return finish('settings', toOpenChamberDefaults(data));
    } catch (error) {
        markStartupTrace('config.defaults:error', { error: error instanceof Error ? error.message : String(error) });
        return finish('error', null);
    }
};

const parseModelString = (modelString: string): { providerId: string; modelId: string } | null => {
    return parseModelIdentifier(modelString);
};

const normalizeProviderId = (value: string) => value?.toLowerCase?.() ?? '';

type ProviderModel = Model;
type ProviderWithModelList = Provider & { models: Model[] };

type GitModelSelection = { providerId: string; modelId: string };
type ProviderModelSelection = { providerId: string; modelId: string; variant?: string | null } | null;

const sanitizePersistedSelectedProviderId = (providerId: string | undefined): string => (
    providerId === ADD_PROVIDER_SENTINEL ? "" : (providerId ?? "")
);

const normalizeOptionalString = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const findProviderModel = (
    providers: ProviderWithModelList[],
    providerId: string,
    modelId: string,
): Model | undefined => (
    findCatalogModel(providers.find((provider) => provider.id === providerId)?.models, modelId)
);

const modelHasVariant = (model: Model | undefined, variant: string | null | undefined): boolean => (
    typeof variant === "string" && listModelVariantIds(model?.variants).includes(variant)
);

const resolveRememberedVariantForModel = (
    providers: ProviderWithModelList[],
    providerId: string | undefined,
    modelId: string | undefined,
): EffortChoice => {
    if (!providerId || !modelId) return undefined;
    const model = findProviderModel(providers, providerId, modelId);
    if (!model) return undefined;
    const variants = modelVariantNames(model);
    if (variants.length === 0) return undefined;
    return resolveEffortChoice([readRememberedEffort(providerId, modelId)], variants);
};

const hasProviderModel = (
    providers: ProviderWithModelList[],
    providerId: string,
    modelId: string
): boolean => {
    if (isAutoModel(providerId, modelId)) {
        return selectAutoReady(useRoutingStore.getState());
    }
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) {
        return false;
    }
    return findCatalogModel(provider.models, modelId) !== undefined;
};

export const isStaleAutoSelection = (providerId?: string | null, modelId?: string | null): boolean => {
    if (!providerId || !modelId || !isAutoModel(providerId, modelId)) return false;
    if (!useConfigStore.getState().settingsDefaultsLoaded) return false;
    if (!useUIStore.getState().routingFeatureAvailable) return true;
    const routing = useRoutingStore.getState();
    return routing.loaded && !selectAutoReady(routing);
};

const hasLiveCatalog = (state: Pick<ConfigStore, 'directoryScoped'>, directoryKey: string): boolean => (
    state.directoryScoped[directoryKey]?.providersLoaded === true
);

const isMissingFromCatalog = (
    providers: ProviderWithModelList[],
    catalogLoaded: boolean,
    providerId: string,
    modelId: string,
): boolean => catalogLoaded
    && providers.length > 0
    && !isAutoModel(providerId, modelId)
    && !hasProviderModel(providers, providerId, modelId);

type ConfiguredDefault = { model: string | undefined; variant: string | undefined };

const inheritedDefaultsFor = (
    agents: Agent[],
    agentName: string | undefined,
    opencodeDefaultModel: string | undefined,
): ConfiguredDefault[] => {
    const pinned = agents.find((agent) => agent.name === agentName)?.model;
    const opencode = opencodeDefaultModel ? parseModelSelection(opencodeDefaultModel) : null;
    return [
        { model: pinned?.providerID && pinned.id ? `${pinned.providerID}/${pinned.id}` : undefined, variant: pinned?.variant },
        { model: opencode ? `${opencode.providerID}/${opencode.modelID}` : undefined, variant: opencode?.variant },
    ];
};

const pickConfiguredDefault = (
    providers: ProviderWithModelList[],
    catalogLoaded: boolean,
    candidates: ConfiguredDefault[],
): { providerId: string; modelId: string; variant: string | undefined } | null => {
    for (const candidate of candidates) {
        const parsed = candidate.model ? parseModelString(candidate.model) : null;
        if (!parsed || isStaleAutoSelection(parsed.providerId, parsed.modelId)) continue;
        if (isMissingFromCatalog(providers, catalogLoaded, parsed.providerId, parsed.modelId)) continue;
        return { ...parsed, variant: candidate.variant };
    }
    return null;
};

const resolveProviderModelSelection = ({
    providers,
    catalogLoaded,
    currentProviderId,
    currentModelId,
    currentVariant,
    preserveCurrent = false,
    configuredDefaults,
    inheritedDefaults,
    allowFallback,
    fallbackPrefs,
}: {
    providers: ProviderWithModelList[];
    catalogLoaded: boolean;
    currentProviderId?: string;
    currentModelId?: string;
    currentVariant?: string;
    preserveCurrent?: boolean;
    configuredDefaults: ConfiguredDefault[];
    inheritedDefaults: ConfiguredDefault[];
    allowFallback: boolean;
    fallbackPrefs: FallbackModelPrefs;
}): ProviderModelSelection => {
    const resolveVariant = (providerId: string, modelId: string, variant?: string): string | undefined => {
        if (!variant) {
            return undefined;
        }

        return modelHasVariant(findProviderModel(providers, providerId, modelId), variant) ? variant : undefined;
    };
    const resolveVariantOrRemembered = (
        providerId: string,
        modelId: string,
        variant?: string,
    ): string | null | undefined => (
        resolveVariant(providerId, modelId, variant)
        ?? resolveRememberedVariantForModel(providers, providerId, modelId)
    );

    const preserveManual = preserveCurrent && !isStaleAutoSelection(currentProviderId, currentModelId);
    if (currentProviderId && currentModelId && (preserveManual || hasProviderModel(providers, currentProviderId, currentModelId))) {
        return {
            providerId: currentProviderId,
            modelId: currentModelId,
            variant: preserveCurrent
                ? currentVariant
                : resolveVariantOrRemembered(currentProviderId, currentModelId, currentVariant),
        };
    }

    const configured = pickConfiguredDefault(providers, catalogLoaded, configuredDefaults);
    if (configured) {
        return {
            providerId: configured.providerId,
            modelId: configured.modelId,
            variant: hasProviderModel(providers, configured.providerId, configured.modelId)
                ? resolveVariantOrRemembered(configured.providerId, configured.modelId, configured.variant)
                : configured.variant,
        };
    }

    if (!allowFallback) return null;
    const inherited = pickConfiguredDefault(providers, catalogLoaded, inheritedDefaults);
    if (inherited) {
        return {
            providerId: inherited.providerId,
            modelId: inherited.modelId,
            variant: hasProviderModel(providers, inherited.providerId, inherited.modelId)
                ? resolveVariantOrRemembered(inherited.providerId, inherited.modelId, inherited.variant)
                : inherited.variant,
        };
    }
    const fallback = resolveLastSelectedModel(fallbackPrefs, providers, catalogLoaded) ?? resolveFallbackModel(providers, fallbackPrefs.hiddenModels);
    if (!fallback) return null;
    return {
        ...fallback,
        variant: resolveRememberedVariantForModel(providers, fallback.providerId, fallback.modelId),
    };
};

type FallbackModelPrefs = {
    hiddenModels: readonly ModelRef[];
    lastSelectedModel: string | undefined;
};

const readFallbackModelPrefs = (): FallbackModelPrefs => {
    const { hiddenModels, lastSelectedModel } = useUIStore.getState();
    return { hiddenModels, lastSelectedModel };
};

const isModelHidden = (hiddenModels: readonly ModelRef[], providerId: string, modelId: string): boolean => hiddenModels.some(
    (hidden) => hidden.providerID === providerId && hidden.modelID === modelId,
);

const resolveLastSelectedModel = (
    { hiddenModels, lastSelectedModel }: FallbackModelPrefs,
    providers: ProviderWithModelList[],
    catalogLoaded: boolean,
): { providerId: string; modelId: string } | null => {
    const parsed = lastSelectedModel ? parseModelString(lastSelectedModel) : null;
    if (!parsed) return null;
    if (isModelHidden(hiddenModels, parsed.providerId, parsed.modelId)) return null;
    if (isStaleAutoSelection(parsed.providerId, parsed.modelId)) return null;
    if (isMissingFromCatalog(providers, catalogLoaded, parsed.providerId, parsed.modelId)) return null;
    return parsed;
};

const resolveFallbackModel = (
    providers: ProviderWithModelList[],
    hiddenModels: readonly ModelRef[],
): { providerId: string; modelId: string } | null => {
    const isVisible = (providerId: string, modelId: string) => !isModelHidden(hiddenModels, providerId, modelId);

    const hasBigPickle = hasProviderModel(providers, FALLBACK_PROVIDER_ID, FALLBACK_MODEL_ID);
    if (hasBigPickle && isVisible(FALLBACK_PROVIDER_ID, FALLBACK_MODEL_ID)) {
        return { providerId: FALLBACK_PROVIDER_ID, modelId: FALLBACK_MODEL_ID };
    }
    for (const provider of providers) {
        const visibleModel = provider.models.find((model) => isVisible(provider.id, model.modelID));
        if (visibleModel) {
            return { providerId: provider.id, modelId: visibleModel.modelID };
        }
    }

    if (hasBigPickle) {
        return { providerId: FALLBACK_PROVIDER_ID, modelId: FALLBACK_MODEL_ID };
    }
    const firstProvider = providers[0];
    const firstModel = firstProvider?.models[0];
    if (firstProvider && firstModel) {
        return { providerId: firstProvider.id, modelId: firstModel.modelID };
    }
    return null;
};

type DefaultAgentModelSelection = {
    agentName: string | undefined;
    providerId?: string;
    modelId?: string;
    variant?: string | null;
};

type DirectoryDefaultSelection = {
    agentName: string | undefined;
    providerId: string;
    modelId: string;
    variant?: string | null;
};

const resolveDefaultAgentModelSelection = ({
    agents,
    providers,
    catalogLoaded,
    projectDefaultAgent,
    projectDefaultModel,
    projectDefaultVariant,
    settingsDefaultAgent,
    settingsDefaultModel,
    settingsDefaultVariant,
    opencodeDefaultAgent,
    opencodeDefaultModel,
    allowFallback = true,
    fallbackPrefs,
}: {
    agents: Agent[];
    providers: ProviderWithModelList[];
    catalogLoaded: boolean;
    projectDefaultAgent?: string;
    projectDefaultModel?: string;
    projectDefaultVariant?: string;
    settingsDefaultAgent?: string;
    settingsDefaultModel?: string;
    settingsDefaultVariant?: string;
    opencodeDefaultAgent?: string;
    opencodeDefaultModel?: string;
    allowFallback?: boolean;
    fallbackPrefs: FallbackModelPrefs;
}): DefaultAgentModelSelection => {
    const resolveVariant = (providerId: string, modelId: string, variant?: string): string | undefined => {
        if (!variant) {
            return undefined;
        }
        return modelHasVariant(findProviderModel(providers, providerId, modelId), variant) ? variant : undefined;
    };
    const primaryAgents = agents.filter((agent) => isPrimaryMode(agent.mode) && !isAgentHidden(agent));

    let resolvedAgent: Agent | undefined;
    if (projectDefaultAgent) {
        resolvedAgent = agents.find((agent) => agent.name === projectDefaultAgent);
    }
    if (!resolvedAgent && settingsDefaultAgent) {
        resolvedAgent = agents.find((agent) => agent.name === settingsDefaultAgent);
    }
    if (!resolvedAgent && opencodeDefaultAgent) {
        const candidate = agents.find((agent) => agent.name === opencodeDefaultAgent);
        if (candidate && isPrimaryMode(candidate.mode) && !isAgentHidden(candidate)) {
            resolvedAgent = candidate;
        }
    }
    if (!resolvedAgent) {
        resolvedAgent = primaryAgents.find((agent) => agent.name === "build") || primaryAgents[0] || agents[0];
    }

    const resolveAgentOrRememberedVariant = (): string | null | undefined => {
        if (!providerId || !modelId) return undefined;
        const model = findProviderModel(providers, providerId, modelId);
        if (!model) return undefined;
        const variants = modelVariantNames(model);
        if (variants.length === 0) return undefined;
        const agentVariant = resolvedAgent?.model?.providerID === providerId && resolvedAgent.model.id === modelId
            ? resolvedAgent.model.variant
            : undefined;
        return resolveEffortChoice([agentVariant, readRememberedEffort(providerId, modelId)], variants);
    };

    let providerId: string | undefined;
    let modelId: string | undefined;
    let variant: string | null | undefined;

    const configured = pickConfiguredDefault(providers, catalogLoaded, [
        { model: projectDefaultModel, variant: projectDefaultVariant },
        { model: settingsDefaultModel, variant: settingsDefaultVariant },
    ]);
    if (configured) {
        providerId = configured.providerId;
        modelId = configured.modelId;
        variant = hasProviderModel(providers, providerId, modelId)
            ? resolveVariant(providerId, modelId, configured.variant)
            : configured.variant;
    }

    if (providerId || !allowFallback) {
        if (variant === undefined) {
            variant = resolveAgentOrRememberedVariant();
        }
        return { agentName: resolvedAgent?.name ?? projectDefaultAgent ?? settingsDefaultAgent, providerId, modelId, variant };
    }

    const agentModel = resolvedAgent?.model;
    if (agentModel?.providerID && agentModel.id
        && !isMissingFromCatalog(providers, catalogLoaded, agentModel.providerID, agentModel.id)) {
        providerId = agentModel.providerID;
        modelId = agentModel.id;
        variant = hasProviderModel(providers, providerId, modelId)
            ? resolveVariant(providerId, modelId, agentModel.variant)
            : agentModel.variant;
    }

    if (!providerId && opencodeDefaultModel) {
        const parsed = parseModelSelection(opencodeDefaultModel);
        if (parsed && !isMissingFromCatalog(providers, catalogLoaded, parsed.providerID, parsed.modelID)) {
            providerId = parsed.providerID;
            modelId = parsed.modelID;
            variant = hasProviderModel(providers, providerId, modelId)
                ? resolveVariant(providerId, modelId, parsed.variant)
                : parsed.variant;
        }
    }

    if (!providerId) {
        const fallback = resolveLastSelectedModel(fallbackPrefs, providers, catalogLoaded) ?? resolveFallbackModel(providers, fallbackPrefs.hiddenModels);
        providerId = fallback?.providerId;
        modelId = fallback?.modelId;
    }

    if (variant === undefined) {
        variant = resolveAgentOrRememberedVariant();
    }

    return { agentName: resolvedAgent?.name, providerId, modelId, variant };
};

const resolveGitGenerationModelSelection = ({
    providers,
    settingsZenModel,
}: {
    providers: ProviderWithModelList[];
    settingsZenModel?: string;
}): GitModelSelection | null => {
    const zenModel = normalizeOptionalString(settingsZenModel);

    if (!Array.isArray(providers) || providers.length === 0) {
        if (zenModel) {
            return { providerId: GIT_UTILITY_PROVIDER_ID, modelId: zenModel };
        }
        return null;
    }

    if (zenModel && hasProviderModel(providers, GIT_UTILITY_PROVIDER_ID, zenModel)) {
        return { providerId: GIT_UTILITY_PROVIDER_ID, modelId: zenModel };
    }

    if (hasProviderModel(providers, GIT_UTILITY_PROVIDER_ID, GIT_UTILITY_PREFERRED_MODEL_ID)) {
        return { providerId: GIT_UTILITY_PROVIDER_ID, modelId: GIT_UTILITY_PREFERRED_MODEL_ID };
    }

    const zenProvider = providers.find((provider) => provider.id === GIT_UTILITY_PROVIDER_ID);
    if (zenProvider?.models.length) {
        const randomIndex = Math.floor(Math.random() * zenProvider.models.length);
        const randomModelId = normalizeOptionalString(zenProvider.models[randomIndex]?.modelID);
        if (randomModelId) {
            return { providerId: GIT_UTILITY_PROVIDER_ID, modelId: randomModelId };
        }
    }

    return null;
};

interface ModelsDevModelEntry {
    id?: string;
    name?: string;
    tool_call?: boolean;
    reasoning?: boolean;
    temperature?: boolean;
    attachment?: boolean;
    structured_output?: boolean;
    modalities?: {
        input?: string[];
        output?: string[];
    };
    cost?: {
        input?: number;
        output?: number;
        cache_read?: number;
        cache_write?: number;
    };
    limit?: {
        context?: number;
        output?: number;
    };
    knowledge?: string;
    release_date?: string;
    last_updated?: string;
}

interface ModelsDevProviderEntry {
    id?: string;
    models?: Record<string, ModelsDevModelEntry | undefined>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");

const isModelsDevModelEntry = (value: unknown): value is ModelsDevModelEntry => {
    if (!isRecord(value)) {
        return false;
    }
    const candidate = value as ModelsDevModelEntry;
    if (candidate.modalities) {
        const { input, output } = candidate.modalities;
        if (input && !isStringArray(input)) {
            return false;
        }
        if (output && !isStringArray(output)) {
            return false;
        }
    }
    return true;
};

const isModelsDevProviderEntry = (value: unknown): value is ModelsDevProviderEntry => {
    if (!isRecord(value)) {
        return false;
    }
    const candidate = value as ModelsDevProviderEntry;
    return candidate.models === undefined || isRecord(candidate.models);
};

const buildModelMetadataKey = (providerId: string, modelId: string) => {
    const normalizedProvider = normalizeProviderId(providerId);
    if (!normalizedProvider || !modelId) {
        return '';
    }
    return `${normalizedProvider}/${modelId}`;
};

const runtimeModelReleaseDate = (released: number | undefined): string | undefined => {
    if (released === undefined || !Number.isFinite(released) || released <= 0) return undefined;
    const date = new Date(released);
    if (!Number.isFinite(date.getTime())) return undefined;
    const iso = date.toISOString();
    return /^\d{4}-/.test(iso) ? iso.slice(0, 10) : undefined;
};

const deriveModelMetadata = (providerId: string, model: ProviderModel): ModelMetadata => {
    const baseCost = model.cost.find((entry) => !entry.tier) ?? model.cost[0];
    const hasReasoningSignal = modelVariantNames(model).length > 0
        || model.compatibility?.reasoningField !== undefined
        || model.compatibility?.requireReasoning === true;
    const releaseDate = runtimeModelReleaseDate(model.time?.released);
    const metadata: ModelMetadata = {
        id: model.modelID,
        providerId,
        name: model.name,
        tool_call: model.capabilities.tools,
        attachment: model.capabilities.input.includes('image'),
        ...(hasReasoningSignal ? { reasoning: true } : {}),
        modalities: {
            input: model.capabilities.input,
            output: model.capabilities.output,
        },
        cost: baseCost ? {
            input: baseCost.input,
            output: baseCost.output,
            cache_read: baseCost.cache.read,
            cache_write: baseCost.cache.write,
        } : undefined,
        limit: { context: model.limit.context, output: model.limit.output },
    };
    if (releaseDate) metadata.release_date = releaseDate;
    return metadata;
};

const findDescriptiveMetadata = (
    metadata: ReadonlyMap<string, ModelMetadata>,
    model: ProviderModel,
    providerCanonical: string | undefined,
): ModelMetadata | undefined => {
    if (!model.modelID) return undefined;
    const canonical = normalizeOptionalString(model.canonical)
        ?? normalizeOptionalString(providerCanonical);
    if (canonical) {
        return metadata.get(buildModelMetadataKey(canonical, model.modelID));
    }
    let match: ModelMetadata | undefined;
    for (const [key, entry] of metadata) {
        const separator = key.indexOf('/');
        if (separator < 0 || key.slice(separator + 1) !== model.modelID) continue;
        if (match) return undefined;
        match = entry;
    }
    return match;
};

export const resolveModelMetadata = (
    modelsMetadata: ReadonlyMap<string, ModelMetadata>,
    providers: readonly ProviderWithModelList[],
    providerId: string,
    modelId: string,
): ModelMetadata | undefined => {
    const key = buildModelMetadataKey(providerId, modelId);
    if (!key) {
        return undefined;
    }
    const cached = modelsMetadata.get(key);
    const provider = providers.find((p) => p.id === providerId);
    const model = findCatalogModel(provider?.models, modelId);

    if (cached) {
        if (!model) return cached;
        const releaseDate = runtimeModelReleaseDate(model.time?.released);
        const hasLiveLimits = model.limit.context > 0;
        if (!hasLiveLimits && !releaseDate) return cached;
        const metadata: ModelMetadata = { ...cached };
        if (hasLiveLimits) {
            metadata.limit = {
                ...cached.limit,
                context: model.limit.context,
                output: model.limit.output,
            };
        }
        if (releaseDate) metadata.release_date = releaseDate;
        return metadata;
    }

    if (!model) return undefined;
    const derived = deriveModelMetadata(providerId, model);
    const descriptive = findDescriptiveMetadata(modelsMetadata, model, provider?.canonical);
    if (!descriptive) return derived;
    const supplemented: ModelMetadata = { ...derived };
    const knowledge = normalizeOptionalString(descriptive.knowledge);
    if (knowledge) supplemented.knowledge = knowledge;
    if (!supplemented.release_date) {
        const releaseDate = normalizeOptionalString(descriptive.release_date);
        if (releaseDate) supplemented.release_date = releaseDate;
    }
    const lastUpdated = normalizeOptionalString(descriptive.last_updated);
    if (lastUpdated) supplemented.last_updated = lastUpdated;
    return supplemented;
};

const transformModelsDevResponse = (payload: unknown): Map<string, ModelMetadata> => {
    const metadataMap = new Map<string, ModelMetadata>();

    if (!isRecord(payload)) {
        return metadataMap;
    }

    for (const [providerKey, providerValue] of Object.entries(payload)) {
        if (!isModelsDevProviderEntry(providerValue)) {
            continue;
        }

        const providerId = typeof providerValue.id === 'string' && providerValue.id.length > 0 ? providerValue.id : providerKey;
        const models = providerValue.models;
        if (!models || !isRecord(models)) {
            continue;
        }

        for (const [modelKey, modelValue] of Object.entries(models)) {
            if (!isModelsDevModelEntry(modelValue)) {
                continue;
            }

            const resolvedModelId =
                typeof modelKey === 'string' && modelKey.length > 0
                    ? modelKey
                    : modelValue.id;

            if (!resolvedModelId || typeof resolvedModelId !== 'string' || resolvedModelId.length === 0) {
                continue;
            }

            const metadata: ModelMetadata = {
                id: typeof modelValue.id === 'string' && modelValue.id.length > 0 ? modelValue.id : resolvedModelId,
                providerId,
                name: typeof modelValue.name === 'string' ? modelValue.name : undefined,
                tool_call: typeof modelValue.tool_call === 'boolean' ? modelValue.tool_call : undefined,
                reasoning: typeof modelValue.reasoning === 'boolean' ? modelValue.reasoning : undefined,
                temperature: typeof modelValue.temperature === 'boolean' ? modelValue.temperature : undefined,
                attachment: typeof modelValue.attachment === 'boolean' ? modelValue.attachment : undefined,
                structured_output:
                    typeof modelValue.structured_output === 'boolean' ? modelValue.structured_output : undefined,
                modalities: modelValue.modalities
                    ? {
                          input: isStringArray(modelValue.modalities.input) ? modelValue.modalities.input : undefined,
                          output: isStringArray(modelValue.modalities.output) ? modelValue.modalities.output : undefined,
                      }
                    : undefined,
                cost: modelValue.cost,
                limit: modelValue.limit,
                knowledge: typeof modelValue.knowledge === 'string' ? modelValue.knowledge : undefined,
                release_date: typeof modelValue.release_date === 'string' ? modelValue.release_date : undefined,
                last_updated: typeof modelValue.last_updated === 'string' ? modelValue.last_updated : undefined,
            };

            const key = buildModelMetadataKey(providerId, resolvedModelId);
            if (key) {
                metadataMap.set(key, metadata);
            }
        }
    }

    return metadataMap;
};

const fetchModelsDevMetadata = async (): Promise<Map<string, ModelMetadata>> => {
    if (typeof fetch !== 'function') {
        return new Map();
    }

    const sources = [MODELS_DEV_PROXY_URL, MODELS_DEV_API_URL];

    for (const source of sources) {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
        const timeout = controller ? setTimeout(() => controller.abort(), 8000) : undefined;

        try {
            const isAbsoluteUrl = /^https?:\/\//i.test(source);
            const requestInit: RequestInit = {
                signal: controller?.signal,
                headers: {
                    Accept: 'application/json',
                },
                cache: 'no-store',
            };

            if (isAbsoluteUrl) {
                requestInit.mode = 'cors';
            } else {
                requestInit.credentials = 'same-origin';
            }

            const response = isAbsoluteUrl
                ? await fetch(source, requestInit)
                : await runtimeFetch(source, requestInit);

            if (!response.ok) {
                throw new Error(`Metadata request to ${source} returned status ${response.status}`);
            }

            const data = await response.json();
            return transformModelsDevResponse(data);
        } catch (error: unknown) {
            if ((error as Error)?.name === 'AbortError') {
                console.warn(`Model metadata request aborted (${source})`);
            } else {
                console.warn(`Failed to fetch model metadata from ${source}:`, error);
            }
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
        }
    }

    return new Map();
};

let modelsMetadataInFlight: Promise<Map<string, ModelMetadata>> | null = null;

const MODELS_METADATA_IDLE_TIMEOUT_MS = 3_000;

const whenIdle = (): Promise<void> => new Promise((resolve) => {
    if (typeof window === 'undefined') {
        resolve();
        return;
    }
    // external: https://developer.mozilla.org/en-US/docs/Web/API/Window/requestIdleCallback#browser_compatibility Safari and iOS need the timer fallback.
    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => resolve(), { timeout: MODELS_METADATA_IDLE_TIMEOUT_MS });
    } else {
        window.setTimeout(resolve, 1_000);
    }
});

const ensureModelsMetadataFetch = (
    getModelsMetadata: () => Map<string, ModelMetadata>,
    setModelsMetadata: (metadata: Map<string, ModelMetadata>) => void,
) => {
    const existing = getModelsMetadata();
    if (existing.size > 0) {
        return;
    }

    if (modelsMetadataInFlight) {
        return;
    }

    markStartupTrace('modelsMetadata:queued');
    const runtimeContext = captureConfigRuntimeContext();
    const request: Promise<Map<string, ModelMetadata>> = whenIdle()
        .then(() => isConfigRuntimeContextCurrent(runtimeContext)
            ? measureStartupTrace('modelsMetadata', fetchModelsDevMetadata)
            : new Map<string, ModelMetadata>())
        .then((metadata) => {
            if (metadata.size > 0 && modelsMetadataInFlight === request && isConfigRuntimeContextCurrent(runtimeContext)) {
                markStartupTrace('modelsMetadata:set', { entries: metadata.size });
                setModelsMetadata(metadata);
            }
            return metadata;
        })
        .catch(() => new Map<string, ModelMetadata>())
        .finally(() => {
            if (modelsMetadataInFlight === request) modelsMetadataInFlight = null;
        });
    modelsMetadataInFlight = request;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CONNECTION_PROBE_TIMEOUT_MS = 800;
const CONNECTION_HEALTH_WAIT_MS = 3_000;

const probeOpenCodeHealth = async (timeoutMs = CONNECTION_PROBE_TIMEOUT_MS): Promise<boolean> => {
    return Promise.race([
        opencodeClient.checkHealth().catch(() => false),
        sleep(Math.max(1, timeoutMs)).then(() => false),
    ]);
};

const DIRECTORY_KEY_GLOBAL = "__global__";

const toDirectoryKey = (directory: string | null | undefined): string => {
    const trimmed = typeof directory === 'string' ? directory.trim() : '';
    return trimmed.length > 0 ? trimmed : DIRECTORY_KEY_GLOBAL;
};

const fromDirectoryKey = (key: string): string | null => (key === DIRECTORY_KEY_GLOBAL ? null : key);

const resolveInitialDirectoryKey = (): string => {
    if (typeof window === 'undefined') {
        return DIRECTORY_KEY_GLOBAL;
    }

    const directory = opencodeClient.getDirectory() ?? useDirectoryStore.getState().currentDirectory;
    return toConfigDirectoryKey(directory);
};

const WORKTREE_PROJECT_MAP_KEY = 'oc.worktreeProjectMap.v2';
const LEGACY_WORKTREE_PROJECT_MAP_KEY = 'oc.worktreeProjectMap';
const MAX_WORKTREE_PROJECT_RUNTIME_MAPS = 8;
type WorktreeProjectMapEnvelope = {
    version: 2;
    legacyClaimed: boolean;
    runtimes: Record<string, { updatedAt: number; entries: Record<string, string> }>;
};
const _worktreeProjectMaps = new Map<string, Record<string, string>>();
const readWorktreeProjectEnvelope = (): WorktreeProjectMapEnvelope => {
    try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(WORKTREE_PROJECT_MAP_KEY) : null;
        if (!raw) return { version: 2, legacyClaimed: false, runtimes: {} };
        const parsed = JSON.parse(raw) as Partial<WorktreeProjectMapEnvelope>;
        if (parsed.version !== 2 || !parsed.runtimes || typeof parsed.runtimes !== 'object') {
            return { version: 2, legacyClaimed: false, runtimes: {} };
        }
        return { version: 2, legacyClaimed: parsed.legacyClaimed === true, runtimes: parsed.runtimes };
    } catch {
        return { version: 2, legacyClaimed: false, runtimes: {} };
    }
};
const writeWorktreeProjectEnvelope = (envelope: WorktreeProjectMapEnvelope): void => {
    const runtimes = Object.fromEntries(
        Object.entries(envelope.runtimes)
            .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
            .slice(0, MAX_WORKTREE_PROJECT_RUNTIME_MAPS),
    );
    localStorage.setItem(WORKTREE_PROJECT_MAP_KEY, JSON.stringify({ ...envelope, runtimes }));
};
const getWorktreeProjectMap = (): Record<string, string> => {
    const runtimeKey = getRuntimeKey() || 'default';
    const existing = _worktreeProjectMaps.get(runtimeKey);
    if (existing) return existing;
    const envelope = readWorktreeProjectEnvelope();
    let map = envelope.runtimes[runtimeKey]?.entries ?? null;
    if (!map && !envelope.legacyClaimed) {
        try {
            const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LEGACY_WORKTREE_PROJECT_MAP_KEY) : null;
            map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
            envelope.legacyClaimed = true;
            envelope.runtimes[runtimeKey] = { updatedAt: Date.now(), entries: map };
            writeWorktreeProjectEnvelope(envelope);
            localStorage.removeItem(LEGACY_WORKTREE_PROJECT_MAP_KEY);
        } catch {
            map = {};
        }
    }
    const result = map ?? {};
    _worktreeProjectMaps.set(runtimeKey, result);
    return result;
};
const rememberWorktreeProject = (worktree: string, project: string): void => {
    if (!worktree || !project || worktree === project) return;
    const map = getWorktreeProjectMap();
    if (map[worktree] === project) return;
    map[worktree] = project;
    try {
        const runtimeKey = getRuntimeKey() || 'default';
        const envelope = readWorktreeProjectEnvelope();
        envelope.legacyClaimed = true;
        envelope.runtimes[runtimeKey] = { updatedAt: Date.now(), entries: map };
        writeWorktreeProjectEnvelope(envelope);
        localStorage.removeItem(LEGACY_WORKTREE_PROJECT_MAP_KEY);
    } catch {
        // localStorage quota exceeded — ignore; live resolution still works.
    }
};

const normalizeConfigPath = (value: string | null | undefined): string | null => {
    const result = normalizePath(value);
    if (result === null) return null;
    return result || '/';
};

const getKnownProjectDirectories = (): string[] => {
    try {
        return useProjectsStore.getState().projects
            .map((project) => normalizeConfigPath(project.path))
            .filter((path): path is string => Boolean(path));
    } catch {
        return [];
    }
};

const getFallbackProjectDirectory = (): string | null => {
    try {
        const { projects, activeProjectId } = useProjectsStore.getState();
        const active = activeProjectId
            ? projects.find((project) => project.id === activeProjectId)
            : null;
        return normalizeConfigPath(active?.path ?? projects[0]?.path ?? null);
    } catch {
        return null;
    }
};

type ProjectDefaults = { projectDefaultAgent?: string; projectDefaultModel?: string; projectDefaultVariant?: string };

const isChatDraftOpen = (): boolean => {
    const session = useSessionUIStore.getState();
    return !session.currentSessionId && Boolean(session.newSessionDraft?.open) && session.newSessionDraft.target === 'chat';
};

const getProjectDefaultsForConfigDirectory = (directory: string | null | undefined): ProjectDefaults => {
    const configDirectory = normalizeConfigPath(directory);
    if (!configDirectory) {
        return {};
    }
    if (isChatDraftOpen() && toDirectoryKey(configDirectory) === useConfigStore.getState().activeDirectoryKey) return {};
    return readProjectDefaults(configDirectory);
};

const readProjectDefaults = (configDirectory: string): ProjectDefaults => {
    const projectDirectory = resolveProjectDirectory(configDirectory);
    const project = useProjectsStore.getState().projects.find((entry) => normalizeConfigPath(entry.path) === projectDirectory);
    return {
        projectDefaultAgent: normalizeOptionalString(project?.defaultAgent),
        projectDefaultModel: normalizeOptionalString(project?.defaultModel),
        projectDefaultVariant: normalizeOptionalString(project?.defaultVariant),
    };
};

const resolveConfiguredDefaultVariant = (
    defaults: {
        projectDefaultModel?: string;
        projectDefaultVariant?: string;
        settingsDefaultModel?: string;
        settingsDefaultVariant?: string;
    },
    providerId: string,
    modelId: string,
): string | undefined => {
    const isThisModel = (model: string | undefined) => {
        const parsed = model ? parseModelString(model) : null;
        return parsed?.providerId === providerId && parsed.modelId === modelId;
    };
    if (isThisModel(defaults.projectDefaultModel)) return defaults.projectDefaultVariant;
    if (isThisModel(defaults.settingsDefaultModel)) return defaults.settingsDefaultVariant;
    return undefined;
};

const resolveProjectDirectory = (directory: string | null | undefined): string | null => {
    const dir = normalizeConfigPath(directory);
    const projects = getKnownProjectDirectories();
    if (!dir) return null;
    if (projects.includes(dir)) return dir;
    if (isSpaceDirectory(dir)) return null;

    const cached = normalizeConfigPath(getWorktreeProjectMap()[dir]);
    if (cached) return cached;
    try {
        const project = resolveProjectForSessionDirectory(
            useProjectsStore.getState().projects,
            useSessionUIStore.getState().availableWorktreesByProject,
            dir,
        );
        const projectPath = normalizeConfigPath(project?.path ?? null);
        if (projectPath && projectPath !== dir) {
            rememberWorktreeProject(dir, projectPath);
            return projectPath;
        }
    } catch { /* The cached mapping, if any, was checked above. */ }
    return null;
};

const resolveConfigDirectory = normalizeConfigPath;

const toConfigDirectoryKey = (directory: string | null | undefined): string =>
    toDirectoryKey(resolveConfigDirectory(directory));

const _providersLoadedAt = new Map<string, number>();
const _agentsLoadedAt = new Map<string, number>();
const CONFIG_REFRESH_TTL_MS = 30_000;

const ALL_DIRECTORIES = '*';
let _catalogRevision = 0;
let _configCatalogLoadEpoch = 0;
const _providersStaleAt = new Map<string, number>();
const _agentsStaleAt = new Map<string, number>();

const markCatalogStale = (loadedAt: Map<string, number>, staleAt: Map<string, number>, directoryKey: string | null): void => {
    _catalogRevision += 1;
    if (directoryKey === null) {
        loadedAt.clear();
        staleAt.set(ALL_DIRECTORIES, _catalogRevision);
        return;
    }
    loadedAt.delete(directoryKey);
    staleAt.set(directoryKey, _catalogRevision);
};

const isCatalogStaleSince = (staleAt: Map<string, number>, directoryKey: string, loadRevision: number): boolean =>
    Math.max(staleAt.get(directoryKey) ?? 0, staleAt.get(ALL_DIRECTORIES) ?? 0) > loadRevision;

const markCatalogLoaded = (
    loadedAt: Map<string, number>,
    staleAt: Map<string, number>,
    directoryKey: string,
    loadRevision: number,
): void => {
    if (isCatalogStaleSince(staleAt, directoryKey, loadRevision)) return;
    loadedAt.set(directoryKey, Date.now());
};

export const markConfigCatalogStale = (kind: CatalogKind, directory: string | null): void => {
    const directoryKey = directory ? toConfigDirectoryKey(directory) : null;
    if (kind === 'provider' || kind === 'model' || kind === 'credential' || kind === 'config') {
        markCatalogStale(_providersLoadedAt, _providersStaleAt, directoryKey);
    }
    if (kind === 'agent' || kind === 'config') {
        markCatalogStale(_agentsLoadedAt, _agentsStaleAt, directoryKey);
    }
};
const getConfigLoadKey = (context: ConfigRuntimeContext, directoryKey: string): string => (
    JSON.stringify([context.generation, context.runtimeKey, directoryKey])
);

const persistLoadedCatalog = (
    context: ConfigRuntimeContext,
    directoryKey: string,
    update: CachedCatalog,
    staleAt: Map<string, number>,
    loadRevision: number,
): void => {
    if (directoryKey === DIRECTORY_KEY_GLOBAL) return;
    writeCachedCatalogWhenSettled(
        context.runtimeKey,
        directoryKey,
        update,
        () => !isConfigRuntimeContextCurrent(context) || isCatalogStaleSince(staleAt, directoryKey, loadRevision),
    );
};

const hydrateConfigCatalogFromCache = async (directoryKey: string): Promise<void> => {
    if (directoryKey === DIRECTORY_KEY_GLOBAL) return;
    const context = captureConfigRuntimeContext();
    const cached = await readCachedCatalog(context.runtimeKey, directoryKey);
    if (!cached || !isConfigRuntimeContextCurrent(context)) return;
    useConfigStore.setState((state) => {
        const snapshot = state.directoryScoped[directoryKey] ?? createEmptyDirectoryScopedConfig();
        const isActive = state.activeDirectoryKey === directoryKey;
        const providersLive = snapshot.providersLoaded === true || snapshot.providers.length > 0
            || (isActive && (state.providersLoaded || state.providers.length > 0));
        const agentsLive = snapshot.agentsLoaded === true || snapshot.agents.length > 0
            || (isActive && (state.agentsLoaded || state.agents.length > 0));
        const providers = !providersLive && cached.providers?.length ? cached.providers : null;
        const agents = !agentsLive && cached.agents?.length ? cached.agents : null;
        if (!providers && !agents) return state;
        markStartupTrace('configCatalogCache:hydrated', { directoryKey, providers: providers?.length ?? 0, agents: agents?.length ?? 0 });
        const defaultProviders = providers && cached.defaultProviders ? cached.defaultProviders : snapshot.defaultProviders;
        const nextSnapshot: DirectoryScopedConfig = {
            ...snapshot,
            ...(providers ? { providers, defaultProviders } : {}),
            ...(agents ? { agents } : {}),
        };
        return {
            directoryScoped: { ...state.directoryScoped, [directoryKey]: nextSnapshot },
            ...(isActive && providers ? { providers, defaultProviders } : {}),
            ...(isActive && agents ? { agents } : {}),
        };
    });
};

const _agentsLoadErrors = new Map<string, Error>();

const clearProjectConfigError = (directoryKey: string): void => {
    if (!useConfigStore.getState().projectConfigErrors[directoryKey]) return;
    useConfigStore.setState((state) => {
        const next = { ...state.projectConfigErrors };
        delete next[directoryKey];
        return { projectConfigErrors: next };
    });
};

subscribeRuntimeEndpointChanged((detail) => {
    configRuntimeGeneration += 1;
    invalidateOpenChamberDefaultsCache();
    _providersLoadedAt.clear();
    _agentsLoadedAt.clear();
    _providersStaleAt.clear();
    _agentsStaleAt.clear();
    _agentsLoadErrors.clear();
    _inFlightProviders.clear();
    _inFlightAgents.clear();
    _agentsLoadGeneration.clear();
    _initializeAppInFlight = null;
    modelsMetadataInFlight = null;
    if (detail.runtimeKey === detail.previousRuntimeKey) return;
    configInstanceGeneration += 1;
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

const isConfigFresh = (loadedAt: Map<string, number>, key: string): boolean => {
    const at = loadedAt.get(key);
    return typeof at === 'number' && Date.now() - at < CONFIG_REFRESH_TTL_MS;
};

interface DirectoryScopedConfig {
    providersLoaded?: boolean;
    agentsLoaded?: boolean;

    providers: ProviderWithModelList[];
    agents: Agent[];
    currentProviderId: string;
    currentModelId: string;
    currentVariant?: string | undefined;
    currentVariantSelection?: CurrentVariantSelection;
    currentAgentName: string | undefined;
    selectedProviderId: string;
    agentModelSelections: { [agentName: string]: { providerId: string; modelId: string } };
    defaultProviders: { [key: string]: string };
    opencodeDefaultAgent?: string;
    opencodeDefaultModel?: string;
    selectionSource?: "auto" | "manual";
    agentSelectionSource?: "auto" | "manual";
}

type CurrentVariantSelection = {
    override: string | null | undefined;
    inherited: string | null | undefined;
};

const resolveVariantFromSelection = (selection: CurrentVariantSelection): string | undefined => {
    if (selection.override === null) return undefined;
    const variant = selection.override ?? selection.inherited;
    return variant ?? undefined;
};

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

const variantAfterResolve = (selection: CurrentVariantSelection | undefined, resolved: string | null | undefined): string | undefined => (
    selection?.override === undefined ? resolved ?? undefined : resolveVariantFromSelection(selection)
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

const SELECTION_FIELDS = ["currentProviderId", "currentModelId", "currentAgentName", "selectionSource", "agentSelectionSource"] as const;
type SelectionField = typeof SELECTION_FIELDS[number];

const isUnchangedSelection = (
    state: Pick<ConfigStore, "activeDirectoryKey" | "directoryScoped" | SelectionField>,
    next: Partial<Pick<DirectoryScopedConfig, SelectionField>>,
): boolean => {
    const snapshot = state.directoryScoped[state.activeDirectoryKey];
    if (!snapshot) return false;
    return SELECTION_FIELDS.every((field) => !(field in next) || (next[field] === state[field] && next[field] === snapshot[field]));
};

const variantResetForModelChange = (
    state: Pick<ConfigStore, "currentProviderId" | "currentModelId">,
    providerId: string,
    modelId: string,
): Partial<Pick<DirectoryScopedConfig, "currentVariant" | "currentVariantSelection">> => (
    state.currentProviderId === providerId && state.currentModelId === modelId
        ? {}
        : { currentVariant: undefined, currentVariantSelection: { override: undefined, inherited: undefined } }
);

const createEmptyDirectoryScopedConfig = (
    providers: ProviderWithModelList[] = [],
    agents: Agent[] = [],
): DirectoryScopedConfig => ({
    providers,
    agents,
    currentProviderId: "",
    currentModelId: "",
    currentVariant: undefined,
    currentAgentName: undefined,
    selectedProviderId: "",
    agentModelSelections: {},
    defaultProviders: {},
    opencodeDefaultAgent: undefined,
    opencodeDefaultModel: undefined,
    selectionSource: "auto",
    agentSelectionSource: "auto",
});

const resolveSelectionWithManualGuard = ({
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
}: {
    currentAgentName: string | undefined;
    currentProviderId: string;
    currentModelId: string;
    currentVariant: string | undefined;
    selectionSource: "auto" | "manual";
    agentSelectionSource: "auto" | "manual";
    resolvedAgentName: string | undefined;
    resolvedProviderId: string | undefined;
    resolvedModelId: string | undefined;
    resolvedVariant: string | null | undefined;
}) => {
    const manualAgentName = currentAgentName;
    const manualModelValid = !!currentProviderId
        && !!currentModelId;
    const userOwnsSelection = selectionSource === "manual" || (agentSelectionSource === "manual" && !!manualAgentName);
    const preserveManual = userOwnsSelection && (!!manualAgentName || manualModelValid);

    return {
        agentName: preserveManual ? (manualAgentName ?? resolvedAgentName) : resolvedAgentName,
        providerId: preserveManual && manualModelValid ? currentProviderId : resolvedProviderId,
        modelId: preserveManual && manualModelValid ? currentModelId : resolvedModelId,
        variant: preserveManual && manualModelValid ? currentVariant : resolvedVariant,
        selectionSource: preserveManual && selectionSource === "manual" ? "manual" as const : "auto" as const,
    };
};

interface ConfigStore {

    activeDirectoryKey: string;
    directoryScoped: Record<string, DirectoryScopedConfig>;
    configRuntimeKey: string;
    catalogReloadRevision: number;

    providers: ProviderWithModelList[];
    agents: Agent[];
    providersLoaded: boolean;
    agentsLoaded: boolean;
    currentProviderId: string;
    currentModelId: string;
    currentVariant: string | undefined;
    currentVariantSelection: CurrentVariantSelection;
    currentAgentName: string | undefined;
    selectedProviderId: string;
    agentModelSelections: { [agentName: string]: { providerId: string; modelId: string } };
    defaultProviders: { [key: string]: string };
    selectionSource: "auto" | "manual";
    agentSelectionSource: "auto" | "manual";
    isConnected: boolean;
    hasEverConnected: boolean;
    connectionPhase: "connecting" | "connected" | "reconnecting";
    lastDisconnectReason: string | null;
    lastInitFailure: InitFailure | null;
    projectConfigErrors: Record<string, ProjectConfigError>;
    settingsOnlyProviders: Record<string, ProviderWithModelList[]>;
    isInitialized: boolean;
    modelsMetadata: Map<string, ModelMetadata>;
    settingsDefaultModel: string | undefined;
    settingsDefaultsLoaded: boolean;
    settingsDefaultVariant: string | undefined;
    settingsDefaultAgent: string | undefined;
    opencodeDefaultAgent: string | undefined;
    opencodeDefaultModel: string | undefined;
    settingsAutoCreateWorktree: boolean;
    settingsGitmojiEnabled: boolean;
    settingsDefaultFileViewerPreview: boolean;
    settingsZenModel: string | undefined;
    settingsMessageStreamTransport: 'auto' | 'ws' | 'sse';
    voiceProvider: 'browser' | 'local' | 'openai' | 'openai-compatible' | 'say';
    setVoiceProvider: (provider: 'browser' | 'local' | 'openai' | 'openai-compatible' | 'say') => void;
    speechRate: number;
    speechPitch: number;
    speechVolume: number;
    sayVoice: string;
    browserVoice: string;
    localTtsVoiceId: number;
    localTtsModelId: string;
    ttsFollowTextLanguage: boolean;
    openaiVoice: string;
    voiceApiKeys: VoiceApiKeyState;
    openaiCompatibleUrl: string;
    openaiCompatibleVoice: string;
    openaiCompatibleTtsModel: string;
    openaiCompatibleTtsEndpointPath: string;
    dictationEnabled: boolean;
    dictationAutoSend: boolean;
    sttProvider: 'local' | 'openai-compatible';
    sttServerUrl: string;
    sttModel: string;
    sttEndpointPath: string;
    sttLocalModel: string;
    sttLanguage: string;
    sttCorrectTranscript: boolean;
    showMessageTTSButtons: boolean;
    autoReadAloudEnabled: boolean;
    ttsInputMode: 'sanitized' | 'raw' | 'summarized';
    ttsChunkedMode: boolean;
    summarizeMessageTTS: boolean;
    summarizeVoiceConversation: boolean;
    summarizeCharacterThreshold: number;
    summarizeMaxLength: number;
    setSpeechRate: (rate: number) => void;
    setSpeechPitch: (pitch: number) => void;
    setSpeechVolume: (volume: number) => void;
    setSayVoice: (voice: string) => void;
    setBrowserVoice: (voice: string) => void;
    setLocalTtsVoiceId: (voiceId: number) => void;
    setLocalTtsModelId: (modelId: string) => void;
    setTtsFollowTextLanguage: (enabled: boolean) => void;
    setOpenaiVoice: (voice: string) => void;
    setVoiceApiKey: (kind: VoiceApiKeyKind, apiKey: string | null) => Promise<boolean>;
    refreshVoiceApiKeys: (options?: { force?: boolean }) => Promise<void>;
    setOpenaiCompatibleUrl: (url: string) => void;
    setOpenaiCompatibleVoice: (voice: string) => void;
    setOpenaiCompatibleTtsModel: (model: string) => void;
    setOpenaiCompatibleTtsEndpointPath: (path: string) => void;
    setDictationEnabled: (enabled: boolean) => void;
    setDictationAutoSend: (enabled: boolean) => void;
    setSttProvider: (provider: 'local' | 'openai-compatible') => void;
    setSttServerUrl: (url: string) => void;
    setSttModel: (model: string) => void;
    setSttEndpointPath: (path: string) => void;
    setSttLocalModel: (model: string) => void;
    setSttLanguage: (lang: string) => void;
    setSttCorrectTranscript: (enabled: boolean) => void;
    setShowMessageTTSButtons: (show: boolean) => void;
    setAutoReadAloudEnabled: (enabled: boolean) => void;
    setTtsInputMode: (mode: 'sanitized' | 'raw' | 'summarized') => void;
    setTtsChunkedMode: (enabled: boolean) => void;
    setSummarizeMessageTTS: (enabled: boolean) => void;
    setSummarizeVoiceConversation: (enabled: boolean) => void;
    setSummarizeCharacterThreshold: (threshold: number) => void;
    setSummarizeMaxLength: (maxLength: number) => void;

    activateDirectory: (directory: string | null | undefined, options?: { preserveManualModel?: boolean }) => Promise<void>;

    loadProviders: (options?: { directory?: string | null; source?: string; fresh?: boolean }) => Promise<void>;
    loadSessionDefaults: () => Promise<boolean>;
    loadAgents: (options?: { directory?: string | null; source?: string; fresh?: boolean }) => Promise<boolean>;
    invalidateModelMetadataCache: () => void;
    invalidateProviderCache: (directory?: string | null) => void;
    setProvider: (providerId: string) => void;
    setModel: (modelId: string) => void;
    setCurrentVariant: (variant: string | undefined) => void;
    setCurrentVariantOverride: (override: string | null | undefined, inherited: string | null | undefined) => void;
    cycleCurrentVariant: () => string | undefined;
    getCurrentModelVariants: () => string[];
    getDefaultVariantForModel: (providerId: string, modelId: string, directory?: string | null) => string | undefined;
    setAgent: (agentName: string | undefined, options?: { keepModel?: boolean }) => void;
    applyDefaultModelAgentSelection: (options?: { projectDefaultAgent?: string; projectDefaultModel?: string; projectDefaultVariant?: string }) => void;
    resolveDirectoryDefaultSelection: (directory: string) => Promise<DirectoryDefaultSelection | null>;
    dropStaleAutoSelection: () => void;
    applyOpenCodeConfigDefaults: (directory?: string | null, source?: string, config?: Config) => void;
    setSelectedProvider: (providerId: string) => void;
    setSettingsDefaultModel: (model: string | undefined) => void;
    setSettingsDefaultVariant: (variant: string | undefined) => void;
    setSettingsDefaultAgent: (agent: string | undefined) => void;
    setSettingsAutoCreateWorktree: (enabled: boolean) => void;
    setSettingsGitmojiEnabled: (enabled: boolean) => void;
    setSettingsDefaultFileViewerPreview: (enabled: boolean) => void;
    setSettingsZenModel: (model: string | undefined) => void;
    setSettingsMessageStreamTransport: (transport: 'auto' | 'ws' | 'sse') => void;
    getResolvedGitGenerationModel: () => { providerId: string; modelId: string } | null;
    saveAgentModelSelection: (agentName: string, providerId: string, modelId: string) => void;
    getAgentModelSelection: (agentName: string) => { providerId: string; modelId: string } | null;
    probeConnection: (options?: { timeoutMs?: number }) => Promise<boolean>;
    checkConnection: () => Promise<boolean>;
    initializeApp: () => Promise<void>;
    getCurrentProvider: () => ProviderWithModelList | undefined;
    getCurrentModel: () => ProviderModel | undefined;
    getCurrentAgent: () => Agent | undefined;
    getModelMetadata: (providerId: string, modelId: string) => ModelMetadata | undefined;
    getVisibleAgents: () => Agent[];
}

declare global {
    interface Window {
        __zustand_config_store__?: UseBoundStore<StoreApi<ConfigStore>>;
    }
}

export type InitFailure = {
    step: 'serverUnreachable' | 'openCodeUnavailable' | 'loadAgents' | 'unexpected';
    message: string | null;
};

const _inFlightProviders = new Map<string, Promise<void>>();
const _inFlightAgents = new Map<string, Promise<boolean>>();
const _agentsLoadGeneration = new Map<string, number>();
let _initializeAppInFlight: Promise<void> | null = null;

export const invalidateConfigAgentsLoad = (directory?: string | null): void => {
    const runtimeContext = captureConfigRuntimeContext();
    const directoryKey = toConfigDirectoryKey(directory ?? fromDirectoryKey(useConfigStore.getState().activeDirectoryKey));
    const inFlightKey = getConfigLoadKey(runtimeContext, directoryKey);
    _agentsLoadedAt.delete(directoryKey);
    _agentsLoadGeneration.set(inFlightKey, (_agentsLoadGeneration.get(inFlightKey) ?? 0) + 1);
    _inFlightAgents.delete(inFlightKey);
    opencodeClient.invalidateAgentList(fromDirectoryKey(directoryKey));
};

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

const EMPTY_PROVIDERS: ProviderWithModelList[] = [];
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

let voiceApiKeysLoad: { runtimeKey: string; promise: Promise<void> } | null = null;

export const useConfigStore = create<ConfigStore>()(
    devtools(
        persist(
            (set, get) => ({

                activeDirectoryKey: resolveInitialDirectoryKey(),
                directoryScoped: {},
                configRuntimeKey: getRuntimeKey(),
                catalogReloadRevision: 0,

                providers: [],
                agents: [],
                providersLoaded: false,
                agentsLoaded: false,
                currentProviderId: "",
                currentModelId: "",
                currentVariant: undefined,
                currentVariantSelection: { override: undefined, inherited: undefined },
                currentAgentName: undefined,
                selectedProviderId: "",
                agentModelSelections: {},
                defaultProviders: {},
                selectionSource: "auto",
                agentSelectionSource: "auto",
                isConnected: false,
                hasEverConnected: false,
                connectionPhase: "connecting",
                lastDisconnectReason: null,
                lastInitFailure: null,
                projectConfigErrors: {},
                settingsOnlyProviders: {},
                isInitialized: false,
                modelsMetadata: new Map<string, ModelMetadata>(),
                settingsDefaultModel: undefined,
                settingsDefaultsLoaded: false,
                settingsDefaultVariant: undefined,
                settingsDefaultAgent: undefined,
                opencodeDefaultAgent: undefined,
                opencodeDefaultModel: undefined,
                settingsAutoCreateWorktree: false,
                settingsGitmojiEnabled: false,
                settingsDefaultFileViewerPreview: true,
                settingsZenModel: undefined,
                settingsMessageStreamTransport: 'auto',
                voiceProvider: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('voiceProvider');
                        if (saved === 'openai' || saved === 'browser' || saved === 'local' || saved === 'say' || saved === 'openai-compatible') return saved;
                    }
                    return 'browser';
                })(),
                speechRate: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('speechRate');
                        if (saved) {
                            const parsed = parseFloat(saved);
                            if (!isNaN(parsed) && parsed >= 0.5 && parsed <= 2) return parsed;
                        }
                    }
                    return 1;
                })(),
                speechPitch: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('speechPitch');
                        if (saved) {
                            const parsed = parseFloat(saved);
                            if (!isNaN(parsed) && parsed >= 0.5 && parsed <= 2) return parsed;
                        }
                    }
                    return 1;
                })(),
                speechVolume: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('speechVolume');
                        if (saved) {
                            const parsed = parseFloat(saved);
                            if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
                        }
                    }
                    return 1;
                })(),
                sayVoice: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sayVoice');
                        if (saved) return saved;
                    }
                    return 'Samantha';
                })(),
                localTtsVoiceId: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('localTtsVoiceId');
                        if (saved !== null) {
                            const parsed = Number.parseInt(saved, 10);
                            if (Number.isInteger(parsed) && parsed >= 0) return parsed;
                        }
                    }
                    return 0;
                })(),
                localTtsModelId: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('localTtsModelId');
                        if (saved) return saved;
                    }
                    return 'kokoro-en-v0_19';
                })(),

                ttsFollowTextLanguage: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('ttsFollowTextLanguage');
                        if (saved !== null) return saved === 'true';
                    }
                    return true;
                })(),
                browserVoice: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('browserVoice');
                        if (saved) return saved;
                    }
                    return '';
                })(),
                openaiVoice: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiVoice');
                        if (saved) return saved;
                    }
                    return 'nova';
                })(),
                voiceApiKeys: EMPTY_VOICE_API_KEYS,
                openaiCompatibleUrl: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiCompatibleUrl');
                        if (saved) return saved;
                    }
                    return '';
                })(),
                openaiCompatibleVoice: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiCompatibleVoice');
                        if (saved) return saved;
                    }
                    return 'af_sky';
                })(),
                openaiCompatibleTtsModel: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiCompatibleTtsModel');
                        if (saved && saved !== 'speaches-ai/Kokoro-82M-v1.0-ONNX') return saved;
                    }
                    return 'kokoro';
                })(),
                openaiCompatibleTtsEndpointPath: getSafeStorage().getItem('openaiCompatibleTtsEndpointPath') ?? '',
                dictationEnabled: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('dictationEnabled');
                        if (saved === 'false') return false;
                    }
                    return true;
                })(),
                dictationAutoSend: getSafeStorage().getItem('dictationAutoSend') === 'true',
                sttProvider: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttProvider');
                        if (saved === 'local' || saved === 'openai-compatible') return saved;
                        if (saved === 'server') return 'openai-compatible' as const;
                    }
                    return 'local' as const;
                })(),
                sttServerUrl: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttServerUrl');
                        if (saved) return saved;
                    }
                    return 'http://localhost:8001/v1';
                })(),
                sttModel: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttModel');
                        if (saved) return saved;
                    }
                    return 'deepdml/faster-whisper-large-v3-turbo-ct2';
                })(),
                sttEndpointPath: getSafeStorage().getItem('sttEndpointPath') ?? '',
                sttLocalModel: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttLocalModel');
                        if (saved) return saved;
                    }
                    return '';
                })(),
                sttLanguage: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttLanguage');
                        if (saved !== null) return saved;
                    }
                    return '';
                })(),
                sttCorrectTranscript: globalThis.localStorage?.getItem('sttCorrectTranscript') === 'true',
                showMessageTTSButtons: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('showMessageTTSButtons');
                        if (saved === 'true') return true;
                    }
                    return false;
                })(),
                autoReadAloudEnabled: (() => {
                    const saved = globalThis.window?.localStorage?.getItem('autoReadAloudEnabled');
                    return saved === 'true';
                })(),
                ttsInputMode: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('ttsInputMode');
                        if (saved === 'raw') return 'raw' as const;
                        if (saved === 'summarized') return 'summarized' as const;
                    }
                    return 'sanitized' as const;
                })(),
                ttsChunkedMode: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('ttsChunkedMode');
                        if (saved === 'true') return true;
                    }
                    return false;
                })(),
                summarizeMessageTTS: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('summarizeMessageTTS');
                        if (saved === 'true') return true;
                    }
                    return false;
                })(),
                summarizeVoiceConversation: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('summarizeVoiceConversation');
                        if (saved === 'true') return true;
                    }
                    return false;
                })(),
                summarizeCharacterThreshold: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('summarizeCharacterThreshold');
                        if (saved) {
                            const parsed = parseInt(saved, 10);
                            if (!isNaN(parsed) && parsed >= 50 && parsed <= 2000) return parsed;
                        }
                    }
                    return 200;
                })(),
                summarizeMaxLength: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('summarizeMaxLength');
                        if (saved) {
                            const parsed = parseInt(saved, 10);
                            if (!isNaN(parsed) && parsed >= 50 && parsed <= 2000) return parsed;
                        }
                    }
                    return 500;
                })(),
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

                    const catalogEpoch = _configCatalogLoadEpoch;
                    const isCurrentProviderLoad = () => (
                        isConfigRuntimeContextCurrent(runtimeContext)
                        && _configCatalogLoadEpoch === catalogEpoch
                    );

                    const promise: Promise<void> = (async () => {
                    if (!isCurrentProviderLoad()) return;
                    const loadRevision = _catalogRevision;
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
                                    fallbackPrefs: readFallbackModelPrefs(),
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

                setCurrentVariantOverride: (override, inherited) => {
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
                    return resolveConfiguredDefaultVariant({
                        ...(configDirectory
                            ? readProjectDefaults(configDirectory)
                            : getProjectDefaultsForConfigDirectory(fromDirectoryKey(state.activeDirectoryKey))),
                        settingsDefaultModel: state.settingsDefaultModel,
                        settingsDefaultVariant: state.settingsDefaultVariant,
                    }, providerId, modelId);
                },

                cycleCurrentVariant: () => {
                    const variantKeys = get().getCurrentModelVariants();
                    if (variantKeys.length === 0) {
                        return undefined;
                    }

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

                loadSessionDefaults: async () => {
                    const runtimeContext = captureConfigRuntimeContext();
                    const revision = openChamberDefaultsUserRevision;
                    const defaults = await fetchOpenChamberDefaults(runtimeContext);
                    if (!isConfigRuntimeContextCurrent(runtimeContext) || !defaults) return false;

                    set((state) => {
                        const edited = revision !== openChamberDefaultsUserRevision;
                        const next: Partial<ConfigStore> = {
                            configRuntimeKey: runtimeContext.runtimeKey,
                            settingsDefaultsLoaded: true,
                            settingsDefaultModel: edited ? state.settingsDefaultModel : defaults.defaultModel,
                            settingsDefaultVariant: edited ? state.settingsDefaultVariant : defaults.defaultVariant,
                            settingsDefaultAgent: edited ? state.settingsDefaultAgent : defaults.defaultAgent,
                            settingsAutoCreateWorktree: defaults.autoCreateWorktree ?? false,
                            settingsGitmojiEnabled: defaults.gitmojiEnabled ?? false,
                            settingsDefaultFileViewerPreview: defaults.defaultFileViewerPreview ?? true,
                            settingsZenModel: defaults.zenModel,
                            settingsMessageStreamTransport: defaults.messageStreamTransport ?? state.settingsMessageStreamTransport,
                            dictationEnabled: typeof defaults.dictationEnabled === 'boolean' ? defaults.dictationEnabled : state.dictationEnabled,
                            dictationAutoSend: defaults.dictationAutoSend ?? state.dictationAutoSend,
                            sttProvider: defaults.sttProvider ?? state.sttProvider,
                            sttServerUrl: defaults.sttServerUrl ?? state.sttServerUrl,
                            sttModel: defaults.sttModel ?? state.sttModel,
                            sttEndpointPath: defaults.sttEndpointPath ?? state.sttEndpointPath,
                            sttLocalModel: defaults.sttLocalModel ?? state.sttLocalModel,
                            sttLanguage: defaults.sttLanguage ?? state.sttLanguage,
                            sttCorrectTranscript: defaults.sttCorrectTranscript ?? state.sttCorrectTranscript,
                        };
                        if (!useSessionUIStore.getState().currentSessionId && state.selectionSource === 'auto' && state.agentSelectionSource === 'auto' && next.settingsDefaultAgent) {
                            next.currentAgentName = next.settingsDefaultAgent;
                        }
                        return next;
                    });
                    const state = get();
                    const projectDefaults = getProjectDefaultsForConfigDirectory(fromDirectoryKey(state.activeDirectoryKey));
                    if (!useSessionUIStore.getState().currentSessionId && state.selectionSource === 'auto' && state.agentSelectionSource === 'auto'
                        && state.currentVariantSelection.override === undefined
                        && (projectDefaults.projectDefaultModel || state.settingsDefaultModel)) {
                        state.applyDefaultModelAgentSelection(projectDefaults);
                    }
                    markStartupTrace('config.defaults:published');
                    return true;
                },

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
                    const entryCatalogEpoch = _configCatalogLoadEpoch;
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
                        if (_configCatalogLoadEpoch !== entryCatalogEpoch
                            || (_agentsLoadGeneration.get(inFlightKey) ?? 0) !== joinedGeneration) {
                            return get().loadAgents({ directory: configDirectory, source });
                        }
                        return loaded;
                    }

                    const catalogEpoch = _configCatalogLoadEpoch;
                    const loadGeneration = _agentsLoadGeneration.get(inFlightKey) ?? 0;
                    const isCurrentAgentLoad = () => (
                        isConfigRuntimeContextCurrent(runtimeContext)
                        && _configCatalogLoadEpoch === catalogEpoch
                        && (_agentsLoadGeneration.get(inFlightKey) ?? 0) === loadGeneration
                    );
                    const promise = (async (): Promise<boolean> => {
                    if (!isCurrentAgentLoad()) return false;
                    const loadRevision = _catalogRevision;
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
                                fallbackPrefs: readFallbackModelPrefs(),
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

                invalidateModelMetadataCache: () => {
                    modelsMetadataInFlight = null;
                    set({ modelsMetadata: new Map<string, ModelMetadata>() });
                },

                setAgent: (agentName: string | undefined, options?: { keepModel?: boolean }) => {
                    const {
                        agents,
                        providers,
                        settingsDefaultModel,
                        currentProviderId,
                        currentModelId,
                        currentAgentName,
                    } = get();
                    const hadManualSelection = get().selectionSource === "manual";
                    const agentSelectionSource = agentName ? "manual" as const : "auto" as const;

                    if (!isUnchangedSelection(get(), { currentAgentName: agentName, agentSelectionSource })) {
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
                                currentAgentName: agentName,
                                agentSelectionSource,
                            };

                            return {
                                currentAgentName: agentName,
                                agentSelectionSource,
                                directoryScoped: {
                                    ...state.directoryScoped,
                                    [directoryKey]: nextSnapshot,
                                },
                            };
                        });
                    }

                    if (agentName) {
                        const { currentSessionId } = useSessionUIStore.getState();
                        const selState = useSelectionStore.getState();

                        if (currentSessionId) {
                            selState.saveSessionAgentSelection(currentSessionId, agentName);
                        }

                        if (currentSessionId && useSessionUIStore.getState().isOpenChamberCreatedSession(currentSessionId)) {
                            const existingAgentModel = selState.getAgentModelForSession(currentSessionId, agentName);
                            if (!existingAgentModel) {
                                useSessionUIStore.getState().initializeNewOpenChamberSession(currentSessionId, agents);
                            }
                        }
                    }

                    if (agentName && !options?.keepModel) {
                        const { currentSessionId } = useSessionUIStore.getState();

                        const applyResolvedModelSelection = (
                            providerId: string,
                            modelId: string,
                            variantSelection: CurrentVariantSelection,
                            source: "auto" | "manual" = "manual",
                        ) => {
                            const variant = resolveVariantFromSelection(variantSelection);
                            const current = get();
                            if (
                                current.currentProviderId === providerId
                                && current.currentModelId === modelId
                                && current.currentVariant === variant
                                && current.currentVariantSelection.override === variantSelection.override
                                && current.currentVariantSelection.inherited === variantSelection.inherited
                                && current.selectionSource === source
                            ) {
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

                                const nextSnapshot: DirectoryScopedConfig = {
                                    ...baseSnapshot,
                                    currentProviderId: providerId,
                                    currentModelId: modelId,
                                    currentVariant: variant,
                                    currentVariantSelection: variantSelection,
                                    selectionSource: source,
                                };

                                return {
                                    currentProviderId: providerId,
                                    currentModelId: modelId,
                                    currentVariant: variant,
                                    currentVariantSelection: variantSelection,
                                    selectionSource: source,
                                    directoryScoped: {
                                        ...state.directoryScoped,
                                        [directoryKey]: nextSnapshot,
                                    },
                                };
                            });
                        };

                        const agent = agents.find((candidate) => candidate.name === agentName);

                        const resolveVariantSelectionForModel = (
                            providerId: string,
                            modelId: string,
                        ): CurrentVariantSelection => {
                            const model = findProviderModel(providers, providerId, modelId);
                            const variantOptions = model ? modelVariantNames(model) : undefined;
                            if (variantOptions && variantOptions.length === 0) return { override: undefined, inherited: undefined };

                            const isAvailable = (candidate: string | null | undefined): candidate is string => (
                                candidate !== null
                                && candidate !== undefined
                                && (!model || modelHasVariant(model, candidate))
                            );

                            const agentVariant = agent?.model?.providerID === providerId && agent.model.id === modelId
                                ? agent.model.variant
                                : undefined;
                            const configuredVariant = get().getDefaultVariantForModel(providerId, modelId);
                            const inherited = variantOptions
                                ? resolveEffortChoice(
                                    [agentVariant, configuredVariant, readRememberedEffort(providerId, modelId)],
                                    variantOptions,
                                )
                                : [agentVariant, configuredVariant].find(isAvailable);

                            const savedVariant = currentSessionId
                                ? useSelectionStore.getState().getAgentModelVariantForSession(
                                    currentSessionId,
                                    agentName,
                                    providerId,
                                    modelId,
                                )
                                : undefined;
                            if (savedVariant === null || isAvailable(savedVariant)) {
                                return { override: savedVariant, inherited };
                            }

                            const liveSelection = get().currentVariantSelection;
                            const sameModel = get().currentProviderId === providerId && get().currentModelId === modelId;
                            if (!currentSessionId && sameModel && (liveSelection.override === null || isAvailable(liveSelection.override))) {
                                return { override: liveSelection.override, inherited };
                            }

                            return { override: undefined, inherited };
                        };

                        const livePick = currentSessionId
                            ? useSelectionStore.getState().getSessionModelPick(currentSessionId)
                            : null;
                        const hasLiveModelPick = currentSessionId
                            ? livePick?.providerId === currentProviderId && livePick.modelId === currentModelId
                            : hadManualSelection && Boolean(currentProviderId && currentModelId);
                        if (hasLiveModelPick) {
                            if (currentSessionId) {
                                const selection = useSelectionStore.getState();
                                selection.saveSessionModelSelection(currentSessionId, currentProviderId, currentModelId);
                                selection.saveAgentModelForSession(currentSessionId, agentName, currentProviderId, currentModelId);
                            }
                            return;
                        }

                        if (currentSessionId) {
                            const existingAgentModel = useSelectionStore.getState().getAgentModelForSession(currentSessionId, agentName);
                            if (existingAgentModel) {
                                applyResolvedModelSelection(
                                    existingAgentModel.providerId,
                                    existingAgentModel.modelId,
                                    resolveVariantSelectionForModel(existingAgentModel.providerId, existingAgentModel.modelId),
                                    "manual",
                                );
                                return;
                            }
                        }

                        const agentModelSelection = agent?.model;
                        if (agentModelSelection?.providerID && agentModelSelection?.id) {
                            const { providerID, id: modelID } = agentModelSelection;
                            const agentProvider = providers.find((provider) => provider.id === providerID);
                            const agentModel = findCatalogModel(agentProvider?.models, modelID);

                            if (agentModel) {
                                applyResolvedModelSelection(
                                    providerID,
                                    modelID,
                                    resolveVariantSelectionForModel(providerID, modelID),
                                    "auto",
                                );
                                return;
                            }
                        }

                        const prevAgent = agents.find((candidate) => candidate.name === currentAgentName);
                        const prevAgentHasPinnedModel = Boolean(
                            prevAgent?.model?.providerID
                            && prevAgent?.model?.id
                            && prevAgent.model.providerID === currentProviderId
                            && prevAgent.model.id === currentModelId
                        );
                        const targetHasPinnedModel = Boolean(agent?.model?.providerID && agent?.model?.id);

                        if (
                            !targetHasPinnedModel
                            && !prevAgentHasPinnedModel
                            && hadManualSelection
                            && currentProviderId
                            && currentModelId
                        ) {
                            if (currentSessionId) {
                                const selection = useSelectionStore.getState();
                                selection.saveSessionModelSelection(currentSessionId, currentProviderId, currentModelId);
                                selection.saveAgentModelForSession(currentSessionId, agentName, currentProviderId, currentModelId);
                            }
                            return;
                        }

                        if (settingsDefaultModel) {
                            const parsed = parseModelString(settingsDefaultModel);
                            if (parsed) {
                                const settingsProvider = providers.find((p) => p.id === parsed.providerId);
                                if (findCatalogModel(settingsProvider?.models, parsed.modelId)) {
                                    applyResolvedModelSelection(
                                        parsed.providerId,
                                        parsed.modelId,
                                        resolveVariantSelectionForModel(parsed.providerId, parsed.modelId),
                                        "auto",
                                    );
                                    return;
                                }
                            }
                        }

                    }
                },

                dropStaleAutoSelection: () => {
                    const current = get();
                    if (!isStaleAutoSelection(current.currentProviderId, current.currentModelId)) return;
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
                        fallbackPrefs: readFallbackModelPrefs(),
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
                        fallbackPrefs: readFallbackModelPrefs(),
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
                        fallbackPrefs: readFallbackModelPrefs(),
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
                            fallbackPrefs: readFallbackModelPrefs(),
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

                 setSettingsDefaultModel: (model: string | undefined) => {
                     recordOpenChamberDefaultsChange();
                     set({ settingsDefaultModel: model });
                     if (!useSessionUIStore.getState().currentSessionId) get().applyDefaultModelAgentSelection();
                 },

                 setSettingsDefaultVariant: (variant: string | undefined) => {
                     recordOpenChamberDefaultsChange();
                     set({ settingsDefaultVariant: variant });
                     if (!useSessionUIStore.getState().currentSessionId) get().applyDefaultModelAgentSelection();
                 },
 
                 setSettingsDefaultAgent: (agent: string | undefined) => {
                     recordOpenChamberDefaultsChange();
                     set({ settingsDefaultAgent: agent });
                     if (!useSessionUIStore.getState().currentSessionId) get().applyDefaultModelAgentSelection();
                 },

                setSettingsAutoCreateWorktree: (enabled: boolean) => {
                    set({ settingsAutoCreateWorktree: enabled });
                },

                setSettingsGitmojiEnabled: (enabled: boolean) => {
                    set({ settingsGitmojiEnabled: enabled });
                },

                setSettingsDefaultFileViewerPreview: (enabled: boolean) => {
                    set({ settingsDefaultFileViewerPreview: enabled });
                },

                setSettingsZenModel: (model: string | undefined) => {
                    set({ settingsZenModel: model });
                },

                setSettingsMessageStreamTransport: (transport: 'auto' | 'ws' | 'sse') => {
                    set({ settingsMessageStreamTransport: transport });
                },

                getResolvedGitGenerationModel: () => {
                    const state = get();
                    return resolveGitGenerationModelSelection({
                        providers: state.providers,
                        settingsZenModel: state.settingsZenModel,
                    });
                },

                setVoiceProvider: (provider: 'browser' | 'local' | 'openai' | 'openai-compatible' | 'say') => {
                    set({ voiceProvider: provider });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('voiceProvider', provider);
                    }
                },

                setSpeechRate: (rate: number) => {
                    const clampedRate = Math.max(0.5, Math.min(2, rate));
                    set({ speechRate: clampedRate });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('speechRate', String(clampedRate));
                    }
                },

                setSpeechPitch: (pitch: number) => {
                    const clampedPitch = Math.max(0.5, Math.min(2, pitch));
                    set({ speechPitch: clampedPitch });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('speechPitch', String(clampedPitch));
                    }
                },

                setSpeechVolume: (volume: number) => {
                    const clampedVolume = Math.max(0, Math.min(1, volume));
                    set({ speechVolume: clampedVolume });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('speechVolume', String(clampedVolume));
                    }
                },

                setSayVoice: (voice: string) => {
                    set({ sayVoice: voice });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sayVoice', voice);
                    }
                },

                setLocalTtsVoiceId: (voiceId: number) => {
                    set({ localTtsVoiceId: voiceId });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('localTtsVoiceId', String(voiceId));
                    }
                },

                setLocalTtsModelId: (modelId: string) => {
                    set({ localTtsModelId: modelId });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('localTtsModelId', modelId);
                    }
                },

                setTtsFollowTextLanguage: (enabled: boolean) => {
                    set({ ttsFollowTextLanguage: enabled });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('ttsFollowTextLanguage', String(enabled));
                    }
                },

                setBrowserVoice: (voice: string) => {
                    set({ browserVoice: voice });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('browserVoice', voice);
                    }
                },

                setOpenaiVoice: (voice: string) => {
                    set({ openaiVoice: voice });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiVoice', voice);
                    }
                },

                setVoiceApiKey: async (kind, apiKey) => {
                    try {
                        set({ voiceApiKeys: await updateVoiceApiKeys({ [kind]: apiKey }) });
                        return true;
                    } catch (error) {
                        console.warn('Failed to save voice API key:', error);
                        return false;
                    }
                },

                refreshVoiceApiKeys: (options) => {
                    const runtimeKey = getRuntimeKey();
                    if (!options?.force && voiceApiKeysLoad?.runtimeKey === runtimeKey) {
                        return voiceApiKeysLoad.promise;
                    }
                    const promise = (async () => {
                        try {
                            const migrated = await migrateLegacyVoiceApiKeys();
                            const voiceApiKeys = migrated ?? await fetchVoiceApiKeys();
                            if (getRuntimeKey() === runtimeKey) set({ voiceApiKeys });
                        } catch (error) {
                            if (getRuntimeKey() === runtimeKey) set({ voiceApiKeys: EMPTY_VOICE_API_KEYS });
                            console.warn('Failed to read voice API keys:', error);
                        }
                    })();
                    voiceApiKeysLoad = { runtimeKey, promise };
                    return promise;
                },

                setOpenaiCompatibleUrl: (url: string) => {
                    set({ openaiCompatibleUrl: url });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiCompatibleUrl', url);
                    }
                },


                setOpenaiCompatibleVoice: (voice: string) => {
                    set({ openaiCompatibleVoice: voice });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiCompatibleVoice', voice);
                    }
                },

                setOpenaiCompatibleTtsModel: (model: string) => {
                    set({ openaiCompatibleTtsModel: model });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiCompatibleTtsModel', model);
                    }
                },

                setOpenaiCompatibleTtsEndpointPath: (path: string) => {
                    set({ openaiCompatibleTtsEndpointPath: path });
                    getSafeStorage().setItem('openaiCompatibleTtsEndpointPath', path);
                },

                setDictationEnabled: (enabled: boolean) => {
                    set({ dictationEnabled: enabled });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('dictationEnabled', String(enabled));
                    }
                    updateDesktopSettings({ dictationEnabled: enabled }).catch(() => {});
                },

                setSttCorrectTranscript: (enabled: boolean) => {
                    set({ sttCorrectTranscript: enabled });
                    globalThis.localStorage?.setItem('sttCorrectTranscript', String(enabled));
                    updateDesktopSettings({ sttCorrectTranscript: enabled }).catch(() => {});
                },

                setDictationAutoSend: (enabled: boolean) => {
                    set({ dictationAutoSend: enabled });
                    getSafeStorage().setItem('dictationAutoSend', String(enabled));
                    updateDesktopSettings({ dictationAutoSend: enabled }).catch(() => {});
                },

                setSttProvider: (provider: 'local' | 'openai-compatible') => {
                    set({ sttProvider: provider });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttProvider', provider);
                    }
                    updateDesktopSettings({ sttProvider: provider }).catch(() => {});
                },

                setSttServerUrl: (url: string) => {
                    set({ sttServerUrl: url });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttServerUrl', url);
                    }
                    updateDesktopSettings({ sttServerUrl: url }).catch(() => {});
                },


                setSttModel: (model: string) => {
                    set({ sttModel: model });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttModel', model);
                    }
                    updateDesktopSettings({ sttModel: model }).catch(() => {});
                },

                setSttEndpointPath: (path: string) => {
                    set({ sttEndpointPath: path });
                    getSafeStorage().setItem('sttEndpointPath', path);
                    updateDesktopSettings({ sttEndpointPath: path }).catch(() => {});
                },

                setSttLocalModel: (model: string) => {
                    set({ sttLocalModel: model });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttLocalModel', model);
                    }
                    updateDesktopSettings({ sttLocalModel: model }).catch(() => {});
                },

                setSttLanguage: (lang: string) => {
                    set({ sttLanguage: lang });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttLanguage', lang);
                    }
                    updateDesktopSettings({ sttLanguage: lang }).catch(() => {});
                },

                setShowMessageTTSButtons: (show: boolean) => {
                    set({ showMessageTTSButtons: show });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('showMessageTTSButtons', String(show));
                    }
                },

                setAutoReadAloudEnabled: (enabled: boolean) => {
                    set({ autoReadAloudEnabled: enabled });
                    globalThis.window?.localStorage?.setItem('autoReadAloudEnabled', String(enabled));
                },

                setTtsInputMode: (mode: 'sanitized' | 'raw' | 'summarized') => {
                    set({ ttsInputMode: mode });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('ttsInputMode', mode);
                    }
                },

                setTtsChunkedMode: (enabled: boolean) => {
                    set({ ttsChunkedMode: enabled });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('ttsChunkedMode', String(enabled));
                    }
                },

                setSummarizeMessageTTS: (enabled: boolean) => {
                    set({ summarizeMessageTTS: enabled });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('summarizeMessageTTS', String(enabled));
                    }
                },

                setSummarizeVoiceConversation: (enabled: boolean) => {
                    set({ summarizeVoiceConversation: enabled });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('summarizeVoiceConversation', String(enabled));
                    }
                },

                setSummarizeCharacterThreshold: (threshold: number) => {
                    const clamped = Math.max(50, Math.min(2000, threshold));
                    set({ summarizeCharacterThreshold: clamped });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('summarizeCharacterThreshold', String(clamped));
                    }
                },

                setSummarizeMaxLength: (maxLength: number) => {
                    const clamped = Math.max(50, Math.min(2000, maxLength));
                    set({ summarizeMaxLength: clamped });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('summarizeMaxLength', String(clamped));
                    }
                },

                probeConnection: async (options?: { timeoutMs?: number }) => {
                    const isHealthy = await probeOpenCodeHealth(options?.timeoutMs);
                    if (isHealthy) {
                        set({ isConnected: true, hasEverConnected: true, connectionPhase: "connected" });
                        return true;
                    }

                    const state = get();
                    if (state.isConnected) {
                        return true;
                    }

                    set({
                        isConnected: false,
                        connectionPhase: state.hasEverConnected ? "reconnecting" : "connecting",
                        lastDisconnectReason: 'health_probe_unhealthy',
                    });
                    return false;
                },

                checkConnection: async () => {
                    const runtimeContext = captureConfigRuntimeContext();
                    markStartupTrace('checkConnection:start');
                    const maxAttempts = 5;
                    let attempt = 0;
                    let lastError: unknown = null;
                    let lastProbe: OpencodeHealthProbe = 'unreachable';

                    while (attempt < maxAttempts) {
                        if (!isConfigRuntimeContextCurrent(runtimeContext)) return false;
                        try {
                            markStartupTrace('checkConnection:attempt', { attempt: attempt + 1 });
                            const probeStarted = Date.now();
                            lastProbe = await measureStartupTrace(
                                'checkConnection:health',
                                () => opencodeClient.probeHealth({ waitMs: CONNECTION_HEALTH_WAIT_MS }),
                                { attempt: attempt + 1 },
                            );
                            const isHealthy = lastProbe === 'healthy';
                            if (!isConfigRuntimeContextCurrent(runtimeContext)) return false;
                            if (!isHealthy && attempt < maxAttempts - 1) {
                                const hasEverConnected = get().hasEverConnected;
                                set({
                                    isConnected: false,
                                    connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
                                    lastDisconnectReason: 'health_check_unhealthy',
                                });
                                attempt += 1;
                                await sleep(Math.max(0, 400 * attempt - (Date.now() - probeStarted)));
                                continue;
                            }

                            const hasEverConnected = get().hasEverConnected;
                            set(isHealthy
                                ? { isConnected: true, hasEverConnected: true, connectionPhase: "connected" }
                                : {
                                    isConnected: false,
                                    connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
                                    lastDisconnectReason: lastProbe === 'unreachable' ? 'health_check_failed' : 'health_check_unhealthy',
                                });
                            markStartupTrace('checkConnection:end', { healthy: isHealthy, attempts: attempt + 1 });
                            return isHealthy;
                        } catch (error) {
                            lastError = error;
                            attempt += 1;
                            const delay = 400 * attempt;
                            await sleep(delay);
                        }
                    }

                    if (!isConfigRuntimeContextCurrent(runtimeContext)) return false;
                    if (lastError) {
                        console.warn("[ConfigStore] Failed to reach OpenCode after retrying:", lastError);
                    }
                    set({
                        isConnected: false,
                        connectionPhase: get().hasEverConnected ? "reconnecting" : "connecting",
                        lastDisconnectReason: 'health_check_failed',
                    });
                    markStartupTrace('checkConnection:end', { healthy: false, attempts: maxAttempts });
                    return false;
                },

                initializeApp: async () => {
                    if (_initializeAppInFlight) {
                        markStartupTrace('initializeApp:deduped');
                        return _initializeAppInFlight;
                    }

                    const runtimeContext = captureConfigRuntimeContext();
                    const instanceGeneration = configInstanceGeneration;
                    const run = (async () => {
                        const initStarted = typeof performance !== 'undefined' ? performance.now() : Date.now();
                        markStartupTrace('initializeApp:start');
                        try {
                            const debug = streamDebugEnabled();
                            if (debug) console.log("Starting app initialization...");

                            void get().loadSessionDefaults();
                            const isConnected = await get().checkConnection();
                            if (!isConfigRuntimeContextCurrent(runtimeContext)) return;
                            if (debug) console.log("Connection check result:", isConnected);

                            if (!isConnected) {
                                if (debug) console.log("Server not connected");
                                set({
                                    isConnected: false,
                                    connectionPhase: get().hasEverConnected ? "reconnecting" : "connecting",
                                    lastInitFailure: {
                                        step: get().lastDisconnectReason === 'health_check_unhealthy' ? 'openCodeUnavailable' : 'serverUnreachable',
                                        message: null,
                                    },
                                });
                                return;
                            }

                            if (debug) console.log("Initializing app...");
                            markStartupTrace('initApp:skipped', { reason: 'checkConnection already verified health' });


                            const initialDirectory = opencodeClient.getDirectory()
                                ?? useDirectoryStore.getState().currentDirectory
                                ?? fromDirectoryKey(get().activeDirectoryKey);
                            const resolvedProject = isSpaceDirectory(initialDirectory) ? null : resolveProjectForSessionDirectory(
                                useProjectsStore.getState().projects,
                                useSessionUIStore.getState().availableWorktreesByProject,
                                initialDirectory ?? null,
                            );
                            const resolvedInitialDirectory = (resolvedProject || resolveProjectDirectory(initialDirectory))
                                ? resolveConfigDirectory(initialDirectory)
                                : null;
                            const chatsRoot = isChatDraftOpen() ? await resolveChatsRootDirectory().catch(() => null) : null;
                            if (!isConfigRuntimeContextCurrent(runtimeContext)) return;
                            const chatDraftDirectory = isChatDraftOpen() ? resolveConfigDirectory(chatsRoot) : null;
                            const sessionState = useSessionUIStore.getState();
                            const openSessionDirectory = sessionState.currentSessionId
                                ? resolveConfigDirectory(sessionState.currentSessionDirectory)
                                : null;
                            const configDirectory = openSessionDirectory ?? chatDraftDirectory ?? resolvedInitialDirectory ?? getFallbackProjectDirectory();
                            if (!configDirectory) {
                                markStartupTrace('initializeApp:noProjectConfigDirectory');
                                set({ isInitialized: true, isConnected: true, hasEverConnected: true, connectionPhase: "connected", lastInitFailure: null });
                                return;
                            }
                            if (!openSessionDirectory && !chatDraftDirectory && !resolvedInitialDirectory && initialDirectory !== configDirectory) {
                                markStartupTrace('initializeApp:normalizedUnknownDirectoryToProject', {
                                    initialDirectory,
                                    configDirectory,
                                });
                                opencodeClient.setDirectory(configDirectory);
                                useDirectoryStore.getState().setDirectory(configDirectory, { showOverlay: false });
                            }
                            const configDirectoryKey = toDirectoryKey(configDirectory);
                            if (get().activeDirectoryKey !== configDirectoryKey) {
                                set({ activeDirectoryKey: configDirectoryKey });
                                void hydrateConfigCatalogFromCache(configDirectoryKey);
                            }

                            if (debug) console.log("Loading providers and agents...");
                            const [, agentsLoaded] = await Promise.all([
                                get().loadProviders({ directory: configDirectory, source: 'initializeApp' }),
                                get().loadAgents({ directory: configDirectory, source: 'initializeApp' }),
                            ]);

                            if (!isConfigRuntimeContextCurrent(runtimeContext)) return;
                            if (!agentsLoaded) {
                                const configError = get().projectConfigErrors[configDirectoryKey];
                                const agentsError = _agentsLoadErrors.get(configDirectoryKey);
                                const awaitsTrust = !configError && agentsError instanceof OpencodeApiError && agentsError.status === 403
                                    && await isOpenCodeTrustPending(configDirectory);
                                if (!isConfigRuntimeContextCurrent(runtimeContext)) return;
                                if (configError) {
                                    markStartupTrace('initializeApp:projectConfigInvalid', { configDirectoryKey, name: configError.name });
                                } else if (awaitsTrust) {
                                    markStartupTrace('initializeApp:projectAwaitsTrust', { configDirectoryKey });
                                } else if (isLocationNotFoundError(agentsError)
                                    || await opencodeClient.getDirectoryAvailability(configDirectory) === 'missing') {
                                    if (!isConfigRuntimeContextCurrent(runtimeContext)) return;
                                    markStartupTrace('initializeApp:projectDirectoryMissing', { configDirectoryKey });
                                } else {
                                    set({ lastInitFailure: { step: 'loadAgents', message: _agentsLoadErrors.get(configDirectoryKey)?.message || null } });
                                    return;
                                }
                            }
                            set({ isInitialized: true, isConnected: true, hasEverConnected: true, connectionPhase: "connected", lastInitFailure: null });
                            setTimeout(() => {
                                if (instanceGeneration !== configInstanceGeneration) return;
                                void get().loadAgents({ directory: configDirectory, source: 'startupAgentRecheck' });
                            }, 8_000);
                            const initEnded = typeof performance !== 'undefined' ? performance.now() : Date.now();
                            markStartupTrace('initializeApp:end', {
                                durationMs: Math.round(initEnded - initStarted),
                                providers: get().providers.length,
                                agents: get().agents.length,
                            });
                            if (debug) console.log("App initialized successfully");
                        } catch (error) {
                            if (!isConfigRuntimeContextCurrent(runtimeContext)) return;
                            console.error("Failed to initialize app:", error);
                            set({
                                isInitialized: false,
                                isConnected: false,
                                connectionPhase: get().hasEverConnected ? "reconnecting" : "connecting",
                                lastDisconnectReason: 'init_error',
                                lastInitFailure: { step: 'unexpected', message: (error instanceof Error ? error.message : String(error)) || null },
                            });
                            markStartupTrace('initializeApp:error', { error: error instanceof Error ? error.message : String(error) });
                        }
                    })().finally(() => {
                        if (_initializeAppInFlight === run) _initializeAppInFlight = null;
                    });

                    _initializeAppInFlight = run;
                    return run;
                },

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
            }),
            {
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
                partialize: (state) => ({
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
                }),
             },
         ),
    ),
);

if (typeof window !== "undefined") {
    window.__zustand_config_store__ = useConfigStore;
}

if (typeof window !== "undefined") {
    const hydrateActiveCatalog = () => void hydrateConfigCatalogFromCache(useConfigStore.getState().activeDirectoryKey);
    if (useConfigStore.persist.hasHydrated()) hydrateActiveCatalog();
    else useConfigStore.persist.onFinishHydration(hydrateActiveCatalog);
}

export const invalidateConfigCatalogsForReload = (
    kinds: readonly ("provider" | "agent")[],
): void => {
    _configCatalogLoadEpoch += 1;
    if (kinds.includes("provider")) {
        markConfigCatalogStale("provider", null);
        _inFlightProviders.clear();
        opencodeClient.clearProviderCatalogRequests();
    }
    if (kinds.includes("agent")) {
        markConfigCatalogStale("agent", null);
        _agentsLoadGeneration.clear();
        _inFlightAgents.clear();
        opencodeClient.clearAgentListRequests();
    }
    useConfigStore.setState((state) => ({ catalogReloadRevision: state.catalogReloadRevision + 1 }));
};

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

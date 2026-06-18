import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import type { Provider, Agent, Config } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "@/lib/opencode/client";
import { scopeMatches, subscribeToConfigChanges } from "@/lib/configSync";
import type { ModelMetadata } from "@/types";
import { getSafeStorage } from "./utils/safeStorage";
import { filterVisibleAgents } from "./useAgentsStore";
import { isPrimaryMode } from "@/components/chat/mobileControlsUtils";
import { useSessionUIStore } from "@/sync/session-ui-store";
import { useSelectionStore } from "@/sync/selection-store";
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry";
import { updateDesktopSettings } from "@/lib/persistence";
import { useDirectoryStore } from "@/stores/useDirectoryStore";
import { useProjectsStore } from "@/stores/useProjectsStore";
import { resolveProjectForSessionDirectory } from "@/lib/projectResolution";
import { streamDebugEnabled } from "@/stores/utils/streamDebug";
import { parseModelIdentifier } from "@/lib/modelIdentifier";
import { runtimeFetch } from "@/lib/runtime-fetch";
import { markStartupTrace, measureStartupTrace } from "@/lib/startupTrace";
import { getSyncConfig, subscribeToSyncConfigChanges } from "@/sync/sync-refs";

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const MODELS_DEV_PROXY_URL = "/api/openchamber/models-metadata";
const STT_SILENCE_THRESHOLD_DB_MIN = -100;
const STT_SILENCE_THRESHOLD_DB_MAX = 0;
const STT_SILENCE_HOLD_MS_MIN = 250;
const STT_SILENCE_HOLD_MS_MAX = 10000;

const FALLBACK_PROVIDER_ID = "opencode";
const FALLBACK_MODEL_ID = "big-pickle";
const GIT_UTILITY_PROVIDER_ID = "zen";
const GIT_UTILITY_PREFERRED_MODEL_ID = "big-pickle";
const PROVIDER_CONFIG_REFRESH_CONCURRENCY = 4;

const normalizeSttSilenceThresholdDb = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return undefined;
    }
    return Math.max(STT_SILENCE_THRESHOLD_DB_MIN, Math.min(STT_SILENCE_THRESHOLD_DB_MAX, value));
};

const normalizeSttSilenceHoldMs = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return undefined;
    }
    return Math.max(STT_SILENCE_HOLD_MS_MIN, Math.min(STT_SILENCE_HOLD_MS_MAX, Math.round(value)));
};

interface OpenChamberDefaults {
    defaultModel?: string;
    defaultVariant?: string;
    defaultAgent?: string;
    autoCreateWorktree?: boolean;
    gitmojiEnabled?: boolean;
    defaultFileViewerPreview?: boolean;
    zenModel?: string;
    messageStreamTransport?: 'auto' | 'ws' | 'sse';
    sttProvider?: 'browser' | 'server' | 'wasm';
    sttServerUrl?: string;
    wasmSttModel?: string;
    sttModel?: string;
    sttLanguage?: string;
    sttSilenceThresholdDb?: number;
    sttSilenceHoldMs?: number;
}

const fetchOpenChamberDefaults = async (): Promise<OpenChamberDefaults> => {
    markStartupTrace('config.defaults:start');
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const finish = (source: string, result: OpenChamberDefaults) => {
        const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
        markStartupTrace('config.defaults:end', {
            source,
            durationMs: Math.round(ended - started),
            hasDefaultModel: Boolean(result.defaultModel),
            hasDefaultAgent: Boolean(result.defaultAgent),
        });
        return result;
    };
    try {
        // 1. Runtime settings API (VSCode)
        const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
        if (runtimeSettings) {
            try {
                const result = await runtimeSettings.load();
                const data = result?.settings;
                if (data) {
                    const defaultModel = typeof data?.defaultModel === 'string' ? data.defaultModel.trim() : '';
                    const defaultVariant = typeof data?.defaultVariant === 'string' ? data.defaultVariant.trim() : '';
                    const defaultAgent = typeof data?.defaultAgent === 'string' ? data.defaultAgent.trim() : '';
                    const gitmojiEnabled = typeof data?.gitmojiEnabled === 'boolean' ? data.gitmojiEnabled : undefined;
                    const defaultFileViewerPreview = typeof data?.defaultFileViewerPreview === 'boolean' ? data.defaultFileViewerPreview : undefined;
                    const zenModel = typeof data?.zenModel === 'string' ? data.zenModel.trim() : '';
                    const messageStreamTransport =
                        data?.messageStreamTransport === 'ws' || data?.messageStreamTransport === 'sse' || data?.messageStreamTransport === 'auto'
                            ? data.messageStreamTransport
                            : undefined;
                    const sttProvider = data?.sttProvider === 'browser' || data?.sttProvider === 'server' || data?.sttProvider === 'wasm' ? data.sttProvider : undefined;
                    const sttServerUrl = typeof data?.sttServerUrl === 'string' ? data.sttServerUrl.trim() : undefined;
                    const sttModel = typeof data?.sttModel === 'string' ? data.sttModel.trim() : undefined;
                    const sttLanguage = typeof data?.sttLanguage === 'string' ? data.sttLanguage.trim() : undefined;
                    const sttSilenceThresholdDb = normalizeSttSilenceThresholdDb(data?.sttSilenceThresholdDb);
                    const sttSilenceHoldMs = normalizeSttSilenceHoldMs(data?.sttSilenceHoldMs);

                    return finish('runtime-settings', {
                        defaultModel: defaultModel.length > 0 ? defaultModel : undefined,
                        defaultVariant: defaultVariant.length > 0 ? defaultVariant : undefined,
                        defaultAgent: defaultAgent.length > 0 ? defaultAgent : undefined,
                        autoCreateWorktree: typeof data?.autoCreateWorktree === 'boolean' ? data.autoCreateWorktree : undefined,
                        gitmojiEnabled,
                        defaultFileViewerPreview,
                        zenModel: zenModel.length > 0 ? zenModel : undefined,
                        messageStreamTransport,
                        sttProvider,
                        sttServerUrl,
                        sttModel,
                        sttLanguage,
                        sttSilenceThresholdDb,
                        sttSilenceHoldMs,
                    });
                }
            } catch {
                // Fall through to fetch
            }
        }

        // 2. Fetch API (Web/server)
        const response = await runtimeFetch('/api/config/settings', {
            method: 'GET',
            headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
            return finish('settings-route-not-ok', {});
        }
        const data = await response.json();
        const defaultModel = typeof data?.defaultModel === 'string' ? data.defaultModel.trim() : '';
        const defaultVariant = typeof data?.defaultVariant === 'string' ? data.defaultVariant.trim() : '';
        const defaultAgent = typeof data?.defaultAgent === 'string' ? data.defaultAgent.trim() : '';
        const gitmojiEnabled = typeof data?.gitmojiEnabled === 'boolean' ? data.gitmojiEnabled : undefined;
        const defaultFileViewerPreview = typeof data?.defaultFileViewerPreview === 'boolean' ? data.defaultFileViewerPreview : undefined;
        const zenModel = typeof data?.zenModel === 'string' ? data.zenModel.trim() : '';
        const messageStreamTransport =
            data?.messageStreamTransport === 'ws' || data?.messageStreamTransport === 'sse' || data?.messageStreamTransport === 'auto'
                ? data.messageStreamTransport
                : undefined;
        const sttProvider = data?.sttProvider === 'browser' || data?.sttProvider === 'server' ? data.sttProvider : undefined;
        const sttServerUrl = typeof data?.sttServerUrl === 'string' ? data.sttServerUrl.trim() : undefined;
        const sttModel = typeof data?.sttModel === 'string' ? data.sttModel.trim() : undefined;
        const sttLanguage = typeof data?.sttLanguage === 'string' ? data.sttLanguage.trim() : undefined;
        const sttSilenceThresholdDb = normalizeSttSilenceThresholdDb(data?.sttSilenceThresholdDb);
        const sttSilenceHoldMs = normalizeSttSilenceHoldMs(data?.sttSilenceHoldMs);

        return finish('settings-route', {
            defaultModel: defaultModel.length > 0 ? defaultModel : undefined,
            defaultVariant: defaultVariant.length > 0 ? defaultVariant : undefined,
            defaultAgent: defaultAgent.length > 0 ? defaultAgent : undefined,
            autoCreateWorktree: typeof data?.autoCreateWorktree === 'boolean' ? data.autoCreateWorktree : undefined,
            gitmojiEnabled,
            defaultFileViewerPreview,
            zenModel: zenModel.length > 0 ? zenModel : undefined,
            messageStreamTransport,
            sttProvider,
            sttServerUrl,
            sttModel,
            sttLanguage,
            sttSilenceThresholdDb,
            sttSilenceHoldMs,
        });
    } catch (error) {
        markStartupTrace('config.defaults:error', { error: error instanceof Error ? error.message : String(error) });
        return finish('error', {});
    }
};

const parseModelString = (modelString: string): { providerId: string; modelId: string } | null => {
    return parseModelIdentifier(modelString);
};

const normalizeProviderId = (value: string) => value?.toLowerCase?.() ?? '';

type ProviderModel = Provider["models"][string];
type ProviderWithModelList = Omit<Provider, "models"> & { models: ProviderModel[] };

type GitModelSelection = { providerId: string; modelId: string };
type ProviderModelSelection = { providerId: string; modelId: string; variant?: string } | null;

const normalizeOptionalString = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const hasProviderModel = (
    providers: ProviderWithModelList[],
    providerId: string,
    modelId: string
): boolean => {
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) {
        return false;
    }
    return provider.models.some((model) => model.id === modelId);
};

const resolveProviderModelSelection = ({
    providers,
    currentProviderId,
    currentModelId,
    currentVariant,
    settingsDefaultModel,
    settingsDefaultVariant,
}: {
    providers: ProviderWithModelList[];
    currentProviderId?: string;
    currentModelId?: string;
    currentVariant?: string;
    settingsDefaultModel?: string;
    settingsDefaultVariant?: string;
}): ProviderModelSelection => {
    const resolveVariant = (providerId: string, modelId: string, variant?: string): string | undefined => {
        if (!variant) {
            return undefined;
        }

        const model = providers
            .find((provider) => provider.id === providerId)
            ?.models.find((entry) => entry.id === modelId) as { variants?: Record<string, unknown> } | undefined;

        return model?.variants && Object.prototype.hasOwnProperty.call(model.variants, variant)
            ? variant
            : undefined;
    };

    if (currentProviderId && currentModelId && hasProviderModel(providers, currentProviderId, currentModelId)) {
        return {
            providerId: currentProviderId,
            modelId: currentModelId,
            variant: resolveVariant(currentProviderId, currentModelId, currentVariant),
        };
    }

    if (settingsDefaultModel) {
        const parsed = parseModelString(settingsDefaultModel);
        if (parsed && hasProviderModel(providers, parsed.providerId, parsed.modelId)) {
            return {
                providerId: parsed.providerId,
                modelId: parsed.modelId,
                variant: resolveVariant(parsed.providerId, parsed.modelId, settingsDefaultVariant),
            };
        }
    }

    if (hasProviderModel(providers, FALLBACK_PROVIDER_ID, FALLBACK_MODEL_ID)) {
        return { providerId: FALLBACK_PROVIDER_ID, modelId: FALLBACK_MODEL_ID };
    }

    const firstProvider = providers[0];
    const firstModel = firstProvider?.models[0];
    if (firstProvider && firstModel) {
        return { providerId: firstProvider.id, modelId: firstModel.id };
    }

    return null;
};

type DefaultAgentModelSelection = {
    agentName: string | undefined;
    providerId?: string;
    modelId?: string;
    variant?: string;
};

// Shared default-selection cascade used both at startup (loadAgents) and when opening a
// fresh draft (applyDefaultModelAgentSelection), so the two paths stay identical.
//
//   Agent: settings.defaultAgent → opencode default_agent → build → first primary → first
//   Model: settings.defaultModel → resolved agent's pinned model+variant → opencode config.model
//          → opencode/big-pickle → first
//
// The opencode default_agent / default model (config fields on the OpenCode server) are honored
// only when our own settings have no valid default. OpenCode itself resolves a model the same way:
// an agent's pinned model wins, otherwise the global `model` config applies — so we check the
// agent's model before opencodeDefaultModel. When the agent supplies the model, its `variant` is
// carried through too (if the model actually exposes that variant).
const resolveDefaultAgentModelSelection = ({
    agents,
    providers,
    settingsDefaultAgent,
    settingsDefaultModel,
    settingsDefaultVariant,
    opencodeDefaultAgent,
    opencodeDefaultModel,
}: {
    agents: Agent[];
    providers: ProviderWithModelList[];
    settingsDefaultAgent?: string;
    settingsDefaultModel?: string;
    settingsDefaultVariant?: string;
    opencodeDefaultAgent?: string;
    opencodeDefaultModel?: string;
}): DefaultAgentModelSelection => {
    if (agents.length === 0) {
        return { agentName: undefined };
    }

    const resolveVariant = (providerId: string, modelId: string, variant?: string): string | undefined => {
        if (!variant) {
            return undefined;
        }
        const model = providers
            .find((provider) => provider.id === providerId)
            ?.models.find((entry) => entry.id === modelId) as { variants?: Record<string, unknown> } | undefined;
        return model?.variants && Object.prototype.hasOwnProperty.call(model.variants, variant)
            ? variant
            : undefined;
    };

    // --- Agent cascade ---
    const primaryAgents = agents.filter((agent) => isPrimaryMode(agent.mode));

    let resolvedAgent: Agent | undefined;
    if (settingsDefaultAgent) {
        resolvedAgent = agents.find((agent) => agent.name === settingsDefaultAgent);
    }
    if (!resolvedAgent && opencodeDefaultAgent) {
        const candidate = agents.find((agent) => agent.name === opencodeDefaultAgent);
        // OpenCode requires the default agent to be a visible primary agent.
        if (candidate && isPrimaryMode(candidate.mode) && candidate.hidden !== true) {
            resolvedAgent = candidate;
        }
    }
    if (!resolvedAgent) {
        resolvedAgent = primaryAgents.find((agent) => agent.name === "build") || primaryAgents[0] || agents[0];
    }
    if (!resolvedAgent) {
        return { agentName: undefined };
    }

    // --- Model cascade ---
    let providerId: string | undefined;
    let modelId: string | undefined;
    let variant: string | undefined;

    if (settingsDefaultModel) {
        const parsed = parseModelString(settingsDefaultModel);
        if (parsed && hasProviderModel(providers, parsed.providerId, parsed.modelId)) {
            providerId = parsed.providerId;
            modelId = parsed.modelId;
            variant = resolveVariant(providerId, modelId, settingsDefaultVariant);
        }
    }

    if (!providerId
        && resolvedAgent.model?.providerID
        && resolvedAgent.model?.modelID
        && hasProviderModel(providers, resolvedAgent.model.providerID, resolvedAgent.model.modelID)) {
        providerId = resolvedAgent.model.providerID;
        modelId = resolvedAgent.model.modelID;
        variant = resolveVariant(providerId, modelId, resolvedAgent.variant);
    }

    // OpenCode's global default model — used when neither our settings nor the agent pin a model.
    if (!providerId && opencodeDefaultModel) {
        const parsed = parseModelString(opencodeDefaultModel);
        if (parsed && hasProviderModel(providers, parsed.providerId, parsed.modelId)) {
            providerId = parsed.providerId;
            modelId = parsed.modelId;
        }
    }

    if (!providerId) {
        if (hasProviderModel(providers, FALLBACK_PROVIDER_ID, FALLBACK_MODEL_ID)) {
            providerId = FALLBACK_PROVIDER_ID;
            modelId = FALLBACK_MODEL_ID;
        } else {
            const firstProvider = providers[0];
            const firstModel = firstProvider?.models[0];
            if (firstProvider && firstModel) {
                providerId = firstProvider.id;
                modelId = firstModel.id;
            }
        }
    }

    return { agentName: resolvedAgent.name, providerId, modelId, variant };
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
        const randomModelId = normalizeOptionalString(zenProvider.models[randomIndex]?.id);
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

const mapModalities = (cap: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean } | undefined): string[] => {
    if (!cap) return [];
    const result: string[] = [];
    if (cap.text) result.push('text');
    if (cap.audio) result.push('audio');
    if (cap.image) result.push('image');
    if (cap.video) result.push('video');
    if (cap.pdf) result.push('pdf');
    return result;
};

const deriveModelMetadata = (providerId: string, model: ProviderModel): ModelMetadata => ({
    id: model.id,
    providerId,
    name: model.name,
    tool_call: model.capabilities?.toolcall,
    reasoning: model.capabilities?.reasoning,
    temperature: model.capabilities?.temperature,
    attachment: model.capabilities?.attachment,
    modalities: model.capabilities ? {
        input: mapModalities(model.capabilities.input),
        output: mapModalities(model.capabilities.output),
    } : undefined,
    cost: model.cost ? {
        input: model.cost.input,
        output: model.cost.output,
        cache_read: model.cost.cache?.read,
        cache_write: model.cost.cache?.write,
    } : undefined,
    limit: model.limit,
    release_date: model.release_date,
});

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
    modelsMetadataInFlight = measureStartupTrace('modelsMetadata', fetchModelsDevMetadata)
        .then((metadata) => {
            if (metadata.size > 0) {
                markStartupTrace('modelsMetadata:set', { entries: metadata.size });
                setModelsMetadata(metadata);
            }
            return metadata;
        })
        .catch(() => new Map<string, ModelMetadata>())
        .finally(() => {
            modelsMetadataInFlight = null;
        });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CONNECTION_PROBE_TIMEOUT_MS = 800;

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

// Persisted worktree→project mapping. The runtime worktree map
// (availableWorktreesByProject) is populated by async git discovery and isn't
// ready when initializeApp runs on startup — so without this, a worktree's first
// config load can't resolve to its project and duplicates the project's load.
// We cache resolved mappings to localStorage so subsequent launches resolve the
// project synchronously at init time. worktree→project is effectively immutable,
// so a cached entry is safe to trust.
const WORKTREE_PROJECT_MAP_KEY = 'oc.worktreeProjectMap';
let _worktreeProjectMap: Record<string, string> | null = null;
const getWorktreeProjectMap = (): Record<string, string> => {
    if (_worktreeProjectMap === null) {
        try {
            const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(WORKTREE_PROJECT_MAP_KEY) : null;
            _worktreeProjectMap = raw ? (JSON.parse(raw) as Record<string, string>) : {};
        } catch {
            _worktreeProjectMap = {};
        }
    }
    return _worktreeProjectMap;
};
const rememberWorktreeProject = (worktree: string, project: string): void => {
    if (!worktree || !project || worktree === project) return;
    const map = getWorktreeProjectMap();
    if (map[worktree] === project) return;
    map[worktree] = project;
    try {
        localStorage.setItem(WORKTREE_PROJECT_MAP_KEY, JSON.stringify(map));
    } catch {
        // localStorage quota exceeded — ignore; live resolution still works.
    }
};

const normalizeConfigPath = (value: string | null | undefined): string | null => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) return null;
    return trimmed.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
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

/**
 * Map a directory to its CONFIG scope. Providers/agents/defaults are defined at
 * the PROJECT level (opencode.json), so a worktree must inherit its parent
 * project's config instead of maintaining — and re-fetching — its own
 * per-worktree snapshot. Returns the owning project's path when the directory is
 * a known worktree, else the directory unchanged.
 */
const resolveConfigDirectory = (directory: string | null | undefined): string | null => {
    const dir = normalizeConfigPath(directory);
    const projects = getKnownProjectDirectories();
    if (!dir) return null;
    if (projects.includes(dir)) return dir;

    // 1. Persisted mapping — resolves synchronously when the async worktree
    //    discovery has not populated the runtime map yet.
    const cached = normalizeConfigPath(getWorktreeProjectMap()[dir]);
    if (cached) return cached;
    // 2. Live resolution via projects + discovered worktree map; cache the hit.
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
    } catch {
        return null;
    }
    return null;
};

const toConfigDirectoryKey = (directory: string | null | undefined): string =>
    toDirectoryKey(resolveConfigDirectory(directory));

// Runtime freshness tracking (NOT persisted) for the stale-while-revalidate
// background refresh, keyed by config-directory key. Prevents re-fetching
// project-scoped providers/agents we just loaded — e.g. initializeApp loading a
// project, then activateDirectory firing for the same project moments later.
const _providersLoadedAt = new Map<string, number>();
const _agentsLoadedAt = new Map<string, number>();
const CONFIG_REFRESH_TTL_MS = 30_000;
const PROJECT_CONFIG_PREWARM_DELAY_MS = 1_000;
const isConfigFresh = (loadedAt: Map<string, number>, key: string): boolean => {
    const at = loadedAt.get(key);
    return typeof at === 'number' && Date.now() - at < CONFIG_REFRESH_TTL_MS;
};

interface DirectoryScopedConfig {

    providers: ProviderWithModelList[];
    agents: Agent[];
    currentProviderId: string;
    currentModelId: string;
    currentVariant?: string | undefined;
    currentAgentName: string | undefined;
    selectedProviderId: string;
    agentModelSelections: { [agentName: string]: { providerId: string; modelId: string } };
    defaultProviders: { [key: string]: string };
    opencodeDefaultAgent?: string;
    opencodeDefaultModel?: string;
    selectionSource?: "auto" | "manual";
}

/**
 * Lift the active directory's cached provider/agent snapshot into the top-level
 * fields the pickers read (`providers`, `agents`, selections), so a cold start
 * paints instantly from persisted data. Falls back to whatever top-level data
 * was persisted; handles legacy persisted blobs that only stored directoryScoped.
 */
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
    return next as T;
};

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
});

const hasValidVariant = (
    providers: ProviderWithModelList[],
    providerId: string,
    modelId: string,
    variant: string | undefined,
): boolean => {
    if (!variant) return true;
    const model = providers
        .find((provider) => provider.id === providerId)
        ?.models.find((entry) => entry.id === modelId) as { variants?: Record<string, unknown> } | undefined;
    return !!model?.variants && Object.prototype.hasOwnProperty.call(model.variants, variant);
};

const resolveSelectionWithManualGuard = ({
    agents,
    providers,
    currentAgentName,
    currentProviderId,
    currentModelId,
    currentVariant,
    selectionSource,
    resolvedAgentName,
    resolvedProviderId,
    resolvedModelId,
    resolvedVariant,
}: {
    agents: Agent[];
    providers: ProviderWithModelList[];
    currentAgentName: string | undefined;
    currentProviderId: string;
    currentModelId: string;
    currentVariant: string | undefined;
    selectionSource: "auto" | "manual";
    resolvedAgentName: string | undefined;
    resolvedProviderId: string | undefined;
    resolvedModelId: string | undefined;
    resolvedVariant: string | undefined;
}) => {
    const manualAgentName = currentAgentName && agents.some((agent) => agent.name === currentAgentName)
        ? currentAgentName
        : undefined;
    const manualModelValid = !!currentProviderId
        && !!currentModelId
        && hasProviderModel(providers, currentProviderId, currentModelId)
        && hasValidVariant(providers, currentProviderId, currentModelId, currentVariant);
    const preserveManual = selectionSource === "manual" && (!!manualAgentName || manualModelValid);

    return {
        agentName: preserveManual ? (manualAgentName ?? resolvedAgentName) : resolvedAgentName,
        providerId: preserveManual && manualModelValid ? currentProviderId : resolvedProviderId,
        modelId: preserveManual && manualModelValid ? currentModelId : resolvedModelId,
        variant: preserveManual && manualModelValid ? currentVariant : resolvedVariant,
        selectionSource: preserveManual ? "manual" as const : "auto" as const,
    };
};

interface ConfigStore {

    activeDirectoryKey: string;
    directoryScoped: Record<string, DirectoryScopedConfig>;

    providers: ProviderWithModelList[];
    agents: Agent[];
    currentProviderId: string;
    currentModelId: string;
    currentVariant: string | undefined;
    currentAgentName: string | undefined;
    selectedProviderId: string;
    agentModelSelections: { [agentName: string]: { providerId: string; modelId: string } };
    defaultProviders: { [key: string]: string };
    selectionSource: "auto" | "manual";
    isConnected: boolean;
    hasEverConnected: boolean;
    connectionPhase: "connecting" | "connected" | "reconnecting";
    lastDisconnectReason: string | null;
    isInitialized: boolean;
    modelsMetadata: Map<string, ModelMetadata>;
    // OpenChamber settings-based defaults (take precedence over agent preferences)
    settingsDefaultModel: string | undefined; // format: "provider/model"
    settingsDefaultVariant: string | undefined;
    settingsDefaultAgent: string | undefined;
    // OpenCode server's own `default_agent` config field (name of a primary agent), used as a
    // fallback when our own settingsDefaultAgent is unset. Sourced from sync config.
    opencodeDefaultAgent: string | undefined;
    // OpenCode server's own global `model` config field ("provider/model"), used as a fallback
    // when neither our settingsDefaultModel nor the resolved agent pins a model.
    opencodeDefaultModel: string | undefined;
    settingsAutoCreateWorktree: boolean;
    settingsGitmojiEnabled: boolean;
    settingsDefaultFileViewerPreview: boolean;
    settingsZenModel: string | undefined;
    settingsMessageStreamTransport: 'auto' | 'ws' | 'sse';
    // Voice provider preference ('browser', 'openai', 'openai-compatible', or 'say' for macOS)
    voiceProvider: 'browser' | 'openai' | 'openai-compatible' | 'say';
    setVoiceProvider: (provider: 'browser' | 'openai' | 'openai-compatible' | 'say') => void;
    // TTS settings
    speechRate: number;
    speechPitch: number;
    speechVolume: number;
    sayVoice: string;
    browserVoice: string;
    openaiVoice: string;
    openaiApiKey: string;
    openaiCompatibleUrl: string;
    openaiCompatibleApiKey: string;
    openaiCompatibleVoice: string;
    openaiCompatibleTtsModel: string;
    // STT (speech-to-text) settings
    sttProvider: 'browser' | 'server' | 'wasm';
    sttServerUrl: string;
    sttApiKey: string;
    sttModel: string;
    wasmSttModel: string;
    sttLanguage: string;
    sttSilenceThresholdDb: number;
    sttSilenceHoldMs: number;
    sttTranscribeOnStop: boolean;
    showMessageTTSButtons: boolean;
    ttsInputMode: 'sanitized' | 'raw';
    voiceModeEnabled: boolean;
    // Summarization settings
    summarizeMessageTTS: boolean;
    summarizeVoiceConversation: boolean;
    summarizeCharacterThreshold: number;
    summarizeMaxLength: number;
    setSpeechRate: (rate: number) => void;
    setSpeechPitch: (pitch: number) => void;
    setSpeechVolume: (volume: number) => void;
    setSayVoice: (voice: string) => void;
    setBrowserVoice: (voice: string) => void;
    setOpenaiVoice: (voice: string) => void;
    setOpenaiApiKey: (apiKey: string) => void;
    setOpenaiCompatibleUrl: (url: string) => void;
    setOpenaiCompatibleApiKey: (apiKey: string) => void;
    setOpenaiCompatibleVoice: (voice: string) => void;
    setOpenaiCompatibleTtsModel: (model: string) => void;
    setSttProvider: (provider: 'browser' | 'server' | 'wasm') => void;
    setSttServerUrl: (url: string) => void;
    setSttApiKey: (apiKey: string) => void;
    setSttModel: (model: string) => void;
    setWasmSttModel: (model: string) => void;
    setSttLanguage: (lang: string) => void;
    setSttSilenceThresholdDb: (db: number) => void;
    setSttSilenceHoldMs: (ms: number) => void;
    setSttTranscribeOnStop: (enabled: boolean) => void;
    setShowMessageTTSButtons: (show: boolean) => void;
    setTtsInputMode: (mode: 'sanitized' | 'raw') => void;
    setVoiceModeEnabled: (enabled: boolean) => void;
    setSummarizeMessageTTS: (enabled: boolean) => void;
    setSummarizeVoiceConversation: (enabled: boolean) => void;
    setSummarizeCharacterThreshold: (threshold: number) => void;
    setSummarizeMaxLength: (maxLength: number) => void;

    activateDirectory: (directory: string | null | undefined) => Promise<void>;

    loadProviders: (options?: { directory?: string | null; source?: string }) => Promise<void>;
    loadAgents: (options?: { directory?: string | null; source?: string }) => Promise<boolean>;
    invalidateModelMetadataCache: () => void;
    invalidateProviderCache: (directory?: string | null) => void;
    setProvider: (providerId: string) => void;
    setModel: (modelId: string) => void;
    setCurrentVariant: (variant: string | undefined) => void;
    cycleCurrentVariant: () => void;
    getCurrentModelVariants: () => string[];
    setAgent: (agentName: string | undefined) => void;
    applyDefaultModelAgentSelection: () => void;
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
    prewarmProjectConfigs: (initialDirectory?: string | null) => Promise<void>;
    getCurrentProvider: () => ProviderWithModelList | undefined;
    getCurrentModel: () => ProviderModel | undefined;
    getCurrentAgent: () => Agent | undefined;
    getModelMetadata: (providerId: string, modelId: string) => ModelMetadata | undefined;
    // Returns only visible agents (excludes hidden internal agents like title, compaction, summary)
    getVisibleAgents: () => Agent[];
}

declare global {
    interface Window {
        __zustand_config_store__?: UseBoundStore<StoreApi<ConfigStore>>;
    }
}

// In-flight dedup: prevent concurrent duplicate loadProviders/loadAgents calls for the same directory
const _inFlightProviders = new Map<string, Promise<void>>();
const _inFlightAgents = new Map<string, Promise<boolean>>();
let _initializeAppInFlight: Promise<void> | null = null;

export const useConfigStore = create<ConfigStore>()(
    devtools(
        persist(
            (set, get) => ({

                activeDirectoryKey: resolveInitialDirectoryKey(),
                directoryScoped: {},

                providers: [],
                agents: [],
                currentProviderId: "",
                currentModelId: "",
                currentVariant: undefined,
                currentAgentName: undefined,
                selectedProviderId: "",
                agentModelSelections: {},
                defaultProviders: {},
                selectionSource: "auto",
                isConnected: false,
                hasEverConnected: false,
                connectionPhase: "connecting",
                lastDisconnectReason: null,
                isInitialized: false,
                modelsMetadata: new Map<string, ModelMetadata>(),
                settingsDefaultModel: undefined,
                settingsDefaultVariant: undefined,
                settingsDefaultAgent: undefined,
                opencodeDefaultAgent: undefined,
                opencodeDefaultModel: undefined,
                settingsAutoCreateWorktree: false,
                settingsGitmojiEnabled: false,
                settingsDefaultFileViewerPreview: false,
                settingsZenModel: undefined,
                settingsMessageStreamTransport: 'auto',
                // Voice provider preference - load from localStorage or default to 'browser'
                voiceProvider: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('voiceProvider');
                        if (saved === 'openai' || saved === 'browser' || saved === 'say' || saved === 'openai-compatible') return saved;
                    }
                    return 'browser';
                })(),
                // TTS settings - load from localStorage with defaults
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
                // macOS Say voice - load from localStorage or default to 'Samantha'
                sayVoice: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sayVoice');
                        if (saved) return saved;
                    }
                    return 'Samantha';
                })(),
                // Browser voice - load from localStorage or default to empty (auto-select)
                browserVoice: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('browserVoice');
                        if (saved) return saved;
                    }
                    return '';
                })(),
                // OpenAI voice - load from localStorage or default to 'nova'
                openaiVoice: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiVoice');
                        if (saved) return saved;
                    }
                    return 'nova';
                })(),
                // OpenAI API key for TTS - load from localStorage or default to empty
                openaiApiKey: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiApiKey');
                        if (saved) return saved;
                    }
                    return '';
                })(),
                // OpenAI-compatible custom server URL
                openaiCompatibleUrl: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiCompatibleUrl');
                        if (saved) return saved;
                    }
                    return '';
                })(),
                // OpenAI-compatible custom server API key
                openaiCompatibleApiKey: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiCompatibleApiKey');
                        if (saved) return saved;
                    }
                    return '';
                })(),
                // OpenAI-compatible custom server voice
                openaiCompatibleVoice: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiCompatibleVoice');
                        if (saved) return saved;
                    }
                    return 'af_sky';
                })(),
                // OpenAI-compatible custom server TTS model
                openaiCompatibleTtsModel: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiCompatibleTtsModel');
                        if (saved && saved !== 'speaches-ai/Kokoro-82M-v1.0-ONNX') return saved;
                    }
                    return 'kokoro';
                })(),
                // STT provider: 'browser' (Web Speech API), 'server' (OpenAI-compat), 'wasm' (local Whisper)
                sttProvider: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttProvider');
                        if (saved === 'browser' || saved === 'server' || saved === 'wasm') return saved;
                        // Electron/Chromium's Web Speech API requires Google API keys
                        // not available in Electron, so default to WASM local Whisper.
                        const electron = (window as unknown as { __OPENCHAMBER_ELECTRON__?: { runtime?: string } }).__OPENCHAMBER_ELECTRON__;
                        if (electron?.runtime === 'electron') return 'wasm' as const;
                    }
                    return 'browser' as const;
                })(),
                sttServerUrl: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttServerUrl');
                        if (saved) return saved;
                    }
                    return 'http://localhost:8001/v1';
                })(),
                sttApiKey: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttApiKey');
                        if (saved) return saved;
                    }
                    return '';
                })(),
                sttModel: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttModel');
                        if (saved) return saved;
                    }
                    return 'deepdml/faster-whisper-large-v3-turbo-ct2';
                })(),
                wasmSttModel: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('wasmSttModel');
                        if (saved) return saved;
                    }
                    return 'Xenova/whisper-base.en';
                })(),
                sttLanguage: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttLanguage');
                        if (saved !== null) return saved;
                    }
                    return '';
                })(),
                sttSilenceThresholdDb: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttSilenceThresholdDb');
                        if (saved) {
                            const parsed = parseFloat(saved);
                            if (!isNaN(parsed)) return parsed;
                        }
                    }
                    return -45;
                })(),
                sttSilenceHoldMs: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttSilenceHoldMs');
                        if (saved) {
                            const parsed = parseInt(saved, 10);
                            if (!isNaN(parsed)) return parsed;
                        }
                    }
                    return 1500;
                })(),
                sttTranscribeOnStop: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttTranscribeOnStop');
                        if (saved === 'true') return true;
                    }
                    return false;
                })(),
                // Show TTS buttons on messages - disabled by default until user enables it
                showMessageTTSButtons: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('showMessageTTSButtons');
                        if (saved === 'true') return true;
                    }
                    return false;
                })(),
                ttsInputMode: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('ttsInputMode');
                        if (saved === 'raw') return 'raw' as const;
                    }
                    return 'sanitized' as const;
                })(),
                // Voice mode enabled - load from localStorage or default to false
                voiceModeEnabled: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('voiceModeEnabled');
                        if (saved === 'true') return true;
                    }
                    return false;
                })(),
                // Summarization settings
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
                activateDirectory: async (directory) => {
                    // Resolve the worktree to its owning project up-front so the
                    // active key + snapshot key always match and stay project-scoped.
                    // Everything below operates on this key unchanged; the OpenCode
                    // working directory (opencodeClient.getDirectory()) is separate.
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
                        if (snapshot) {
                            snapshotHadProviders = snapshot.providers.length > 0;
                            snapshotHadAgents = snapshot.agents.length > 0;
                            return {
                                activeDirectoryKey: directoryKey,
                                providers: snapshot.providers,
                                agents: snapshot.agents,
                                currentProviderId: snapshot.currentProviderId,
                                currentModelId: snapshot.currentModelId,
                                currentVariant: snapshot.currentVariant,
                                currentAgentName: snapshot.currentAgentName,
                                selectedProviderId: snapshot.selectedProviderId,
                                agentModelSelections: snapshot.agentModelSelections,
                                defaultProviders: snapshot.defaultProviders,
                                opencodeDefaultAgent: snapshot.opencodeDefaultAgent,
                                opencodeDefaultModel: snapshot.opencodeDefaultModel,
                                selectionSource: snapshot.selectionSource ?? "auto",
                            };
                        }

                        return {
                            activeDirectoryKey: directoryKey,
                            providers: [],
                            agents: [],
                            currentProviderId: "",
                            currentModelId: "",
                            currentAgentName: undefined,
                            selectedProviderId: "",
                            agentModelSelections: {},
                            defaultProviders: {},
                            opencodeDefaultAgent: undefined,
                            opencodeDefaultModel: undefined,
                            selectionSource: "auto",
                        };
                    });

                    if (!get().isConnected) {
                        return;
                    }

                    // Stale-while-revalidate: when a cached snapshot already
                    // populated the pickers, refresh in the background so the UI
                    // stays instant but never shows stale provider/agent data for
                    // longer than one fetch. Only block when there is nothing to show.
                    if (snapshotHadProviders) {
                        if (isConfigFresh(_providersLoadedAt, directoryKey)) {
                            markStartupTrace('activateDirectory:providersFresh', { directoryKey });
                        } else {
                            markStartupTrace('activateDirectory:refreshProvidersBackground', { directoryKey });
                            void get().loadProviders({ directory: fromDirectoryKey(directoryKey), source: 'activateDirectory:refresh' });
                        }
                    } else {
                        await get().loadProviders({ directory: fromDirectoryKey(directoryKey), source: 'activateDirectory' });
                    }

                    if (snapshotHadAgents) {
                        if (isConfigFresh(_agentsLoadedAt, directoryKey)) {
                            markStartupTrace('activateDirectory:agentsFresh', { directoryKey });
                        } else {
                            markStartupTrace('activateDirectory:refreshAgentsBackground', { directoryKey });
                            void get().loadAgents({ directory: fromDirectoryKey(directoryKey), source: 'activateDirectory:refresh' });
                        }
                    } else {
                        await get().loadAgents({ directory: fromDirectoryKey(directoryKey), source: 'activateDirectory' });
                    }
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
                            if (snapshot.providers.length === 0 && Object.keys(snapshot.defaultProviders).length === 0) {
                                return snapshot;
                            }

                            scopedChanged = true;
                            return {
                                ...snapshot,
                                providers: [],
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

                        if (targetDirectoryKey === null || targetDirectoryKey === state.activeDirectoryKey) {
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
                    const requestedDirectory = options?.directory ?? fromDirectoryKey(get().activeDirectoryKey);
                    // Providers are project-scoped: resolve a worktree to its project
                    // so it reuses one shared snapshot instead of its own.
                    const configDirectory = resolveConfigDirectory(requestedDirectory);
                    if (!configDirectory) {
                        markStartupTrace('loadProviders:skippedUnknownDirectory', { requestedDirectory, source: options?.source ?? 'unknown' });
                        return;
                    }
                    const effectiveDirectory = configDirectory ?? opencodeClient.getDirectory() ?? null;
                    const directoryKey = toDirectoryKey(configDirectory);
                    const source = options?.source ?? 'unknown';
                    markStartupTrace('loadProviders:called', { directoryKey, source, requestedDirectory, effectiveDirectory });

                    // Dedup: if a load is already in-flight for this directory, reuse it
                    const existing = _inFlightProviders.get(directoryKey);
                    if (existing) {
                        markStartupTrace('loadProviders:deduped', { directoryKey, source, requestedDirectory, effectiveDirectory });
                        return existing;
                    }

                    const promise = (async () => {
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
                                (metadata) => set({ modelsMetadata: metadata }),
                            );
                            const apiResult = await measureStartupTrace(
                                'loadProviders:api',
                                () => opencodeClient.getProvidersForConfig(fromDirectoryKey(directoryKey)),
                                { directoryKey, source, requestedDirectory, effectiveDirectory, attempt: attempt + 1 },
                            );
                            const providers = Array.isArray(apiResult?.providers) ? apiResult.providers : [];
                            const defaults = apiResult?.default || {};

                            const processedProviders: ProviderWithModelList[] = providers.map((provider) => {
                                const modelRecord = provider.models ?? {};
                                const models: ProviderModel[] = Object.keys(modelRecord).map((modelId) => modelRecord[modelId]);
                                return {
                                    ...provider,
                                    models,
                                };
                            });

                            set((state) => {
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
                                const resolvedModel = resolveProviderModelSelection({
                                    providers: processedProviders,
                                    currentProviderId,
                                    currentModelId,
                                    currentVariant,
                                    settingsDefaultModel: state.settingsDefaultModel,
                                    settingsDefaultVariant: state.settingsDefaultVariant,
                                });
                                const currentSelectedProviderId = state.activeDirectoryKey === directoryKey
                                    ? state.selectedProviderId
                                    : baseSnapshot.selectedProviderId;
                                const selectedProviderId = processedProviders.some((provider) => provider.id === currentSelectedProviderId)
                                    ? currentSelectedProviderId
                                    : (resolvedModel?.providerId ?? processedProviders[0]?.id ?? "");

                                const nextSnapshot: DirectoryScopedConfig = {
                                    ...baseSnapshot,
                                    providers: processedProviders,
                                    defaultProviders: defaults,
                                    currentProviderId: resolvedModel?.providerId ?? "",
                                    currentModelId: resolvedModel?.modelId ?? "",
                                    currentVariant: resolvedModel?.variant,
                                    selectedProviderId,
                                };

                                const nextState: Partial<ConfigStore> = {
                                    directoryScoped: {
                                        ...state.directoryScoped,
                                        [directoryKey]: nextSnapshot,
                                    },
                                };

                                if (state.activeDirectoryKey === directoryKey) {
                                    nextState.providers = processedProviders;
                                    nextState.defaultProviders = defaults;
                                    nextState.currentProviderId = nextSnapshot.currentProviderId;
                                    nextState.currentModelId = nextSnapshot.currentModelId;
                                    nextState.currentVariant = nextSnapshot.currentVariant;
                                    nextState.selectedProviderId = selectedProviderId;
                                }

                                return nextState;
                            });

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
                            _providersLoadedAt.set(directoryKey, Date.now());
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
                        }
                    }

                    console.error("Failed to load providers:", lastError);
                    markStartupTrace('loadProviders:error', {
                        directoryKey,
                        source,
                        requestedDirectory,
                        effectiveDirectory,
                        error: lastError instanceof Error ? lastError.message : String(lastError),
                    });

                    set((state) => {
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
                                    if (settingsProvider?.models.some((m) => m.id === parsed.modelId)) {
                                        const model = settingsProvider.models.find((m) => m.id === parsed.modelId);
                                        const currentVariant = state.settingsDefaultVariant && (model as { variants?: Record<string, unknown> } | undefined)?.variants?.[state.settingsDefaultVariant]
                                            ? state.settingsDefaultVariant
                                            : undefined;

                                        nextState.currentProviderId = parsed.providerId;
                                        nextState.currentModelId = parsed.modelId;
                                        nextState.currentVariant = currentVariant;
                                        nextState.selectedProviderId = parsed.providerId;

                                        nextSnapshot.currentProviderId = parsed.providerId;
                                        nextSnapshot.currentModelId = parsed.modelId;
                                        nextSnapshot.currentVariant = currentVariant;
                                        nextSnapshot.selectedProviderId = parsed.providerId;
                                    }
                                }
                            }
                        }

                        return nextState;
                    });
                    })().finally(() => _inFlightProviders.delete(directoryKey));

                    _inFlightProviders.set(directoryKey, promise);
                    return promise;
                },

                setProvider: (providerId: string) => {
                    const { providers } = get();
                    const provider = providers.find((p) => p.id === providerId);
 
                    if (!provider) {
                        return;
                    }
 
                    const firstModel = provider.models[0];
                    const newModelId = firstModel?.id || "";
 
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
                            currentModelId: newModelId,
                            selectedProviderId: providerId,
                            selectionSource: "manual",
                        };

                        return {
                            currentProviderId: providerId,
                            currentModelId: newModelId,
                            selectedProviderId: providerId,
                            selectionSource: "manual",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                setModel: (modelId: string) => {
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
                            currentModelId: modelId,
                            selectionSource: "manual",
                        };
 
                        return {
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
                    set((state) => {
                        if (state.currentVariant === variant) {
                            return state;
                        }

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
                            currentVariant: variant,
                            selectionSource: "manual",
                        };

                        return {
                            currentVariant: variant,
                            selectionSource: "manual",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                getCurrentModelVariants: () => {
                    const model = get().getCurrentModel();
                    const variants = (model as { variants?: Record<string, unknown> } | undefined)?.variants;
                    if (!variants) {
                        return [];
                    }
                    return Object.keys(variants);
                },

                cycleCurrentVariant: () => {
                    const variantKeys = get().getCurrentModelVariants();
                    if (variantKeys.length === 0) {
                        return;
                    }

                    const current = get().currentVariant;
                    if (!current) {
                        get().setCurrentVariant(variantKeys[0]);
                        return;
                    }

                    const index = variantKeys.indexOf(current);
                    if (index === -1 || index === variantKeys.length - 1) {
                        get().setCurrentVariant(undefined);
                        return;
                    }

                    get().setCurrentVariant(variantKeys[index + 1]);
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

                loadAgents: async (options) => {
                    const requestedDirectory = options?.directory ?? fromDirectoryKey(get().activeDirectoryKey);
                    // Agents are project-scoped: resolve a worktree to its project
                    // so it reuses one shared snapshot instead of its own.
                    const configDirectory = resolveConfigDirectory(requestedDirectory);
                    if (!configDirectory) {
                        markStartupTrace('loadAgents:skippedUnknownDirectory', { requestedDirectory, source: options?.source ?? 'unknown' });
                        return false;
                    }
                    const effectiveDirectory = configDirectory ?? opencodeClient.getDirectory() ?? null;
                    const directoryKey = toDirectoryKey(configDirectory);
                    const source = options?.source ?? 'unknown';
                    markStartupTrace('loadAgents:called', { directoryKey, source, requestedDirectory, effectiveDirectory });

                    // Dedup: if a load is already in-flight for this directory, reuse it
                    const existing = _inFlightAgents.get(directoryKey);
                    if (existing) {
                        markStartupTrace('loadAgents:deduped', { directoryKey, source, requestedDirectory, effectiveDirectory });
                        return existing;
                    }

                    const promise = (async (): Promise<boolean> => {
                    const loaderStarted = typeof performance !== 'undefined' ? performance.now() : Date.now();
                    markStartupTrace('loadAgents:start', { directoryKey, source, requestedDirectory, effectiveDirectory });
                    const existingSnapshot = get().directoryScoped[directoryKey];
                    const previousAgents = existingSnapshot?.agents ?? (get().activeDirectoryKey === directoryKey ? get().agents : []);
                    let lastError: unknown = null;

                    for (let attempt = 0; attempt < 3; attempt++) {
                        try {
                            // Fetch agents and OpenChamber settings in parallel. OpenCode config
                            // comes from sync state if it is already available; it must not block
                            // the agent refresh path.
                            const configDirectoryPath = fromDirectoryKey(directoryKey);
                            const initialSyncedOpencodeConfig = getSyncConfig(requestedDirectory ?? undefined)
                                ?? getSyncConfig(configDirectoryPath ?? undefined);
                            if (initialSyncedOpencodeConfig) {
                                markStartupTrace('loadAgents:syncConfigHit', { directoryKey, source });
                            }
                            const [agents, openChamberDefaults] = await Promise.all([
                                measureStartupTrace(
                                    'loadAgents:api',
                                    () => opencodeClient.listAgents(configDirectoryPath),
                                    { directoryKey, source, requestedDirectory, effectiveDirectory, attempt: attempt + 1 },
                                ),
                                fetchOpenChamberDefaults(),
                            ]);

                            const safeAgents = Array.isArray(agents) ? agents : [];

                            const providerLoad = _inFlightProviders.get(directoryKey);
                            if (providerLoad) {
                                markStartupTrace('loadAgents:awaitProviders', { directoryKey, source });
                                await providerLoad;
                            }

                            const latestSyncedOpencodeConfig = getSyncConfig(requestedDirectory ?? undefined)
                                ?? getSyncConfig(configDirectoryPath ?? undefined);
                            const hasLatestSyncedOpencodeConfig = latestSyncedOpencodeConfig !== undefined;
                            const latestSyncedOpencodeDefaultAgent = hasLatestSyncedOpencodeConfig
                                ? normalizeOptionalString(latestSyncedOpencodeConfig.default_agent)
                                : undefined;
                            const latestSyncedOpencodeDefaultModel = hasLatestSyncedOpencodeConfig
                                ? normalizeOptionalString(latestSyncedOpencodeConfig.model)
                                : undefined;

                            const providers = get().activeDirectoryKey === directoryKey
                                ? get().providers
                                : (get().directoryScoped[directoryKey]?.providers ?? []);

                            const existingZenModel = normalizeOptionalString(get().settingsZenModel);

                            const defaultZenModel = normalizeOptionalString(openChamberDefaults.zenModel);

                            const resolvedExistingGitSelection = resolveGitGenerationModelSelection({
                                providers,
                                settingsZenModel: existingZenModel,
                            });

                            const resolvedDefaultGitSelection = resolveGitGenerationModelSelection({
                                providers,
                                settingsZenModel: defaultZenModel,
                            });

                            const resolvedGitSelection = resolvedExistingGitSelection || resolvedDefaultGitSelection;
                            const resolvedGitModelId = resolvedGitSelection?.modelId;
                            const resolvedZenModel = resolvedGitModelId || defaultZenModel || existingZenModel;

                            set((state) => {
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
                                    settingsDefaultModel: openChamberDefaults.defaultModel,
                                    settingsDefaultVariant: openChamberDefaults.defaultVariant,
                                    settingsDefaultAgent: openChamberDefaults.defaultAgent,
                                    settingsAutoCreateWorktree: openChamberDefaults.autoCreateWorktree ?? false,
                                    settingsGitmojiEnabled: openChamberDefaults.gitmojiEnabled ?? false,
                                    settingsDefaultFileViewerPreview: openChamberDefaults.defaultFileViewerPreview ?? false,
                                    settingsZenModel: resolvedZenModel,
                                    settingsMessageStreamTransport: openChamberDefaults.messageStreamTransport ?? state.settingsMessageStreamTransport ?? 'auto',
                                    sttProvider: openChamberDefaults.sttProvider ?? state.sttProvider,
                                    sttServerUrl: openChamberDefaults.sttServerUrl ?? state.sttServerUrl,
                                    sttModel: openChamberDefaults.sttModel ?? state.sttModel,
                                    sttLanguage: openChamberDefaults.sttLanguage ?? state.sttLanguage,
                                    sttSilenceThresholdDb: openChamberDefaults.sttSilenceThresholdDb ?? state.sttSilenceThresholdDb,
                                    sttSilenceHoldMs: openChamberDefaults.sttSilenceHoldMs ?? state.sttSilenceHoldMs,
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
                                    gitProviderId: '',
                                    gitModelId: '',
                                }).catch(() => {
                                    // Ignore errors - best effort cleanup
                                });
                            }

                            if (safeAgents.length === 0) {
                                set((state) => {
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
                                    };

                                    const nextState: Partial<ConfigStore> = {
                                        directoryScoped: {
                                            ...state.directoryScoped,
                                            [directoryKey]: nextSnapshot,
                                        },
                                    };

                                    if (state.activeDirectoryKey === directoryKey) {
                                        nextState.currentAgentName = undefined;
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
                                _agentsLoadedAt.set(directoryKey, Date.now());
                                return true;
                            }

                            // Helper to validate model exists in providers
                            const validateModel = (providerId: string, modelId: string): boolean => {
                                const provider = providers.find((p) => p.id === providerId);
                                if (!provider) return false;
                                return provider.models.some((m) => m.id === modelId);
                            };

                            // Detect invalid OpenChamber settings so we can clear them from storage.
                            // This is independent of resolution: even though the cascade below falls
                            // back gracefully, stale settings pointing at removed agents/models/variants
                            // should be cleaned up.
                            const invalidSettings: { defaultModel?: string; defaultVariant?: string; defaultAgent?: string } = {};
                            if (openChamberDefaults.defaultAgent && !safeAgents.some((agent) => agent.name === openChamberDefaults.defaultAgent)) {
                                invalidSettings.defaultAgent = '';
                            }
                            if (openChamberDefaults.defaultModel) {
                                const parsed = parseModelString(openChamberDefaults.defaultModel);
                                if (!parsed || !validateModel(parsed.providerId, parsed.modelId)) {
                                    invalidSettings.defaultModel = '';
                                } else if (openChamberDefaults.defaultVariant) {
                                    const provider = providers.find((p) => p.id === parsed.providerId);
                                    const model = provider?.models.find((m) => m.id === parsed.modelId) as { variants?: Record<string, unknown> } | undefined;
                                    const variants = model?.variants;
                                    if (!(variants && Object.prototype.hasOwnProperty.call(variants, openChamberDefaults.defaultVariant))) {
                                        invalidSettings.defaultVariant = '';
                                    }
                                }
                            }

                            // Resolve agent + model via the shared cascade:
                            //   settings.defaultAgent → opencode default_agent → build → first primary → first
                            //   settings.defaultModel → resolved agent's model+variant → opencode/big-pickle → first
                            const resolvedDefault = resolveDefaultAgentModelSelection({
                                agents: safeAgents,
                                providers,
                                settingsDefaultAgent: openChamberDefaults.defaultAgent,
                                settingsDefaultModel: openChamberDefaults.defaultModel,
                                settingsDefaultVariant: openChamberDefaults.defaultVariant,
                                opencodeDefaultAgent,
                                opencodeDefaultModel,
                            });
                            const resolvedAgentName = resolvedDefault.agentName ?? safeAgents[0].name;
                            const resolvedProviderId = resolvedDefault.providerId;
                            const resolvedModelId = resolvedDefault.modelId;
                            const resolvedVariant = resolvedDefault.variant;

                            set((state) => {
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
                                const nextSelection = resolveSelectionWithManualGuard({
                                    agents: safeAgents,
                                    providers,
                                    currentAgentName,
                                    currentProviderId,
                                    currentModelId,
                                    currentVariant,
                                    selectionSource,
                                    resolvedAgentName,
                                    resolvedProviderId,
                                    resolvedModelId,
                                    resolvedVariant,
                                });

                                const nextSnapshot: DirectoryScopedConfig = {
                                    ...baseSnapshot,
                                    providers,
                                    agents: safeAgents,
                                    currentAgentName: nextSelection.agentName,
                                    currentProviderId: nextSelection.providerId ?? baseSnapshot.currentProviderId,
                                    currentModelId: nextSelection.modelId ?? baseSnapshot.currentModelId,
                                    currentVariant: nextSelection.variant,
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
                                    nextState.currentAgentName = nextSelection.agentName;
                                    nextState.opencodeDefaultAgent = opencodeDefaultAgent;
                                    nextState.opencodeDefaultModel = opencodeDefaultModel;
                                    if (nextSelection.providerId && nextSelection.modelId) {
                                        nextState.currentProviderId = nextSelection.providerId;
                                        nextState.currentModelId = nextSelection.modelId;
                                        nextState.currentVariant = nextSelection.variant;
                                    }
                                    nextState.selectionSource = nextSelection.selectionSource;
                                }

                                return nextState;
                            });

                            // Clear invalid settings from storage (best-effort cleanup)
                            if (Object.keys(invalidSettings).length > 0) {
                                // Also clear from store state
                                 set({
                                     settingsDefaultModel: invalidSettings.defaultModel !== undefined ? undefined : get().settingsDefaultModel,
                                     settingsDefaultVariant: invalidSettings.defaultVariant !== undefined ? undefined : get().settingsDefaultVariant,
                                     settingsDefaultAgent: invalidSettings.defaultAgent !== undefined ? undefined : get().settingsDefaultAgent,
                                 });
                                updateDesktopSettings(invalidSettings).catch(() => {
                                    // Ignore errors - best effort cleanup
                                });
                            }

                            const loaderEnded = typeof performance !== 'undefined' ? performance.now() : Date.now();
                            markStartupTrace('loadAgents:end', {
                                directoryKey,
                                source,
                                requestedDirectory,
                                effectiveDirectory,
                                durationMs: Math.round(loaderEnded - loaderStarted),
                                agents: safeAgents.length,
                            });
                            _agentsLoadedAt.set(directoryKey, Date.now());
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
                            const waitMs = 200 * (attempt + 1);
                            await new Promise((resolve) => setTimeout(resolve, waitMs));
                        }
                    }

                    console.error("Failed to load agents:", lastError);
                    markStartupTrace('loadAgents:error', {
                        directoryKey,
                        source,
                        requestedDirectory,
                        effectiveDirectory,
                        error: lastError instanceof Error ? lastError.message : String(lastError),
                    });

                    set((state) => {
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
                    })().finally(() => _inFlightAgents.delete(directoryKey));

                    _inFlightAgents.set(directoryKey, promise);
                    return promise;
                },

                invalidateModelMetadataCache: () => {
                    modelsMetadataInFlight = null;
                    set({ modelsMetadata: new Map<string, ModelMetadata>() });
                },

                setAgent: (agentName: string | undefined) => {
                    const {
                        agents,
                        providers,
                        settingsDefaultModel,
                        settingsDefaultVariant,
                        currentProviderId,
                        currentModelId,
                    } = get();

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
                            selectionSource: "manual",
                        };

                        return {
                            currentAgentName: agentName,
                            selectionSource: "manual",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });

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

                    if (agentName) {
                        const { currentSessionId } = useSessionUIStore.getState();

                        const applyResolvedModelSelection = (providerId: string, modelId: string, variant?: string) => {
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
                                    selectedProviderId: providerId,
                                    selectionSource: "manual",
                                };

                                return {
                                    currentProviderId: providerId,
                                    currentModelId: modelId,
                                    currentVariant: variant,
                                    selectedProviderId: providerId,
                                    selectionSource: "manual",
                                    directoryScoped: {
                                        ...state.directoryScoped,
                                        [directoryKey]: nextSnapshot,
                                    },
                                };
                            });
                        };

                        // Prefer the selected agent's configured model when switching agents.
                        const agent = agents.find((candidate) => candidate.name === agentName);
                        const agentModelSelection = agent?.model;
                        if (agentModelSelection?.providerID && agentModelSelection?.modelID) {
                            const { providerID, modelID } = agentModelSelection;
                            const agentProvider = providers.find((provider) => provider.id === providerID);
                            const agentModel = agentProvider?.models.find((model) => model.id === modelID);

                            if (agentModel) {
                                applyResolvedModelSelection(providerID, modelID, undefined);
                                return;
                            }
                        }

                        if (currentSessionId) {
                            const existingAgentModel = useSelectionStore.getState().getAgentModelForSession(currentSessionId, agentName);
                            if (existingAgentModel && hasProviderModel(providers, existingAgentModel.providerId, existingAgentModel.modelId)) {
                                const savedVariant = useSelectionStore.getState().getAgentModelVariantForSession(
                                    currentSessionId,
                                    agentName,
                                    existingAgentModel.providerId,
                                    existingAgentModel.modelId,
                                );
                                if (
                                    currentProviderId !== existingAgentModel.providerId
                                    || currentModelId !== existingAgentModel.modelId
                                    || get().currentVariant !== savedVariant
                                ) {
                                    applyResolvedModelSelection(existingAgentModel.providerId, existingAgentModel.modelId, savedVariant);
                                }
                                return;
                            }
                        }

                        // If the agent has no preferred model, use settings default.
                        if (settingsDefaultModel) {
                            const parsed = parseModelString(settingsDefaultModel);
                            if (parsed) {
                                const settingsProvider = providers.find((p) => p.id === parsed.providerId);
                                if (settingsProvider?.models.some((m) => m.id === parsed.modelId)) {
                                    let nextVariant: string | undefined;
                                    if (settingsDefaultVariant) {
                                        const model = settingsProvider.models.find((m) => m.id === parsed.modelId) as { variants?: Record<string, unknown> } | undefined;
                                        const variants = model?.variants;
                                        if (variants && Object.prototype.hasOwnProperty.call(variants, settingsDefaultVariant)) {
                                            nextVariant = settingsDefaultVariant;
                                        }
                                    }

                                    applyResolvedModelSelection(parsed.providerId, parsed.modelId, nextVariant);
                                    return;
                                }
                            }
                        }

                        // Otherwise keep the current valid model selection unchanged.
                    }
                },

                // Re-applies the same priority cascade used at app startup (see loadAgents):
                //   agent: settings.defaultAgent → build → first primary → first agent
                //   model: settings.defaultModel → agent's preferred model → opencode/big-pickle → first
                // Used when entering a fresh draft session so model/agent reset to defaults
                // instead of sticking to the previously open session's selection.
                applyDefaultModelAgentSelection: () => {
                    const {
                        agents,
                        providers,
                        settingsDefaultModel,
                        settingsDefaultVariant,
                        settingsDefaultAgent,
                        opencodeDefaultAgent,
                        opencodeDefaultModel,
                    } = get();

                    if (agents.length === 0 || providers.length === 0) {
                        return;
                    }

                    const {
                        agentName: resolvedAgentName,
                        providerId: resolvedProviderId,
                        modelId: resolvedModelId,
                        variant: resolvedVariant,
                    } = resolveDefaultAgentModelSelection({
                        agents,
                        providers,
                        settingsDefaultAgent,
                        settingsDefaultModel,
                        settingsDefaultVariant,
                        opencodeDefaultAgent,
                        opencodeDefaultModel,
                    });

                    if (!resolvedAgentName) {
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
                            currentAgentName: resolvedAgentName,
                            ...(resolvedProviderId && resolvedModelId
                                ? {
                                    currentProviderId: resolvedProviderId,
                                    currentModelId: resolvedModelId,
                                    currentVariant: resolvedVariant,
                                    selectedProviderId: resolvedProviderId,
                                }
                                : {}),
                            selectionSource: "auto",
                        };

                        const nextState: Partial<ConfigStore> = {
                            currentAgentName: resolvedAgentName,
                            selectionSource: "auto",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };

                        if (resolvedProviderId && resolvedModelId) {
                            nextState.currentProviderId = resolvedProviderId;
                            nextState.currentModelId = resolvedModelId;
                            nextState.currentVariant = resolvedVariant;
                            nextState.selectedProviderId = resolvedProviderId;
                        }

                        return nextState;
                    });
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
                    const opencodeDefaultModel = normalizeOptionalString(syncedConfig.model);

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

                        if (providers.length === 0 || agents.length === 0) {
                            if (!defaultsChanged) {
                                return state;
                            }
                            return nextState;
                        }

                        const resolved = resolveDefaultAgentModelSelection({
                            agents,
                            providers,
                            settingsDefaultAgent: state.settingsDefaultAgent,
                            settingsDefaultModel: state.settingsDefaultModel,
                            settingsDefaultVariant: state.settingsDefaultVariant,
                            opencodeDefaultAgent,
                            opencodeDefaultModel,
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
                            agents,
                            providers,
                            currentAgentName,
                            currentProviderId,
                            currentModelId,
                            currentVariant,
                            selectionSource,
                            resolvedAgentName: resolved.agentName,
                            resolvedProviderId: resolved.providerId,
                            resolvedModelId: resolved.modelId,
                            resolvedVariant: resolved.variant,
                        });

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...defaultsSnapshot,
                            providers,
                            agents,
                            currentAgentName: nextSelection.agentName,
                            ...(nextSelection.providerId && nextSelection.modelId
                                ? {
                                    currentProviderId: nextSelection.providerId,
                                    currentModelId: nextSelection.modelId,
                                    currentVariant: nextSelection.variant,
                                    selectedProviderId: nextSelection.providerId,
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
                                    || state.currentVariant !== nextSelection.variant
                                    || state.selectedProviderId !== nextSelection.providerId
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
                                nextState.currentVariant = nextSelection.variant;
                                nextState.selectedProviderId = nextSelection.providerId;
                            }
                        }

                        markStartupTrace('loadAgents:opencodeConfigDefaultsApplied', { directoryKey, eventDirectory, source });
                        return nextState;
                    });
                },

                 setSettingsDefaultModel: (model: string | undefined) => {
                     set({ settingsDefaultModel: model });
                 },

                 setSettingsDefaultVariant: (variant: string | undefined) => {
                     set({ settingsDefaultVariant: variant });
                 },
 
                 setSettingsDefaultAgent: (agent: string | undefined) => {
                     set({ settingsDefaultAgent: agent });
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

                setVoiceProvider: (provider: 'browser' | 'openai' | 'openai-compatible' | 'say') => {
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

                setOpenaiApiKey: (apiKey: string) => {
                    set({ openaiApiKey: apiKey });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiApiKey', apiKey);
                    }
                },

                setOpenaiCompatibleUrl: (url: string) => {
                    set({ openaiCompatibleUrl: url });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiCompatibleUrl', url);
                    }
                },

                setOpenaiCompatibleApiKey: (apiKey: string) => {
                    set({ openaiCompatibleApiKey: apiKey });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiCompatibleApiKey', apiKey);
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

                setSttProvider: (provider: 'browser' | 'server' | 'wasm') => {
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

                setSttApiKey: (apiKey: string) => {
                    set({ sttApiKey: apiKey });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttApiKey', apiKey);
                    }
                },

                setSttModel: (model: string) => {
                    set({ sttModel: model });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttModel', model);
                    }
                    updateDesktopSettings({ sttModel: model }).catch(() => {});
                },

                setWasmSttModel: (model: string) => {
                    set({ wasmSttModel: model });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('wasmSttModel', model);
                    }
                    updateDesktopSettings({ wasmSttModel: model }).catch(() => {});
                },

                setSttLanguage: (lang: string) => {
                    set({ sttLanguage: lang });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttLanguage', lang);
                    }
                    updateDesktopSettings({ sttLanguage: lang }).catch(() => {});
                },

                setSttSilenceThresholdDb: (db: number) => {
                    set({ sttSilenceThresholdDb: db });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttSilenceThresholdDb', String(db));
                    }
                    updateDesktopSettings({ sttSilenceThresholdDb: db }).catch(() => {});
                },

                setSttSilenceHoldMs: (ms: number) => {
                    set({ sttSilenceHoldMs: ms });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttSilenceHoldMs', String(ms));
                    }
                    updateDesktopSettings({ sttSilenceHoldMs: ms }).catch(() => {});
                },

                setSttTranscribeOnStop: (enabled: boolean) => {
                    set({ sttTranscribeOnStop: enabled });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttTranscribeOnStop', String(enabled));
                    }
                    updateDesktopSettings({ sttTranscribeOnStop: enabled }).catch(() => {});
                },

                setShowMessageTTSButtons: (show: boolean) => {
                    set({ showMessageTTSButtons: show });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('showMessageTTSButtons', String(show));
                    }
                },

                setTtsInputMode: (mode: 'sanitized' | 'raw') => {
                    set({ ttsInputMode: mode });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('ttsInputMode', mode);
                    }
                },

                setVoiceModeEnabled: (enabled: boolean) => {
                    set({ voiceModeEnabled: enabled });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('voiceModeEnabled', String(enabled));
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
                    markStartupTrace('checkConnection:start');
                    const maxAttempts = 5;
                    let attempt = 0;
                    let lastError: unknown = null;

                    while (attempt < maxAttempts) {
                        try {
                            markStartupTrace('checkConnection:attempt', { attempt: attempt + 1 });
                            const isHealthy = await measureStartupTrace(
                                'checkConnection:health',
                                () => opencodeClient.checkHealth(),
                                { attempt: attempt + 1 },
                            );
                            if (!isHealthy && attempt < maxAttempts - 1) {
                                const hasEverConnected = get().hasEverConnected;
                                set({
                                    isConnected: false,
                                    connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
                                    lastDisconnectReason: 'health_check_unhealthy',
                                });
                                attempt += 1;
                                await sleep(400 * attempt);
                                continue;
                            }

                            const hasEverConnected = get().hasEverConnected;
                            set(isHealthy
                                ? { isConnected: true, hasEverConnected: true, connectionPhase: "connected" }
                                : {
                                    isConnected: false,
                                    connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
                                    lastDisconnectReason: 'health_check_unhealthy',
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

                    const run = (async () => {
                        const initStarted = typeof performance !== 'undefined' ? performance.now() : Date.now();
                        markStartupTrace('initializeApp:start');
                        try {
                            const debug = streamDebugEnabled();
                            if (debug) console.log("Starting app initialization...");

                            const isConnected = await get().checkConnection();
                            if (debug) console.log("Connection check result:", isConnected);

                            if (!isConnected) {
                                if (debug) console.log("Server not connected");
                                // checkConnection already set lastDisconnectReason; do not overwrite.
                                set({
                                    isConnected: false,
                                    connectionPhase: get().hasEverConnected ? "reconnecting" : "connecting",
                                });
                                return;
                            }

                            if (debug) console.log("Initializing app...");
                            markStartupTrace('initApp:skipped', { reason: 'checkConnection already verified health' });

                            // Stale-while-revalidate: do NOT invalidate the hydrated
                            // provider snapshot here. The pickers keep showing the
                            // last-known providers/agents while loadProviders/loadAgents
                            // below fetch fresh data and overwrite on success. Clearing
                            // first would blank the UI for the duration of the fetch.

                            // Config (providers/agents/defaults) lives at the PROJECT level. If the
                            // app starts on a worktree directory, load config under the owning
                            // project's key so the initial draft — which activates the project — finds
                            // a ready snapshot instead of triggering a second provider/agent load.
                            const initialDirectory = opencodeClient.getDirectory()
                                ?? useDirectoryStore.getState().currentDirectory
                                ?? fromDirectoryKey(get().activeDirectoryKey);
                            const resolvedProject = resolveProjectForSessionDirectory(
                                useProjectsStore.getState().projects,
                                useSessionUIStore.getState().availableWorktreesByProject,
                                initialDirectory ?? null,
                            );
                            const resolvedInitialDirectory = resolveConfigDirectory(resolvedProject?.path ?? initialDirectory ?? null);
                            const configDirectory = resolvedInitialDirectory ?? getFallbackProjectDirectory();
                            if (!configDirectory) {
                                markStartupTrace('initializeApp:noProjectConfigDirectory');
                                set({ isInitialized: true, isConnected: true, hasEverConnected: true, connectionPhase: "connected" });
                                return;
                            }
                            if (!resolvedInitialDirectory && initialDirectory !== configDirectory) {
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
                            }

                            if (debug) console.log("Loading providers and agents...");
                            await Promise.all([
                                get().loadProviders({ directory: configDirectory, source: 'initializeApp' }),
                                get().loadAgents({ directory: configDirectory, source: 'initializeApp' }),
                            ]);

                            set({ isInitialized: true, isConnected: true, hasEverConnected: true, connectionPhase: "connected" });
                            void get().prewarmProjectConfigs(configDirectory);
                            const initEnded = typeof performance !== 'undefined' ? performance.now() : Date.now();
                            markStartupTrace('initializeApp:end', {
                                durationMs: Math.round(initEnded - initStarted),
                                providers: get().providers.length,
                                agents: get().agents.length,
                            });
                            if (debug) console.log("App initialized successfully");
                        } catch (error) {
                            console.error("Failed to initialize app:", error);
                            set({
                                isInitialized: false,
                                isConnected: false,
                                connectionPhase: get().hasEverConnected ? "reconnecting" : "connecting",
                                lastDisconnectReason: 'init_error',
                            });
                            markStartupTrace('initializeApp:error', { error: error instanceof Error ? error.message : String(error) });
                        }
                    })().finally(() => {
                        _initializeAppInFlight = null;
                    });

                    _initializeAppInFlight = run;
                    return run;
                },

                prewarmProjectConfigs: async (initialDirectory?: string | null) => {
                    if (!get().isConnected) {
                        return;
                    }

                    const initialKey = toConfigDirectoryKey(initialDirectory ?? fromDirectoryKey(get().activeDirectoryKey));
                    const projectDirectories = useProjectsStore.getState().projects
                        .map((project) => project.path)
                        .filter((path): path is string => typeof path === 'string' && path.trim().length > 0);
                    const seen = new Set<string>([initialKey]);
                    const queuedDirectories: string[] = [];

                    for (const directory of projectDirectories) {
                        const directoryKey = toConfigDirectoryKey(directory);
                        if (seen.has(directoryKey)) {
                            continue;
                        }
                        seen.add(directoryKey);

                        const snapshot = get().directoryScoped[directoryKey];
                        if (snapshot?.providers.length && snapshot.agents.length) {
                            continue;
                        }
                        const scopedDirectory = fromDirectoryKey(directoryKey);
                        if (scopedDirectory) {
                            queuedDirectories.push(scopedDirectory);
                        }
                    }

                    for (const directory of queuedDirectories) {
                        await sleep(PROJECT_CONFIG_PREWARM_DELAY_MS);
                        if (!get().isConnected) {
                            return;
                        }
                        const directoryKey = toConfigDirectoryKey(directory);
                        const snapshot = get().directoryScoped[directoryKey];
                        const tasks: Promise<unknown>[] = [];
                        if (!snapshot?.providers.length) {
                            tasks.push(get().loadProviders({ directory, source: 'projectConfigPrewarm' }));
                        }
                        if (!snapshot?.agents.length) {
                            tasks.push(get().loadAgents({ directory, source: 'projectConfigPrewarm' }));
                        }
                        if (tasks.length > 0) {
                            await Promise.allSettled(tasks);
                        }
                    }
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
                    return provider.models.find((model) => model.id === currentModelId);
                },

                getCurrentAgent: () => {
                    const { agents, currentAgentName } = get();
                    if (!currentAgentName) return undefined;
                    return agents.find((a) => a.name === currentAgentName);
                },
                getModelMetadata: (providerId: string, modelId: string) => {
                    const key = buildModelMetadataKey(providerId, modelId);
                    if (!key) {
                        return undefined;
                    }
                    const { modelsMetadata, providers } = get();
                    const cached = modelsMetadata.get(key);
                    if (cached) {
                        return cached;
                    }

                    // Fallback: derive metadata from provider model data (covers custom providers not in models.dev)
                    const provider = providers.find((p) => p.id === providerId);
                    if (!provider) {
                        return undefined;
                    }
                    const model = provider.models.find((m) => m.id === modelId);
                    if (!model) {
                        return undefined;
                    }

                    return deriveModelMetadata(providerId, model);
                },
                getVisibleAgents: () => {
                    const { agents } = get();
                    return filterVisibleAgents(agents);
                },
            }),
            {
                name: "config-store",
                storage: createJSONStorage(() => getSafeStorage()),
                merge: (persistedState, currentState) =>
                    hydrateActiveDirectorySnapshot({
                        ...currentState,
                        ...(persistedState && typeof persistedState === 'object'
                            ? (persistedState as Partial<ConfigStore>)
                            : {}),
                    }),
                // Stale-while-revalidate: persist the last-known provider/agent
                // snapshots so the model/agent pickers paint instantly on cold
                // start. Freshness is guaranteed by the background refresh in
                // initializeApp() / activateDirectory() (which overwrite these on
                // success) and by the provider/agent config-change subscriptions.
                partialize: (state) => ({
                    activeDirectoryKey: state.activeDirectoryKey,
                    directoryScoped: state.directoryScoped,
                    providers: state.providers,
                    agents: state.agents,
                    currentProviderId: state.currentProviderId,
                    currentModelId: state.currentModelId,
                    currentVariant: state.currentVariant,
                    currentAgentName: state.currentAgentName,
                    selectedProviderId: state.selectedProviderId,
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

const refreshKnownProviderDirectories = async (source: string): Promise<void> => {
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
            const directoryKey = directoryKeys[nextIndex];
            nextIndex += 1;
            await useConfigStore.getState().loadProviders({
                directory: fromDirectoryKey(directoryKey),
                source,
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
        void useConfigStore.getState().activateDirectory(state.currentDirectory);
    });
}

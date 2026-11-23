import { type ModelMetadata } from '@/types';
import { type ProviderModel, type ProviderWithModelList, type ConfigSlice } from './types';
import { modelVariantNames } from '@/lib/modelVariants';
import { normalizeOptionalString } from './selectionResolution';
import { findCatalogModel } from '@/lib/opencode/model';
import { fetchBypassingRuntimeBridge, runtimeFetch } from '@/lib/runtime-fetch';
import { markStartupTrace, measureStartupTrace } from '@/lib/startupTrace';
import { captureConfigRuntimeContext, isConfigRuntimeContextCurrent } from './runtime';
import { isRecord } from '@/lib/utils';

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const MODELS_DEV_PROXY_URL = "/api/openchamber/models-metadata";

const normalizeProviderId = (value: string) => value?.toLowerCase?.() ?? '';

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
                ? await fetchBypassingRuntimeBridge(source, requestInit)
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

export const ensureModelsMetadataFetch = (
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

export const createMetadataActions: ConfigSlice<'invalidateModelMetadataCache'> = (set) => ({
    invalidateModelMetadataCache: () => {
        modelsMetadataInFlight = null;
        set({ modelsMetadata: new Map<string, ModelMetadata>() });
    },
});

export const resetModelsMetadataRequest = (): void => { modelsMetadataInFlight = null; };

import { parseModelIdentifier, parseModelSelection } from '@/lib/modelIdentifier';
import { type Model, findCatalogModel, type Agent } from '@/lib/opencode/model';
import { type ConfigStore, type CurrentVariantSelection, type DirectoryScopedConfig, type ProviderWithModelList, type ProviderModelSelection, type DefaultAgentModelSelection, type GitModelSelection } from './types';
import { listModelVariantIds, modelVariantNames } from '@/lib/modelVariants';
import { type EffortChoice, resolveEffortChoice, readRememberedEffort } from '@/lib/modelEfforts';
import { isAutoModel } from '@/lib/routing/autoModel';
import { selectAutoReady, useRoutingStore } from '@/stores/useRoutingStore';
import { useUIStore } from '@/stores/useUIStore';
import { type ModelRef } from '@/lib/settings/parsers';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { isAgentHidden } from '../useAgentsStore';

const FALLBACK_PROVIDER_ID = "opencode";
const FALLBACK_MODEL_ID = "big-pickle";
const GIT_UTILITY_PROVIDER_ID = "zen";
const GIT_UTILITY_PREFERRED_MODEL_ID = "big-pickle";

export const resolveVariantFromSelection = (selection: CurrentVariantSelection): string | undefined => {
    if (selection.override === null) return undefined;
    const variant = selection.override ?? selection.inherited;
    return variant ?? undefined;
};

export const variantAfterResolve = (selection: CurrentVariantSelection | undefined, resolved: string | null | undefined): string | undefined => (
    selection?.override === undefined ? resolved ?? undefined : resolveVariantFromSelection(selection)
);

const SELECTION_FIELDS = ["currentProviderId", "currentModelId", "currentAgentName", "selectionSource", "agentSelectionSource"] as const;
type SelectionField = typeof SELECTION_FIELDS[number];

export const isUnchangedSelection = (
    state: Pick<ConfigStore, "activeDirectoryKey" | "directoryScoped" | SelectionField>,
    next: Partial<Pick<DirectoryScopedConfig, SelectionField>>,
): boolean => {
    const snapshot = state.directoryScoped[state.activeDirectoryKey];
    if (!snapshot) return false;
    return SELECTION_FIELDS.every((field) => !(field in next) || (next[field] === state[field] && next[field] === snapshot[field]));
};

export const variantResetForModelChange = (
    state: Pick<ConfigStore, "currentProviderId" | "currentModelId">,
    providerId: string,
    modelId: string,
): Partial<Pick<DirectoryScopedConfig, "currentVariant" | "currentVariantSelection">> => (
    state.currentProviderId === providerId && state.currentModelId === modelId
        ? {}
        : { currentVariant: undefined, currentVariantSelection: { override: undefined, inherited: undefined } }
);

export const parseModelString = (modelString: string): { providerId: string; modelId: string } | null => {
    return parseModelIdentifier(modelString);
};

export const normalizeOptionalString = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

export const findProviderModel = (
    providers: ProviderWithModelList[],
    providerId: string,
    modelId: string,
): Model | undefined => (
    findCatalogModel(providers.find((provider) => provider.id === providerId)?.models, modelId)
);

export const modelHasVariant = (model: Model | undefined, variant: string | null | undefined): boolean => (
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

export const hasProviderModel = (
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

export const isStaleAutoSelection = (settingsDefaultsLoaded: boolean, providerId?: string | null, modelId?: string | null): boolean => {
    if (!providerId || !modelId || !isAutoModel(providerId, modelId)) return false;
    if (!settingsDefaultsLoaded) return false;
    if (!useUIStore.getState().routingFeatureAvailable) return true;
    const routing = useRoutingStore.getState();
    return routing.loaded && !selectAutoReady(routing);
};


export const isMissingFromCatalog = (
    providers: ProviderWithModelList[],
    catalogLoaded: boolean,
    providerId: string,
    modelId: string,
): boolean => catalogLoaded
    && providers.length > 0
    && !isAutoModel(providerId, modelId)
    && !hasProviderModel(providers, providerId, modelId);

type ConfiguredDefault = { model: string | undefined; variant: string | undefined };

export const inheritedDefaultsFor = (
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
    settingsDefaultsLoaded: boolean,
): { providerId: string; modelId: string; variant: string | undefined } | null => {
    for (const candidate of candidates) {
        const parsed = candidate.model ? parseModelString(candidate.model) : null;
        if (!parsed || isStaleAutoSelection(settingsDefaultsLoaded, parsed.providerId, parsed.modelId)) continue;
        if (isMissingFromCatalog(providers, catalogLoaded, parsed.providerId, parsed.modelId)) continue;
        return { ...parsed, variant: candidate.variant };
    }
    return null;
};

export const resolveProviderModelSelection = ({
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

    const preserveManual = preserveCurrent && !isStaleAutoSelection(fallbackPrefs.settingsDefaultsLoaded, currentProviderId, currentModelId);
    if (currentProviderId && currentModelId && (preserveManual || hasProviderModel(providers, currentProviderId, currentModelId))) {
        return {
            providerId: currentProviderId,
            modelId: currentModelId,
            variant: preserveCurrent
                ? currentVariant
                : resolveVariantOrRemembered(currentProviderId, currentModelId, currentVariant),
        };
    }

    const configured = pickConfiguredDefault(providers, catalogLoaded, configuredDefaults, fallbackPrefs.settingsDefaultsLoaded);
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
    const inherited = pickConfiguredDefault(providers, catalogLoaded, inheritedDefaults, fallbackPrefs.settingsDefaultsLoaded);
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
    settingsDefaultsLoaded: boolean;
};

export const readFallbackModelPrefs = (settingsDefaultsLoaded: boolean): FallbackModelPrefs => {
    const { hiddenModels, lastSelectedModel } = useUIStore.getState();
    return { hiddenModels, lastSelectedModel, settingsDefaultsLoaded };
};

const isModelHidden = (hiddenModels: readonly ModelRef[], providerId: string, modelId: string): boolean => hiddenModels.some(
    (hidden) => hidden.providerID === providerId && hidden.modelID === modelId,
);

const resolveLastSelectedModel = (
    { hiddenModels, lastSelectedModel, settingsDefaultsLoaded }: FallbackModelPrefs,
    providers: ProviderWithModelList[],
    catalogLoaded: boolean,
): { providerId: string; modelId: string } | null => {
    const parsed = lastSelectedModel ? parseModelString(lastSelectedModel) : null;
    if (!parsed) return null;
    if (isModelHidden(hiddenModels, parsed.providerId, parsed.modelId)) return null;
    if (isStaleAutoSelection(settingsDefaultsLoaded, parsed.providerId, parsed.modelId)) return null;
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


export const resolveDefaultAgentModelSelection = ({
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
    ], fallbackPrefs.settingsDefaultsLoaded);
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

export const resolveGitGenerationModelSelection = ({
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

export const resolveConfiguredDefaultVariant = (
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

export const resolveSelectionWithManualGuard = ({
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

import { type ConfigStore, type CurrentVariantSelection, type DirectoryScopedConfig, type ProviderWithModelList } from './types';
import { type Agent } from '@/lib/opencode/model';

export const hasLiveCatalog = (state: Pick<ConfigStore, 'directoryScoped'>, directoryKey: string): boolean => (
    state.directoryScoped[directoryKey]?.providersLoaded === true
);

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

export const createEmptyDirectoryScopedConfig = (
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

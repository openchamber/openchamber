import { type ConfigSlice, type DirectoryScopedConfig, type CurrentVariantSelection } from './types';
import { isUnchangedSelection, resolveVariantFromSelection } from './selectionResolution';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { findProviderModel, modelHasVariant, parseModelString, resolveInheritedDefaultVariant } from './selectionResolution';
import { modelVariantNames } from '@/lib/modelVariants';
import { resolveEffortChoice, readRememberedEffort } from '@/lib/modelEfforts';
import { findCatalogModel } from '@/lib/opencode/model';
import { fromDirectoryKey } from './directories';
import { getProjectDefaultsForConfigDirectory } from './projectDefaults';

export const createAgentSelection: ConfigSlice<'setAgent'> = (set, get) => ({
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
                const inheritedDefault = resolveInheritedDefaultVariant({
                    ...getProjectDefaultsForConfigDirectory(fromDirectoryKey(get().activeDirectoryKey)),
                    settingsDefaultModel: get().settingsDefaultModel,
                    settingsDefaultVariant: get().settingsDefaultVariant,
                }, providerId, modelId);
                const inherited = variantOptions
                    ? resolveEffortChoice(
                        [agentVariant, configuredVariant, readRememberedEffort(providerId, modelId), inheritedDefault],
                        variantOptions,
                    )
                    : [agentVariant, configuredVariant, inheritedDefault].find(isAvailable);

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

            const scopeDefaultModel = currentSessionId
                ? undefined
                : getProjectDefaultsForConfigDirectory(fromDirectoryKey(get().activeDirectoryKey)).projectDefaultModel;
            for (const configuredModel of [scopeDefaultModel, settingsDefaultModel]) {
                const parsed = configuredModel ? parseModelString(configuredModel) : null;
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
});

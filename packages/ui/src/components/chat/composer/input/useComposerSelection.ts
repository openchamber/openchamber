import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerColumn } from './useComposerColumn';
import React from 'react';
import { resolveModelMetadata, useConfigStore } from '@/stores/useConfigStore';
import { filterVisibleAgents } from '@/stores/useAgentsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSelectionStore } from '@/sync/selection-store';
import { btwModelAvailability, resolveBtwSelection } from '@/stores/useBtwStore';
import { usePinnedComposerSelection } from '../../pinnedComposerSelection';
import { findCatalogModel } from '@/lib/opencode/model';
import { selectAutoReady, useRoutingStore } from '@/stores/useRoutingStore';
import { providersOfSpaceOffer, spaceOfferAllows, useSpaceModelOffer } from '@/lib/spaces/space-model-offer';
import { useComposerFollowsSpace } from '@/lib/spaces/useComposerFollowsSpace';
import { AUTO_PROVIDER_ID } from '@/lib/routing/autoModel';
import { useKeybinds } from '@/hooks/useKeybind';
import { getNextFavoriteModel } from '@/lib/modelRefs';
import { modelVariantNames, nextThinkingVariant } from '@/lib/modelVariants';

type Dependencies = {
    column: Pick<ReturnType<typeof useComposerColumn>, 'columnPinned'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerFormRef'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'currentSessionId' | 'currentDirectory' | 'isBtwActive' | 'btwComposerSessionId' | 'sessionAgentPick' | 'btwAgentSelection' | 'btwModelSelection' | 'spaceTarget'>;
};

export function useComposerSelection({
    column, editorState, sessionScope,
}: Dependencies) {
    const { columnPinned } = column;
    const { composerFormRef } = editorState;
    const {
        currentSessionId, currentDirectory, isBtwActive, btwComposerSessionId, sessionAgentPick,
        btwAgentSelection, btwModelSelection, spaceTarget,
    } = sessionScope;

    useComposerFollowsSpace(columnPinned ? null : spaceTarget, currentSessionId ?? null);

    const spaceOffer = useSpaceModelOffer(spaceTarget);

    const pinnedComposerSelection = usePinnedComposerSelection({
        enabled: columnPinned,
        sessionId: currentSessionId,
        directory: currentDirectory ?? null,
    });

    const mailboxTarget = columnPinned ? currentSessionId : null;

    const shownSessionId = isBtwActive ? btwComposerSessionId : currentSessionId;

    const configProviderId = useConfigStore((state) => state.currentProviderId);

    const configModelId = useConfigStore((state) => state.currentModelId);

    const configCatalogLoaded = useConfigStore((state) => state.providersLoaded && state.agentsLoaded);

    const currentProviderId = pinnedComposerSelection?.model?.providerId ?? configProviderId;

    const currentModelId = pinnedComposerSelection?.model?.modelId ?? configModelId;

    const modelsMetadata = useConfigStore((state) => state.modelsMetadata);

    const providerCatalog = useConfigStore((state) => state.providers);

    const usableProviders = React.useMemo(() => providersOfSpaceOffer(spaceOffer, providerCatalog), [providerCatalog, spaceOffer]);

    const autoReady = useRoutingStore(selectAutoReady);

    const currentModelMetadata = React.useMemo(
        () => currentProviderId && currentModelId
            ? resolveModelMetadata(modelsMetadata, providerCatalog, currentProviderId, currentModelId)
            : undefined,
        [currentProviderId, currentModelId, modelsMetadata, providerCatalog],
    );

    const configVariant = useConfigStore((state) => state.currentVariant);

    const currentVariant = pinnedComposerSelection ? pinnedComposerSelection.variant ?? undefined : configVariant;

    const currentVariantSelection = useConfigStore((state) => state.currentVariantSelection);

    const configAgentName = useConfigStore((state) => state.currentAgentName);

    const currentAgentName = pinnedComposerSelection?.agent ?? sessionAgentPick ?? configAgentName;

    const setAgent = useConfigStore((state) => state.setAgent);

    const allAgents = useConfigStore((state) => state.agents);

    const agents = React.useMemo(() => filterVisibleAgents(allAgents), [allAgents]);

    const btwSavedVariant = useSelectionStore(React.useCallback(
        (state) => btwComposerSessionId && btwAgentSelection && btwModelSelection
            ? state.getAgentModelVariantForSession(
                btwComposerSessionId,
                btwAgentSelection,
                btwModelSelection.providerId,
                btwModelSelection.modelId,
            )
            : undefined,
        [btwAgentSelection, btwComposerSessionId, btwModelSelection],
    ));

    const btwComposerVariant = pinnedComposerSelection
        ? pinnedComposerSelection.variant
        : currentVariantSelection.override === null ? null : currentVariantSelection.override ?? configVariant;

    const effectiveBtwSelection = React.useMemo(() => resolveBtwSelection({
        agents,
        savedAgent: btwAgentSelection,
        isModelAvailable: btwModelAvailability(usableProviders, autoReady && spaceOfferAllows(spaceOffer, AUTO_PROVIDER_ID)),
        savedModel: btwModelSelection,
        savedVariant: btwSavedVariant,
        composerModel: currentProviderId && currentModelId ? { providerId: currentProviderId, modelId: currentModelId } : null,
        composerVariant: btwComposerVariant,
    }), [agents, autoReady, btwAgentSelection, btwComposerVariant, btwModelSelection, btwSavedVariant, currentModelId, currentProviderId, spaceOffer, usableProviders]);

    React.useEffect(() => {
        const { model, agent, variant } = effectiveBtwSelection;
        if (!isBtwActive || !btwComposerSessionId || !model || !agent) return;
        const selections = useSelectionStore.getState();
        if (selections.getSessionModelSelection(btwComposerSessionId)) return;
        selections.saveSessionAgentSelection(btwComposerSessionId, agent);
        selections.saveSessionModelSelection(btwComposerSessionId, model.providerId, model.modelId);
        selections.saveAgentModelForSession(btwComposerSessionId, agent, model.providerId, model.modelId);
        selections.saveAgentModelVariantForSession(btwComposerSessionId, agent, model.providerId, model.modelId, variant);
    }, [btwComposerSessionId, effectiveBtwSelection, isBtwActive]);

    const [btwModelSelectorOpen, setBtwModelSelectorOpen] = React.useState(false);

    if (!isBtwActive && btwModelSelectorOpen) setBtwModelSelectorOpen(false);

    const isBtwKey = (event: KeyboardEvent): boolean => {
        const keyColumn = event.target instanceof Element ? event.target.closest('[data-chat-column="pinned"]') : null;
        if (columnPinned ? !keyColumn?.contains(composerFormRef.current) : keyColumn) return false;
        const ui = useUIStore.getState();
        return !(ui.isSettingsDialogOpen
            || ui.isCommandPaletteOpen
            || ui.isHelpDialogOpen
            || ui.isSessionSwitcherOpen
            || ui.isAboutDialogOpen);
    };

    const cycleBtwFavoriteModel = (event: KeyboardEvent, delta: number): boolean | void => {
        if (!isBtwKey(event) || !btwComposerSessionId) return false;
        const ui = useUIStore.getState();
        const { model, agent } = effectiveBtwSelection;
        const next = getNextFavoriteModel(
            ui.favoriteModels,
            usableProviders,
            ui.hiddenModels,
            { providerID: model?.providerId ?? '', modelID: model?.modelId ?? '' },
            delta,
        );
        if (!next) return false;
        const selections = useSelectionStore.getState();
        selections.saveSessionModelSelection(btwComposerSessionId, next.providerID, next.modelID);
        if (agent) selections.saveAgentModelForSession(btwComposerSessionId, agent, next.providerID, next.modelID);
        selections.pickSessionModel(btwComposerSessionId, next.providerID, next.modelID);
    };

    const cycleBtwThinkingVariant = (event: KeyboardEvent): boolean | void => {
        if (!isBtwKey(event) || !btwComposerSessionId) return false;
        const { model, agent, variant } = effectiveBtwSelection;
        if (!model || !agent) return false;
        const variants = modelVariantNames(findCatalogModel(providerCatalog.find((provider) => provider.id === model.providerId)?.models, model.modelId));
        if (variants.length === 0) return false;
        useSelectionStore.getState().saveAgentModelVariantForSession(
            btwComposerSessionId,
            agent,
            model.providerId,
            model.modelId,
            nextThinkingVariant(variants, variant),
        );
        useSelectionStore.getState().pickSessionModel(btwComposerSessionId, model.providerId, model.modelId);
    };

    useKeybinds(isBtwActive ? {
        open_model_selector: (event) => {
            if (!isBtwKey(event) || !btwComposerSessionId) return false;
            setBtwModelSelectorOpen((open) => !open);
        },
        cycle_thinking_variant: cycleBtwThinkingVariant,
        cycle_favorite_model_forward: (event) => cycleBtwFavoriteModel(event, 1),
        cycle_favorite_model_backward: (event) => cycleBtwFavoriteModel(event, -1),
    } : {});

    return {
        currentProviderId, currentModelId, currentModelMetadata, agents, mailboxTarget, shownSessionId,
        currentAgentName, currentVariant, effectiveBtwSelection, configCatalogLoaded, setAgent,
        btwModelSelectorOpen, setBtwModelSelectorOpen, pinnedComposerSelection,
    };
}

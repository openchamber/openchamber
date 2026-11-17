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
import { useKeybinds } from '@/hooks/useKeybind';
import { getNextFavoriteModel } from '@/lib/modelRefs';
import { modelVariantNames, nextThinkingVariant } from '@/lib/modelVariants';

type Dependencies = {
    column: Pick<ReturnType<typeof useComposerColumn>, 'columnPinned'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerFormRef'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'currentSessionId' | 'currentDirectory' | 'isBtwActive' | 'btwComposerSessionId' | 'sessionAgentPick' | 'btwAgentSelection' | 'btwModelSelection'>;
};

export function useComposerSelection({
    column, editorState, sessionScope,
}: Dependencies) {
    const { columnPinned } = column;
    const { composerFormRef } = editorState;
    const {
        currentSessionId, currentDirectory, isBtwActive, btwComposerSessionId, sessionAgentPick,
        btwAgentSelection, btwModelSelection,
    } = sessionScope;

    // A pinned column's composer sends with its own selection; the app-wide
    // current model, agent and effort belong to the main chat.
    const pinnedComposerSelection = usePinnedComposerSelection({
        enabled: columnPinned,
        sessionId: currentSessionId,
        directory: currentDirectory ?? null,
    });

    // Pending text and context other parts of the app leave for "the
    // composer" are the main chat's; a pinned composer takes only what was
    // addressed to its session (see input-store `pendingInputTarget`).
    const mailboxTarget = columnPinned ? currentSessionId : null;

    // The session this composer is talking to, which `/btw` changes. Text
    // addressed to a session (a revert of that session's message) belongs here
    // only while this composer is the one showing it.
    const shownSessionId = isBtwActive ? btwComposerSessionId : currentSessionId;

    const configProviderId = useConfigStore((state) => state.currentProviderId);

    const configModelId = useConfigStore((state) => state.currentModelId);

    const configCatalogLoaded = useConfigStore((state) => state.providersLoaded && state.agentsLoaded);

    const currentProviderId = pinnedComposerSelection?.model?.providerId ?? configProviderId;

    const currentModelId = pinnedComposerSelection?.model?.modelId ?? configModelId;

    const modelsMetadata = useConfigStore((state) => state.modelsMetadata);

    const providerCatalog = useConfigStore((state) => state.providers);

    const autoReady = useRoutingStore(selectAutoReady);

    // The composer renders on every keystroke; for a model models.dev does not
    // list, a lookup scans the whole metadata catalog and builds a new object.
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

    // Filtered here rather than through `getVisibleAgents()`, which returns a
    // new array on every call: that identity would rebuild the language
    // context, and with it re-tokenize the editor, on every keystroke.
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

    // A pinned chat's `/btw` starts on that chat's level, as it does on its model.
    const btwComposerVariant = pinnedComposerSelection
        ? pinnedComposerSelection.variant
        : currentVariantSelection.override === null ? null : currentVariantSelection.override ?? configVariant;

    // Memoized: the footer and its model controls compare this selection by
    // identity, and nothing in it changes while the user types.
    const effectiveBtwSelection = React.useMemo(() => resolveBtwSelection({
        agents,
        savedAgent: btwAgentSelection,
        isModelAvailable: btwModelAvailability(providerCatalog, autoReady),
        savedModel: btwModelSelection,
        savedVariant: btwSavedVariant,
        composerModel: currentProviderId && currentModelId ? { providerId: currentProviderId, modelId: currentModelId } : null,
        composerVariant: btwComposerVariant,
    }), [agents, autoReady, btwAgentSelection, btwComposerVariant, btwModelSelection, btwSavedVariant, currentModelId, currentProviderId, providerCatalog]);

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

    // While BTW is open the app-wide model, effort and favorite-model handlers
    // decline, so the parent's selection never moves; these act on the BTW
    // selection its chips show and save it the way the BTW picker does
    // (#5914, #6403). As with permission keys, a key pressed in a chat pinned
    // in the side panel is that chat's and a key pressed anywhere else is the
    // main chat's.
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
            providerCatalog,
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

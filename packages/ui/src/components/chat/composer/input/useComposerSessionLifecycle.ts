import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerMobilePanels } from './useComposerMobilePanels';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerDraftHistory } from './useComposerDraftHistory';
import type { useComposerColumn } from './useComposerColumn';
import React from 'react';
import { selectAutoReviewRunning, useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useInputStore } from '@/sync/input-store';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { createChatDraftIdentity, clearChatDraft } from '@/lib/chatDraftPersistence';
import { useBtwStore } from '@/stores/useBtwStore';
import { btwPendingComposerKey } from '@/lib/btw';
import { useSessionActivity } from '@/hooks/useSessionActivity';
import { type MobileControlsPanel } from '../../mobileControlsUtils';
import { usePendingComposerText } from '../../composer/state/usePendingComposerText';

type Dependencies = {
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'currentSessionId' | 'immediateBtwSubmitRef' | 'btwSessionId' | 'activeRuntimeKey' | 'currentSessionDirectoryForSync' | 'currentDirectory' | 'pendingBtwComposerRequest' | 'isBtwActive' | 'chatDraftIdentity' | 'consumePendingBtwComposerRequest' | 'newSessionDraftOpen' | 'btwDirectory'>;
    draftHistory: Pick<ReturnType<typeof useComposerDraftHistory>, 'restoreDraft'>;
    column: Pick<ReturnType<typeof useComposerColumn>, 'focusColumnInput' | 'columnPinned'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    mobilePanels: Pick<ReturnType<typeof useComposerMobilePanels>, 'setMobileControlsPanel'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'setInputMode' | 'composerText' | 'setMessage'>;
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'isMobile'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'mailboxTarget' | 'shownSessionId'>;
};

export function useComposerSessionLifecycle({
    sessionScope, draftHistory, column, editorState, mobilePanels, draftText, preferences, selection,
}: Dependencies) {
    const {
        currentSessionId, immediateBtwSubmitRef, btwSessionId, activeRuntimeKey,
        currentSessionDirectoryForSync, currentDirectory, pendingBtwComposerRequest, isBtwActive,
        chatDraftIdentity, consumePendingBtwComposerRequest, newSessionDraftOpen, btwDirectory,
    } = sessionScope;
    const { restoreDraft } = draftHistory;
    const { focusColumnInput, columnPinned } = column;
    const { composerRef } = editorState;
    const { setMobileControlsPanel } = mobilePanels;
    const { setInputMode, composerText, setMessage } = draftText;
    const { isMobile } = preferences;
    const { mailboxTarget, shownSessionId } = selection;

    const handleExitBtw = React.useCallback(() => {
        if (!currentSessionId) return;
        immediateBtwSubmitRef.current = null;
        const panels = useBtwStore.getState();
        const pending = panels.byParent[currentSessionId];
        if (pending?.pending && !pending.creating && !btwSessionId) {
            const pendingSessionId = btwPendingComposerKey(currentSessionId);
            const identity = createChatDraftIdentity(activeRuntimeKey, currentSessionDirectoryForSync ?? currentDirectory, pendingSessionId);
            if (identity) {
                clearChatDraft(identity, true);
                useInlineCommentDraftStore.getState().clearDrafts({ directory: identity.directory, sessionKey: pendingSessionId });
            }
            useSelectionStore.getState().clearSessionSelections(pendingSessionId);
            useInputStore.getState().consumePendingBtwComposerRequest(currentSessionId);
            panels.clearPanelState(currentSessionId);
            return;
        }
        panels.setPanelState(currentSessionId, { collapsed: true });
    }, [activeRuntimeKey, btwSessionId, currentDirectory, currentSessionDirectoryForSync, currentSessionId, immediateBtwSubmitRef]);

    React.useEffect(() => {
        const request = pendingBtwComposerRequest;
        if (!request || request.parentSessionId !== currentSessionId) return;
        if (!isBtwActive) {
            useBtwStore.getState().setPanelState(
                request.parentSessionId,
                btwSessionId ? { collapsed: false } : { pending: true, collapsed: false },
            );
            return;
        }
        if (!chatDraftIdentity) return;
        const consumed = consumePendingBtwComposerRequest(currentSessionId);
        if (!consumed) return;
        restoreDraft(chatDraftIdentity, consumed.text, new Set());
        queueMicrotask(() => focusColumnInput());
    }, [btwSessionId, chatDraftIdentity, consumePendingBtwComposerRequest, currentSessionId, focusColumnInput, isBtwActive, pendingBtwComposerRequest, restoreDraft]);

    const prevNewSessionDraftOpenRef = React.useRef(newSessionDraftOpen);

    React.useEffect(() => {
        if (!prevNewSessionDraftOpenRef.current && newSessionDraftOpen && !columnPinned) {
            requestAnimationFrame(() => {
                if (isMobile) {
                    composerRef.current?.focus({ preventScroll: true });
                } else {
                    composerRef.current?.focus();
                }
            });
        }
        prevNewSessionDraftOpenRef.current = newSessionDraftOpen;
    }, [columnPinned, newSessionDraftOpen, isMobile, composerRef]);

    const { phase: currentSessionPhase } = useSessionActivity(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory ?? undefined);

    const { phase: btwSessionPhase } = useSessionActivity(btwSessionId, btwDirectory ?? undefined);

    const sessionPhase = isBtwActive ? btwSessionPhase : currentSessionPhase;

    const autoReviewDirectory = currentSessionDirectoryForSync ?? currentDirectory;

    const autoReviewRunning = useAutoReviewStore(React.useMemo(
        () => selectAutoReviewRunning(currentSessionId, autoReviewDirectory),
        [currentSessionId, autoReviewDirectory],
    ));

    const handleOpenMobilePanel = React.useCallback((panel: MobileControlsPanel) => {
        if (!isMobile) {
            return;
        }
        setMobileControlsPanel(panel);
        composerRef.current?.blur();
    }, [isMobile, composerRef, setMobileControlsPanel]);

    const focusComposer = React.useCallback(() => composerRef.current?.focus(), [composerRef]);

    const leaveShellMode = React.useCallback(() => setInputMode('normal'), [setInputMode]);

    usePendingComposerText({
        target: mailboxTarget,
        sessionId: shownSessionId,
        text: composerText,
        setMessage,
        focus: focusComposer,
        holdSlashCommand: isBtwActive,
        onSlashCommand: leaveShellMode,
    });

    return {
        sessionPhase, autoReviewRunning, currentSessionPhase, handleExitBtw, handleOpenMobilePanel,
    };
}

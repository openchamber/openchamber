import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useChatTurnNavigation } from '../hooks/useChatTurnNavigation';
import type { useChatSurfaceMode } from '../useChatSurfaceMode';
import type { useChatTimelineController } from '../hooks/useChatTimelineController';
import { useChatKeyboardNavigation } from './chatKeyboardNavigation';

type ColumnTurnNavigation = {
    navigation: ReturnType<typeof useChatTurnNavigation>;
    handlePromptNavigatorSelect: (turnId: string) => void;
    canLoadEarlierPrompts: boolean;
    showPromptNavigator: boolean;
};

/** Turn-to-turn navigation: the prompt navigator, its visibility, and the arrow keys. */
export const useColumnTurnNavigation = ({
    pinned,
    isMobile,
    chatSurfaceMode,
    isDesktopExpandedInput,
    currentSessionId,
    timelineController,
    scrollRef,
}: {
    pinned: boolean;
    isMobile: boolean;
    chatSurfaceMode: ReturnType<typeof useChatSurfaceMode>;
    isDesktopExpandedInput: boolean;
    currentSessionId: string | null;
    timelineController: ReturnType<typeof useChatTimelineController>;
    scrollRef: React.RefObject<HTMLDivElement | null>;
}): ColumnTurnNavigation => {
    const promptNavigatorEnabled = useUIStore((state) => state.promptNavigatorEnabled);
    const navigation = useChatTurnNavigation({
        sessionId: currentSessionId,
        turnIds: timelineController.turnIds,
        activeTurnId: timelineController.activeTurnId,
        scrollToTurn: timelineController.scrollToTurn,
        scrollToMessage: timelineController.scrollToMessage,
        resumeToBottom: timelineController.resumeToBottomInstant,
    });
    const handlePromptNavigatorSelect = React.useCallback((turnId: string) => {
        // Instant on purpose: a long smooth scroll through a virtualized
        // timeline gets cancelled by row remounts and lands mid-way or on the
        // wrong message; a teleport always arrives.
        void navigation.scrollToTurnId(turnId, { behavior: 'auto' });
    }, [navigation]);
    const canLoadEarlierPrompts = timelineController.historySignals.canLoadEarlier;
    // The mini chat window is too narrow for the navigator's panel.
    const showPromptNavigator = !isMobile
        && chatSurfaceMode !== 'mini-chat'
        && !isDesktopExpandedInput
        && promptNavigatorEnabled
        && timelineController.turnIds.length >= 2;

    React.useEffect(() => {
        if (!showPromptNavigator && !pinned) {
            useUIStore.getState().setPromptNavigatorPanelOpen(false);
        }
    }, [pinned, showPromptNavigator]);

    useChatKeyboardNavigation({ currentSessionId, isDesktopExpandedInput, navigation, scrollRef });

    return { navigation, handlePromptNavigatorSelect, canLoadEarlierPrompts, showPromptNavigator };
};

import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useRightSlotStore } from '@/components/layout/rightSlot';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { useWorkStatusVisibility } from '../work-status/useWorkStatusVisibility';
import type { useChatSurfaceMode } from '../useChatSurfaceMode';

type NewSessionDraft = {
    open?: boolean;
    target?: string;
    bootstrapPendingDirectory?: string | null;
    directoryOverride?: string | null;
};

/**
 * Where the work-status panel goes for this column: beside the transcript in
 * the right slot, or over the chat when there is no room, and which directory
 * its readouts describe.
 */
export const useWorkStatusPlacement = ({
    pinned,
    isMobile,
    isVSCode,
    chatSurfaceMode,
    draftOpen,
    newSessionDraft,
    effectiveSessionDirectory,
    columnRootRef,
}: {
    pinned: boolean;
    isMobile: boolean;
    isVSCode: boolean;
    chatSurfaceMode: ReturnType<typeof useChatSurfaceMode>;
    draftOpen: boolean;
    newSessionDraft: NewSessionDraft | undefined;
    effectiveSessionDirectory: string | undefined;
    columnRootRef: React.MutableRefObject<HTMLDivElement | null>;
}) => {
    const isManagedChatContext = draftOpen
        ? newSessionDraft?.target === 'chat'
        : isChatDirectoryPath(effectiveSessionDirectory);
    // A draft can target another project or a pending worktree before it has a
    // session. Keep the panel on that same directory so its project, MCP, and
    // usage readouts describe where the draft will run rather than the project
    // the user came from.
    const workStatusDirectory = draftOpen
        ? (isManagedChatContext ? null : newSessionDraft?.bootstrapPendingDirectory ?? newSessionDraft?.directoryOverride ?? effectiveSessionDirectory)
        : effectiveSessionDirectory;
    // Work-status panel: a borderless column to the right of the transcript.
    // It yields to a narrow chat, and to the context panel unless the chat area
    // fits both beside the transcript; `rowRef` goes on the row that holds both
    // columns, so its width never depends on the panel's own visibility.
    const {
        rowRef: workStatusRowRef,
        visible: workStatusVisible,
        fits: workStatusFits,
        roomy: workStatusRoomy,
        roomyBesidePanel: workStatusRoomyBesidePanel,
    } = useWorkStatusVisibility({
        isMobile,
        isVSCode,
    });
    const attachColumnRoot = React.useCallback((node: HTMLDivElement | null) => {
        columnRootRef.current = node;
        workStatusRowRef(node);
    }, [columnRootRef, workStatusRowRef]);
    // Surfaces that never host the panel skip it entirely; the rest keep it
    // mounted so its visibility can animate rather than snap.
    // A pinned column leaves the panel, and the app-wide flags below, to the
    // main chat.
    const workStatusPanelMountable = !isMobile
        && !pinned
        && chatSurfaceMode !== 'mini-chat';
    const showWorkStatusPanel = workStatusPanelMountable && workStatusVisible;
    // The inline card renders in the right slot beside the chat, which owns
    // the one width animation for the card and the context panel together
    // (components/layout/rightSlot.ts).
    const workStatusHost = useRightSlotStore((state) => state.workStatusHost);

    // Offered over the chat when there is no room beside it. The panel is still
    // switched on; only the layout refuses it.
    const workStatusPanelEnabled = useUIStore((state) => state.workStatusPanelEnabled);
    const workStatusOverlayOpen = useUIStore((state) => state.workStatusOverlayOpen);
    const setWorkStatusPanelFits = useUIStore((state) => state.setWorkStatusPanelFits);
    // Mounted whenever it could be shown, not only while it is: an element
    // that appears and disappears with the condition has nothing to animate.
    const workStatusOverlayMountable = workStatusPanelMountable
        && workStatusPanelEnabled
        && !workStatusFits;
    // The slot keeps the card's column while the context panel covers it.
    const workStatusReserved = workStatusPanelMountable && workStatusPanelEnabled && workStatusRoomy;
    const showWorkStatusOverlay = workStatusOverlayMountable && workStatusOverlayOpen;

    React.useEffect(() => {
        if (pinned) return;
        setWorkStatusPanelFits(workStatusPanelMountable && workStatusFits);
        return () => setWorkStatusPanelFits(false);
    }, [pinned, setWorkStatusPanelFits, workStatusFits, workStatusPanelMountable]);

    // Published so the header can drop the readouts the panel already carries.
    // Cleared on unmount: a chat that goes away is not showing anything.
    const setWorkStatusPanelVisible = useUIStore((state) => state.setWorkStatusPanelVisible);
    React.useEffect(() => {
        if (pinned) return;
        setWorkStatusPanelVisible(showWorkStatusPanel);
        return () => setWorkStatusPanelVisible(false);
    }, [pinned, setWorkStatusPanelVisible, showWorkStatusPanel]);

    return {
        attachColumnRoot,
        isManagedChatContext,
        workStatusDirectory,
        workStatusPanelMountable,
        showWorkStatusPanel,
        workStatusHost,
        workStatusOverlayMountable,
        showWorkStatusOverlay,
        workStatusReserved,
        workStatusRoomyBesidePanel,
    };
};

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
    const workStatusDirectory = draftOpen
        ? (isManagedChatContext ? null : newSessionDraft?.bootstrapPendingDirectory ?? newSessionDraft?.directoryOverride ?? effectiveSessionDirectory)
        : effectiveSessionDirectory;
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
    const workStatusPanelMountable = !isMobile
        && !pinned
        && chatSurfaceMode !== 'mini-chat';
    const showWorkStatusPanel = workStatusPanelMountable && workStatusVisible;
    const workStatusHost = useRightSlotStore((state) => state.workStatusHost);

    const workStatusPanelEnabled = useUIStore((state) => state.workStatusPanelEnabled);
    const workStatusOverlayOpen = useUIStore((state) => state.workStatusOverlayOpen);
    const setWorkStatusPanelFits = useUIStore((state) => state.setWorkStatusPanelFits);
    const workStatusOverlayMountable = workStatusPanelMountable
        && workStatusPanelEnabled
        && !workStatusFits;
    const workStatusReserved = workStatusPanelMountable && workStatusPanelEnabled && workStatusRoomy;
    const showWorkStatusOverlay = workStatusOverlayMountable && workStatusOverlayOpen;

    React.useEffect(() => {
        if (pinned) return;
        setWorkStatusPanelFits(workStatusPanelMountable && workStatusFits);
        return () => setWorkStatusPanelFits(false);
    }, [pinned, setWorkStatusPanelFits, workStatusFits, workStatusPanelMountable]);

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

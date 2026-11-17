import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { CHAT_INPUT_EDITOR_SELECTOR } from '../composer/editor/dom';
import { useChatColumnActions, type ChatColumnActions } from '../chatColumnSession';
import type { PinnedSelection } from './useChatColumnSelection';

export const useChatColumnControls = ({
    pinned,
    setPinnedSelection,
}: {
    pinned: boolean;
    setPinnedSelection: (selection: PinnedSelection) => void;
}) => {
    const globalTimelineDialogOpen = useUIStore((s) => s.isTimelineDialogOpen);
    const setGlobalTimelineDialogOpen = useUIStore((s) => s.setTimelineDialogOpen);
    const [pinnedTimelineDialogOpen, setPinnedTimelineDialogOpen] = React.useState(false);
    const isTimelineDialogOpen = pinned ? pinnedTimelineDialogOpen : globalTimelineDialogOpen;
    const setTimelineDialogOpen = pinned ? setPinnedTimelineDialogOpen : setGlobalTimelineDialogOpen;
    const columnRootRef = React.useRef<HTMLDivElement | null>(null);
    const pinnedColumnActions = React.useMemo<ChatColumnActions | null>(() => (pinned ? {
        pinned: true,
        openSession: (sessionId, directory) => setPinnedSelection({ sessionId, directory }),
        openTimelineDialog: () => setPinnedTimelineDialogOpen(true),
        focusInput: () => columnRootRef.current?.querySelector<HTMLElement>(CHAT_INPUT_EDITOR_SELECTOR)?.focus(),
    } : null), [pinned, setPinnedSelection]);
    const inheritedColumnActions = useChatColumnActions();
    const columnActions = pinnedColumnActions ?? inheritedColumnActions;

    return { columnRootRef, columnActions, isTimelineDialogOpen, setTimelineDialogOpen };
};

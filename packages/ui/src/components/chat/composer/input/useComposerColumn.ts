import { useChatColumnActions, useChatColumnSession } from '../../chatColumnSession';



export function useComposerColumn() {
    const chatColumnSession = useChatColumnSession();

    const { pinned: columnPinned, openTimelineDialog, focusInput: focusColumnInput } = useChatColumnActions();

    return {
        chatColumnSession, columnPinned, openTimelineDialog, focusColumnInput,
    };
}

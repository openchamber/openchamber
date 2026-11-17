import { useChatColumnActions, useChatColumnSession } from '../../chatColumnSession';



export function useComposerColumn() {
    // The session this composer belongs to: its column's (see
    // chatColumnSession.ts); outside a column it follows the live selection.
    const chatColumnSession = useChatColumnSession();

    const { pinned: columnPinned, openTimelineDialog, focusInput: focusColumnInput } = useChatColumnActions();

    return {
        chatColumnSession, columnPinned, openTimelineDialog, focusColumnInput,
    };
}

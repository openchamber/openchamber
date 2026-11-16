import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { eventMatchesShortcut, getEffectiveShortcutCombo } from '@/lib/shortcuts';

// ── in-conversation search ──────────────────────────────────────────────
// Cmd+F belongs to whatever has focus: the editor keeps its own search,
// the chat (its composer, or nothing focused after clicking its text)
// opens this bar. With several chat columns on screen, an unfocused
// Cmd+F goes to the column the pointer last pressed in. Search is opt-in;
// while it is off the shortcut is left alone. VS Code has no OpenChamber
// server and so no index to search.
export const useChatSearch = ({
    active,
    currentSessionId,
}: {
    active: boolean;
    currentSessionId: string | null;
}) => {
    const chatRootRef = React.useRef<HTMLDivElement>(null);
    const lastPressedInsideRef = React.useRef(false);
    const [chatSearch, setChatSearch] = React.useState({ open: false, focusRequest: 0 });
    const [chatSearchSessionId, setChatSearchSessionId] = React.useState(currentSessionId);
    // The search belongs to the conversation it was opened in. Close it
    // synchronously on session switch: a passive effect would leave one
    // commit rendering the old hits under the new session id, and the bar
    // would re-issue message focus for the new session with the old hit's
    // id, ending in a "linked message not found" toast.
    if (chatSearchSessionId !== currentSessionId) {
        setChatSearchSessionId(currentSessionId);
        if (chatSearch.open) setChatSearch((current) => ({ ...current, open: false }));
    }
    const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
    const messageSearchEnabled = useUIStore((state) => state.messageSearchEnabled);
    React.useEffect(() => {
        if (!active || !currentSessionId || !messageSearchEnabled || isVSCodeRuntime()) return;
        const combo = getEffectiveShortcutCombo('find_in_file', shortcutOverrides);
        const onPointerDown = (event: PointerEvent) => {
            // SAFETY: a pointer event target inside the document is a Node.
            lastPressedInsideRef.current = Boolean(chatRootRef.current?.contains(event.target as Node));
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || !eventMatchesShortcut(event, combo)) return;
            const root = chatRootRef.current;
            const focused = document.activeElement;
            const unfocused = !focused || focused === document.body;
            if (!root || (unfocused ? !lastPressedInsideRef.current : !root.contains(focused))) return;
            event.preventDefault();
            setChatSearch((current) => ({ open: true, focusRequest: current.focusRequest + 1 }));
        };
        document.addEventListener('pointerdown', onPointerDown, { capture: true });
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, { capture: true });
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [active, currentSessionId, messageSearchEnabled, shortcutOverrides]);
    const closeChatSearch = React.useCallback(() => {
        setChatSearch((current) => ({ ...current, open: false }));
    }, []);

    return { chatRootRef, chatSearch, messageSearchEnabled, closeChatSearch };
};

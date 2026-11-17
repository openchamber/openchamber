import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { eventMatchesShortcut, getEffectiveShortcutCombo } from '@/lib/shortcuts';

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

export const CHAT_INPUT_EDITOR_SELECTOR = '[data-chat-input="true"] .cm-content';

/** The main chat's composer editor, skipping the one of a chat pinned in the side panel. */
export function findMainChatInputEditor(): HTMLElement | null {
    const editors = document.querySelectorAll<HTMLElement>(CHAT_INPUT_EDITOR_SELECTOR);
    for (const editor of editors) {
        if (!editor.closest('[data-chat-column="pinned"]')) return editor;
    }
    return null;
}

/**
 * Focuses the main chat's composer. A chat pinned in the side panel has a
 * composer of its own, which app-wide callers (shortcuts, the terminal, file
 * comments) must not land in; inside a chat, use the column's own
 * `focusInput` (`chatColumnSession.ts`) instead.
 */
export function focusChatInput(): void {
    findMainChatInputEditor()?.focus();
}

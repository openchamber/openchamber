export const CHAT_INPUT_EDITOR_SELECTOR = '[data-chat-input="true"] .cm-content';

/**
 * Focuses the main chat's composer. A chat pinned in the side panel has a
 * composer of its own, which app-wide callers (shortcuts, the terminal, file
 * comments) must not land in; inside a chat, use the column's own
 * `focusInput` (`chatColumnSession.ts`) instead.
 */
export function focusChatInput(): void {
    const editors = document.querySelectorAll<HTMLElement>(CHAT_INPUT_EDITOR_SELECTOR);
    for (const editor of editors) {
        if (!editor.closest('[data-chat-column="pinned"]')) {
            editor.focus();
            return;
        }
    }
}
